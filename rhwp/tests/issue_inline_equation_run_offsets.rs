//! 인라인 수식이 들어 있는 run 뒤에 이어지는 다른 글자 모양 run 의 char_start 가
//! 수식 개수만큼 앞당겨지면 캐럿·hit-test·선택 하이라이트가 어긋난다.
//! 논리 오프셋(텍스트 + 인라인 컨트롤당 1) 끝까지 캐럿과 선택이 이어져야 한다.

use rhwp::wasm_api::HwpDocument;

fn json_number(json: &str, key: &str) -> f64 {
    let pattern = format!("\"{}\":", key);
    let start = json.find(&pattern).expect("json key") + pattern.len();
    let rest = &json[start..];
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
        .unwrap_or(rest.len());
    rest[..end].parse().expect("json number")
}

#[test]
fn 인라인_수식_뒤의_글자_런은_논리_오프셋을_유지한다() {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    // "ab" [수식] "cd" [수식] "efgh" — 마지막 "gh" 만 굵게 해 run 을 나눈다.
    doc.insert_text_native(0, 0, 0, "abcdefgh").unwrap();
    doc.insert_equation_native(0, 0, 4, "x over y", 1000, 0)
        .unwrap();
    doc.insert_equation_native(0, 0, 2, "a over b", 1000, 0)
        .unwrap();
    // 논리 오프셋: a0 b1 [eq]2 c3 d4 [eq]5 e6 f7 g8 h9 → 길이 10
    doc.apply_char_format_native(0, 0, 6, 8, r#"{"bold":true}"#)
        .unwrap();

    let caret_x = |offset: u32| json_number(&doc.get_cursor_rect(0, 0, offset).unwrap(), "x");
    let xs: Vec<f64> = (0..=10).map(caret_x).collect();
    for pair in xs.windows(2) {
        assert!(
            pair[1] > pair[0],
            "캐럿이 논리 오프셋마다 전진해야 함: {xs:?}"
        );
    }

    // 끝 문자 한 글자 선택도 사각형이 나와야 한다.
    let last = doc.get_selection_rects(0, 0, 9, 0, 10).unwrap();
    assert!(
        last.contains("\"width\""),
        "마지막 글자 선택 rect 누락: {last}"
    );
    let rect_x = json_number(&last, "x");
    assert!(
        (rect_x - xs[9]).abs() < 0.5,
        "선택 rect x {rect_x} != 캐럿 x {}",
        xs[9]
    );
}
