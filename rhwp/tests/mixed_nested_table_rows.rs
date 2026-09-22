//! 페이지 분할 셀 안에서 텍스트와 함께 배치된 중첩 표의 본문 행 보존.
//! 높이 기반 mixed split의 end_row가 1로 고정되어 헤더 아래 행이 사라졌던 회귀.

use std::fs;
use std::path::Path;

fn assert_body_rows_rendered(sample: &str, page: u32, pages: u32, body_text: &[&str]) {
    let bytes = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(sample)).expect("fixture");
    let mut doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse");
    assert_eq!(doc.page_count(), pages, "페이지네이션을 바꾸지 않아야 한다");
    let svg = doc.render_page_svg_native(page).expect("render");

    // SVG가 한 글자씩 방출하는 텍스트를 합쳐 실제 본문 내용의 보존을 확인한다.
    let mut text = String::new();
    let mut remaining = svg.as_str();
    while let Some(open) = remaining.find("<text ") {
        let after = &remaining[open..];
        let start = after.find('>').expect("text start") + 1;
        let end = after.find("</text>").expect("text end");
        text.extend(after[start..end].chars().filter(|ch| !ch.is_whitespace()));
        remaining = &after[end + "</text>".len()..];
    }
    for expected in body_text {
        assert!(
            text.contains(expected),
            "{sample}의 {}쪽에 중첩 표 본문 {expected:?} 누락",
            page + 1
        );
    }
}

#[test]
fn mixed_two_row_work_hours_table_keeps_both_body_cells() {
    assert_body_rows_rendered(
        "samples/issue1770_rowsplit_tolerance.hwpx",
        1,
        4,
        &[
            "월요일~금요일",
            "근무형태",
            "(3근무)",
            "근무방식및근로시간은",
        ],
    );
}

#[test]
fn mixed_three_row_nested_table_keeps_both_treatment_rows() {
    assert_body_rows_rendered(
        "samples/pic-in-head-02.hwp",
        2,
        6,
        &[
            "19nivolumab",
            "20pembrolizumab",
            "백금기반화학요법",
            "EGFR",
            "ALK",
        ],
    );
}
