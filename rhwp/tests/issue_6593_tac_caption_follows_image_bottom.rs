//! Bottom captions on Treat-As-Char pictures attach to the drawn picture-box
//! bottom. A stored lineseg taller than the picture used to place them on
//! `pic_y + baseline` and overflow the line.
#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const SAMPLE: &str = "samples/issue6575/tac_picture_line_top.hwpx";
const TARGET_WIDTH_PX: f64 = 557.25;
const CAPTION_NEEDLE: &str = "환경위성센터 누리집 주요 화면";
const PIC_H_HU: f64 = 15425.0;
const BASELINE_HU: f64 = 18050.0;
const LINE_H_HU: f64 = 21235.0;
const CAPTION_GAP_HU: f64 = 850.0;
const CAPTION_FIRST_LINE_VERTPOS_HU: f64 = 500.0;
const TOLERANCE_PX: f64 = 3.0;

fn hu_px(hu: f64) -> f64 {
    hu * 96.0 / 7200.0
}

fn walk_image(node: &RenderNode, image: &mut Option<(f64, f64)>) {
    if matches!(node.node_type, RenderNodeType::Image(_))
        && (node.bbox.width - TARGET_WIDTH_PX).abs() < 1.0
    {
        *image = Some((node.bbox.y, node.bbox.y + node.bbox.height));
    }
    for child in &node.children {
        walk_image(child, image);
    }
}

fn walk_caption(
    node: &RenderNode,
    img_bottom: f64,
    caption_ys: &mut Vec<f64>,
    caption_bottoms: &mut Vec<f64>,
) {
    if let RenderNodeType::TextRun(tr) = &node.node_type {
        if tr.text.contains(CAPTION_NEEDLE) {
            caption_ys.push(node.bbox.y);
        }
        if node.bbox.y > img_bottom - 1.0
            && node.bbox.y < img_bottom + hu_px(LINE_H_HU)
            && node.bbox.height < 40.0
        {
            caption_bottoms.push(node.bbox.y + node.bbox.height);
        }
    }
    for child in &node.children {
        walk_caption(child, img_bottom, caption_ys, caption_bottoms);
    }
}

#[test]
fn bottom_caption_of_tac_picture_starts_right_below_the_drawn_picture() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let core = DocumentCore::from_bytes(&std::fs::read(path).expect("read sample")).expect("open");
    let tree = core.build_page_render_tree(0).expect("page 1 render tree");

    let mut image = None;
    walk_image(&tree.root, &mut image);
    let (img_y, img_bottom) = image.expect("폭 557.25px TAC 그림이 있어야 한다");

    let mut caption_ys = Vec::new();
    let mut caption_bottoms = Vec::new();
    walk_caption(
        &tree.root,
        img_bottom,
        &mut caption_ys,
        &mut caption_bottoms,
    );
    assert_eq!(
        caption_ys.len(),
        1,
        "캡션 글줄 `{CAPTION_NEEDLE}` 은 한 번 있어야 한다: {caption_ys:?}"
    );

    let expected_gap = hu_px(CAPTION_GAP_HU + CAPTION_FIRST_LINE_VERTPOS_HU);
    let defect_drop = hu_px(BASELINE_HU - PIC_H_HU);
    let caption_y = caption_ys[0];
    let gap = caption_y - img_bottom;
    assert!(
        (gap - expected_gap).abs() < TOLERANCE_PX,
        "캡션 첫 줄 y={caption_y:.2} 는 그림 바닥({img_bottom:.2}) + {expected_gap:.2}px \
         에 있어야 한다. 그림 y={img_y:.2}. 결함 시 +{defect_drop:.2}px"
    );
    assert!(
        (gap - (expected_gap + defect_drop)).abs() > 10.0,
        "캡션 첫 줄 gap={gap:.2} 가 그림 바닥+{defect_drop:.2}px 이면 회귀"
    );

    let line_bottom = img_y + hu_px(LINE_H_HU);
    let cap_block_bottom = caption_bottoms
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    assert!(
        cap_block_bottom.is_finite(),
        "그림 아래 캡션 줄이 있어야 한다"
    );
    assert!(
        (cap_block_bottom - line_bottom).abs() < TOLERANCE_PX,
        "캡션 블록 바닥({cap_block_bottom:.2})은 저장 줄 바닥({line_bottom:.2})에 있어야 한다. \
         결함 시 +{defect_drop:.2}px 로 줄을 넘긴다"
    );
}
