//! edit-stress — 단일 문서 고강도 편집 내성 진단.
//!
//! 실제 편집기(스튜디오/MCP)가 쓰는 DocumentCore 편집 명령을 한 문서에 연속으로 가해
//! 표 구조·그림 속성·레이아웃·직렬화 왕복이 무너지지 않는지 검사한다.
//! 편집 배터리: 본문 텍스트 삽입/삭제/문단 분할·병합, 쪽 나눔, 표 행/열 삽입·삭제,
//! 셀 텍스트, 셀 병합/분할, 그림 속성 재설정·절반 축소·삭제, 서식(굵게·크기·정렬),
//! SVG 렌더 스모크, HWPX 재직렬화 → 재파싱 대조, 스냅숏 복원 대조.
//!
//! 사용:
//!     rhwp edit-stress <파일.hwpx> [-o report.json]
//!
//! 종료 코드: 0 = 결함 없음, 1 = 결함 발견(파서 panic 포함), 2 = 사용법 오류·파싱 거부.
//! stdout 으로 JSON 리포트(사람용 요약은 stderr). op 단위 panic 은 catch_unwind 로
//! 격리하고, panic 후에는 문서를 재적재해 다음 그룹을 계속 진행한다.

use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::time::Instant;

use serde_json::{json, Value};

use crate::model::control::Control;
use crate::wasm_api::HwpDocument;

#[derive(Clone, Debug, PartialEq)]
struct TableLoc {
    sec: usize,
    para: usize,
    ctrl: usize,
    rows: u16,
    cols: u16,
    cells: usize,
}

#[derive(Clone, Debug, PartialEq)]
struct PicLoc {
    sec: usize,
    para: usize,
    ctrl: usize,
}

/// 본문 컨트롤 트리(1단계)에서 표·그림 위치를 수집한다.
fn take_inventory(doc: &HwpDocument) -> (Vec<TableLoc>, Vec<PicLoc>) {
    let mut tables = Vec::new();
    let mut pics = Vec::new();
    for (s, section) in doc.document.sections.iter().enumerate() {
        for (p, para) in section.paragraphs.iter().enumerate() {
            for (c, ctrl) in para.controls.iter().enumerate() {
                match ctrl {
                    Control::Table(t) => tables.push(TableLoc {
                        sec: s,
                        para: p,
                        ctrl: c,
                        rows: t.row_count,
                        cols: t.col_count,
                        cells: t.cells.len(),
                    }),
                    Control::Picture(_) => pics.push(PicLoc {
                        sec: s,
                        para: p,
                        ctrl: c,
                    }),
                    _ => {}
                }
            }
        }
    }
    (tables, pics)
}

/// 특정 위치 표의 현재 치수를 모델에서 직접 읽는다.
fn table_dims(doc: &HwpDocument, loc: &TableLoc) -> Option<(u16, u16, usize)> {
    let para = doc
        .document
        .sections
        .get(loc.sec)?
        .paragraphs
        .get(loc.para)?;
    match para.controls.get(loc.ctrl) {
        Some(Control::Table(t)) => Some((t.row_count, t.col_count, t.cells.len())),
        _ => None,
    }
}

struct Report {
    ops: Vec<Value>,
    bugs: Vec<Value>,
}

impl Report {
    fn bug(&mut self, code: &str, op: &str, detail: String) {
        self.bugs
            .push(json!({"code": code, "op": op, "detail": detail}));
    }
}

/// op 하나를 panic 격리 아래 실행하고 기록한다. panic 이면 Err(메시지).
fn run_op<F>(
    report: &mut Report,
    doc: &mut HwpDocument,
    name: &str,
    target: String,
    expect_ok: bool,
    f: F,
) -> Result<bool, String>
where
    F: FnOnce(&mut HwpDocument) -> Result<String, String>,
{
    let t0 = Instant::now();
    let outcome = panic::catch_unwind(AssertUnwindSafe(|| f(doc)));
    let ms = t0.elapsed().as_millis() as u64;
    match outcome {
        Ok(Ok(_)) => {
            let pages = doc.page_count();
            report.ops.push(json!({
                "name": name, "target": target, "result": "ok", "pagesAfter": pages, "ms": ms
            }));
            if pages == 0 {
                report.bug("ZERO_PAGES", name, format!("{target}: 편집 후 페이지 0"));
            }
            Ok(true)
        }
        Ok(Err(e)) => {
            report.ops.push(json!({
                "name": name, "target": target, "result": "err", "detail": e, "ms": ms
            }));
            if expect_ok {
                report.bug("OP_ERR", name, format!("{target}: {e}"));
            }
            Ok(false)
        }
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "?".to_string());
            report.ops.push(json!({
                "name": name, "target": target, "result": "panic", "detail": msg, "ms": ms
            }));
            report.bug("PANIC", name, format!("{target}: {msg}"));
            Err(msg)
        }
    }
}

fn hwp_err(e: crate::error::HwpError) -> String {
    format!("{e:?}")
}

/// 구역에서 텍스트 편집 대상 문단(앞쪽 120개 중 최장)을 고른다.
fn pick_target_para(doc: &HwpDocument, sec: usize) -> Option<(usize, usize)> {
    let count = doc.get_paragraph_count_native(sec).ok()?;
    let mut best: Option<(usize, usize)> = None;
    for p in 0..count.min(120) {
        let len = doc.get_paragraph_length_native(sec, p).unwrap_or(0);
        if len > best.map(|(_, l)| l).unwrap_or(0) {
            best = Some((p, len));
        }
    }
    best.filter(|&(_, l)| l > 0)
}

/// 텍스트 편집 그룹. panic 시 Err 반환(호출부가 문서를 재적재).
fn text_group(report: &mut Report, doc: &mut HwpDocument, sec: usize) -> Result<(), String> {
    let Some((p, len)) = pick_target_para(doc, sec) else {
        return Ok(());
    };
    let tgt = format!("s{sec}p{p}");
    let pages_before = doc.page_count();

    run_op(report, doc, "text_insert_start", tgt.clone(), true, |d| {
        d.insert_text_native(sec, p, 0, "가A").map_err(hwp_err)
    })?;
    if doc.page_count() < pages_before {
        report.bug(
            "INSERT_PAGES_DECREASED",
            "text_insert_start",
            format!("{tgt}: {} → {}", pages_before, doc.page_count()),
        );
    }
    let mid = 2 + len / 2;
    run_op(report, doc, "text_insert_mid", tgt.clone(), true, |d| {
        d.insert_text_native(sec, p, mid, "확인B").map_err(hwp_err)
    })?;
    run_op(report, doc, "text_insert_end", tgt.clone(), true, |d| {
        let l = d.get_paragraph_length_native(sec, p).map_err(hwp_err)?;
        d.insert_text_native(sec, p, l, " 끝C").map_err(hwp_err)
    })?;
    run_op(report, doc, "text_delete", tgt.clone(), true, |d| {
        d.delete_text_native(sec, p, 2, 2).map_err(hwp_err)
    })?;

    // 마커 잔존 확인 — 삽입 직후 읽기 손실은 편집 경로 결함이다.
    let readback = doc.get_text_range_native(sec, p, 0, 8).unwrap_or_default();
    if !readback.contains("가A") {
        report.bug(
            "TEXT_READBACK_LOST",
            "text_insert_start",
            format!("{tgt}: 삽입 마커 소실, 현재={readback:?}"),
        );
    }

    let before_split = doc.get_paragraph_count_native(sec).unwrap_or(0);
    let split_ok = run_op(report, doc, "para_split", tgt.clone(), true, |d| {
        let l = d.get_paragraph_length_native(sec, p).map_err(hwp_err)?;
        d.split_paragraph_native(sec, p, l / 2, None)
            .map_err(hwp_err)
    })?;
    if split_ok {
        let after_split = doc.get_paragraph_count_native(sec).unwrap_or(0);
        if after_split != before_split + 1 {
            report.bug(
                "PARA_SPLIT_COUNT",
                "para_split",
                format!("{tgt}: 문단 수 {before_split} → {after_split} (기대 +1)"),
            );
        }
        run_op(report, doc, "para_merge", tgt.clone(), true, |d| {
            d.merge_paragraph_native(sec, p + 1).map_err(hwp_err)
        })?;
        let after_merge = doc.get_paragraph_count_native(sec).unwrap_or(0);
        if after_merge != before_split {
            report.bug(
                "PARA_MERGE_COUNT",
                "para_merge",
                format!("{tgt}: 문단 수 {after_split} → {after_merge} (기대 {before_split})"),
            );
        }
    }

    let before_ins = doc.get_paragraph_count_native(sec).unwrap_or(0);
    let ins_ok = run_op(report, doc, "para_insert", tgt.clone(), true, |d| {
        d.insert_paragraph_native(sec, p).map_err(hwp_err)
    })?;
    if ins_ok {
        let after_ins = doc.get_paragraph_count_native(sec).unwrap_or(0);
        if after_ins == before_ins + 1 {
            run_op(report, doc, "para_delete", tgt.clone(), true, |d| {
                d.delete_paragraph_native(sec, p + 1).map_err(hwp_err)
            })?;
        } else {
            report.bug(
                "PARA_INSERT_COUNT",
                "para_insert",
                format!("{tgt}: 문단 수 {before_ins} → {after_ins} (기대 +1)"),
            );
        }
    }

    let pages_pb = doc.page_count();
    let pb_ok = run_op(report, doc, "page_break", tgt.clone(), true, |d| {
        d.insert_page_break_native(sec, p, 0).map_err(hwp_err)
    })?;
    if pb_ok && doc.page_count() < pages_pb {
        report.bug(
            "PAGEBREAK_PAGES_DECREASED",
            "page_break",
            format!("{tgt}: {} → {}", pages_pb, doc.page_count()),
        );
    }
    Ok(())
}

/// 표 편집 그룹 (한 표).
fn table_group(report: &mut Report, doc: &mut HwpDocument, loc: &TableLoc) -> Result<(), String> {
    let (sec, p, c) = (loc.sec, loc.para, loc.ctrl);
    let tgt = format!("s{sec}p{p}c{c}");
    let Some((rows0, cols0, _)) = table_dims(doc, loc) else {
        return Ok(());
    };
    // 행/열 0짜리 퇴화 표는 rows0-1/cols0-1 이 u16 underflow 를 일으키므로 건너뛴다
    // (디버그 빌드 panic, 릴리스 빌드 65535 전달로 가짜 OP_ERR 유발).
    if rows0 == 0 || cols0 == 0 {
        return Ok(());
    }

    let ok = run_op(report, doc, "table_row_insert", tgt.clone(), true, |d| {
        d.insert_table_row_native(sec, p, c, rows0 - 1, true)
            .map_err(hwp_err)
    })?;
    if ok {
        match table_dims(doc, loc) {
            Some((r, _, _)) if r == rows0 + 1 => {
                run_op(report, doc, "table_row_delete", tgt.clone(), true, |d| {
                    d.delete_table_row_native(sec, p, c, rows0).map_err(hwp_err)
                })?;
                if let Some((r2, _, _)) = table_dims(doc, loc) {
                    if r2 != rows0 {
                        report.bug(
                            "TABLE_DIMS",
                            "table_row_delete",
                            format!("{tgt}: 행 {rows0}+1-1 = {r2} (기대 {rows0})"),
                        );
                    }
                }
            }
            other => report.bug(
                "TABLE_DIMS",
                "table_row_insert",
                format!("{tgt}: 행 삽입 후 치수 {other:?} (기대 rows={})", rows0 + 1),
            ),
        }
    }

    let ok = run_op(report, doc, "table_col_insert", tgt.clone(), true, |d| {
        d.insert_table_column_native(sec, p, c, cols0 - 1, true)
            .map_err(hwp_err)
    })?;
    if ok {
        match table_dims(doc, loc) {
            Some((_, k, _)) if k == cols0 + 1 => {
                run_op(report, doc, "table_col_delete", tgt.clone(), true, |d| {
                    d.delete_table_column_native(sec, p, c, cols0)
                        .map_err(hwp_err)
                })?;
                if let Some((_, k2, _)) = table_dims(doc, loc) {
                    if k2 != cols0 {
                        report.bug(
                            "TABLE_DIMS",
                            "table_col_delete",
                            format!("{tgt}: 열 {cols0}+1-1 = {k2} (기대 {cols0})"),
                        );
                    }
                }
            }
            other => report.bug(
                "TABLE_DIMS",
                "table_col_insert",
                format!("{tgt}: 열 삽입 후 치수 {other:?} (기대 cols={})", cols0 + 1),
            ),
        }
    }

    let ok = run_op(report, doc, "cell_text_insert", tgt.clone(), true, |d| {
        d.insert_text_in_cell_native(sec, p, c, 0, 0, 0, "셀검증")
            .map_err(hwp_err)
    })?;
    if ok {
        let back = doc
            .get_text_in_cell_native(sec, p, c, 0, 0, 0, 32)
            .unwrap_or_default();
        if !back.contains("셀검증") {
            report.bug(
                "CELL_TEXT_LOST",
                "cell_text_insert",
                format!("{tgt}: 셀 삽입 텍스트 소실, 현재={back:?}"),
            );
        }
    }

    if rows0 >= 2 && cols0 >= 2 {
        // 병합/분할은 기존 병합 상태에 따라 정당하게 거부될 수 있어 Err 는 결함으로 치지 않는다.
        let merged = run_op(report, doc, "cell_merge", tgt.clone(), false, |d| {
            d.merge_table_cells_native(sec, p, c, 0, 0, 1, 1)
                .map_err(hwp_err)
        })?;
        if merged {
            if let Some((r, k, _)) = table_dims(doc, loc) {
                if r != rows0 || k != cols0 {
                    report.bug(
                        "TABLE_DIMS",
                        "cell_merge",
                        format!("{tgt}: 병합 후 격자 {rows0}x{cols0} → {r}x{k}"),
                    );
                }
            }
        }
        run_op(report, doc, "cell_split_into", tgt.clone(), false, |d| {
            d.split_table_cell_into_native(sec, p, c, 0, 0, 2, 2, false, false)
                .map_err(hwp_err)
        })?;
    }
    Ok(())
}

/// 그림 편집 그룹 (한 그림). delete=true 면 마지막에 삭제까지 검증.
fn pic_group(
    report: &mut Report,
    doc: &mut HwpDocument,
    loc: &PicLoc,
    delete: bool,
) -> Result<(), String> {
    let (sec, p, c) = (loc.sec, loc.para, loc.ctrl);
    let tgt = format!("s{sec}p{p}c{c}");
    let props = match doc.get_picture_properties_native(sec, p, c) {
        Ok(v) => v,
        Err(e) => {
            report.bug("OP_ERR", "pic_props_get", format!("{tgt}: {e:?}"));
            return Ok(());
        }
    };
    let parsed: Value = serde_json::from_str(&props).unwrap_or(Value::Null);
    let (w, h) = (
        parsed.get("width").and_then(Value::as_i64).unwrap_or(0),
        parsed.get("height").and_then(Value::as_i64).unwrap_or(0),
    );

    if w > 0 && h > 0 {
        // 동일 값 재설정 — 무손실이어야 한다.
        let ok = run_op(report, doc, "pic_set_noop", tgt.clone(), true, |d| {
            d.set_picture_properties_native(sec, p, c, &format!("{{\"width\":{w},\"height\":{h}}}"))
                .map_err(hwp_err)
        })?;
        if ok {
            if let Ok(after) = doc.get_picture_properties_native(sec, p, c) {
                let av: Value = serde_json::from_str(&after).unwrap_or(Value::Null);
                let (aw, ah) = (
                    av.get("width").and_then(Value::as_i64).unwrap_or(0),
                    av.get("height").and_then(Value::as_i64).unwrap_or(0),
                );
                if aw != w || ah != h {
                    report.bug(
                        "PIC_NOOP_SET_CHANGED",
                        "pic_set_noop",
                        format!("{tgt}: {w}x{h} → {aw}x{ah}"),
                    );
                }
            }
        }
        let (hw, hh) = (w / 2, h / 2);
        let ok = run_op(report, doc, "pic_resize_half", tgt.clone(), true, |d| {
            d.set_picture_properties_native(
                sec,
                p,
                c,
                &format!("{{\"width\":{hw},\"height\":{hh}}}"),
            )
            .map_err(hwp_err)
        })?;
        if ok {
            if let Ok(after) = doc.get_picture_properties_native(sec, p, c) {
                let av: Value = serde_json::from_str(&after).unwrap_or(Value::Null);
                let aw = av.get("width").and_then(Value::as_i64).unwrap_or(0);
                if (aw - hw).abs() > hw / 50 + 1 {
                    report.bug(
                        "PIC_RESIZE_NOT_APPLIED",
                        "pic_resize_half",
                        format!("{tgt}: width {w} → 요청 {hw}, 실제 {aw}"),
                    );
                }
            }
        }
    }

    if delete {
        let before = take_inventory(doc).1.len();
        let ok = run_op(report, doc, "pic_delete", tgt.clone(), true, |d| {
            d.delete_picture_control_native(sec, p, c).map_err(hwp_err)
        })?;
        if ok {
            let after = take_inventory(doc).1.len();
            if after != before - 1 {
                report.bug(
                    "PIC_DELETE_MISS",
                    "pic_delete",
                    format!("{tgt}: 그림 수 {before} → {after} (기대 -1)"),
                );
            }
        }
    }
    Ok(())
}

/// 서식 그룹.
fn format_group(report: &mut Report, doc: &mut HwpDocument, sec: usize) -> Result<(), String> {
    let Some((p, len)) = pick_target_para(doc, sec) else {
        return Ok(());
    };
    let tgt = format!("s{sec}p{p}");
    run_op(report, doc, "char_bold", tgt.clone(), true, |d| {
        d.apply_char_format_native(sec, p, 0, 5.min(len), r#"{"bold":true}"#)
            .map_err(hwp_err)
    })?;
    run_op(report, doc, "char_size", tgt.clone(), true, |d| {
        d.apply_char_format_native(sec, p, 0, 8.min(len), r#"{"fontSize":1600}"#)
            .map_err(hwp_err)
    })?;
    run_op(report, doc, "para_align_center", tgt.clone(), true, |d| {
        d.apply_para_format_native(sec, p, r#"{"alignment":"center"}"#)
            .map_err(hwp_err)
    })?;
    Ok(())
}

/// 렌더 스모크 — 첫/중간/끝 페이지 SVG.
fn render_smoke(report: &mut Report, doc: &HwpDocument, label: &str) {
    let pages = doc.page_count();
    if pages == 0 {
        report.bug("ZERO_PAGES", label, "렌더 대상 페이지 없음".to_string());
        return;
    }
    let mut targets = vec![0, pages / 2, pages - 1];
    targets.dedup();
    for pg in targets {
        let out = panic::catch_unwind(AssertUnwindSafe(|| doc.render_page_svg_native(pg)));
        match out {
            Ok(Ok(svg)) if !svg.is_empty() => {}
            Ok(Ok(_)) => report.bug("RENDER_FAIL", label, format!("페이지 {pg}: 빈 SVG")),
            Ok(Err(e)) => report.bug("RENDER_FAIL", label, format!("페이지 {pg}: {e:?}")),
            Err(_) => report.bug("PANIC", label, format!("SVG 렌더 panic (페이지 {pg})")),
        }
    }
}

pub fn run(args: &[String]) {
    let mut path: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-o" | "--out" => out = it.next().map(PathBuf::from),
            "-h" | "--help" => {
                eprintln!("사용: rhwp edit-stress <파일.hwpx> [-o report.json]");
                std::process::exit(2);
            }
            _ => path = Some(PathBuf::from(a)),
        }
    }
    let Some(path) = path else {
        eprintln!("사용: rhwp edit-stress <파일.hwpx> [-o report.json]");
        std::process::exit(2);
    };

    let t_start = Instant::now();
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("오류: 파일 읽기 실패 - {e}");
            std::process::exit(2);
        }
    };
    let mut report = Report {
        ops: Vec::new(),
        bugs: Vec::new(),
    };

    // op panic 은 리포트로 수집하므로 기본 훅의 소음을 끈다.
    let prev_hook = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));

    let parsed = panic::catch_unwind(AssertUnwindSafe(|| HwpDocument::from_bytes(&bytes)));
    let mut doc = match parsed {
        Ok(Ok(d)) => d,
        Ok(Err(e)) => {
            panic::set_hook(prev_hook);
            emit(
                &path,
                out.as_deref(),
                json!({
                    "file": path.display().to_string(),
                    "status": format!("parse_error:{e:?}"),
                    "bugs": [], "ops": []
                }),
            );
            // 정상적인 파싱 거부는 편집 결함이 아니다 — 문서화된 사용법/파싱 오류 코드.
            std::process::exit(2);
        }
        Err(_) => {
            panic::set_hook(prev_hook);
            emit(
                &path,
                out.as_deref(),
                json!({
                    "file": path.display().to_string(),
                    "status": "parse_panic",
                    "bugs": [{"code":"PANIC","op":"parse","detail":"파싱 panic"}], "ops": []
                }),
            );
            std::process::exit(1);
        }
    };

    // 기준선.
    let base_pages = doc.page_count();
    let (base_tables, base_pics) = take_inventory(&doc);
    let base_para0 = doc.get_paragraph_count_native(0).unwrap_or(0);
    render_smoke(&mut report, &doc, "render_baseline");
    let snap = doc.save_snapshot_native();
    let mut snapshot_valid = true;

    // 문서 재적재 도우미 — panic 으로 오염된 문서를 새로 판다.
    macro_rules! reload_on_panic {
        ($res:expr) => {
            if $res.is_err() {
                if let Ok(Ok(fresh)) =
                    panic::catch_unwind(AssertUnwindSafe(|| HwpDocument::from_bytes(&bytes)))
                {
                    doc = fresh;
                    snapshot_valid = false;
                } else {
                    report.bug("PANIC", "reload", "panic 후 재적재 실패".to_string());
                }
            }
        };
    }

    let sec_count = doc.document.sections.len();
    for sec in 0..sec_count.min(3) {
        let r = text_group(&mut report, &mut doc, sec);
        reload_on_panic!(r);
    }

    let (tables, _) = take_inventory(&doc);
    for loc in tables.iter().take(6) {
        let r = table_group(&mut report, &mut doc, loc);
        reload_on_panic!(r);
    }

    let (_, pics) = take_inventory(&doc);
    let pic_total = pics.len().min(4);
    for (i, loc) in pics.iter().take(4).enumerate() {
        let r = pic_group(&mut report, &mut doc, loc, i + 1 == pic_total);
        reload_on_panic!(r);
    }

    for sec in 0..sec_count.min(2) {
        let r = format_group(&mut report, &mut doc, sec);
        reload_on_panic!(r);
    }

    render_smoke(&mut report, &doc, "render_after_edits");

    // HWPX 재직렬화 → 재파싱 대조.
    let (edited_tables, edited_pics) = take_inventory(&doc);
    let edited_pages = doc.page_count();
    let export = panic::catch_unwind(AssertUnwindSafe(|| doc.export_hwpx_native()));
    match export {
        Ok(Ok(out_bytes)) => {
            match panic::catch_unwind(AssertUnwindSafe(|| HwpDocument::from_bytes(&out_bytes))) {
                Ok(Ok(doc2)) => {
                    let rt_pages = doc2.page_count();
                    if rt_pages != edited_pages {
                        report.bug(
                            "RT_PAGE_DRIFT",
                            "roundtrip",
                            format!("편집본 {edited_pages}쪽 → 재파싱 {rt_pages}쪽"),
                        );
                    }
                    let (rt_tables, rt_pics) = take_inventory(&doc2);
                    let dims =
                        |v: &Vec<TableLoc>| v.iter().map(|t| (t.rows, t.cols)).collect::<Vec<_>>();
                    if dims(&rt_tables) != dims(&edited_tables) {
                        report.bug(
                            "RT_TABLE_MISMATCH",
                            "roundtrip",
                            format!(
                                "표 치수 {:?} → {:?}",
                                dims(&edited_tables),
                                dims(&rt_tables)
                            ),
                        );
                    }
                    if rt_pics.len() != edited_pics.len() {
                        report.bug(
                            "RT_PIC_COUNT",
                            "roundtrip",
                            format!("그림 {} → {}", edited_pics.len(), rt_pics.len()),
                        );
                    }
                    if let Some((p, _)) = pick_target_para(&doc, 0) {
                        let orig = doc.get_text_range_native(0, p, 0, 8).unwrap_or_default();
                        if orig.contains("가A") {
                            let rt = doc2.get_text_range_native(0, p, 0, 8).unwrap_or_default();
                            if !rt.contains("가A") {
                                report.bug(
                                    "RT_TEXT_LOSS",
                                    "roundtrip",
                                    format!("s0p{p} 마커 소실: {rt:?}"),
                                );
                            }
                        }
                    }
                    render_smoke(&mut report, &doc2, "render_roundtrip");
                }
                Ok(Err(e)) => report.bug("RT_PARSE_FAIL", "roundtrip", format!("{e:?}")),
                Err(_) => report.bug("PANIC", "roundtrip", "재파싱 panic".to_string()),
            }
        }
        Ok(Err(e)) => report.bug("EXPORT_FAIL", "export_hwpx", format!("{e:?}")),
        Err(_) => report.bug("PANIC", "export_hwpx", "HWPX 직렬화 panic".to_string()),
    }

    // 스냅숏 복원 대조.
    if snapshot_valid {
        let restored = panic::catch_unwind(AssertUnwindSafe(|| doc.restore_snapshot_native(snap)));
        match restored {
            Ok(Ok(_)) => {
                let pages = doc.page_count();
                let (t2, p2) = take_inventory(&doc);
                let para0 = doc.get_paragraph_count_native(0).unwrap_or(0);
                if pages != base_pages
                    || para0 != base_para0
                    || t2.len() != base_tables.len()
                    || p2.len() != base_pics.len()
                {
                    report.bug(
                        "RESTORE_MISMATCH",
                        "restore_snapshot",
                        format!(
                            "쪽 {base_pages}→{pages}, 문단0 {base_para0}→{para0}, 표 {}→{}, 그림 {}→{}",
                            base_tables.len(), t2.len(), base_pics.len(), p2.len()
                        ),
                    );
                }
            }
            Ok(Err(e)) => report.bug("OP_ERR", "restore_snapshot", format!("{e:?}")),
            Err(_) => report.bug("PANIC", "restore_snapshot", "복원 panic".to_string()),
        }
    }

    panic::set_hook(prev_hook);

    let bug_count = report.bugs.len();
    let doc_json = json!({
        "file": path.display().to_string(),
        "status": "ok",
        "elapsedMs": t_start.elapsed().as_millis() as u64,
        "baseline": {
            "pages": base_pages,
            "sections": sec_count,
            "tables": base_tables.len(),
            "pictures": base_pics.len(),
        },
        "ops": report.ops,
        "bugs": report.bugs,
    });
    emit(&path, out.as_deref(), doc_json);
    eprintln!(
        "[edit-stress] {} — op {}건, 결함 {}건, {}ms",
        path.display(),
        report.ops.len(),
        bug_count,
        t_start.elapsed().as_millis()
    );
    std::process::exit(i32::from(bug_count > 0));
}

fn emit(_path: &std::path::Path, out: Option<&std::path::Path>, v: Value) {
    let text = serde_json::to_string_pretty(&v).unwrap_or_else(|_| "{}".to_string());
    match out {
        Some(o) => {
            if let Some(parent) = o.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::write(o, &text) {
                eprintln!("오류: 리포트 저장 실패 - {e}");
                println!("{text}");
            }
        }
        None => println!("{text}"),
    }
}
