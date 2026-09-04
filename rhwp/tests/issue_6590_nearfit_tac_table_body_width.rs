#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const SAMPLE: &str = "samples/basic/BlogForm_BookReview.hwp";
const NEAR_FIT_MIN_RATIO: f64 = 0.9;

struct NearfitTacRender {
    width: f64,
    right: f64,
}

fn body_metrics(core: &DocumentCore) -> (u32, f64, f64) {
    let page_def = &core.document().sections[0].section_def.page_def;
    let body_width = page_def
        .width
        .saturating_sub(page_def.margin_left)
        .saturating_sub(page_def.margin_right);
    let body_width_px =
        rhwp::renderer::hwpunit_to_px(body_width as i32, rhwp::renderer::DEFAULT_DPI);
    let body_right = rhwp::renderer::hwpunit_to_px(
        (page_def.width - page_def.margin_right) as i32,
        rhwp::renderer::DEFAULT_DPI,
    );
    (body_width, body_width_px, body_right)
}

fn nearfit_tac_keys(core: &DocumentCore, body_width: u32) -> Vec<(usize, usize)> {
    let mut keys = Vec::new();
    for (para_index, paragraph) in core.document().sections[0].paragraphs.iter().enumerate() {
        for (control_index, control) in paragraph.controls.iter().enumerate() {
            let Control::Table(table) = control else {
                continue;
            };
            let source_width = table.common.width;
            if table.common.treat_as_char
                && body_width > 0
                && source_width > body_width
                && f64::from(body_width) >= f64::from(source_width) * NEAR_FIT_MIN_RATIO
            {
                keys.push((para_index, control_index));
            }
        }
    }
    keys
}

fn collect_nearfit_renders(
    node: &RenderNode,
    keys: &[(usize, usize)],
    out: &mut Vec<NearfitTacRender>,
) {
    if let RenderNodeType::Table(table) = &node.node_type {
        if let (Some(para_index), Some(control_index)) = (table.para_index, table.control_index) {
            if keys.contains(&(para_index, control_index)) {
                out.push(NearfitTacRender {
                    width: node.bbox.width,
                    right: node.bbox.x + node.bbox.width,
                });
            }
        }
    }
    for child in &node.children {
        collect_nearfit_renders(child, keys, out);
    }
}

fn load_nearfit_tac_renders() -> (Vec<NearfitTacRender>, f64, f64) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let bytes = std::fs::read(path).expect("read sample");
    let core = DocumentCore::from_bytes(&bytes).expect("parse");
    let (body_width, body_width_px, body_right) = body_metrics(&core);
    let keys = nearfit_tac_keys(&core, body_width);
    assert!(
        !keys.is_empty(),
        "표본에 본문 폭을 근소 초과하는 최상위 TAC 표가 있어야 한다"
    );
    let tree = core.build_page_render_tree(0).expect("render page 1");
    let mut renders = Vec::new();
    collect_nearfit_renders(&tree.root, &keys, &mut renders);
    assert_eq!(
        renders.len(),
        keys.len(),
        "근소 초과 TAC 표 {}개가 렌더 트리에 있어야 한다",
        keys.len()
    );
    (renders, body_width_px, body_right)
}

#[test]
fn nearfit_tac_table_is_scaled_into_body_width() {
    let (renders, _, body_right) = load_nearfit_tac_renders();
    for table in &renders {
        assert!(
            table.right <= body_right + 0.5,
            "본문 폭을 근소 초과하는 TAC 표는 본문 폭으로 축소돼야 한다 \
             (표 우단 {:.1}px > 본문 우단 {body_right:.1}px)",
            table.right
        );
    }
}

#[test]
fn table_within_body_width_keeps_declared_width() {
    let (renders, body_width_px, _) = load_nearfit_tac_renders();
    for table in &renders {
        assert!(
            table.width >= body_width_px - 1.0,
            "축소는 본문 폭까지만. 표 폭 {:.1}px 이 본문 폭 {body_width_px:.1}px 보다 작다",
            table.width
        );
    }
}
