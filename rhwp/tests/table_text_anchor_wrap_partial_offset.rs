//! Para-relative Square RowBreak tables must retain their first-fragment top offset.
//!
//! The Hancom oracle for `table_text_anchor_wrap.hwpx` places the first table fragment at
//! `body_top + vertical_offset + outer_margin_top`. The partial-table path used to start it at
//! `body_top`, overlapping its visible anchor line and fitting too much table content on page 1.

use std::fs;
use std::path::Path;

use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::wasm_api::HwpDocument;

const SAMPLE: &str = "samples/table_text_anchor_wrap.hwpx";

fn find_table(node: &RenderNode, para_index: usize, control_index: usize) -> Option<&RenderNode> {
    if matches!(
        &node.node_type,
        RenderNodeType::Table(table)
            if table.para_index == Some(para_index) && table.control_index == Some(control_index)
    ) {
        return Some(node);
    }
    node.children
        .iter()
        .find_map(|child| find_table(child, para_index, control_index))
}

fn find_body(node: &RenderNode) -> Option<&RenderNode> {
    if matches!(node.node_type, RenderNodeType::Body { .. }) {
        return Some(node);
    }
    node.children.iter().find_map(find_body)
}

#[test]
fn first_partial_square_table_keeps_para_offset_and_outer_top_margin() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {SAMPLE}: {e}"));
    let doc = HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {SAMPLE}: {e:?}"));

    let tree = doc
        .build_page_render_tree(0)
        .expect("build first-page render tree");
    let body = find_body(&tree.root).expect("first-page body");
    let table = find_table(&tree.root, 0, 2).expect("first partial table fragment");

    let body_top = 75.590_551_181_102_36;
    let expected_top = body_top + rhwp::renderer::hwpunit_to_px(1_657 + 283, 96.0);
    assert!(
        (table.bbox.y - expected_top).abs() <= 0.2,
        "first fragment must retain para offset and outer top margin: expected {expected_top:.2}px, actual {:.2}px",
        table.bbox.y
    );
    let table_bottom = table.bbox.y + table.bbox.height;
    let body_bottom = body.bbox.y + body.bbox.height;
    assert!(
        table_bottom <= body_bottom + 0.2,
        "pagination must reserve the same top inset used by layout: table bottom {:.2}px, body bottom {:.2}px",
        table_bottom,
        body_bottom
    );
}

#[test]
fn continuation_defers_a_new_row_when_only_its_padding_would_fit() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {SAMPLE}: {e}"));
    let doc = HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {SAMPLE}: {e:?}"));

    assert_eq!(doc.page_count(), 3, "Hancom oracle page count");
    let tree = doc
        .build_page_render_tree(1)
        .expect("build second-page render tree");
    let body = find_body(&tree.root).expect("second-page body");
    let table = find_table(&tree.root, 0, 2).expect("second partial table fragment");

    let table_bottom = table.bbox.y + table.bbox.height;
    let body_bottom = body.bbox.y + body.bbox.height;
    assert!(
        table_bottom <= body_bottom + 0.2,
        "a continuation must defer the next row when its content budget is exhausted: table bottom {table_bottom:.2}px, body bottom {body_bottom:.2}px",
    );
}
