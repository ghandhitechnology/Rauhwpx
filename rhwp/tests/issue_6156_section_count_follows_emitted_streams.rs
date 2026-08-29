//! [Issue #6156] `DOCUMENT_PROPERTIES.section_count` 가 실제 방출 구역 수에서
//! 유도되지 않아 한글이 문서를 손상으로 판정한다.
//!
//! 한글은 이 값을 `BodyText/SectionN` 탐색의 상한으로 읽는다. 선언값이 실제 스트림
//! 수보다 크면 없는 구역을 찾다가 손상 판정을 내고 `forceopen` 으로도 열리지 않는다
//! (실측: 선언 2 / 스트림 1 → 한컴 COM `Open` 실패).
//!
//! 종전 직렬화기는 저장된 `props.section_count` / raw DocInfo 통과 값을 그대로
//! 썼다. 입력 IR 이 이미 어긋난 경우(선언 2 / IR 구역 1)나 구역을 더하거나 빼는
//! 편집은 불일치를 산출물에 남겼다.
//!
//! 계약: 저장 산출물의 선언 구역 수 == 실제 방출한 `BodyText/SectionN` 스트림 수.
//! 입력 모델이 무엇을 선언했든, 어느 경로(스트림 raw 통과 · 레코드 raw 통과 ·
//! 모델 writer)를 타든 같다.

use rhwp::model::document::{DocInfo, DocProperties, Document, Section};
use rhwp::model::paragraph::Paragraph;
use rhwp::parser::cfb_reader::CfbReader;
use rhwp::parser::doc_info::parse_doc_info;
use rhwp::serializer::cfb_writer::serialize_hwp;
use rhwp::serializer::doc_info::serialize_doc_info;

fn sample_props(section_count: u16) -> DocProperties {
    DocProperties {
        section_count,
        page_start_num: 1,
        footnote_start_num: 1,
        endnote_start_num: 1,
        picture_start_num: 1,
        table_start_num: 1,
        equation_start_num: 1,
        raw_data: None,
        caret_list_id: 0,
        caret_para_id: 0,
        caret_char_pos: 0,
    }
}

fn section_with_para() -> Section {
    Section {
        paragraphs: vec![Paragraph::default()],
        ..Default::default()
    }
}

fn document_with(section_count_field: u16, n_sections: usize, doc_info: DocInfo) -> Document {
    Document {
        doc_properties: sample_props(section_count_field),
        doc_info,
        sections: (0..n_sections).map(|_| section_with_para()).collect(),
        ..Default::default()
    }
}

fn declared_and_stream_count(bytes: &[u8]) -> (u16, u32) {
    let mut cfb = CfbReader::open(bytes).expect("CFB 열기");
    let doc_info = cfb.read_doc_info(false).expect("DocInfo 읽기");
    let (_, props) = parse_doc_info(&doc_info).expect("DocInfo 파싱");
    (props.section_count, cfb.section_count())
}

fn assert_declared_matches_streams(bytes: &[u8], expected: u16) {
    let (declared, streams) = declared_and_stream_count(bytes);
    assert_eq!(
        streams, expected as u32,
        "방출 BodyText/SectionN 스트림 수가 기대와 다름"
    );
    assert_eq!(
        declared, expected,
        "선언 구역 수가 실제 방출 스트림 수에서 유도되지 않았다 — 한글 손상 판정 형상"
    );
}

/// 선언값이 실제보다 큰 입력 — DocInfo 스트림 raw 통과 경로.
///
/// 원본을 파싱하면 `DocInfo.raw_stream` 이 봉인된 채로 실려 온다. 구역만 덜어내면
/// 모델의 선언값(2)은 그대로이고 스트림은 1개가 되므로, 보정이 없으면 원본
/// 선언값이 그대로 통과해 한글이 손상 판정을 낸다.
#[test]
fn issue_6156_raw_stream_passthrough_overcount_is_corrected() {
    let props = sample_props(2);
    let mut doc_info = DocInfo::default();
    let sealed = serialize_doc_info(&doc_info, &props);
    doc_info.raw_stream = Some(sealed);
    doc_info.raw_stream_dirty = false;

    let doc = document_with(2, 1, doc_info);
    let bytes = serialize_hwp(&doc).expect("serialize");
    assert_declared_matches_streams(&bytes, 1);
}

/// 레코드 raw_data 통과 경로 — 스트림 봉인은 깨졌지만 DOCUMENT_PROPERTIES
/// 원본 바이트는 그대로라 선언 2가 다시 실려 나간다.
#[test]
fn issue_6156_record_raw_data_passthrough_overcount_is_corrected() {
    let mut props = sample_props(2);
    let raw = rhwp::serializer::doc_info::serialize_document_properties(&props);
    props.raw_data = Some(raw);
    props.section_count = 2;

    let mut doc_info = DocInfo::default();
    doc_info.raw_stream_dirty = true;

    let doc = Document {
        doc_properties: props,
        doc_info,
        sections: vec![section_with_para()],
        ..Default::default()
    };
    let bytes = serialize_hwp(&doc).expect("serialize");
    assert_declared_matches_streams(&bytes, 1);
}

/// 모델 writer 경로 — raw 캐시 없는 합성 IR 도 같은 계약을 지킨다.
#[test]
fn issue_6156_synthetic_ir_declared_count_follows_streams() {
    let doc = document_with(3, 1, DocInfo::default());
    let bytes = serialize_hwp(&doc).expect("serialize");
    assert_declared_matches_streams(&bytes, 1);
}

/// 구역을 더하면 선언 값도 늘어난다.
#[test]
fn issue_6156_adding_a_section_updates_declared_count() {
    let mut doc = document_with(1, 1, DocInfo::default());
    doc.sections.push(section_with_para());
    // 편집 경로를 모사: 모델 필드는 갱신하지 않는다.
    assert_eq!(doc.doc_properties.section_count, 1);

    let bytes = serialize_hwp(&doc).expect("serialize");
    assert_declared_matches_streams(&bytes, 2);
}

/// 정상 문서는 값이 바뀌지 않는다 — 보정이 멀쩡한 왕복을 흔들지 않는지.
#[test]
fn issue_6156_well_formed_document_keeps_its_count() {
    let doc = document_with(2, 2, DocInfo::default());
    let bytes = serialize_hwp(&doc).expect("serialize");
    assert_declared_matches_streams(&bytes, 2);
}

/// DOCUMENT_PROPERTIES 가 없는 병리 raw 스트림은 봉인을 깨고 재생성한다.
#[test]
fn issue_6156_pathological_raw_stream_rewrites_doc_info() {
    let mut doc_info = DocInfo::default();
    doc_info.raw_stream = Some(vec![0, 1, 2, 3]);
    doc_info.raw_stream_dirty = false;

    let doc = document_with(9, 1, doc_info);
    let bytes = serialize_hwp(&doc).expect("serialize");
    assert_declared_matches_streams(&bytes, 1);
}
