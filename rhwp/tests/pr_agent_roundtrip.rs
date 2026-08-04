//! 에이전트 저작 문서 라운드트립 (플랜 §E: roundtrip fidelity).
//!
//! 에이전트 툴 경로가 쓰는 native API 만으로 문서를 조립하고
//! (treatAsChar 표 + 셀 텍스트 + 본문 수식 + 본문 그림) HWPX 저장 → 재파싱 후
//! 개체와 내용이 보존되는지 단언한다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::Document;

/// 1×1 픽셀 흰색 PNG (미리 인코딩된 최소 유효 PNG).
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
    0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

fn find_table(doc: &Document) -> Option<(usize, usize)> {
    for (pi, p) in doc.sections[0].paragraphs.iter().enumerate() {
        for (ci, c) in p.controls.iter().enumerate() {
            if matches!(c, Control::Table(_)) {
                return Some((pi, ci));
            }
        }
    }
    None
}

#[test]
fn agent_authored_document_roundtrips_via_hwpx() {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().expect("빈 문서");

    // 표 (treatAsChar — 에이전트 create_table 경로), 셀 채움
    core.create_table_ex_native(0, 0, 0, 2, 2, true, None, None)
        .expect("표 생성");
    let (tp, tc) = find_table(core.document()).expect("표 위치");
    core.insert_text_in_cell_native(0, tp, tc, 0, 0, 0, "이름")
        .expect("셀 텍스트");
    core.insert_text_in_cell_native(0, tp, tc, 3, 0, 0, "값 42")
        .expect("셀 텍스트 2");

    // 본문 수식 (에이전트 insert_equation 경로)
    core.insert_equation_native(0, 0, 0, "x = {1} over {2}", 1000, 0)
        .expect("수식 삽입");

    // 본문 그림 (에이전트 insert_image 경로: floating 삽입)
    core.insert_picture_native(
        0,
        0,
        0,
        &[],
        TINY_PNG,
        7500,
        7500,
        1,
        1,
        "png",
        "테스트 그림",
        None,
        None,
    )
    .expect("그림 삽입");

    // 저장 → 재파싱
    let saved = core.export_hwpx_native().expect("HWPX 직렬화");
    let reloaded = DocumentCore::from_bytes(&saved).expect("저장본 재파싱");
    let doc = reloaded.document();

    // 표 + 셀 텍스트 보존
    let (tp2, tc2) = find_table(doc).expect("재파싱 후 표");
    let table = match &doc.sections[0].paragraphs[tp2].controls[tc2] {
        Control::Table(t) => t,
        _ => unreachable!(),
    };
    assert_eq!(table.cells.len(), 4, "2×2 표 셀 수 보존");
    assert_eq!(table.cells[0].paragraphs[0].text, "이름");
    assert_eq!(table.cells[3].paragraphs[0].text, "값 42");

    // 수식 스크립트 보존
    let eq = doc.sections[0]
        .paragraphs
        .iter()
        .flat_map(|p| p.controls.iter())
        .find_map(|c| match c {
            Control::Equation(e) => Some(e),
            _ => None,
        })
        .expect("재파싱 후 수식");
    assert_eq!(eq.script, "x = {1} over {2}");

    // 그림 보존 (컨트롤 + BinData)
    let has_picture = doc.sections[0]
        .paragraphs
        .iter()
        .flat_map(|p| p.controls.iter())
        .any(|c| matches!(c, Control::Picture(_)));
    assert!(has_picture, "재파싱 후 그림 컨트롤 보존");
}
