//! PR #1019: PageBackground fill mode + RealPic color watermark SVG path guards.

use std::path::Path;

use rhwp::renderer::render_tree::{
    REAL_PICTURE_WATERMARK_FILL_OPACITY, REAL_PICTURE_WATERMARK_PAGE_OPACITY,
};
use rhwp::wasm_api::HwpDocument;

fn load_doc(rel_path: &str) -> HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel_path);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn assert_realpic_watermark_svg_path(svg: &str, label: &str) {
    assert!(
        svg.contains("data:image/png;base64,"),
        "{label}: RealPic watermark should be emitted as tone-baked PNG"
    );
    assert!(
        !svg.contains("rhwp-img-bc-b-50c70"),
        "{label}: RealPic preset must not use generic brightness/contrast SVG filter"
    );
    assert!(
        !svg.contains("rhwp-realpic-watermark-tone"),
        "{label}: decodeable RealPic preset should bake tone into PNG pixels"
    );
    assert!(
        !svg.contains("data:application/octet-stream"),
        "{label}: image resolver must not fall back to octet-stream"
    );

    let page_opacity = format!("opacity=\"{}\"", REAL_PICTURE_WATERMARK_PAGE_OPACITY);
    let fill_opacity = format!("opacity=\"{}\"", REAL_PICTURE_WATERMARK_FILL_OPACITY);
    assert!(
        svg.contains(&page_opacity) || svg.contains(&fill_opacity),
        "{label}: RealPic watermark opacity should be applied"
    );
}

#[test]
fn issue_1019_143_realpic_page_background_svg_path() {
    let doc = load_doc("samples/143E433F503322BD33.hwp");
    assert!(
        doc.page_count() >= 1,
        "fixture should have at least one page"
    );

    let svg = doc
        .render_page_svg_native(0)
        .expect("render 143E433F503322BD33.hwp page 1");
    assert_realpic_watermark_svg_path(&svg, "143E433F503322BD33 page 1");
}

#[test]
fn issue_1019_253_empty_realpic_svg_path_pages_1_and_2() {
    let doc = load_doc("samples/253E164F57A1BC6934-empty.hwp");
    assert!(
        doc.page_count() >= 2,
        "fixture should have at least two pages"
    );

    for page in 0..2 {
        let svg = doc.render_page_svg_native(page).unwrap_or_else(|e| {
            panic!("render 253E164F57A1BC6934-empty.hwp page {}: {e}", page + 1)
        });
        assert_realpic_watermark_svg_path(
            &svg,
            &format!("253E164F57A1BC6934-empty page {}", page + 1),
        );
    }
}
