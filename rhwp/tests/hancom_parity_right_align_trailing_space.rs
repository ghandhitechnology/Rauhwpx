//! 오른쪽 정렬 줄의 끝 공백은 정렬 폭에 넣지 않는다 (한컴 macOS 정합).
//!
//! `samples/hwpx/hy-001.hwpx` 2쪽 담당자 표의 직명 칸은 오른쪽 정렬(paraPr 21)이며
//! 윗줄 `과  장 ` 만 끝 공백을 가진다. 한컴은 끝 공백을 무시해 `장` 과 아랫줄
//! `사무관` 의 `관` 을 같은 오른쪽 끝에 맞춘다. 끝 공백을 폭에 넣으면 `장` 이 공백
//! 한 칸만큼 왼쪽으로 밀린다.

use std::fs;
use std::path::Path;

fn attr_f64(fragment: &str, key: &str) -> Option<f64> {
    let pat = format!("{key}=\"");
    let start = fragment.find(&pat)? + pat.len();
    let rest = &fragment[start..];
    rest[..rest.find('"')?].parse().ok()
}

/// 표 행(y 범위) 안에서 글자 `glyph` 를 그린 `<text>` 들의 x 좌표.
fn glyph_xs(svg: &str, glyph: &str, y_range: (f64, f64)) -> Vec<f64> {
    svg.split("<text ")
        .skip(1)
        .filter_map(|frag| {
            let elem = &frag[..frag.find("</text>")?];
            let text = &elem[elem.rfind('>')? + 1..];
            let (x, y) = (attr_f64(elem, "x")?, attr_f64(elem, "y")?);
            (text == glyph && y > y_range.0 && y < y_range.1).then_some(x)
        })
        .collect()
}

#[test]
fn right_aligned_cell_ignores_trailing_space() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/hwpx/hy-001.hwpx");
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse hy-001.hwpx");
    let svg = doc.render_page_svg_native(1).expect("render page 2 SVG");

    // `과  장 ` 줄과 `사무관` 줄의 마지막 글자 — 둘 다 표 오른쪽 부분(x > 440)에 있다.
    let jang = glyph_xs(&svg, "장", (250.0, 285.0));
    let gwan = glyph_xs(&svg, "관", (285.0, 300.0));
    let jang_x = jang
        .iter()
        .copied()
        .find(|x| *x > 440.0)
        .expect("`장` in 직명 칸");
    let gwan_x = gwan
        .iter()
        .copied()
        .find(|x| *x > 440.0)
        .expect("`관` in 직명 칸");
    assert!(
        (jang_x - gwan_x).abs() < 0.5,
        "오른쪽 정렬 끝 글자가 어긋남: `장` x={jang_x:.2}, `관` x={gwan_x:.2} — 끝 공백이 정렬 폭에 들어감"
    );
}
