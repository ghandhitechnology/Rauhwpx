//! Issue #6872: HWPX 저장이 각주 numbering 토큰과 빈 장식 문자를 원본대로 보존한다.
//!
//! 파서가 `ON_PAGE` 와 `RESTART_PAGE` 를 둘 다 받으므로 rhwp 자기 왕복은 통과한다.
//! 한글은 `RESTART_*` 를 연속 번호로 떨어뜨리고, 빈 `suffixChar` 를 `)` 로 되돌린다.
//!
//! Rauhwpx 는 `tests/cases/` 가 아니라 `tests/issue_NNNN_*.rs` 를 쓴다.

use std::io::Read;

use rhwp::model::document::Document;
use rhwp::model::footnote::{FootnoteNumbering, NumberFormat};
use rhwp::parser::hwpx::parse_hwpx;
use rhwp::serializer::serialize_hwpx;

fn section0_xml(doc: &Document) -> String {
    let bytes = serialize_hwpx(doc).expect("HWPX 직렬화");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("zip 열기");
    let mut f = zip
        .by_name("Contents/section0.xml")
        .expect("Contents/section0.xml");
    let mut s = String::new();
    f.read_to_string(&mut s).expect("section0.xml 읽기");
    s
}

fn doc_with_one_section() -> Document {
    let mut doc = Document::default();
    if doc.sections.is_empty() {
        doc.sections.push(Default::default());
    }
    doc
}

#[test]
fn issue6872_numbering_emits_hancom_tokens() {
    let mut doc = doc_with_one_section();
    doc.sections[0].section_def.footnote_shape.numbering = FootnoteNumbering::RestartPage;
    doc.sections[0].section_def.endnote_shape.numbering = FootnoteNumbering::RestartSection;
    let xml = section0_xml(&doc);

    assert!(
        xml.contains(r#"<hp:numbering type="ON_PAGE""#),
        "쪽마다 재시작은 한컴 토큰 ON_PAGE 로 나가야 한다: {xml:.400}"
    );
    assert!(
        xml.contains(r#"<hp:numbering type="ON_SECTION""#),
        "구역마다 재시작은 ON_SECTION 으로 나가야 한다: {xml:.400}"
    );
    assert!(
        !xml.contains("RESTART_PAGE") && !xml.contains("RESTART_SECTION"),
        "한컴이 쓰지 않는 토큰을 내보내면 한글이 연속 번호로 떨어진다: {xml:.400}"
    );
}

#[test]
fn issue6872_source_empty_suffix_char_stays_empty() {
    let mut doc = doc_with_one_section();
    let fs = &mut doc.sections[0].section_def.footnote_shape;
    fs.number_format = NumberFormat::UserChar;
    fs.user_char = '*';
    fs.suffix_char = '\0';
    fs.deco_chars_from_source = true;
    let xml = section0_xml(&doc);

    assert!(
        xml.contains(r#"type="USER_CHAR" userChar="*" prefixChar="" suffixChar="""#),
        "원본이 비운 접미는 빈 채로 나가야 한다(`*` 가 `*)` 가 되지 않게): {xml:.600}"
    );

    let bytes = serialize_hwpx(&doc).expect("HWPX 직렬화");
    let parsed = parse_hwpx(&bytes).expect("왕복 파싱");
    let xml2 = section0_xml(&parsed);
    assert!(
        xml2.contains(r#"type="USER_CHAR" userChar="*" prefixChar="" suffixChar="""#),
        "파서가 빈 접미를 다시 읽은 뒤에도 빈 채로 나가야 한다: {xml2:.600}"
    );
}

#[test]
fn issue6872_unset_ir_keeps_template_suffix() {
    let doc = doc_with_one_section();
    let xml = section0_xml(&doc);

    assert!(
        xml.contains(r#"suffixChar=")""#),
        "IR 미설정은 템플릿 기본값 `)` 를 유지한다(#2742): {xml:.600}"
    );
    assert!(
        !xml.contains(r#"suffixChar="""#),
        "미설정을 빈 값으로 내보내면 #2742 계약이 깨진다: {xml:.600}"
    );
}
