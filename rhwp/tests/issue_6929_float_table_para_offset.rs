#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const SAMPLE: &str = "samples/issue6929/148776468_search_ad_terms_press_release.hwp";

const ORACLE_TABLE_TOP: f64 = 100.2;
const ORACLE_TITLE_TOP: f64 = 268.2;
const TITLE: &str = "인터넷포털 검색광고서비스";

fn page0(sample: &str) -> RenderNode {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(sample);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("재현체 {}: {e}", path.display()));
    let core = DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("로드 {sample}: {e}"));
    core.build_page_render_tree(0)
        .unwrap_or_else(|e| panic!("렌더 {sample}: {e}"))
        .root
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

fn head_table(node: &RenderNode, out: &mut Option<(f64, f64)>) {
    if !node.visible || node.editor_only {
        return;
    }
    if matches!(node.node_type, RenderNodeType::Table(_)) {
        let top = node.bbox.y;
        if out.is_none_or(|(cur, _)| top < cur) {
            *out = Some((top, top + node.bbox.height));
        }
        return;
    }
    for c in &node.children {
        head_table(c, out);
    }
}

fn title_top(node: &RenderNode, out: &mut Option<f64>) {
    if !node.visible || node.editor_only {
        return;
    }
    if matches!(node.node_type, RenderNodeType::TextLine(_)) && line_text(node).contains(TITLE) {
        if out.is_none_or(|cur| node.bbox.y < cur) {
            *out = Some(node.bbox.y);
        }
        return;
    }
    for c in &node.children {
        title_top(c, out);
    }
}

#[test]
fn para_relative_float_table_starts_at_its_declared_offset() {
    let root = page0(SAMPLE);
    let mut table = None;
    head_table(&root, &mut table);
    let (top, _) = table.expect("1쪽 머리 표를 못 찾았습니다");
    assert!(
        (top - ORACLE_TABLE_TOP).abs() <= 1.0,
        "머리 표 상단이 정본과 다릅니다 — 정본 {ORACLE_TABLE_TOP:.1} · 현재 {top:.1} \
         (저장 vertOffset 433 HU = 5.77px, 본문 상단 94.5)"
    );
}

#[test]
fn the_head_table_does_not_reach_into_the_title() {
    let root = page0(SAMPLE);
    let mut table = None;
    head_table(&root, &mut table);
    let (_, bottom) = table.expect("1쪽 머리 표를 못 찾았습니다");
    let mut title = None;
    title_top(&root, &mut title);
    let title = title.expect("제목 문단을 못 찾았습니다");

    assert!(
        (title - ORACLE_TITLE_TOP).abs() <= 1.0,
        "제목 상단이 정본과 다릅니다 — 정본 {ORACLE_TITLE_TOP:.1} · 현재 {title:.1}"
    );
    assert!(
        bottom <= title + 0.5,
        "표 아래끝이 제목을 {:.1}px 침범합니다 — 표 바닥 {bottom:.1} · 제목 상단 {title:.1}",
        bottom - title
    );
}

#[test]
fn visible_host_title_still_pushes_its_float_table_down() {
    let root = page0("samples/issue1549_multipositive_float_tables.hwpx");
    let mut title = None;
    title_top_of(&root, "MULTI POSITIVE TITLE", &mut title);
    let title = title.expect("host 제목을 못 찾았습니다");
    let mut table = None;
    head_table(&root, &mut table);
    let (top, _) = table.expect("자리차지 표를 못 찾았습니다");
    assert!(
        top > title,
        "보이는 host 제목이 있으면 표가 그 아래여야 합니다 — 제목 {title:.1} · 표 {top:.1}"
    );
}

fn title_top_of(node: &RenderNode, needle: &str, out: &mut Option<f64>) {
    if !node.visible || node.editor_only {
        return;
    }
    if matches!(node.node_type, RenderNodeType::TextLine(_)) && line_text(node).contains(needle) {
        if out.is_none_or(|cur| node.bbox.y < cur) {
            *out = Some(node.bbox.y);
        }
        return;
    }
    for c in &node.children {
        title_top_of(c, needle, out);
    }
}
