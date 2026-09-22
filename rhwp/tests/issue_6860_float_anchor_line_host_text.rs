//! [Issue #6860]
#![cfg(not(target_arch = "wasm32"))]

use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::wasm_api::HwpDocument;

const SAMPLE: &str = "samples/issue6860/3067979-road-lighting-photometric-appendix.hwpx";
/// [#5584]
const CONTROL_SAMPLE: &str = "samples/issue5584/float_host_title_above_table.hwpx";

const HOST_LINE_1: &str = "도로조명계산";
const HOST_LINE_2: &str = "국제적으로";

fn read(rel: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read(&path)
        .unwrap_or_else(|error| panic!("fixture 를 읽을 수 없다 ({}): {error}", path.display()))
}

fn document(rel: &str) -> HwpDocument {
    HwpDocument::from_bytes(&read(rel)).expect("문서 로드")
}

fn tree(document: &HwpDocument, page: u32) -> RenderNode {
    document
        .build_page_render_tree(page)
        .unwrap_or_else(|error| panic!("쪽 idx {page} render tree: {error:?}"))
        .root
}

fn column_table_tops(node: &RenderNode, in_column: bool, out: &mut Vec<(f64, f64)>) {
    if in_column {
        if matches!(node.node_type, RenderNodeType::Table(_)) {
            out.push((node.bbox.y, node.bbox.y + node.bbox.height));
            return;
        }
    }
    let in_column = in_column || matches!(node.node_type, RenderNodeType::Column(_));
    for child in &node.children {
        column_table_tops(child, in_column, out);
    }
}

fn line_text(node: &RenderNode, out: &mut String) {
    if let RenderNodeType::TextRun(run) = &node.node_type {
        out.push_str(&run.text);
    }
    for child in &node.children {
        line_text(child, out);
    }
}

fn body_line_bands(node: &RenderNode, needle: &str, in_cell: bool, out: &mut Vec<(f64, f64)>) {
    let in_cell = in_cell || matches!(node.node_type, RenderNodeType::TableCell(_));
    if !in_cell {
        if matches!(node.node_type, RenderNodeType::TextLine(_)) {
            let mut text = String::new();
            line_text(node, &mut text);
            if text.contains(needle) {
                out.push((node.bbox.y, node.bbox.y + node.bbox.height));
            }
            return;
        }
    }
    for child in &node.children {
        body_line_bands(child, needle, in_cell, out);
    }
}

fn find_lines(document: &HwpDocument, page: u32, needle: &str) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    body_line_bands(&tree(document, page), needle, false, &mut out);
    out
}

fn column_flow_boxes(node: &RenderNode, in_column: bool, out: &mut Vec<(f64, f64, &'static str)>) {
    if in_column {
        let kind = match node.node_type {
            RenderNodeType::Table(_) => Some("표"),
            RenderNodeType::TextLine(_) => Some("줄"),
            _ => None,
        };
        if let Some(kind) = kind {
            out.push((node.bbox.y, node.bbox.y + node.bbox.height, kind));
            return;
        }
    }
    let in_column = in_column || matches!(node.node_type, RenderNodeType::Column(_));
    for child in &node.children {
        column_flow_boxes(child, in_column, out);
    }
}

fn body_bounds(node: &RenderNode) -> Option<(f64, f64)> {
    if matches!(node.node_type, RenderNodeType::Body { .. }) {
        return Some((node.bbox.y, node.bbox.y + node.bbox.height));
    }
    node.children.iter().find_map(body_bounds)
}

/// 쪽 수는 걸지 않는다. 이 fixture 는 절단본이라 rhwp(저장 `vertpos` 추종)와
/// 한글(절단본 재조판)의 절대 좌표가 다르다.
#[test]
fn no_flow_item_overflows_the_body() {
    let document = document(SAMPLE);
    for page in 0..document.page_count() {
        let root = tree(&document, page);
        let (body_top, body_bottom) = body_bounds(&root).expect("Body");
        let mut boxes = Vec::new();
        column_flow_boxes(&root, false, &mut boxes);
        for (top, bottom, kind) in boxes {
            assert!(
                top >= body_top - 0.5 && bottom <= body_bottom + 0.5,
                "쪽 {page} 의 {kind} 이 본문({body_top:.1}..{body_bottom:.1}) 밖이다 — \
                 {top:.1}..{bottom:.1}"
            );
        }
    }
}

#[test]
fn host_lines_render_above_the_float_table() {
    let document = document(SAMPLE);

    let mut tables = Vec::new();
    column_table_tops(&tree(&document, 0), false, &mut tables);
    assert_eq!(
        tables.len(),
        1,
        "1쪽에는 자리차지 표 하나가 시작해야 한다 — got {tables:?}"
    );
    let table_top = tables[0].0;

    for needle in [HOST_LINE_1, HOST_LINE_2] {
        let lines = find_lines(&document, 0, needle);
        assert_eq!(
            lines.len(),
            1,
            "호스트 줄 {needle:?} 이 1쪽에 정확히 한 번 있어야 한다 — \
             회귀 시 0개(2쪽으로 밀림). got {lines:?}"
        );
        let (top, bottom) = lines[0];
        assert!(
            bottom <= table_top + 0.5,
            "호스트 줄 {needle:?} 은 표 위에서 끝나야 한다 — \
             줄 {top:.1}..{bottom:.1}, 표 상단 {table_top:.1}"
        );
    }
}

#[test]
fn host_lines_are_not_deferred_behind_the_last_fragment() {
    let document = document(SAMPLE);
    for needle in [HOST_LINE_1, HOST_LINE_2] {
        let lines = find_lines(&document, 1, needle);
        assert!(
            lines.is_empty(),
            "2쪽(마지막 표 조각)에 호스트 줄 {needle:?} 이 남았다 — \
             회귀 시 y=1064.2 / 1085.5 로 그려진다. got {lines:?}"
        );
    }
}

#[test]
fn host_lines_stay_inside_the_body() {
    let document = document(SAMPLE);
    let root = tree(&document, 0);
    let (body_top, body_bottom) = body_bounds(&root).expect("1쪽 Body");

    for needle in [HOST_LINE_1, HOST_LINE_2] {
        let lines = find_lines(&document, 0, needle);
        let (top, bottom) = lines
            .first()
            .copied()
            .unwrap_or_else(|| panic!("호스트 줄 {needle:?} 이 1쪽에 없다"));
        assert!(
            top >= body_top - 0.5 && bottom <= body_bottom + 0.5,
            "호스트 줄 {needle:?} 이 본문({body_top:.1}..{body_bottom:.1}) 밖이다 — \
             {top:.1}..{bottom:.1}"
        );
    }
}

/// [#5584]
#[test]
fn single_line_host_control_still_renders_above_the_table() {
    let document = document(CONTROL_SAMPLE);

    let mut tables = Vec::new();
    column_table_tops(&tree(&document, 0), false, &mut tables);
    assert!(
        !tables.is_empty(),
        "#5584 통제군 1쪽에 자리차지 표가 있어야 한다"
    );
    let table_top = tables.iter().map(|t| t.0).fold(f64::INFINITY, f64::min);

    let lines = find_lines(&document, 0, "취업취약계층");
    assert_eq!(
        lines.len(),
        1,
        "#5584 제목이 1쪽에 있어야 한다 — got {lines:?}"
    );
    assert!(
        lines[0].1 <= table_top + 0.5,
        "#5584 제목이 표 위에서 끝나야 한다 — 줄 {:.1}..{:.1}, 표 상단 {table_top:.1}",
        lines[0].0,
        lines[0].1
    );
}
