//! Issue #6766: 빈 누름틀의 캐럿은 문단 정렬이 정한 앵커에 남아야 한다.
#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::DocumentCore;
use serde_json::Value;

fn cursor_x(core: &DocumentCore, para: usize) -> f64 {
    let json = core
        .get_cursor_rect_native(0, para, 0)
        .unwrap_or_else(|e| panic!("cursor rect para={para}: {e:?}"));
    let value: Value = serde_json::from_str(&json).unwrap_or_else(|e| panic!("json: {e}"));
    value["x"]
        .as_f64()
        .unwrap_or_else(|| panic!("cursor x: {json}"))
}

#[test]
fn empty_clickhere_caret_follows_left_center_and_right_alignment() {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().expect("blank document");
    core.split_paragraph_native(0, 0, 0, None)
        .expect("second paragraph");
    core.split_paragraph_native(0, 1, 0, None)
        .expect("third paragraph");
    core.apply_para_format_native(0, 1, r#"{"alignment":"center"}"#)
        .expect("center alignment");
    core.apply_para_format_native(0, 2, r#"{"alignment":"right"}"#)
        .expect("right alignment");
    for (para, name) in [(0, "left"), (1, "center"), (2, "right")] {
        core.insert_click_here_field_at(0, para, 0, "입력", "", name, true)
            .unwrap_or_else(|e| panic!("{name} field: {e:?}"));
    }
    let left_x = cursor_x(&core, 0);
    let center_x = cursor_x(&core, 1);
    let right_x = cursor_x(&core, 2);
    assert!(
        left_x + 20.0 < center_x && center_x + 20.0 < right_x,
        "empty ClickHere caret must follow alignment: left={left_x}, center={center_x}, right={right_x}"
    );
}
