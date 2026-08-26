//! Issue #2004 잔여: 부동 표 셀 이미지 스택 콘텐츠 페이지네이션 회귀 테스트.
//!
//! `samples/issue2004_cell_image_stack.hwp(x)` — 1×1 RowBreak 부동 표(자리차지,
//! tac=false) 셀에 전면급 Square 부동 이미지 5장이 varying offset으로 스택된 문서.
//! 수정 전에는 셀 측정이 저장 높이(871.9px)에 머물러 표가 원자 배치되고 이미지
//! 5장이 한 쪽에 겹쳐 4쪽으로 렌더됐다.
//!
//! 수정: 정규화(`compute_render_normalized`)에서 셀 스택을 이미지 1장짜리 inline
//! 문단 N개로 분할하고 각 문단에 이미지 높이 합성 line_seg를 부여 → 셀 측정이
//! 스택 총높이(4310.6px)를 반영, 기존 RowBreak 분할 스캔에 자연 진입해 쪽당
//! 이미지 1장씩 배치된다.
//!
//! 기대값 8쪽 = 한글 2022 편집기 출력(`pdf/issue2004_cell_image_stack-2022.pdf`,
//! 8쪽: p1~p3 본문, p4~p8 프레임 이미지 1장씩).

use std::fs;
use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

fn page_count_of(rel: &str) -> u32 {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(repo_root).join(rel);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("parse {}: {:?}", rel, e));
    doc.page_count()
}

fn target_table_node(node: &RenderNode) -> Option<&RenderNode> {
    if let RenderNodeType::Table(table) = &node.node_type {
        if table.para_index == Some(42) && table.control_index == Some(0) {
            return Some(node);
        }
    }
    node.children.iter().find_map(target_table_node)
}

fn body_y(node: &RenderNode) -> Option<f64> {
    if matches!(node.node_type, RenderNodeType::Body { .. }) {
        return Some(node.bbox.y);
    }
    node.children.iter().find_map(body_y)
}

fn image_bboxes(node: &RenderNode, out: &mut Vec<(f64, f64, f64, f64)>) {
    if matches!(node.node_type, RenderNodeType::Image(_)) {
        out.push((node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height));
    }
    for child in &node.children {
        image_bboxes(child, out);
    }
}

#[test]
fn cell_image_stack_hwp_paginates_to_8_pages() {
    let pages = page_count_of("samples/issue2004_cell_image_stack.hwp");
    assert_eq!(
        pages, 8,
        "issue2004 HWP5 8쪽 기대(한글 2022 정답지). 실측 {}p — 4p면 부동 표 셀 \
         이미지 스택 미분할(#2004), 9p+면 과분할 회귀.",
        pages
    );
}

#[test]
fn cell_image_stack_hwpx_paginates_to_8_pages() {
    let pages = page_count_of("samples/issue2004_cell_image_stack.hwpx");
    assert_eq!(
        pages, 8,
        "issue2004 HWPX 8쪽 기대(한글 2022 정답지). 실측 {}p — 4p면 부동 표 셀 \
         이미지 스택 미분할(#2004), 9p+면 과분할 회귀.",
        pages
    );
}

#[test]
fn cell_image_stack_continuations_repeat_authored_outer_top() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/issue2004_cell_image_stack.hwp");
    let bytes = fs::read(&path).expect("read #2004 fixture");
    let core = DocumentCore::from_bytes(&bytes).expect("parse #2004 fixture");
    let expected_outer_top = 283.0 * 96.0 / 7200.0;
    let expected_image_x = [107.2, 114.1, 106.8, 105.3];

    for page_index in 4..=7 {
        let tree = core
            .build_page_render_tree(page_index)
            .unwrap_or_else(|error| panic!("render page {}: {error}", page_index + 1));
        let body_top = body_y(&tree.root).expect("body bbox");
        let table = target_table_node(&tree.root).expect("#2004 continuation table");
        let table_top = table.bbox.y;
        assert!(
            (table_top - body_top - expected_outer_top).abs() <= 0.15,
            "page {} continuation must reopen the authored 283HU outer-top: \
             body={body_top:.2}, table={table_top:.2}",
            page_index + 1
        );

        let mut images = Vec::new();
        image_bboxes(table, &mut images);
        assert_eq!(
            images.len(),
            1,
            "page {} must contain only the signed-offset inline image, not the unshifted fallback: {images:?}",
            page_index + 1
        );
        assert!(
            (images[0].0 - expected_image_x[page_index as usize - 4]).abs() <= 0.15,
            "page {} picture x must preserve its authored signed horizontal offset: {:?}",
            page_index + 1,
            images[0]
        );
        assert!(
            (images[0].1 - (table_top + 1.0)).abs() <= 0.15,
            "page {} picture y must remain rebased to the fragment content top: {:?}",
            page_index + 1,
            images[0]
        );
    }
}
