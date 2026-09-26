//! 각주 구분선 길이 기본값(noteLine length="-1") = 5cm.
//!
//! 한컴 macOS·Windows 2022 정답지 모두 footnote-01 의 각주 구분선을 141.7pt(5cm)로
//! 그린다. 종전 렌더는 단 폭의 1/3(약 160pt)로 그렸다.

use rhwp::wasm_api::HwpDocument;

fn line_lengths(svg: &str) -> Vec<f64> {
    let attr = |tag: &str, name: &str| -> Option<f64> {
        let key = format!(" {name}=\"");
        let start = tag.find(&key)? + key.len();
        let end = start + tag[start..].find('"')?;
        tag[start..end].parse().ok()
    };
    svg.split("<line")
        .skip(1)
        .filter_map(|tag| {
            let tag = &tag[..tag.find("/>")?];
            let (x1, x2) = (attr(tag, "x1")?, attr(tag, "x2")?);
            let (y1, y2) = (attr(tag, "y1")?, attr(tag, "y2")?);
            (y1 == y2).then_some(x2 - x1)
        })
        .collect()
}

#[test]
fn default_footnote_separator_is_five_centimeters() {
    // 5cm = 14173 HWPUNIT → 96dpi 에서 188.97px
    let expected = 14173.0 * 96.0 / 7200.0;
    for sample in ["samples/footnote-01.hwp", "samples/hwpx/footnote-01.hwpx"] {
        let bytes = std::fs::read(sample).expect("sample");
        let doc = HwpDocument::from_bytes(&bytes).expect("parse");
        let shape = &doc.document().sections[0].section_def.footnote_shape;
        assert_eq!(shape.separator_length, -1, "{sample}: 기본 길이 sentinel");

        let svg = doc.render_page_svg_native(0).expect("render page 1");
        let lengths = line_lengths(&svg);
        assert!(
            lengths.iter().any(|len| (len - expected).abs() < 0.5),
            "{sample}: 5cm 각주 구분선이 없다. 가로선 길이 {lengths:?}"
        );
    }
}
