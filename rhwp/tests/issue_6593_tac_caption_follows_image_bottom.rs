//! [Issue #6593] 캡션 붙은 글자처럼(TAC) 그림의 아래 캡션이 그림 바닥이 아니라
//! `그림 상단 + baseline` 에 붙어, 저장 줄을 넘고 뒤 내용을 18pt 밀던 결함의 가드.
//!
//! `layout_shape_item` 은 캡션 y 를 `image_bottom + spacing` 으로 잡는데, 종전에는
//! `image_bottom = 그림 상단 + max(baseline, 그림 높이)` 였다. 저장 줄이 그림 + 캡션을
//! 통째로 예약한 줄은 baseline 이 그림 높이보다 커서, 캡션이 `baseline − 그림 높이`
//! 만큼 내려가 줄 바닥을 넘고 `result_y` 가 캡션 끝으로 밀린다.
//!
//! 픽스처는 #6575 와 같은 `samples/issue6575/tac_picture_line_top.hwpx`.
//! 원본 HWP `156489219` 5쪽의 결함 lineseg(`lh=21235 th=21235 bl=18050`)와
//! TAC 그림(`curSz h=15425HU=205.7px`), Bottom 캡션(간격 850HU, 첫 줄 vertpos 500HU)을
//! 보존한다. 업스트림 절대 y(캡션 457.3 / 표 529.1)는 이 문단 위 표 레이아웃이
//! Rauhwpx 와 달라 쓰지 않고, 캡션 첫 줄이 그려진 그림 상자 바닥에 붙는지
//! (결함 시 +35px)로 잠근다. 축소본에는 원본 5쪽 후속 표(pi=44)가 없으므로
//! 후속 +18pt 이동은 이 35px 넘침이 `result_y` 를 미는 같은 근인으로 잠근다.
//!
//! Ported from edwardkim/rhwp #6595 (closes #6593; landed via #6645).
#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const SAMPLE: &str = "samples/issue6575/tac_picture_line_top.hwpx";
const TARGET_WIDTH_PX: f64 = 557.25;
const CAPTION_NEEDLE: &str = "환경위성센터 누리집 주요 화면";
const DEFECT_DROP_PX: f64 = 35.0;
/// 850HU 캡션 간격 + 캡션 첫 줄 저장 vertpos 500HU, 96dpi.
const EXPECTED_GAP_PX: f64 = 1350.0 * 96.0 / 7200.0;
const TOLERANCE_PX: f64 = 3.0;

fn collect_target(node: &RenderNode, image: &mut Option<(f64, f64)>, captions: &mut Vec<f64>) {
    match &node.node_type {
        RenderNodeType::Image(_) if (node.bbox.width - TARGET_WIDTH_PX).abs() < 1.0 => {
            *image = Some((node.bbox.y, node.bbox.y + node.bbox.height));
        }
        RenderNodeType::TextRun(tr) if tr.text.contains(CAPTION_NEEDLE) => {
            captions.push(node.bbox.y);
        }
        _ => {}
    }
    for child in &node.children {
        collect_target(child, image, captions);
    }
}

#[test]
fn bottom_caption_of_tac_picture_starts_right_below_the_drawn_picture() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let core = DocumentCore::from_bytes(&std::fs::read(path).expect("read sample")).expect("open");
    let tree = core.build_page_render_tree(0).expect("page 1 render tree");

    let mut image = None;
    let mut captions = Vec::new();
    collect_target(&tree.root, &mut image, &mut captions);

    let (img_y, img_bottom) = image.expect("폭 557.25px TAC 그림이 있어야 한다");
    assert_eq!(
        captions.len(),
        1,
        "캡션 글줄 `{CAPTION_NEEDLE}` 은 한 번 있어야 한다: {captions:?}"
    );
    let caption_y = captions[0];
    let gap = caption_y - img_bottom;

    assert!(
        (gap - EXPECTED_GAP_PX).abs() < TOLERANCE_PX,
        "캡션 첫 줄 y={caption_y:.2} 는 그림 바닥({img_bottom:.2}) + {EXPECTED_GAP_PX:.2}px \
         (간격+첫 줄 vertpos)에 있어야 한다. 그림 y={img_y:.2}. 결함 시 +{DEFECT_DROP_PX}px \
         (그림 상단 + baseline, gap≈{:.2})",
        EXPECTED_GAP_PX + DEFECT_DROP_PX
    );
    assert!(
        (gap - (EXPECTED_GAP_PX + DEFECT_DROP_PX)).abs() > 10.0,
        "캡션 첫 줄 gap={gap:.2} 가 그림 바닥+{DEFECT_DROP_PX}px \
         ({:.2})이면 #6593 회귀",
        EXPECTED_GAP_PX + DEFECT_DROP_PX
    );
}
