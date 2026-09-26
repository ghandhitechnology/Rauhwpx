#![cfg(not(target_arch = "wasm32"))]
//! 한컴(macOS) PDF 기준: 첨자 진행폭 축소와 반각 낫표의 halt 배치.
//!
//! 표본 `samples/hwpx/el-school-001.hwpx` 1쪽.
//! - '장소*를' (함초롬바탕 15pt·장평 97%·자간 -3%, '*' 위첨자): PDF 에서 '*' 원점 228.00pt,
//!   '를' 원점 232.92pt → 첨자 진행폭 4.92pt. glyph 만 줄이고 원래 크기 advance(7.7pt)를
//!   남기면 뒤 글자가 밀린다.
//! - 제목 '「 초등학생…' (HY헤드라인M 16pt·자간 -13%, 전각 `「` 에 반각 칸): PDF 에서 `「`
//!   glyph 원점 141.12pt, '초' 원점 162.00pt → 20.88pt. glyph 를 찌그러뜨리지 않고 칸 오른쪽
//!   끝에 맞춘다.

use std::path::Path;

use rhwp::document_core::DocumentCore;

const PT_TO_PX: f64 = 96.0 / 72.0;

fn page_svg(rel: &str, page: u32) -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let core = DocumentCore::from_bytes(&std::fs::read(p).expect("표본 읽기")).expect("문서 로드");
    core.render_page_svg_native(page).expect("SVG 렌더")
}

/// (x, 속성 문자열, 텍스트) — `x=` 또는 `transform="translate(x,y)..."` 모두 지원.
fn text_elements(svg: &str) -> Vec<(f64, String, String)> {
    svg.split("<text ")
        .skip(1)
        .filter_map(|rest| {
            let close = rest.find('>')?;
            let attrs = &rest[..close];
            let body = &rest[close + 1..rest.find("</text>")?];
            let x = if let Some(i) = attrs.find("translate(") {
                let s = &attrs[i + "translate(".len()..];
                s[..s.find(',')?].parse().ok()?
            } else {
                let i = attrs.find("x=\"")? + 3;
                let s = &attrs[i..];
                s[..s.find('"')?].parse().ok()?
            };
            Some((x, attrs.to_string(), body.to_string()))
        })
        .collect()
}

fn following(elements: &[(f64, String, String)], first: &str, next: &str) -> (f64, f64, String) {
    elements
        .windows(2)
        .find(|w| w[0].2 == first && w[1].2 == next)
        .map(|w| (w[0].0, w[1].0, w[0].1.clone()))
        .unwrap_or_else(|| panic!("'{first}' 다음 '{next}' 글자를 찾지 못함"))
}

#[test]
fn superscript_advance_shrinks_with_its_glyph() {
    let svg = page_svg("samples/hwpx/el-school-001.hwpx", 0);
    let (star_x, next_x, _) = following(&text_elements(&svg), "*", "를");
    let advance = next_x - star_x;
    let hancom = 4.92 * PT_TO_PX;
    assert!(
        (advance - hancom).abs() < 0.3,
        "위첨자 '*' 진행폭 {advance:.2}px, 한컴 {hancom:.2}px"
    );
}

#[test]
fn halfwidth_opening_bracket_keeps_full_glyph_right_aligned() {
    let svg = page_svg("samples/hwpx/el-school-001.hwpx", 0);
    let (bracket_x, next_x, attrs) = following(&text_elements(&svg), "「", "초");
    assert!(
        !attrs.contains("textLength"),
        "전각 `「` glyph 를 반각 칸에 찌그러뜨리면 안 된다: {attrs}"
    );
    let gap = next_x - bracket_x;
    let hancom = (162.00 - 141.12) * PT_TO_PX;
    assert!(
        (gap - hancom).abs() < 0.3,
        "`「` glyph 원점 → '초' {gap:.2}px, 한컴 {hancom:.2}px"
    );
}
