//! Issue #1138: rhwp-studio 표 셀 내부 그림/도형 우클릭 → "개체 속성" 다이얼로그 미표시.
//!
//! 본 task 의 핵심: 표 셀 내부 shape 에 대한 by_path WASM API 신규
//! (`get_cell_shape_properties_by_path_native`, `set_cell_shape_properties_by_path_native`).
//!
//! `samples/inner-table-01.hwp` 의 외부 표(8×2) 셀[5](r=2,c=1) 안 사각형 도형
//! (dump 출력: `ctrl[0] 사각형: tac=true, wrap=InFrontOfText`) 을 path 기반으로
//! 조회 + 변경 + 재조회 검증.

use rhwp::document_core::DocumentCore;

fn load_inner_table_01() -> DocumentCore {
    let bytes = std::fs::read("samples/inner-table-01.hwp").expect("read inner-table-01.hwp");
    DocumentCore::from_bytes(&bytes).expect("parse inner-table-01.hwp")
}

#[test]
fn cell_shape_properties_by_path_basic_get() {
    let core = load_inner_table_01();
    // dump 결과: 표 control_idx=2, 셀[5] (r=2,c=1), 셀 paragraph[0], 사각형 control[0]
    let path_json = r#"[{"controlIdx":2,"cellIdx":5,"cellParaIdx":0}]"#;
    let result = core.get_cell_shape_properties_by_path_native(0, 0, path_json, 0);
    assert!(
        result.is_ok(),
        "셀 안 사각형 properties 조회 실패: {:?}",
        result.err()
    );

    let props_json = result.unwrap();
    let props: serde_json::Value = serde_json::from_str(&props_json).expect("JSON 파싱");
    assert!(props.get("width").is_some(), "width 필드 부재");
    assert!(props.get("height").is_some(), "height 필드 부재");
    assert!(props.get("treatAsChar").is_some(), "treatAsChar 필드 부재");
    // sample 의 사각형은 tac=true (dump 결과)
    assert_eq!(props["treatAsChar"], serde_json::Value::Bool(true));
}

#[test]
fn cell_shape_properties_by_path_round_trip() {
    let mut core = load_inner_table_01();
    let path_json = r#"[{"controlIdx":2,"cellIdx":5,"cellParaIdx":0}]"#;

    // 1. 기존 props 조회
    let before = core
        .get_cell_shape_properties_by_path_native(0, 0, path_json, 0)
        .expect("초기 조회");
    let before_v: serde_json::Value = serde_json::from_str(&before).unwrap();
    let orig_width = before_v["width"].as_u64().expect("width u64") as u32;

    // 2. width 두 배로 변경
    let new_width = orig_width * 2;
    let props_update = format!(r#"{{"width":{}}}"#, new_width);
    let set_result =
        core.set_cell_shape_properties_by_path_native(0, 0, path_json, 0, &props_update);
    assert!(set_result.is_ok(), "변경 실패: {:?}", set_result.err());

    // 3. 재조회 — width 변경 반영
    let after = core
        .get_cell_shape_properties_by_path_native(0, 0, path_json, 0)
        .expect("변경 후 조회");
    let after_v: serde_json::Value = serde_json::from_str(&after).unwrap();
    let updated_width = after_v["width"].as_u64().expect("width u64") as u32;
    assert_eq!(updated_width, new_width, "width 변경 미반영");
}

#[test]
fn cell_shape_properties_by_path_invalid_json() {
    let core = load_inner_table_01();
    let result = core.get_cell_shape_properties_by_path_native(0, 0, "not-a-json", 0);
    assert!(result.is_err(), "잘못된 JSON 거부");
    let err_msg = format!("{:?}", result.err().unwrap());
    assert!(err_msg.contains("JSON 파싱") || err_msg.contains("파싱 실패"));
}

#[test]
fn cell_shape_properties_by_path_empty_path() {
    let core = load_inner_table_01();
    let result = core.get_cell_shape_properties_by_path_native(0, 0, "[]", 0);
    assert!(result.is_err(), "빈 path 거부");
    let err_msg = format!("{:?}", result.err().unwrap());
    assert!(err_msg.contains("비어"));
}

#[test]
fn cell_shape_properties_by_path_out_of_range_cell() {
    let core = load_inner_table_01();
    // cellIdx=999 — 표 셀 개수 초과
    let path_json = r#"[{"controlIdx":2,"cellIdx":999,"cellParaIdx":0}]"#;
    let result = core.get_cell_shape_properties_by_path_native(0, 0, path_json, 0);
    assert!(result.is_err(), "범위 초과 cellIdx 거부");
}

#[test]
fn cell_shape_properties_by_path_out_of_range_inner_ctrl() {
    let core = load_inner_table_01();
    // inner_control_idx=999 — 셀 paragraph 내 control 개수 초과
    let path_json = r#"[{"controlIdx":2,"cellIdx":5,"cellParaIdx":0}]"#;
    let result = core.get_cell_shape_properties_by_path_native(0, 0, path_json, 999);
    assert!(result.is_err(), "범위 초과 inner_control_idx 거부");
}

#[test]
fn cell_shape_properties_by_path_wrong_table_ctrl() {
    // controlIdx=0 (구역정의) — 표가 아님
    let core = load_inner_table_01();
    let path_json = r#"[{"controlIdx":0,"cellIdx":5,"cellParaIdx":0}]"#;
    let result = core.get_cell_shape_properties_by_path_native(0, 0, path_json, 0);
    assert!(result.is_err(), "controlIdx 가 표가 아닌 경우 거부");
}
