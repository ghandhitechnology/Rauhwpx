use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

fn cursor_x(doc: &HwpDocument, para: u32, offset: u32) -> f64 {
    let json = doc
        .get_cursor_rect(0, para, offset)
        .unwrap_or_else(|error| panic!("cursor rect para={para} offset={offset}: {error:?}"));
    serde_json::from_str::<Value>(&json).expect("cursor rect JSON")["x"]
        .as_f64()
        .expect("cursor x")
}

fn assert_near(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() <= 0.2,
        "{label}: expected {expected}±0.2, got {actual}"
    );
}

#[test]
fn multiline_body_selection_stops_at_each_paragraphs_text_end() {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().expect("blank document");

    let lines = ["abcdefghij", "short", "last line"];
    doc.insert_text_native(0, 0, 0, lines[0])
        .expect("first line");
    doc.split_paragraph_native(0, 0, lines[0].len(), None)
        .expect("second paragraph");
    doc.insert_text_native(0, 1, 0, lines[1])
        .expect("second line");
    doc.split_paragraph_native(0, 1, lines[1].len(), None)
        .expect("third paragraph");
    doc.insert_text_native(0, 2, 0, lines[2])
        .expect("third line");

    let json = doc
        .get_selection_rects(0, 0, 2, 2, 4)
        .expect("multiline selection rects");
    let rects = serde_json::from_str::<Vec<Value>>(&json).expect("selection rect JSON");
    assert_eq!(
        rects.len(),
        3,
        "one text-bounded rect per paragraph: {json}"
    );

    let expected = [
        (
            cursor_x(&doc, 0, 2),
            cursor_x(&doc, 0, lines[0].len() as u32),
        ),
        (
            cursor_x(&doc, 1, 0),
            cursor_x(&doc, 1, lines[1].len() as u32),
        ),
        (cursor_x(&doc, 2, 0), cursor_x(&doc, 2, 4)),
    ];

    for (index, (rect, (start_x, end_x))) in rects.iter().zip(expected).enumerate() {
        let x = rect["x"].as_f64().expect("selection x");
        let width = rect["width"].as_f64().expect("selection width");
        assert_near(x, start_x.min(end_x), &format!("rect {index} x"));
        assert_near(
            width,
            (end_x - start_x).abs(),
            &format!("rect {index} width"),
        );
    }
}
