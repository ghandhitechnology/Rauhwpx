use std::path::Path;

use rhwp::wasm_api::HwpDocument;

fn read_sample(rel: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
}

fn json_number(json: &str, key: &str) -> f64 {
    let pattern = format!("\"{}\":", key);
    let start = json.find(&pattern).expect("json key not found") + pattern.len();
    let rest = &json[start..];
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
        .unwrap_or(rest.len());
    rest[..end].parse::<f64>().expect("json number parse")
}

fn assert_nav(doc: &HwpDocument, from: u32, delta: i32, to: u32) {
    let json = doc.navigate_next_editable_wasm(0, 0, from, delta, "[]");
    assert!(
        json.contains(&format!("\"charOffset\":{}", to)),
        "navigate from {from} delta {delta}: expected charOffset {to}, json={json}"
    );
}

#[test]
fn issue_1071_hwpx_tac_shapes_move_as_single_logical_units() {
    let bytes = read_sample("samples/hwpx/shape-001.hwpx");
    let doc = HwpDocument::from_bytes(&bytes).expect("parse shape-001.hwpx");

    assert_nav(&doc, 0, 1, 1);
    assert_nav(&doc, 1, 1, 2);
    assert_nav(&doc, 2, 1, 3);
    assert_nav(&doc, 3, 1, 4);

    assert_nav(&doc, 4, -1, 3);
    assert_nav(&doc, 3, -1, 2);
    assert_nav(&doc, 2, -1, 1);
    assert_nav(&doc, 1, -1, 0);
}

fn cursor_rect_xs(rel: &str) -> Vec<f64> {
    let bytes = read_sample(rel);
    let doc = HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {rel}: {e:?}"));
    let xs: Vec<f64> = (0..=4)
        .map(|offset| {
            let rect = doc
                .get_cursor_rect_native(0, 0, offset)
                .unwrap_or_else(|e| panic!("{rel} cursor rect offset {offset}: {e:?}"));
            json_number(&rect, "x")
        })
        .collect();
    xs
}

#[test]
fn issue_1071_tac_shape_cursor_rects_advance_for_each_logical_unit() {
    for rel in ["samples/shape-001.hwp", "samples/hwpx/shape-001.hwpx"] {
        let xs = cursor_rect_xs(rel);
        for pair in xs.windows(2) {
            assert!(
                pair[1] > pair[0],
                "{rel}: TAC shape cursor x must advance at every logical unit: xs={xs:?}"
            );
        }
    }
}

#[test]
fn issue_1071_hwpx_tac_shape_cursor_rects_are_monotonic() {
    let xs = cursor_rect_xs("samples/hwpx/shape-001.hwpx");
    for pair in xs.windows(2) {
        assert!(
            pair[1] >= pair[0],
            "TAC shape cursor x must be monotonic: xs={xs:?}"
        );
    }
    assert!(
        xs[4] > xs[0],
        "cursor after second TAC shape must be to the right of start: xs={xs:?}"
    );
}

#[test]
fn issue_1071_spaces_between_tac_shapes_have_balanced_caret_steps() {
    for rel in ["samples/shape-001.hwp", "samples/hwpx/shape-001.hwpx"] {
        let xs = cursor_rect_xs(rel);
        let first_space_step = xs[2] - xs[1];
        let second_space_step = xs[3] - xs[2];
        assert!(
            (first_space_step - second_space_step).abs() <= 0.2,
            "{rel}: consecutive spaces between TAC shapes should split visual gap evenly: xs={xs:?}"
        );
    }
}
