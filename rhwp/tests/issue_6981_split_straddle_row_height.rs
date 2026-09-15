//! [#6981] 조각 경계가 rowspan 블록 안쪽이면 이어받는 조각의 걸친 셀이 제 높이를 받는다.
//!
//! # 무엇이 깨져 있었나
//!
//! 조각 경계가 rowspan 블록 안쪽에 떨어지면, 이어받는 조각의 걸친 셀은 `#1748` 의
//! 높이-컷으로 **남은 유닛 전부**를 받는다. 그런데 그 셀이 덮는 행들의 높이는 같은 행의
//! `row_span==1` 셀만 보고 정해진다. 어긋난 만큼 clip 이 글자를 지운다 — 렌더 트리에는
//! 정상 좌표로 있는데 화면에 한 자도 안 나간다.
//!
//! `samples/task2287/1342000_edu_curriculum_map.hwp` 377쪽, 셀 `(62,8) row_span=2`:
//!
//! ```text
//!   저장: 셀 3882 HU = 51.76px · 여백 141 HU = 1.88px · 문단 3개 vpos 0·1300·2600 HU
//!         내용 바닥 48.00px + 1.88 = 49.88 = 51.76 − 1.88   ← 온전하면 딱 맞는다
//!   그리드 행 62 = 30.65px · 행 63 = 21.11px
//!         앞 조각(30.65px)에 문단 1개, 이어받는 조각(21.11px)에 문단 2개(32.55px 필요)
//!         → `• 선언문 작성` 이 11.4px 밖 → 사라짐
//! ```
//!
//! 조판·렌더가 같은 출처(`straddle_continuation_demand`)를 쓰지 않으면 목표 문구가
//! 칸 밖으로 나가거나, 조각이 본문을 넘거나, 최종 컷 뒤에 빈 쪽이 생긴다.
#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

/// 자기 칸 상자 아래로 내려간 글줄 — 이 결함이 화면에서 글자를 지우는 그 모양이다.
fn lines_outside_their_cell(node: &RenderNode, cell_bottom: Option<f64>, out: &mut Vec<String>) {
    if !node.visible || node.editor_only {
        return;
    }
    let mut bottom = cell_bottom;
    if matches!(node.node_type, RenderNodeType::TableCell(_)) {
        bottom = Some(node.bbox.y + node.bbox.height);
    }
    if matches!(node.node_type, RenderNodeType::TextLine(_)) {
        if let Some(limit) = bottom {
            let text = line_text(node);
            if !text.trim().is_empty() && node.bbox.y + node.bbox.height > limit + 0.5 {
                out.push(text);
            }
        }
    }
    for child in &node.children {
        lines_outside_their_cell(child, bottom, out);
    }
}

fn line_text(node: &RenderNode) -> String {
    let mut s = String::new();
    if let RenderNodeType::TextRun(run) = &node.node_type {
        s.push_str(run.display_or_text());
    }
    for c in &node.children {
        s.push_str(&line_text(c));
    }
    s
}

fn fixture_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/task2287/1342000_edu_curriculum_map.hwp")
}

fn escaped_lines(path: &Path, page: u32) -> Vec<String> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("재현체 {}: {e}", path.display()));
    let core = DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("로드: {e}"));
    let tree = core
        .build_page_render_tree(page)
        .unwrap_or_else(|e| panic!("렌더 p{page}: {e}"));
    let mut out = Vec::new();
    lines_outside_their_cell(&tree.root, None, &mut out);
    out
}

const NEEDLE: &str = "선언문 작성";

/// 쪽 번호에 묶지 않고 전 쪽을 훑는다.
///
/// `선언문 작성` 은 이 문서에 **여러 번** 나온다(정본 273·287·378쪽). 첫 하나만 보면
/// 멀쩡한 쪽을 집어 판정이 뒤집히므로 **모든 출현**을 본다.
fn all_occurrences(path: &Path, needle: &str) -> Vec<(u32, f64, f64)> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("재현체 {}: {e}", path.display()));
    let core = DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("로드: {e}"));
    let mut out = Vec::new();
    for page in 0..core.page_count() {
        let Ok(tree) = core.build_page_render_tree(page) else {
            continue;
        };
        let mut found = Vec::new();
        locate(&tree.root, None, needle, &mut found);
        for (line_bottom, cell_bottom) in found {
            out.push((page, line_bottom, cell_bottom));
        }
    }
    out
}

fn locate(node: &RenderNode, cell_bottom: Option<f64>, needle: &str, out: &mut Vec<(f64, f64)>) {
    if !node.visible || node.editor_only {
        return;
    }
    let mut bottom = cell_bottom;
    if matches!(node.node_type, RenderNodeType::TableCell(_)) {
        bottom = Some(node.bbox.y + node.bbox.height);
    }
    if matches!(node.node_type, RenderNodeType::TextLine(_)) && line_text(node).contains(needle) {
        if let Some(limit) = bottom {
            out.push((node.bbox.y + node.bbox.height, limit));
            return;
        }
    }
    for child in &node.children {
        locate(child, bottom, needle, out);
    }
}

#[test]
fn no_occurrence_of_the_line_escapes_its_cell() {
    let path = fixture_path();
    let found = all_occurrences(&path, NEEDLE);
    assert!(
        found.len() >= 3,
        "`{NEEDLE}` 출현이 {}건뿐입니다 — 검사 대상이 비었습니다",
        found.len()
    );
    let escaped: Vec<_> = found
        .iter()
        .filter(|(_, line_bottom, cell_bottom)| *line_bottom > *cell_bottom + 0.5)
        .collect();
    assert!(
        escaped.is_empty(),
        "`{NEEDLE}` 줄이 자기 칸 밖입니다(clip 이 지운다) — (쪽0based, 줄바닥, 칸바닥) {escaped:?}"
    );
}

/// 그 쪽 전체에도 칸 밖 글줄이 없어야 한다 — 한 줄만 밀어 넣고 다른 줄을 밀어내면 안 된다.
#[test]
fn the_pages_that_carry_it_have_no_escaped_line() {
    let path = fixture_path();
    for (page, _, _) in all_occurrences(&path, NEEDLE) {
        let escaped = escaped_lines(&path, page);
        assert!(
            escaped.is_empty(),
            "{page}쪽(0-based)에 칸 밖으로 나간 글줄이 있습니다: {escaped:?}"
        );
    }
}

/// 원본의 section 28 / 표 문단을 보존한 내부 IR 계약 입력이다.
/// 별도로 한컴에서 저장하거나 PDF로 변환한 축소 문서가 아니다.
fn isolated_curriculum_table() -> rhwp::model::document::Document {
    let path = fixture_path();
    let bytes = std::fs::read(&path).expect("committed curriculum fixture");
    let core = DocumentCore::from_bytes(&bytes).expect("parse curriculum fixture");
    let mut doc = core.document().clone();
    let table_matches = |table: &rhwp::model::table::Table| {
        table.row_count == 83
            && table.cells.iter().any(|cell| {
                cell.row == 62
                    && cell.col == 8
                    && cell.row_span == 2
                    && cell
                        .paragraphs
                        .iter()
                        .any(|para| para.text.contains("선언문"))
            })
    };
    let section = doc.sections[28].clone();
    let paragraph = section.paragraphs[2].clone();
    assert!(
        paragraph.controls.iter().any(|control| {
            matches!(
                control,
                rhwp::model::control::Control::Table(table) if table_matches(table)
            )
        }),
        "fixture source table contract changed"
    );
    doc.sections = vec![section];
    doc.sections[0].paragraphs = vec![paragraph];
    doc
}

fn assert_tables_inside_body(node: &RenderNode, body_bottom: Option<f64>) {
    if !node.visible || node.editor_only {
        return;
    }
    let body_bottom = if matches!(node.node_type, RenderNodeType::Body { .. }) {
        Some(node.bbox.y + node.bbox.height)
    } else {
        body_bottom
    };
    if matches!(node.node_type, RenderNodeType::Table(_)) {
        if let Some(bottom) = body_bottom {
            assert!(
                node.bbox.y + node.bbox.height <= bottom + 0.5,
                "table bottom {} exceeds body bottom {bottom}",
                node.bbox.y + node.bbox.height
            );
        }
    }
    for child in &node.children {
        assert_tables_inside_body(child, body_bottom);
    }
}

fn assert_continuation_document(
    doc: rhwp::model::document::Document,
    check_needle_body: bool,
) -> u32 {
    let mut core = DocumentCore::new_empty();
    core.set_document(doc);
    let mut occurrences = Vec::new();
    for page in 0..core.page_count() {
        let tree = core
            .build_page_render_tree(page)
            .expect("render every fragment");
        let mut found = Vec::new();
        locate(&tree.root, None, NEEDLE, &mut found);
        // 기본 입력의 이어받는 바늘 조각은 본문 안에 있어야 한다. 여백을 조인
        // 변형은 이 엔진의 기존 13px 하단 압축으로 본문을 넘길 수 있어 칸 경계만 잠근다.
        if check_needle_body && !found.is_empty() {
            assert_tables_inside_body(&tree.root, None);
        }
        occurrences.extend(found);
    }
    assert_eq!(occurrences.len(), 1, "continuation text lost or duplicated");
    assert!(
        occurrences.iter().all(|(line, cell)| *line <= *cell + 0.5),
        "continuation line must remain inside its cell: {occurrences:?}"
    );
    core.page_count()
}

/// PR 원안은 시작 컷에서 이미 소비한 유닛을 재예약해 p3 본문을 4.213px 넘었다.
#[test]
fn consumed_start_cut_does_not_grow_the_fragment_past_the_body() {
    assert_eq!(
        assert_continuation_document(isolated_curriculum_table(), true),
        4
    );
}

/// 본문 예산을 바꿔 쪽수 전환을 강제한다. 이 엔진은 13px 하단 압축이
/// 상류 ±20px(1500 HU) 변화를 흡수해 쪽수가 그대로라, 같은 41점을 더 넓은
/// 여백에서 검사한다.
#[test]
fn continuation_height_respects_varying_page_budgets() {
    let source = isolated_curriculum_table();
    let mut counts = std::collections::BTreeSet::new();
    for delta_hu in (-15000i32..=15000).step_by(750) {
        let mut doc = source.clone();
        let page = &mut doc.sections[0].section_def.page_def;
        page.margin_bottom = (page.margin_bottom as i32 + delta_hu) as u32;
        counts.insert(assert_continuation_document(doc, false));
    }
    assert!(
        counts.len() > 1,
        "budget variants must exercise a page break transition, got {counts:?}"
    );
}

/// 한컴 2022 기준 PDF p83에는 전남부터 제주까지의 조례가 함께 있다.
/// 앞 쪽에서 소비한 빈 행 밴드를 내용 컷만으로 재계산하면 이 행들이 밀려난다.
#[test]
fn physical_blank_band_is_not_reserved_again_on_continuation() {
    let path = fixture_path();
    let bytes = std::fs::read(&path).expect("committed curriculum fixture");
    let core = DocumentCore::from_bytes(&bytes).expect("parse curriculum fixture");
    let page = {
        let tree = core.build_page_render_tree(82).expect("render page 83");
        if line_text(&tree.root).contains("전라남도교육청") {
            82
        } else {
            (0..core.page_count())
                .find(|&page| {
                    let tree = core
                        .build_page_render_tree(page)
                        .unwrap_or_else(|e| panic!("render page {page}: {e}"));
                    line_text(&tree.root).contains("전라남도교육청")
                })
                .expect("Jeonnam ordinance missing from document")
        }
    };
    let tree = core
        .build_page_render_tree(page)
        .expect("render Jeonnam continuation page");
    let text = line_text(&tree.root);
    assert!(
        text.contains("전라남도교육청"),
        "Jeonnam ordinance moved out of the continuation page"
    );
    assert!(
        text.contains("제주특별자치도교육청"),
        "Jeju ordinance moved out of the continuation page"
    );
    assert_tables_inside_body(&tree.root, None);
}

/// 최종 컷 뒤에 내용 없는 페이지를 할당하면 378쪽에는 쪽 번호만 남는다.
/// 마지막 표의 글자는 앞 쪽에 남고, 다음 구역 본문은 빈 쪽 없이 이어져야 한다.
#[test]
fn completed_terminal_cut_does_not_allocate_an_empty_page() {
    let path = fixture_path();
    let bytes = std::fs::read(&path).expect("committed curriculum fixture");
    let core = DocumentCore::from_bytes(&bytes).expect("parse curriculum fixture");
    let successor = if core.page_count() > 377 {
        377
    } else {
        let mut last_needle_page = None;
        for page in 0..core.page_count() {
            let tree = core
                .build_page_render_tree(page)
                .unwrap_or_else(|e| panic!("render page {page}: {e}"));
            if line_text(&tree.root).contains(NEEDLE) {
                last_needle_page = Some(page);
            }
        }
        let last = last_needle_page.expect("선언문 작성 occurrence");
        (last + 1..core.page_count())
            .find(|&page| {
                let tree = core
                    .build_page_render_tree(page)
                    .unwrap_or_else(|e| panic!("render page {page}: {e}"));
                line_text(&tree.root).contains("노동인권")
            })
            .unwrap_or(last)
    };
    let tree = core
        .build_page_render_tree(successor)
        .expect("render successor page");
    fn body_has_text(node: &RenderNode) -> bool {
        if matches!(node.node_type, RenderNodeType::Body { .. }) {
            return !line_text(node).trim().is_empty();
        }
        node.children.iter().any(body_has_text)
    }
    assert!(
        body_has_text(&tree.root),
        "completed row cut left an empty successor page"
    );
    assert!(
        line_text(&tree.root).contains("노동인권"),
        "next section must follow the completed table"
    );
}
