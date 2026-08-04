//! Issue #838: ClickHere 필드 값 설정 시 paragraph metadata 보존
//!
//! 재현: field-01.hwp의 빈 ClickHere range에 값을 삽입한 뒤 HWP로 직렬화하면
//! `char_count`, `char_offsets`, `field_ranges`가 함께 갱신되어야 한다.

use std::fs;
use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::model::control::FieldType;

#[test]
fn set_field_value_updates_empty_click_here_range() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwp_path = Path::new(repo_root).join("samples/field-01.hwp");
    let bytes =
        fs::read(&hwp_path).unwrap_or_else(|e| panic!("read {}: {}", hwp_path.display(), e));

    let mut core = DocumentCore::from_bytes(&bytes).expect("parse field-01.hwp");

    let fields = core.collect_all_fields();
    assert!(!fields.is_empty(), "field-01.hwp should contain fields");

    let first_field = &fields[0];
    let field_name = first_field.field.field_name().unwrap_or("");
    assert!(!field_name.is_empty(), "first field should have a name");

    let result = core.set_field_value_by_name(field_name, "테스트회사");
    assert!(
        result.is_ok(),
        "set_field_value_by_name failed: {:?}",
        result.err()
    );

    let fields_after = core.collect_all_fields();
    let updated = fields_after
        .iter()
        .find(|f| f.field.field_name() == Some(field_name))
        .expect("field should still exist after set");

    // 핵심 검증: 빈 ClickHere range가 설정한 값만 포함하도록 확장되어야 한다.
    assert_eq!(
        updated.value, "테스트회사",
        "field value should be exactly the set value; got: '{}'",
        updated.value
    );
}

#[test]
fn set_field_value_roundtrips_two_empty_click_here_fields() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwp_path = Path::new(repo_root).join("samples/field-01.hwp");
    let bytes =
        fs::read(&hwp_path).unwrap_or_else(|e| panic!("read {}: {}", hwp_path.display(), e));

    let mut core = DocumentCore::from_bytes(&bytes).expect("parse field-01.hwp");
    let fields = core.collect_all_fields();
    let empty_fields: Vec<_> = fields
        .iter()
        .filter(|f| f.field.field_type == FieldType::ClickHere && f.value.is_empty())
        .collect();
    assert!(
        empty_fields.len() >= 2,
        "field-01.hwp should contain at least two empty ClickHere fields"
    );

    let id1 = empty_fields[0].field.field_id;
    let id2 = empty_fields[1].field.field_id;
    core.set_field_value_by_id(id1, "테스트회사")
        .expect("set first field");
    core.set_field_value_by_id(id2, "테스트작성자")
        .expect("set second field");

    for para_index in [7, 8] {
        let para = &core.document().sections[0].paragraphs[para_index];
        assert_eq!(
            para.char_offsets.len(),
            para.text.chars().count(),
            "para {para_index} char_offsets must match text chars"
        );
    }

    let saved = core.export_hwp_native().expect("export hwp");
    if let Ok(output_path) = std::env::var("RHWP_ISSUE838_OUT") {
        if let Some(parent) = Path::new(&output_path).parent() {
            fs::create_dir_all(parent).expect("create output parent");
        }
        fs::write(&output_path, &saved).expect("write issue #838 output hwp");
    }
    let reparsed = DocumentCore::from_bytes(&saved).expect("reparse exported hwp");
    let reparsed_fields = reparsed.collect_all_fields();
    let first = reparsed_fields
        .iter()
        .find(|f| f.field.field_id == id1)
        .expect("first field after reparse");
    let second = reparsed_fields
        .iter()
        .find(|f| f.field.field_id == id2)
        .expect("second field after reparse");

    assert_eq!(first.value, "테스트회사");
    assert_eq!(second.value, "테스트작성자");
    assert!(reparsed.document().sections[0].paragraphs[7]
        .text
        .starts_with("회사명\t\t: "));
    assert!(reparsed.document().sections[0].paragraphs[8]
        .text
        .starts_with("작성자\t\t: "));
}
