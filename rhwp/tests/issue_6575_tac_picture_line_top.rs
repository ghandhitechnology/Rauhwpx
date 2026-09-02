//! [Issue #6575] 줄이 그림보다 크게 저장된 빈 줄의 TAC 그림이 줄 상단 대신
//! baseline 에 바닥을 맞춰 앉아 25.5pt 내려간다 (156489219 5쪽, #6494 잔여).
//!
//! 근인: 빈 run 줄의 TAC Picture 배치가 그림 높이만으로 baseline 에 맞췄다.
//! 그러나 156489219 5쪽 그림에는 Bottom 캡션이 있어 저장 lineseg 는 그림,
//! 캡션 간격, 캡션 문단을 함께 예약한다. 그림만 맞추면 캡션 몫만큼 내려간다.
//! 한글 2024 는 전체 개체 상자를 기준으로 그림을 저장 lineseg 상단에 그린다.
//!
//! 수정: Top/Bottom 캡션의 간격과 문단 높이를 그림 높이에 더한 전체 개체 상자를
//! baseline 에 맞춘다. 상자가 baseline 보다 크면 기존 `.max(y)` 클램프가 줄
//! 상단을 준다. 캡션이 없는 그림은 기존 baseline 동작을 유지한다.
//!
//! 픽스처는 원본 HWP 를 HWPX 변환 후 secPr 문단 + 그림 문단만 남기고
//! BinData 를 1×1 스텁으로 바꾼 축소본(22KB). 결함 lineseg
//! (lh=21235 th=21235 bl=18050) 와 TAC 그림(curSz h=15425HU=205.7px)을
//! 그대로 보존한다.
//!
//! Ported from edwardkim/rhwp #6578 / #6576 (devel 최종 계약). 업스트림 SVG
//! 절대 y(444.68)는 이 문단 위 표 레이아웃이 Rauhwpx 와 달라 쓰지 않고,
//! 그림이 소속 TextLine 상단에 앉는지(결함 시 +35px)로 잠근다.
#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const SAMPLE: &str = "samples/issue6575/tac_picture_line_top.hwpx";
const TARGET_WIDTH_PX: f64 = 557.25;
const DEFECT_DROP_PX: f64 = 35.0;

fn collect_target_images_on_lines(node: &RenderNode, out: &mut Vec<(f64, f64, f64)>) {
    if matches!(node.node_type, RenderNodeType::TextLine(_)) {
        for child in &node.children {
            if matches!(child.node_type, RenderNodeType::Image(_))
                && (child.bbox.width - TARGET_WIDTH_PX).abs() < 1.0
            {
                out.push((child.bbox.y, child.bbox.width, node.bbox.y));
            }
        }
    }
    for child in &node.children {
        collect_target_images_on_lines(child, out);
    }
}

#[test]
fn issue_6575_tac_picture_sits_on_line_top_when_line_is_taller() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let core = DocumentCore::from_bytes(&std::fs::read(path).expect("read sample")).expect("open");
    let tree = core.build_page_render_tree(0).expect("page 1 render tree");

    let mut targets = Vec::new();
    collect_target_images_on_lines(&tree.root, &mut targets);
    assert_eq!(
        targets.len(),
        1,
        "폭 {TARGET_WIDTH_PX}px 의 TAC 그림은 정확히 하나여야 한다: {targets:?}"
    );

    let (img_y, _w, line_y) = targets[0];
    assert!(
        (img_y - line_y).abs() < 1.5,
        "TAC 그림 상단({img_y:.2})이 줄 상단({line_y:.2})에 있어야 한다 — \
         결함 시 줄 상단+{DEFECT_DROP_PX}px (baseline 바닥 맞춤, bl−h)"
    );
    assert!(
        (img_y - (line_y + DEFECT_DROP_PX)).abs() > 10.0,
        "TAC 그림 상단({img_y:.2})이 줄 상단+{DEFECT_DROP_PX}px \
         ({:.2})에 있으면 #6575 회귀",
        line_y + DEFECT_DROP_PX
    );
}
