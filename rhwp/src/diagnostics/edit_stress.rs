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
use crate::model::paragraph::Paragraph;
use crate::model::shape::ShapeObject;
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

#[derive(Clone, Debug, PartialEq)]
struct ShapeLoc {
    sec: usize,
    para: usize,
    ctrl: usize,
    picture_subtype: bool,
}

type CellPathStep = (usize, usize, usize);

#[derive(Clone, Debug, PartialEq)]
struct NestedVisualLoc {
    sec: usize,
    parent_para: usize,
    path: Vec<CellPathStep>,
    ctrl: usize,
    picture: bool,
    picture_shape_subtype: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct LayerLoc {
    sec: usize,
    para: usize,
    ctrl: usize,
    kind: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
struct PageImageBrushLoc {
    sec: usize,
    border_fill_id: u16,
}

#[derive(Clone, Debug, PartialEq)]
struct PageImageBrushState {
    props: Value,
    border_fill_count: usize,
    border_fill_debug: String,
    bin_data: Option<(u16, String, Vec<u8>)>,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct RecursiveInventory {
    top_tables: Vec<TableLoc>,
    top_pictures: Vec<PicLoc>,
    top_shapes: Vec<ShapeLoc>,
    nested_visuals: Vec<NestedVisualLoc>,
    layers: Vec<LayerLoc>,
    page_image_brushes: Vec<PageImageBrushLoc>,
    table_count: usize,
    picture_count: usize,
    shape_count: usize,
    group_count: usize,
    nested_table_count: usize,
    nested_picture_count: usize,
    nested_shape_count: usize,
    page_image_brush_count: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct InventoryCounts {
    tables: usize,
    pictures: usize,
    shapes: usize,
    groups: usize,
    page_image_brushes: usize,
}

impl RecursiveInventory {
    fn counts(&self) -> InventoryCounts {
        InventoryCounts {
            tables: self.table_count,
            pictures: self.picture_count,
            shapes: self.shape_count,
            groups: self.group_count,
            page_image_brushes: self.page_image_brush_count,
        }
    }
}

fn walk_shape_object(
    shape: &ShapeObject,
    inventory: &mut RecursiveInventory,
    nested_in_group: bool,
    walk_contents: bool,
) {
    inventory.shape_count += 1;
    match shape {
        ShapeObject::Picture(_) => {
            inventory.picture_count += 1;
            if nested_in_group {
                inventory.nested_picture_count += 1;
            }
        }
        ShapeObject::Group(group) => {
            if nested_in_group {
                inventory.nested_shape_count += 1;
            }
            inventory.group_count += 1;
            for child in &group.children {
                walk_shape_object(child, inventory, true, true);
            }
            if walk_contents {
                if let Some(caption) = &group.caption {
                    for para in &caption.paragraphs {
                        walk_paragraph(None, para, inventory);
                    }
                }
            }
        }
        _ => {
            if nested_in_group {
                inventory.nested_shape_count += 1;
            }
            if walk_contents {
                if let Some(drawing) = shape.drawing() {
                    if let Some(text_box) = &drawing.text_box {
                        for para in &text_box.paragraphs {
                            walk_paragraph(None, para, inventory);
                        }
                    }
                    if let Some(caption) = &drawing.caption {
                        for para in &caption.paragraphs {
                            walk_paragraph(None, para, inventory);
                        }
                    }
                }
            }
        }
    }
}

fn walk_shape_caption(shape: &ShapeObject, inventory: &mut RecursiveInventory) {
    match shape {
        ShapeObject::Group(group) => {
            if let Some(caption) = &group.caption {
                for para in &caption.paragraphs {
                    walk_paragraph(None, para, inventory);
                }
            }
        }
        _ => {
            if let Some(drawing) = shape.drawing() {
                if let Some(caption) = &drawing.caption {
                    for para in &caption.paragraphs {
                        walk_paragraph(None, para, inventory);
                    }
                }
            }
        }
    }
}

/// Recursively inventory body controls. `address` is present only while a control can be
/// reached through the engine's existing cell/textbox/caption path API. Group children and
/// header/footer/note content are still counted, but are intentionally not advertised as mutable.
fn walk_paragraph(
    address: Option<(usize, usize, Vec<CellPathStep>)>,
    para: &Paragraph,
    inventory: &mut RecursiveInventory,
) {
    for (ctrl_idx, ctrl) in para.controls.iter().enumerate() {
        match ctrl {
            Control::Table(table) => {
                inventory.table_count += 1;
                if let Some((sec, parent_para, ref path)) = address {
                    if path.is_empty() {
                        inventory.top_tables.push(TableLoc {
                            sec,
                            para: parent_para,
                            ctrl: ctrl_idx,
                            rows: table.row_count,
                            cols: table.col_count,
                            cells: table.cells.len(),
                        });
                    } else {
                        inventory.nested_table_count += 1;
                    }
                    for (cell_idx, cell) in table.cells.iter().enumerate() {
                        for (cell_para_idx, cell_para) in cell.paragraphs.iter().enumerate() {
                            let mut child_path = path.clone();
                            child_path.push((ctrl_idx, cell_idx, cell_para_idx));
                            walk_paragraph(
                                Some((sec, parent_para, child_path)),
                                cell_para,
                                inventory,
                            );
                        }
                    }
                } else {
                    inventory.nested_table_count += 1;
                    for cell in &table.cells {
                        for cell_para in &cell.paragraphs {
                            walk_paragraph(None, cell_para, inventory);
                        }
                    }
                }
                if let Some(caption) = &table.caption {
                    for caption_para in &caption.paragraphs {
                        walk_paragraph(None, caption_para, inventory);
                    }
                }
            }
            Control::Picture(picture) => {
                inventory.picture_count += 1;
                if let Some((sec, parent_para, ref path)) = address {
                    if path.is_empty() {
                        inventory.top_pictures.push(PicLoc {
                            sec,
                            para: parent_para,
                            ctrl: ctrl_idx,
                        });
                    } else {
                        inventory.nested_picture_count += 1;
                        inventory.nested_visuals.push(NestedVisualLoc {
                            sec,
                            parent_para,
                            path: path.clone(),
                            ctrl: ctrl_idx,
                            picture: true,
                            picture_shape_subtype: false,
                        });
                    }
                    if let Some(caption) = &picture.caption {
                        for (caption_para_idx, caption_para) in
                            caption.paragraphs.iter().enumerate()
                        {
                            let mut child_path = path.clone();
                            child_path.push((ctrl_idx, 0, caption_para_idx));
                            walk_paragraph(
                                Some((sec, parent_para, child_path)),
                                caption_para,
                                inventory,
                            );
                        }
                    }
                } else {
                    inventory.nested_picture_count += 1;
                    if let Some(caption) = &picture.caption {
                        for caption_para in &caption.paragraphs {
                            walk_paragraph(None, caption_para, inventory);
                        }
                    }
                }
            }
            Control::Shape(shape) => {
                let picture_subtype = matches!(shape.as_ref(), ShapeObject::Picture(_));
                walk_shape_object(shape, inventory, false, false);
                if let Some((sec, parent_para, ref path)) = address {
                    if path.is_empty() {
                        inventory.top_shapes.push(ShapeLoc {
                            sec,
                            para: parent_para,
                            ctrl: ctrl_idx,
                            picture_subtype,
                        });
                    } else {
                        if picture_subtype {
                            inventory.nested_picture_count += 1;
                        } else {
                            inventory.nested_shape_count += 1;
                        }
                        inventory.nested_visuals.push(NestedVisualLoc {
                            sec,
                            parent_para,
                            path: path.clone(),
                            ctrl: ctrl_idx,
                            picture: false,
                            picture_shape_subtype: picture_subtype,
                        });
                    }
                    if let Some(drawing) = shape.drawing() {
                        if let Some(text_box) = &drawing.text_box {
                            for (text_para_idx, text_para) in text_box.paragraphs.iter().enumerate()
                            {
                                let mut child_path = path.clone();
                                child_path.push((ctrl_idx, 0, text_para_idx));
                                walk_paragraph(
                                    Some((sec, parent_para, child_path)),
                                    text_para,
                                    inventory,
                                );
                            }
                        }
                    }
                    walk_shape_caption(shape, inventory);
                } else {
                    if picture_subtype {
                        inventory.nested_picture_count += 1;
                    } else {
                        inventory.nested_shape_count += 1;
                    }
                    if let Some(drawing) = shape.drawing() {
                        if let Some(text_box) = &drawing.text_box {
                            for text_para in &text_box.paragraphs {
                                walk_paragraph(None, text_para, inventory);
                            }
                        }
                    }
                    walk_shape_caption(shape, inventory);
                }
            }
            Control::Header(header) => {
                for child in &header.paragraphs {
                    walk_paragraph(None, child, inventory);
                }
            }
            Control::Footer(footer) => {
                for child in &footer.paragraphs {
                    walk_paragraph(None, child, inventory);
                }
            }
            Control::Footnote(note) => {
                for child in &note.paragraphs {
                    walk_paragraph(None, child, inventory);
                }
            }
            Control::Endnote(note) => {
                for child in &note.paragraphs {
                    walk_paragraph(None, child, inventory);
                }
            }
            Control::HiddenComment(comment) => {
                for child in &comment.paragraphs {
                    walk_paragraph(None, child, inventory);
                }
            }
            Control::Field(field) => {
                for child in &field.memo_paragraphs {
                    walk_paragraph(None, child, inventory);
                }
            }
            _ => {}
        }
    }
}

fn take_recursive_inventory(doc: &HwpDocument) -> RecursiveInventory {
    let mut inventory = RecursiveInventory::default();
    for (sec, section) in doc.document.sections.iter().enumerate() {
        for (para_idx, para) in section.paragraphs.iter().enumerate() {
            walk_paragraph(Some((sec, para_idx, Vec::new())), para, &mut inventory);
        }
        for (para_idx, para) in section.paragraphs.iter().enumerate() {
            for (ctrl_idx, ctrl) in para.controls.iter().enumerate() {
                let kind = match ctrl {
                    Control::Shape(_) => Some("shape"),
                    Control::Picture(_) => Some("picture"),
                    Control::Table(table) if !table.common.treat_as_char => Some("table"),
                    Control::Equation(equation) if !equation.common.treat_as_char => {
                        Some("equation")
                    }
                    _ => None,
                };
                if let Some(kind) = kind {
                    inventory.layers.push(LayerLoc {
                        sec,
                        para: para_idx,
                        ctrl: ctrl_idx,
                        kind,
                    });
                }
            }
        }
        let is_image_fill = |border_fill_id: u16| {
            border_fill_id > 0
                && doc
                    .document
                    .doc_info
                    .border_fills
                    .get((border_fill_id - 1) as usize)
                    .is_some_and(|fill| {
                        matches!(fill.fill.fill_type, crate::model::style::FillType::Image)
                    })
        };
        let main_page_border_fill = &section.section_def.page_border_fill;
        if is_image_fill(main_page_border_fill.border_fill_id) {
            inventory.page_image_brush_count += 1;
            inventory.page_image_brushes.push(PageImageBrushLoc {
                sec,
                border_fill_id: main_page_border_fill.border_fill_id,
            });
        }
        for page_border_fill in &section.section_def.extra_page_border_fills {
            let id = page_border_fill.border_fill_id;
            if is_image_fill(id) {
                inventory.page_image_brush_count += 1;
            }
        }
    }
    inventory
}

/// Compatibility projection for the existing destructive top-level edit groups.
fn take_inventory(doc: &HwpDocument) -> (Vec<TableLoc>, Vec<PicLoc>) {
    let inventory = take_recursive_inventory(doc);
    (inventory.top_tables, inventory.top_pictures)
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

fn page_image_brush_state(
    doc: &HwpDocument,
    section_idx: usize,
) -> Result<PageImageBrushState, String> {
    let props = doc
        .get_page_border_fill_native(section_idx)
        .map_err(hwp_err)?;
    let props = serde_json::from_str(&props).map_err(|error| error.to_string())?;
    let section = doc
        .document
        .sections
        .get(section_idx)
        .ok_or_else(|| format!("section {section_idx} missing"))?;
    let border_fill_id = section.section_def.page_border_fill.border_fill_id;
    let border_fill = border_fill_id
        .checked_sub(1)
        .and_then(|index| doc.document.doc_info.border_fills.get(index as usize))
        .ok_or_else(|| format!("page border fill {border_fill_id} missing"))?;
    let image = border_fill
        .fill
        .image
        .as_ref()
        .ok_or_else(|| format!("page border fill {border_fill_id} is not an image fill"))?;
    let bin_data = doc
        .document
        .bin_data_content
        .iter()
        .find(|content| content.id == image.bin_data_id)
        .map(|content| (content.id, content.extension.clone(), content.data.load()));
    Ok(PageImageBrushState {
        props,
        border_fill_count: doc.document.doc_info.border_fills.len(),
        border_fill_debug: format!("{border_fill:?}"),
        bin_data,
    })
}

fn page_image_brush_group(
    report: &mut Report,
    doc: &mut HwpDocument,
    loc: &PageImageBrushLoc,
) -> Result<(), String> {
    let target = format!("s{}bf{}", loc.sec, loc.border_fill_id);
    run_op(
        report,
        doc,
        "pic_page_image_fill_noop",
        target,
        true,
        |document| {
            let before = page_image_brush_state(document, loc.sec)?;
            if before.props["borderFillId"] != loc.border_fill_id {
                return Err(format!(
                    "page image fill reference changed before mutation: expected {}, got {}",
                    loc.border_fill_id, before.props["borderFillId"]
                ));
            }
            let response = document
                .set_page_border_fill_native(
                    loc.sec,
                    &json!({"borderFillId": loc.border_fill_id}).to_string(),
                )
                .map_err(hwp_err)?;
            let after = page_image_brush_state(document, loc.sec)?;
            if after != before {
                return Err(format!(
                    "page image fill drifted across exact reference reuse: {before:?} -> {after:?}"
                ));
            }
            Ok(response)
        },
    )?;
    Ok(())
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

fn table_props_noop_group(
    report: &mut Report,
    doc: &mut HwpDocument,
    loc: &TableLoc,
) -> Result<(), String> {
    let (sec, p, c) = (loc.sec, loc.para, loc.ctrl);
    let tgt = format!("s{sec}p{p}c{c}");
    // Even malformed/legacy tables whose declared row/column counts are zero still have an
    // editable placement contract. Exercise the real table setter with an empty patch and prove
    // that its semantic getter is unchanged before deciding whether structural edits are safe.
    let props_before = match doc.get_table_properties_native(sec, p, c) {
        Ok(properties) => properties,
        Err(error) => {
            report.bug("OP_ERR", "table_props_get", format!("{tgt}: {error:?}"));
            return Ok(());
        }
    };
    let noop_ok = run_op(report, doc, "table_props_noop", tgt.clone(), true, |d| {
        d.set_table_properties_native(sec, p, c, "{}")
            .map_err(hwp_err)
    })?;
    if noop_ok {
        match doc.get_table_properties_native(sec, p, c) {
            Ok(props_after) if props_after == props_before => {}
            Ok(props_after) => report.bug(
                "TABLE_NOOP_SET_CHANGED",
                "table_props_noop",
                format!("{tgt}: {props_before} -> {props_after}"),
            ),
            Err(error) => report.bug(
                "OP_ERR",
                "table_props_get_after_noop",
                format!("{tgt}: {error:?}"),
            ),
        }
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

fn cell_path_json(path: &[CellPathStep]) -> String {
    Value::Array(
        path.iter()
            .map(|&(control_idx, cell_idx, cell_para_idx)| {
                json!({
                    "controlIdx": control_idx,
                    "cellIdx": cell_idx,
                    "cellParaIdx": cell_para_idx,
                })
            })
            .collect(),
    )
    .to_string()
}

fn nested_visual_props(doc: &HwpDocument, loc: &NestedVisualLoc) -> Result<String, String> {
    let para = doc
        .resolve_paragraph_by_path(loc.sec, loc.parent_para, &loc.path)
        .map_err(hwp_err)?;
    let ctrl = para
        .controls
        .get(loc.ctrl)
        .ok_or_else(|| format!("nested control {} out of range", loc.ctrl))?;
    match (loc.picture, ctrl) {
        (true, Control::Picture(picture)) => {
            crate::document_core::DocumentCore::format_picture_properties_json(picture)
                .map_err(hwp_err)
        }
        (false, Control::Shape(shape)) => {
            crate::document_core::DocumentCore::format_shape_props_inner(shape).map_err(hwp_err)
        }
        (true, _) => Err("nested path no longer resolves to Picture".to_string()),
        (false, _) => Err("nested path no longer resolves to Shape".to_string()),
    }
}

/// Path-aware property no-op for pictures and shapes inside cells, textboxes, or picture captions.
/// The empty patch deliberately avoids lossy UI-unit conversions. A semantic property snapshot
/// before and after proves that the real mutation command did not rewrite object state.
fn nested_visual_group(
    report: &mut Report,
    doc: &mut HwpDocument,
    loc: &NestedVisualLoc,
) -> Result<(), String> {
    let path_json = cell_path_json(&loc.path);
    let tgt = format!(
        "s{}p{}path={}c{}",
        loc.sec, loc.parent_para, path_json, loc.ctrl
    );
    let before = nested_visual_props(doc, loc)?;
    let op_name = if loc.picture || loc.picture_shape_subtype {
        "pic_nested_set_noop"
    } else {
        "shape_nested_set_noop"
    };
    let ok = run_op(report, doc, op_name, tgt.clone(), true, |d| {
        if loc.picture {
            d.set_cell_picture_properties_by_path_native(
                loc.sec,
                loc.parent_para,
                &path_json,
                loc.ctrl,
                "{}",
            )
            .map_err(hwp_err)
        } else {
            d.set_cell_shape_properties_by_path_native(
                loc.sec,
                loc.parent_para,
                &path_json,
                loc.ctrl,
                "{}",
            )
            .map_err(hwp_err)
        }
    })?;
    if ok {
        match nested_visual_props(doc, loc) {
            Ok(after) if after == before => {}
            Ok(after) => report.bug(
                "NESTED_VISUAL_NOOP_CHANGED",
                op_name,
                format!("{tgt}: {before} -> {after}"),
            ),
            Err(error) => report.bug(
                "OP_ERR",
                op_name,
                format!("{tgt}: cannot read after no-op: {error}"),
            ),
        }
    }
    Ok(())
}

fn shape_group(report: &mut Report, doc: &mut HwpDocument, loc: &ShapeLoc) -> Result<(), String> {
    let tgt = format!("s{}p{}c{}", loc.sec, loc.para, loc.ctrl);
    let before = doc
        .get_shape_properties_native(loc.sec, loc.para, loc.ctrl)
        .map_err(hwp_err)?;
    let op_name = if loc.picture_subtype {
        "pic_shape_set_noop"
    } else {
        "shape_set_noop"
    };
    let ok = run_op(report, doc, op_name, tgt.clone(), true, |d| {
        d.set_shape_properties_native(loc.sec, loc.para, loc.ctrl, "{}")
            .map_err(hwp_err)
    })?;
    if ok {
        match doc.get_shape_properties_native(loc.sec, loc.para, loc.ctrl) {
            Ok(after) if after == before => {}
            Ok(after) => report.bug(
                "SHAPE_NOOP_SET_CHANGED",
                op_name,
                format!("{tgt}: {before} -> {after}"),
            ),
            Err(error) => report.bug(
                "OP_ERR",
                op_name,
                format!("{tgt}: cannot read after no-op: {error:?}"),
            ),
        }
    }
    Ok(())
}

fn layer_signature(doc: &HwpDocument, sec: usize) -> Vec<(usize, usize, &'static str, i32)> {
    let Some(section) = doc.document.sections.get(sec) else {
        return Vec::new();
    };
    section
        .paragraphs
        .iter()
        .enumerate()
        .flat_map(|(para_idx, para)| {
            para.controls
                .iter()
                .enumerate()
                .filter_map(move |(control_idx, control)| match control {
                    Control::Shape(shape) => {
                        Some((para_idx, control_idx, "shape", shape.z_order()))
                    }
                    Control::Picture(picture) => {
                        Some((para_idx, control_idx, "picture", picture.common.z_order))
                    }
                    Control::Table(table) if !table.common.treat_as_char => {
                        Some((para_idx, control_idx, "table", table.common.z_order))
                    }
                    Control::Equation(equation) if !equation.common.treat_as_char => {
                        Some((para_idx, control_idx, "equation", equation.common.z_order))
                    }
                    _ => None,
                })
        })
        .collect()
}

/// Exercise the shared layer command on every supported top-level floating object kind, including
/// floating tables. Restore a private snapshot inside the operation so this diagnostic cannot
/// perturb later table/picture tests even when moving to front changes several z-order values.
fn layer_group(report: &mut Report, doc: &mut HwpDocument, loc: &LayerLoc) -> Result<(), String> {
    let tgt = format!("s{}p{}c{}:{}", loc.sec, loc.para, loc.ctrl, loc.kind);
    run_op(report, doc, "layer_z_order_roundtrip", tgt, true, |d| {
        let before = layer_signature(d, loc.sec);
        let snapshot = d.save_snapshot_native();
        let mutation = d
            .change_object_z_order_native(loc.sec, loc.para, loc.ctrl, "front")
            .map_err(hwp_err);
        let restore = d.restore_snapshot_native(snapshot).map_err(hwp_err);
        d.discard_snapshot_native(snapshot);
        let mutation_result = mutation?;
        restore?;
        let after = layer_signature(d, loc.sec);
        if before != after {
            return Err(format!(
                "layer snapshot restore mismatch: {before:?} -> {after:?}"
            ));
        }
        Ok(mutation_result)
    })?;
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
    let bytes = match crate::parser::limits::read_local_file_once(&path) {
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

    let parsed = panic::catch_unwind(AssertUnwindSafe(|| {
        HwpDocument::from_local_file_bytes(&bytes)
    }));
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
    let base_inventory = take_recursive_inventory(&doc);
    let base_tables = base_inventory.top_tables.clone();
    let base_pics = base_inventory.top_pictures.clone();
    let base_counts = base_inventory.counts();
    let base_para0 = doc.get_paragraph_count_native(0).unwrap_or(0);
    render_smoke(&mut report, &doc, "render_baseline");
    let snap = doc.save_snapshot_native();
    let mut snapshot_valid = true;

    // 문서 재적재 도우미 — panic 으로 오염된 문서를 새로 판다.
    macro_rules! reload_on_panic {
        ($res:expr) => {
            if $res.is_err() {
                if let Ok(Ok(fresh)) = panic::catch_unwind(AssertUnwindSafe(|| {
                    HwpDocument::from_local_file_bytes(&bytes)
                })) {
                    doc = fresh;
                    snapshot_valid = false;
                } else {
                    report.bug("PANIC", "reload", "panic 후 재적재 실패".to_string());
                }
            }
        };
    }

    // Object-domain safety checks run before text/table structural mutations so every recorded
    // path is still the one discovered in the baseline document.
    for loc in base_inventory.page_image_brushes.iter().take(8) {
        let r = page_image_brush_group(&mut report, &mut doc, loc);
        reload_on_panic!(r);
    }
    for loc in base_inventory.top_tables.iter().take(6) {
        let r = table_props_noop_group(&mut report, &mut doc, loc);
        reload_on_panic!(r);
    }
    for loc in base_inventory.top_shapes.iter().take(6) {
        let r = shape_group(&mut report, &mut doc, loc);
        reload_on_panic!(r);
    }
    for loc in base_inventory.nested_visuals.iter().take(8) {
        let r = nested_visual_group(&mut report, &mut doc, loc);
        reload_on_panic!(r);
    }
    // One layer operation per section is enough to exercise the shared stack without turning the
    // diagnostic into a quadratic pagination benchmark.
    let mut layer_sections = std::collections::BTreeSet::new();
    for loc in &base_inventory.layers {
        if layer_sections.insert(loc.sec) {
            let r = layer_group(&mut report, &mut doc, loc);
            reload_on_panic!(r);
        }
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
    let edited_inventory = take_recursive_inventory(&doc);
    let edited_tables = &edited_inventory.top_tables;
    let edited_pics = &edited_inventory.top_pictures;
    let edited_counts = edited_inventory.counts();
    let edited_pages = doc.page_count();
    let export = panic::catch_unwind(AssertUnwindSafe(|| doc.export_hwpx_native()));
    match export {
        Ok(Ok(out_bytes)) => {
            match panic::catch_unwind(AssertUnwindSafe(|| {
                HwpDocument::from_regenerated_bytes(&out_bytes)
            })) {
                Ok(Ok(doc2)) => {
                    let rt_pages = doc2.page_count();
                    if rt_pages != edited_pages {
                        report.bug(
                            "RT_PAGE_DRIFT",
                            "roundtrip",
                            format!("편집본 {edited_pages}쪽 → 재파싱 {rt_pages}쪽"),
                        );
                    }
                    let rt_inventory = take_recursive_inventory(&doc2);
                    let rt_tables = &rt_inventory.top_tables;
                    let rt_pics = &rt_inventory.top_pictures;
                    let dims =
                        |v: &[TableLoc]| v.iter().map(|t| (t.rows, t.cols)).collect::<Vec<_>>();
                    if dims(rt_tables) != dims(edited_tables) {
                        report.bug(
                            "RT_TABLE_MISMATCH",
                            "roundtrip",
                            format!("표 치수 {:?} → {:?}", dims(edited_tables), dims(rt_tables)),
                        );
                    }
                    if rt_pics.len() != edited_pics.len() {
                        report.bug(
                            "RT_PIC_COUNT",
                            "roundtrip",
                            format!("그림 {} → {}", edited_pics.len(), rt_pics.len()),
                        );
                    }
                    let rt_counts = rt_inventory.counts();
                    if rt_counts != edited_counts {
                        report.bug(
                            "RT_RECURSIVE_OBJECT_COUNT",
                            "roundtrip",
                            format!("재귀 개체 수 {edited_counts:?} -> {rt_counts:?}"),
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
                let restored_inventory = take_recursive_inventory(&doc);
                let t2 = &restored_inventory.top_tables;
                let p2 = &restored_inventory.top_pictures;
                let para0 = doc.get_paragraph_count_native(0).unwrap_or(0);
                if pages != base_pages
                    || para0 != base_para0
                    || t2.len() != base_tables.len()
                    || p2.len() != base_pics.len()
                    || restored_inventory.counts() != base_counts
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
            "recursive": {
                "tables": base_inventory.table_count,
                "pictures": base_inventory.picture_count,
                "shapes": base_inventory.shape_count,
                "groups": base_inventory.group_count,
                "nestedTables": base_inventory.nested_table_count,
                "nestedPictures": base_inventory.nested_picture_count,
                "nestedShapes": base_inventory.nested_shape_count,
                "pageImageBrushes": base_inventory.page_image_brush_count,
                "mutablePageImageBrushes": base_inventory.page_image_brushes.len(),
                "mutableNestedVisuals": base_inventory.nested_visuals.len(),
                "floatingLayers": base_inventory.layers.len(),
            },
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::document::Document;
    use crate::model::image::Picture;
    use crate::model::shape::{CommonObjAttr, DrawingObjAttr, GroupShape, RectangleShape, TextBox};
    use crate::model::table::{Cell, Table};

    fn picture_control() -> Control {
        Control::Picture(Box::new(Picture {
            common: CommonObjAttr {
                width: 2400,
                height: 1600,
                ..Default::default()
            },
            ..Default::default()
        }))
    }

    fn one_cell_table(paragraph: Paragraph) -> Table {
        let mut table = Table {
            row_count: 1,
            col_count: 1,
            common: CommonObjAttr {
                width: 6000,
                height: 3000,
                ..Default::default()
            },
            cells: vec![Cell {
                col_span: 1,
                row_span: 1,
                width: 6000,
                height: 3000,
                paragraphs: vec![paragraph],
                ..Default::default()
            }],
            ..Default::default()
        };
        table.rebuild_grid();
        table
    }

    fn install_body_controls(doc: &mut HwpDocument, controls: Vec<Control>) {
        doc.create_blank_document_native().unwrap();
        doc.document.sections[0].paragraphs[0].controls = controls;
        doc.refresh_layout_native();
    }

    #[test]
    fn recursive_inventory_counts_mutable_paths_and_group_children_once() {
        let deep_picture_para = Paragraph {
            controls: vec![picture_control()],
            ..Default::default()
        };
        let nested_shape = Control::Shape(Box::new(ShapeObject::Rectangle(RectangleShape {
            common: CommonObjAttr {
                width: 3000,
                height: 2000,
                ..Default::default()
            },
            drawing: DrawingObjAttr {
                text_box: Some(TextBox {
                    paragraphs: vec![deep_picture_para],
                    ..Default::default()
                }),
                ..Default::default()
            },
            ..Default::default()
        })));
        let nested_table = Control::Table(Box::new(one_cell_table(Paragraph::default())));
        let outer_cell_para = Paragraph {
            controls: vec![picture_control(), nested_shape, nested_table],
            ..Default::default()
        };
        let top_table = Control::Table(Box::new(one_cell_table(outer_cell_para)));
        let nested_group = ShapeObject::Group(GroupShape {
            children: vec![ShapeObject::Picture(Box::new(Picture::default()))],
            ..Default::default()
        });
        let top_group = Control::Shape(Box::new(ShapeObject::Group(GroupShape {
            children: vec![nested_group],
            common: CommonObjAttr {
                width: 4000,
                height: 4000,
                ..Default::default()
            },
            ..Default::default()
        })));

        let mut doc = HwpDocument::create_empty();
        install_body_controls(&mut doc, vec![top_table, top_group]);
        let inventory = take_recursive_inventory(&doc);

        assert_eq!(inventory.top_tables.len(), 1);
        assert_eq!(inventory.top_shapes.len(), 1);
        assert_eq!(inventory.table_count, 2);
        assert_eq!(inventory.picture_count, 3);
        assert_eq!(inventory.shape_count, 4);
        assert_eq!(inventory.group_count, 2);
        assert_eq!(inventory.nested_table_count, 1);
        assert_eq!(inventory.nested_picture_count, 3);
        assert_eq!(inventory.nested_shape_count, 2);
        assert_eq!(inventory.nested_visuals.len(), 3);
        assert_eq!(inventory.layers.len(), 2);
    }

    #[test]
    fn nested_picture_noop_uses_real_path_setter_without_semantic_drift() {
        let outer_cell_para = Paragraph {
            controls: vec![picture_control()],
            ..Default::default()
        };
        let mut doc = HwpDocument::create_empty();
        install_body_controls(
            &mut doc,
            vec![Control::Table(Box::new(one_cell_table(outer_cell_para)))],
        );
        let inventory = take_recursive_inventory(&doc);
        let loc = inventory.nested_visuals.first().unwrap().clone();
        let before = nested_visual_props(&doc, &loc).unwrap();
        let mut report = Report {
            ops: Vec::new(),
            bugs: Vec::new(),
        };

        nested_visual_group(&mut report, &mut doc, &loc).unwrap();

        assert_eq!(report.ops.len(), 1);
        assert!(report.bugs.is_empty(), "{:?}", report.bugs);
        assert_eq!(before, nested_visual_props(&doc, &loc).unwrap());
    }

    #[test]
    fn zero_declared_table_dimensions_still_exercise_property_contract() {
        let mut doc = HwpDocument::create_empty();
        install_body_controls(
            &mut doc,
            vec![Control::Table(Box::new(Table {
                row_count: 0,
                col_count: 0,
                common: CommonObjAttr {
                    width: 6000,
                    height: 3000,
                    ..Default::default()
                },
                cells: vec![Cell {
                    paragraphs: vec![Paragraph::default()],
                    ..Default::default()
                }],
                ..Default::default()
            }))],
        );
        let loc = take_recursive_inventory(&doc).top_tables[0].clone();
        let mut report = Report {
            ops: Vec::new(),
            bugs: Vec::new(),
        };

        table_props_noop_group(&mut report, &mut doc, &loc).unwrap();

        assert_eq!(report.ops.len(), 1);
        assert_eq!(report.ops[0]["name"], "table_props_noop");
        assert!(report.bugs.is_empty(), "{:?}", report.bugs);
    }

    #[test]
    fn layer_roundtrip_restores_the_exact_stack() {
        let mut back = picture_control();
        let mut front = picture_control();
        if let Control::Picture(picture) = &mut back {
            picture.common.z_order = 1;
        }
        if let Control::Picture(picture) = &mut front {
            picture.common.z_order = 2;
        }
        let mut doc = HwpDocument::create_empty();
        install_body_controls(&mut doc, vec![back, front]);
        let loc = take_recursive_inventory(&doc).layers[0].clone();
        let before = layer_signature(&doc, 0);
        let mut report = Report {
            ops: Vec::new(),
            bugs: Vec::new(),
        };

        layer_group(&mut report, &mut doc, &loc).unwrap();

        assert_eq!(report.ops.len(), 1);
        assert!(report.bugs.is_empty(), "{:?}", report.bugs);
        assert_eq!(before, layer_signature(&doc, 0));
    }

    #[test]
    fn inventory_counts_are_stable_across_document_clone() {
        let mut doc = HwpDocument::create_empty();
        install_body_controls(&mut doc, vec![picture_control()]);
        let cloned: Document = doc.document.clone();
        let mut doc2 = HwpDocument::create_empty();
        doc2.set_document(cloned);
        assert_eq!(
            take_recursive_inventory(&doc).counts(),
            take_recursive_inventory(&doc2).counts()
        );
    }

    #[test]
    fn page_image_brush_is_inventoried_without_becoming_a_picture_control() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("samples/issue2816/imgbrush_total_page_fill.hwpx");
        let bytes = std::fs::read(path).unwrap();
        let doc = HwpDocument::from_bytes(&bytes).unwrap();
        let inventory = take_recursive_inventory(&doc);

        assert_eq!(inventory.picture_count, 0);
        assert_eq!(inventory.page_image_brush_count, 1);
        assert_eq!(inventory.page_image_brushes.len(), 1);
        assert_eq!(inventory.page_image_brushes[0].sec, 0);
        assert!(inventory.nested_visuals.is_empty());
    }

    #[test]
    fn page_image_brush_noop_survives_hwpx_roundtrip_and_snapshot_restore() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("samples/issue2816/imgbrush_total_page_fill.hwpx");
        let bytes = std::fs::read(path).unwrap();
        let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
        let loc = take_recursive_inventory(&doc).page_image_brushes[0].clone();
        let before = page_image_brush_state(&doc, loc.sec).unwrap();
        let snapshot = doc.save_snapshot_native();
        let mut report = Report {
            ops: Vec::new(),
            bugs: Vec::new(),
        };

        page_image_brush_group(&mut report, &mut doc, &loc).unwrap();
        assert_eq!(report.ops.len(), 1);
        assert_eq!(report.ops[0]["name"], "pic_page_image_fill_noop");
        assert!(report.bugs.is_empty(), "{:?}", report.bugs);
        assert_eq!(page_image_brush_state(&doc, loc.sec).unwrap(), before);

        let exported = doc.export_hwpx_native().unwrap();
        let reparsed = HwpDocument::from_bytes(&exported).unwrap();
        assert_eq!(page_image_brush_state(&reparsed, loc.sec).unwrap(), before);

        doc.set_page_border_fill_native(loc.sec, r#"{"spacingLeft":1234}"#)
            .unwrap();
        assert_ne!(page_image_brush_state(&doc, loc.sec).unwrap(), before);
        doc.restore_snapshot_native(snapshot).unwrap();
        assert_eq!(page_image_brush_state(&doc, loc.sec).unwrap(), before);
    }
}
