//! Issue #241: HWPX non-TAC InFront picture anchored to paragraph position.
//!
//! The stamp picture in `samples/hwpx/issue_241.hwpx` is anchored as
//! vertical relation = Para, offset = 754 HU, InFrontOfText. Hancom PDF exports
//! from Hwp 2018 and Hwp 2022 place the stamp at x=377.797pt, y=664.912pt.
//! Converted to rhwp's 96dpi page coordinate system, this is approximately
//! x=503.729px, y=886.549px.

use serde_json::Value;

#[test]
fn issue_241_hwpx_stamp_overlay_uses_host_paragraph_position() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(repo_root).join("samples/hwpx/issue_241.hwpx");
    let bytes = std::fs::read(&path).expect("read samples/hwpx/issue_241.hwpx");
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse issue_241.hwpx");

    let overlay_json = doc
        .get_page_overlay_images_native(0)
        .expect("overlay images");
    let overlay: Value = serde_json::from_str(&overlay_json)
        .unwrap_or_else(|e| panic!("parse overlay json `{overlay_json}`: {e}"));
    let front = overlay["front"].as_array().expect("front overlay array");
    assert_eq!(front.len(), 1, "stamp must be a single InFront overlay");

    let bbox = &front[0]["bbox"];
    let x = bbox["x"].as_f64().expect("bbox.x");
    let y = bbox["y"].as_f64().expect("bbox.y");
    let width = bbox["width"].as_f64().expect("bbox.width");
    let height = bbox["height"].as_f64().expect("bbox.height");

    assert!(
        (x - 503.729).abs() < 1.0,
        "stamp x must match Hancom PDF reference: x={x}, json={overlay_json}"
    );
    assert!(
        (y - 886.549).abs() < 1.0,
        "stamp y must match Hancom PDF reference, not next paragraph start: y={y}, json={overlay_json}"
    );
    assert!(
        (width - 88.272).abs() < 1.0,
        "stamp width must match Hancom PDF reference: width={width}, json={overlay_json}"
    );
    assert!(
        (height - 84.388).abs() < 1.0,
        "stamp height must match Hancom PDF reference: height={height}, json={overlay_json}"
    );
}

#[test]
fn issue_241_hwpx_stamp_host_paragraph_keeps_flow_line_height() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(repo_root).join("samples/hwpx/issue_241.hwpx");
    let bytes = std::fs::read(&path).expect("read samples/hwpx/issue_241.hwpx");
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse issue_241.hwpx");

    let overlay_json = doc
        .get_page_overlay_images_native(0)
        .expect("overlay images");
    let overlay: Value = serde_json::from_str(&overlay_json)
        .unwrap_or_else(|e| panic!("parse overlay json `{overlay_json}`: {e}"));
    let stamp_y = overlay["front"][0]["bbox"]["y"].as_f64().expect("stamp y");

    let text_layout_json = doc.get_page_text_layout_native(0).expect("text layout");
    let text_layout: Value = serde_json::from_str(&text_layout_json)
        .unwrap_or_else(|e| panic!("parse text layout json `{text_layout_json}`: {e}"));
    let pi10_y = text_layout["runs"]
        .as_array()
        .expect("text runs")
        .iter()
        .filter(|run| run["paraIdx"].as_u64() == Some(10))
        .filter_map(|run| run["y"].as_f64())
        .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .expect("pi=10 text run y");

    assert!(
        pi10_y > stamp_y + 8.0,
        "pi=9 stamp host paragraph must reserve its line advance before pi=10: \
         stamp_y={stamp_y}, pi10_y={pi10_y}, text={text_layout_json}, overlay={overlay_json}"
    );
}
