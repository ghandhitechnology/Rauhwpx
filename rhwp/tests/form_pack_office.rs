//! Rauhwpx 공문/품의 서식팩 — 열기·누름틀 채움·표 기하·HWPX 전용 저장.
#![cfg(not(target_arch = "wasm32"))]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use rhwp::document_core::DocumentCore;
use rhwp::form_pack::{
    default_filled_hwpx_path, document_pack_id, refuse_binary_hwp_export,
    snapshot_table_geometry, BRAND_PUMUI, PACK_ID, REFUSE_BINARY_HWP,
};

const PUMUI: &str = "form-pack/품의.hwpx";
const GONGMUN: &str = "form-pack/공문.hwpx";
const PUMUI_VALUES: &str = "form-pack/품의_예시값.json";

const PUMUI_FIELDS: &[&str] = &[
    "생산등록번호",
    "등록일",
    "공개구분",
    "결재직위1",
    "결재직위2",
    "결재직위3",
    "결재직위4",
    "협조자",
    "제목",
    "본문",
    "첨부",
    "기안자",
    "부서",
    "작성일",
];

fn pack(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn load(rel: &str) -> DocumentCore {
    let bytes = fs::read(pack(rel)).unwrap_or_else(|e| panic!("{} 읽기 실패: {e}", pack(rel).display()));
    DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("{} 파싱 실패: {e}", pack(rel).display()))
}

fn field_names(core: &DocumentCore) -> Vec<String> {
    core.collect_all_fields()
        .iter()
        .filter_map(|fi| fi.field.field_name().map(str::to_string))
        .collect()
}

fn nested_table_count(geom: &[rhwp::form_pack::TableGeometry]) -> usize {
    geom.iter()
        .map(|table| {
            table
                .cells
                .iter()
                .map(|cell| cell.nested.len() + nested_table_count(&cell.nested))
                .sum::<usize>()
        })
        .sum()
}

#[test]
fn pumui_form_is_openable_hwpx_with_nested_tables() {
    let core = load(PUMUI);
    assert_eq!(document_pack_id(core.document()), Some(PACK_ID), "품의에 팩 id 표식이 있어야 합니다");
    let names = field_names(&core);
    for required in PUMUI_FIELDS {
        assert!(names.contains(&required.to_string()), "누름틀 '{required}' 없음: {names:?}");
    }
    let geom = snapshot_table_geometry(core.document());
    assert!(
        nested_table_count(&geom) >= 2,
        "문서정보·결재란 중첩 표가 있어야 합니다: {geom:?}"
    );
}

#[test]
fn gongmun_form_is_openable_hwpx() {
    let core = load(GONGMUN);
    assert_eq!(document_pack_id(core.document()), Some(PACK_ID));
    let names = field_names(&core);
    for required in ["행정기관명", "수신자", "제목", "본문", "발신명의"] {
        assert!(names.contains(&required.to_string()), "{required} 없음: {names:?}");
    }
}

#[test]
fn filling_pumui_fields_keeps_nested_table_geometry() {
    let mut core = load(PUMUI);
    let before = snapshot_table_geometry(core.document());
    assert!(nested_table_count(&before) >= 2, "{before:?}");

    let values: serde_json::Map<String, serde_json::Value> = serde_json::from_str(
        &fs::read_to_string(pack(PUMUI_VALUES)).expect("예시값"),
    )
    .expect("JSON");
    for (name, value) in &values {
        let text = value.as_str().unwrap_or("");
        core.set_field_value_by_name(name, text)
            .unwrap_or_else(|e| panic!("필드 '{name}' 채움 실패: {e}"));
    }

    let after = snapshot_table_geometry(core.document());
    assert_eq!(before, after, "채운 뒤 표 격자·셀 크기·중첩 표가 그대로여야 합니다");
    assert!(
        core.document().sections.iter().any(|s| {
            s.paragraphs
                .iter()
                .any(|p| p.text.contains("사무용 비품") || paragraph_has(p, "사무용 비품"))
        }),
        "제목 값이 문서에 남아야 합니다"
    );
    let _ = BRAND_PUMUI;
}

fn paragraph_has(para: &rhwp::model::paragraph::Paragraph, needle: &str) -> bool {
    if para.text.contains(needle) {
        return true;
    }
    para.controls.iter().any(|c| match c {
        rhwp::model::control::Control::Table(table) => table
            .cells
            .iter()
            .any(|cell| cell.paragraphs.iter().any(|inner| paragraph_has(inner, needle))),
        _ => false,
    })
}

#[test]
fn form_pack_refuses_binary_hwp_output_path() {
    let core = load(PUMUI);
    let source = pack(PUMUI);
    let refused = refuse_binary_hwp_export(&source, Path::new("/tmp/품의.hwp"), core.document());
    assert_eq!(refused, Some(REFUSE_BINARY_HWP));
    let allowed = refuse_binary_hwp_export(&source, Path::new("/tmp/품의.hwpx"), core.document());
    assert_eq!(allowed, None);
    assert_eq!(
        default_filled_hwpx_path(&source).extension().and_then(|e| e.to_str()),
        Some("hwpx")
    );
}

#[test]
fn customer_file_named_gongmun_is_not_this_pack() {
    let customer = rhwp::model::document::Document::default();
    assert_eq!(document_pack_id(&customer), None);
    assert_eq!(
        refuse_binary_hwp_export(
            Path::new("/tmp/customer/공문.hwpx"),
            Path::new("/tmp/customer/공문.hwp"),
            &customer,
        ),
        None
    );
    assert_eq!(
        refuse_binary_hwp_export(
            Path::new("/tmp/customer/품의.hwpx"),
            Path::new("/tmp/out.hwp"),
            &customer,
        ),
        None
    );
}

#[test]
fn fill_fields_cli_refuses_hwp_output_for_form_pack() {
    let out = std::env::temp_dir().join(format!(
        "rhwp-form-pack-{}-{}.hwp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let source = pack(PUMUI);
    let data = pack(PUMUI_VALUES);
    let output = Command::new(env!("CARGO_BIN_EXE_rhwp"))
        .args([
            "edit",
            "fill-fields",
            source.to_str().unwrap(),
            "--data",
            &format!("@{}", data.display()),
            "-o",
            out.to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("rhwp 실행");
    assert_ne!(output.status.code(), Some(0), "바이너리 HWP 출력은 실패해야 합니다");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("HWPX") || stderr.contains("거부"),
        "거절 안내가 있어야 합니다: {stderr}"
    );
    assert!(!out.exists(), "거절 시 HWP 파일을 쓰면 안 됩니다");
}
