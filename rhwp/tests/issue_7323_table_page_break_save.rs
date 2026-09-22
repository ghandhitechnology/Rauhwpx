#![cfg(not(target_arch = "wasm32"))]

use rhwp::model::control::Control;
use rhwp::model::document::Document;
use rhwp::model::table::{Table, TablePageBreak};
use rhwp::parser::parse_document;
use rhwp::serializer::serialize_document;
use rhwp::wasm_api::HwpDocument;
use std::path::Path;

const SAMPLE: &str = "samples/2010-01-06.hwp";
const SEC: u32 = 0;
const PARA: u32 = 4;
const CTRL: u32 = 0;

fn sample_bytes() -> Vec<u8> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    std::fs::read(&p).unwrap_or_else(|e| panic!("fixture 읽기 실패 {SAMPLE}: {e}"))
}

fn table_at(doc: &Document) -> &Table {
    match doc.sections[SEC as usize].paragraphs[PARA as usize]
        .controls
        .get(CTRL as usize)
    {
        Some(Control::Table(t)) => t,
        other => panic!("fixture 구조 변경: s{SEC} p{PARA} c{CTRL} 가 표가 아님 ({other:?})"),
    }
}

fn table_at_mut(doc: &mut Document) -> &mut Table {
    match doc.sections[SEC as usize].paragraphs[PARA as usize]
        .controls
        .get_mut(CTRL as usize)
    {
        Some(Control::Table(t)) => t,
        other => panic!("fixture 구조 변경: s{SEC} p{PARA} c{CTRL} 가 표가 아님 ({other:?})"),
    }
}

fn edit_and_roundtrip(json: &str) -> (u32, Document) {
    let mut doc =
        HwpDocument::from_bytes(&sample_bytes()).unwrap_or_else(|e| panic!("파싱: {e:?}"));
    let raw_before = table_at(doc.document()).raw_table_record_attr;
    assert_ne!(
        raw_before, 0,
        "전제 붕괴: fixture 표의 raw_table_record_attr 가 0이면 재구성 경로라 이 축이 아니다",
    );
    doc.set_table_properties(SEC, PARA, CTRL, json)
        .unwrap_or_else(|e| panic!("set_table_properties: {e:?}"));
    let out = serialize_document(doc.document()).unwrap_or_else(|e| panic!("HWP5 직렬화: {e:?}"));
    let reparsed = parse_document(&out).unwrap_or_else(|e| panic!("HWP5 재파싱: {e:?}"));
    (raw_before, reparsed)
}

#[test]
fn page_break_edit_survives_hwp5_save() {
    for (value, want) in [
        (0, TablePageBreak::None),
        (1, TablePageBreak::CellBreak),
        (2, TablePageBreak::RowBreak),
    ] {
        let (raw_before, reparsed) = edit_and_roundtrip(&format!(r#"{{"pageBreak":{value}}}"#));
        let t = table_at(&reparsed);
        assert_eq!(
            t.page_break, want,
            "pageBreak={value} 편집이 HWP5 저장에서 유실됨 (원본 attr {raw_before:#010x} → 재파싱 {:#010x})",
            t.raw_table_record_attr,
        );
        assert_eq!(
            t.raw_table_record_attr & !0x03,
            raw_before & !0x03,
            "pageBreak 편집이 bit 0-1 밖의 attr 비트를 바꿨다",
        );
    }
}

#[test]
fn repeat_header_edit_survives_hwp5_save() {
    let original = parse_document(&sample_bytes()).unwrap_or_else(|e| panic!("원본 파싱: {e:?}"));
    let want = !table_at(&original).repeat_header;

    let (raw_before, reparsed) = edit_and_roundtrip(&format!(r#"{{"repeatHeader":{want}}}"#));
    let t = table_at(&reparsed);
    assert_eq!(
        t.repeat_header, want,
        "repeatHeader={want} 편집이 HWP5 저장에서 유실됨 (원본 attr {raw_before:#010x} → 재파싱 {:#010x})",
        t.raw_table_record_attr,
    );
    assert_eq!(
        t.raw_table_record_attr & !0x04,
        raw_before & !0x04,
        "repeatHeader 편집이 bit 2 밖의 attr 비트를 바꿨다",
    );
}

#[test]
fn unsynced_ir_edit_survives_hwp5_save() {
    let mut original =
        parse_document(&sample_bytes()).unwrap_or_else(|e| panic!("원본 파싱: {e:?}"));
    let raw_before = table_at(&original).raw_table_record_attr;
    assert_ne!(
        raw_before, 0,
        "전제 붕괴: fixture 표의 raw_table_record_attr 가 0"
    );
    {
        let t = table_at_mut(&mut original);
        t.page_break = TablePageBreak::CellBreak;
        t.repeat_header = false;
    }
    original.sections[SEC as usize].raw_stream = None;
    let out = serialize_document(&original).unwrap_or_else(|e| panic!("HWP5 직렬화: {e:?}"));
    let reparsed = parse_document(&out).unwrap_or_else(|e| panic!("HWP5 재파싱: {e:?}"));
    let t = table_at(&reparsed);
    assert_eq!(
        t.page_break,
        TablePageBreak::CellBreak,
        "동기화 없는 IR pageBreak 편집이 HWP5 저장에서 유실됨 (원본 attr {raw_before:#010x} → 재파싱 {:#010x})",
        t.raw_table_record_attr,
    );
    assert!(
        !t.repeat_header,
        "동기화 없는 IR repeatHeader 편집이 HWP5 저장에서 유실됨 (원본 attr {raw_before:#010x} → 재파싱 {:#010x})",
        t.raw_table_record_attr,
    );
    assert_eq!(
        t.raw_table_record_attr & !0x07,
        raw_before & !0x07,
        "IR 편집이 bit 0-2 밖의 attr 비트를 바꿨다",
    );
}

#[test]
fn unedited_table_record_attr_is_preserved() {
    let bytes = sample_bytes();
    let original = parse_document(&bytes).unwrap_or_else(|e| panic!("원본 파싱: {e:?}"));
    let out = serialize_document(&original).unwrap_or_else(|e| panic!("HWP5 직렬화: {e:?}"));
    let reparsed = parse_document(&out).unwrap_or_else(|e| panic!("HWP5 재파싱: {e:?}"));
    assert_eq!(
        table_at(&reparsed).raw_table_record_attr,
        table_at(&original).raw_table_record_attr,
        "무편집 표의 attr 가 저장 왕복에서 바뀌었다",
    );
}
