//! Studio 정적 그림 분리 합성의 그리기 순서 보존 판정 (`flowStaticSplitSafe`).
//!
//! Studio Canvas2D 는 본문 그림을 flow canvas 아래 layer 로 분리해 그린다. 그림보다 먼저
//! 그려지는 흰 채우기가 그림과 겹치면 분리 합성이 그림을 가리므로(hy-001 2쪽 로고 누락)
//! 엔진이 그런 페이지를 분리 불가로 알려야 한다. 글자가 없는 빈 run 은 겹쳐도 무시한다.

use serde_json::Value;

fn split_safe(sample: &str, page: u32) -> bool {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(sample);
    let bytes = std::fs::read(&path).expect("read sample");
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse sample");
    let json = doc
        .get_page_overlay_images_native(page)
        .expect("overlay summary");
    let parsed: Value = serde_json::from_str(&json).expect("overlay JSON");
    parsed["flowStaticSplitSafe"]
        .as_bool()
        .expect("flowStaticSplitSafe flag")
}

#[test]
fn image_over_prior_white_fill_is_not_split() {
    assert!(split_safe("samples/hwpx/hy-001.hwpx", 0));
    assert!(!split_safe("samples/hwpx/hy-001.hwpx", 1));
}

#[test]
fn empty_text_runs_under_inline_images_keep_split() {
    // 40쪽 그림은 앞선 빈 run 의 줄 bbox 와만 겹친다.
    assert!(split_safe("samples/hwpx/aift.hwpx", 39));
}
