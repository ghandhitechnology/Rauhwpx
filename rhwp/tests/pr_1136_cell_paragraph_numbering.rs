//! PR #1136: table-cell paragraphs with `head_type=Number` must render their
//! paragraph number prefixes just like body paragraphs.
//!
//! Repro: `samples/hwpx/k-water-rfp.hwpx` page 20 has schedule table headings
//! inside cells. Hancom output (`pdf/k-water-rfp-2024.pdf`, page 18) shows
//! `1. 서버 클라우드 환경 구축` and `2. 전사 데이터 허브 구축`.

use std::fs;
use std::path::Path;

fn render_page_svg(rel: &str, page_idx: u32) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {rel}: {e}"));
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("parse {rel}: {e:?}"));
    doc.render_page_svg_native(page_idx)
        .unwrap_or_else(|e| panic!("render {rel} page {page_idx}: {e:?}"))
}

fn text_y_values_for_exact_text(svg: &str, needle: &str) -> Vec<f64> {
    let mut ys = Vec::new();
    let mut rest = svg;
    while let Some(open) = rest.find("<text") {
        let after_open = &rest[open..];
        let Some(tag_end_rel) = after_open.find('>') else {
            break;
        };
        let tag_end = open + tag_end_rel;
        let tag = &rest[open..tag_end];
        let after_tag = &rest[tag_end + 1..];
        let Some(close_rel) = after_tag.find("</text>") else {
            break;
        };
        let body = &after_tag[..close_rel];
        if body == needle {
            if let Some(y_off) = tag.find(" y=\"") {
                let y_start = y_off + 4;
                if let Some(y_end_rel) = tag[y_start..].find('"') {
                    if let Ok(y) = tag[y_start..y_start + y_end_rel].parse::<f64>() {
                        ys.push(y);
                    }
                }
            }
        }
        rest = &after_tag[close_rel + "</text>".len()..];
    }
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
    ys
}

#[test]
fn pr1136_table_cell_number_prefixes_are_rendered() {
    let svg = render_page_svg("samples/hwpx/k-water-rfp.hwpx", 19);

    let one_ys = text_y_values_for_exact_text(&svg, "1");
    assert!(
        one_ys.iter().any(|&y| (y - 270.0).abs() < 8.0),
        "page 20 schedule table should render cell heading prefix `1.` near y=270; got {one_ys:?}"
    );

    let two_ys = text_y_values_for_exact_text(&svg, "2");
    assert!(
        two_ys.iter().any(|&y| (y - 558.0).abs() < 8.0),
        "page 20 schedule table should render cell heading prefix `2.` near y=558; got {two_ys:?}"
    );
}
