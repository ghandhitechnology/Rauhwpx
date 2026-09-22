//! 저장 페이지 경계로 나뉜 가운데 정렬 행의 선언 높이와 가시 내용 보존.

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

fn split_cell(node: &RenderNode) -> Option<&RenderNode> {
    if matches!(&node.node_type, RenderNodeType::TableCell(cell)
        if cell.row == 6 && cell.col == 1 && cell.model_cell_index == Some(11))
    {
        return Some(node);
    }
    node.children.iter().find_map(split_cell)
}

fn collect_text(node: &RenderNode, text: &mut String, tops: &mut Vec<f64>) {
    if let RenderNodeType::TextRun(run) = &node.node_type {
        text.push_str(&run.text);
        if !run.text.trim().is_empty() {
            tops.push(node.bbox.y);
        }
    }
    for child in &node.children {
        collect_text(child, text, tops);
    }
}

#[test]
fn saved_reset_row_preserves_both_fragment_heights_and_centered_text() {
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/inner-table-01.hwp"),
    )
    .expect("fixture");
    let core = DocumentCore::from_bytes(&bytes).expect("parse");
    assert_eq!(core.page_count(), 2);
    let first = core.build_page_render_tree(0).expect("first page");
    let next = core.build_page_render_tree(1).expect("continuation page");
    let a = split_cell(&first.root).expect("first fragment");
    let b = split_cell(&next.root).expect("continuation fragment");
    let declared = 48_776.0 / 75.0;
    assert!(
        (a.bbox.height + b.bbox.height - declared).abs() < 0.1,
        "분할 후에도 저장된 행 높이 {declared}를 보존해야 한다: {} + {}",
        a.bbox.height,
        b.bbox.height
    );
    assert!(a.bbox.height > 450.0 && b.bbox.height > 180.0);

    let mut text = String::new();
    let mut tops = Vec::new();
    collect_text(b, &mut text, &mut tops);
    assert!(text.contains("전사 데이터 수집/유통체계 구축"));
    assert!(text.contains("SaaS 갤러리"));
    let first_text_y = tops.into_iter().fold(f64::INFINITY, f64::min);
    assert!(
        first_text_y > b.bbox.y + 25.0,
        "연속 조각도 가운데 정렬을 유지해야 한다"
    );
    let mut whole_text = String::new();
    collect_text(&next.root, &mut whole_text, &mut Vec::new());
    assert!(
        whole_text.contains("SFR-SAAS-009"),
        "다음 행의 중첩 표도 보여야 한다"
    );
}
