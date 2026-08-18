//! 표 쪽나눔·캡션·계산식 서식 계약 테스트.
//!
//! 1. 새 표는 한컴 기본값 "쪽 경계에서: 나눔"(RowBreak)으로 생성된다 — 본문보다
//!    커진 표가 쪽 하단에서 잘리거나 꼬리말을 덮는 대신 다음 쪽으로 이어진다.
//! 2. `pageBreak`/`repeatHeader` 편집이 HWP5 저장·재로드 후에도 살아남는다.
//!    (회귀: `raw_table_record_attr` 를 동기화하지 않아 편집이 저장 시 유실.)
//! 3. 캡션 생성/삭제가 표의 쪽나눔 설정을 오염시키지 않는다.
//!    (회귀: ctrl 헤더 attr 를 HWPTAG_TABLE record attr 에 그대로 덮어씀.)
//! 4. 편집으로 본문보다 커진 쪽나눔=None 표는 자동으로 "나눔"으로 승격된다.
//! 5. 캡션 텍스트 설정/조회, 계산식 결과 서식(`decimalPlaces`/`thousandsSeparator`/
//!    `prefix`/`suffix`) 계약.

use rhwp::model::control::Control;
use rhwp::model::table::TablePageBreak;
use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

/// 본문 첫 표의 (para_idx, ctrl_idx)를 찾는다.
fn find_first_table(doc: &rhwp::model::document::Document) -> Option<(usize, usize)> {
    let section = doc.sections.first()?;
    for (pi, para) in section.paragraphs.iter().enumerate() {
        for (ci, ctrl) in para.controls.iter().enumerate() {
            if matches!(ctrl, Control::Table(_)) {
                return Some((pi, ci));
            }
        }
    }
    None
}

fn table_at(
    doc: &rhwp::model::document::Document,
    para_idx: usize,
    ctrl_idx: usize,
) -> &rhwp::model::table::Table {
    match &doc.sections[0].paragraphs[para_idx].controls[ctrl_idx] {
        Control::Table(t) => t,
        other => panic!("표가 아님: {:?}", std::mem::discriminant(other)),
    }
}

fn blank_doc_with_table() -> (HwpDocument, usize, usize) {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native()
        .expect("빈 문서 생성 실패");
    doc.create_table_native(0, 0, 0, 2, 2)
        .expect("표 생성 실패");
    let (pi, ci) = find_first_table(doc.document()).expect("생성한 표를 찾지 못함");
    (doc, pi, ci)
}

#[test]
fn new_table_defaults_to_row_break() {
    let (doc, pi, ci) = blank_doc_with_table();
    assert_eq!(
        table_at(doc.document(), pi, ci).page_break,
        TablePageBreak::RowBreak,
        "새 표의 쪽나눔 기본값은 한컴과 같은 '나눔'(RowBreak)이어야 한다"
    );
}

#[test]
fn page_break_edit_survives_hwp5_roundtrip() {
    let bytes = std::fs::read("samples/hwp_table_test.hwp").expect("샘플 로드 실패");
    let mut core = HwpDocument::from_bytes(&bytes).expect("HWP5 파싱 실패");
    let (pi, ci) = find_first_table(core.document()).expect("샘플에 표 없음");

    // 실제 .hwp 에서 파싱된 표는 원본 record attr 를 보존한다 — 이 전제가 있어야
    // "raw 가 편집을 덮어쓰는" 회귀를 검증한다.
    assert_ne!(
        table_at(core.document(), pi, ci).raw_table_record_attr,
        0,
        "샘플 표에 원본 record attr 가 보존되어 있어야 한다"
    );

    core.set_table_properties(
        0,
        pi as u32,
        ci as u32,
        "{\"pageBreak\":2,\"repeatHeader\":true}",
    )
    .expect("표 속성 수정 실패");

    let saved = core.export_hwp().expect("HWP5 직렬화 실패");
    let reloaded = HwpDocument::from_bytes(&saved).expect("저장본 재파싱 실패");
    let (rpi, rci) = find_first_table(reloaded.document()).expect("저장본에 표 없음");
    let table = table_at(reloaded.document(), rpi, rci);
    assert_eq!(
        table.page_break,
        TablePageBreak::RowBreak,
        "쪽나눔 편집이 HWP5 저장·재로드 후에도 유지되어야 한다"
    );
    assert!(
        table.repeat_header,
        "제목 줄 반복 편집이 HWP5 저장·재로드 후에도 유지되어야 한다"
    );
}

#[test]
fn caption_toggle_preserves_page_break_on_hwp5_save() {
    let bytes = std::fs::read("samples/hwp_table_test.hwp").expect("샘플 로드 실패");
    let mut core = HwpDocument::from_bytes(&bytes).expect("HWP5 파싱 실패");
    let (pi, ci) = find_first_table(core.document()).expect("샘플에 표 없음");
    let before_pb = table_at(core.document(), pi, ci).page_break;
    let before_rh = table_at(core.document(), pi, ci).repeat_header;

    core.set_table_properties(0, pi as u32, ci as u32, "{\"hasCaption\":true}")
        .expect("캡션 생성 실패");

    let saved = core.export_hwp().expect("HWP5 직렬화 실패");
    let reloaded = HwpDocument::from_bytes(&saved).expect("저장본 재파싱 실패");
    let (rpi, rci) = find_first_table(reloaded.document()).expect("저장본에 표 없음");
    let table = table_at(reloaded.document(), rpi, rci);
    assert_eq!(
        table.page_break, before_pb,
        "캡션 생성이 쪽나눔 설정을 바꾸면 안 된다"
    );
    assert_eq!(
        table.repeat_header, before_rh,
        "캡션 생성이 제목 줄 반복 설정을 바꾸면 안 된다"
    );
}

#[test]
fn oversized_none_table_auto_upgrades_to_row_break() {
    let (mut doc, pi, ci) = blank_doc_with_table();

    // 명시적으로 '나누지 않음'으로 되돌린 뒤, 본문(약 65,700 HWPUNIT)보다 크게 키운다.
    doc.set_table_properties(0, pi as u32, ci as u32, "{\"pageBreak\":0}")
        .expect("쪽나눔 해제 실패");
    assert_eq!(
        table_at(doc.document(), pi, ci).page_break,
        TablePageBreak::None
    );

    // 아직 본문 이하 — 승격되지 않아야 한다.
    doc.set_cell_properties(0, pi as u32, ci as u32, 0, "{\"height\":60000}")
        .expect("셀 높이 설정 실패");
    assert_eq!(
        table_at(doc.document(), pi, ci).page_break,
        TablePageBreak::None,
        "본문 높이 이하인 표는 승격되면 안 된다"
    );

    // 행 삽입(60000 높이 행 복제)으로 본문을 넘어서면 자동 승격된다.
    doc.insert_table_row(0, pi as u32, ci as u32, 0, true)
        .expect("행 삽입 실패");
    assert_eq!(
        table_at(doc.document(), pi, ci).page_break,
        TablePageBreak::RowBreak,
        "편집으로 본문보다 커진 쪽나눔=None 표는 '나눔'으로 자동 승격되어야 한다"
    );
}

#[test]
fn caption_text_set_and_read() {
    let (mut doc, pi, ci) = blank_doc_with_table();

    let result = doc
        .set_table_caption_text(0, pi as u32, ci as u32, "예산 내역", true)
        .expect("캡션 텍스트 설정 실패");
    let parsed: Value = serde_json::from_str(&result).expect("결과 JSON 파싱 실패");
    let text = parsed["captionText"].as_str().expect("captionText 없음");
    assert!(
        text.contains("표") && text.contains('1') && text.contains("예산 내역"),
        "자동 번호 포함 캡션이어야 한다: {text:?}"
    );

    let props = doc
        .get_table_properties(0, pi as u32, ci as u32)
        .expect("표 속성 조회 실패");
    let props: Value = serde_json::from_str(&props).expect("속성 JSON 파싱 실패");
    assert_eq!(props["hasCaption"], true);
    assert_eq!(props["captionNumber"], 1);
    assert_eq!(props["captionText"].as_str(), Some(text));

    // 번호 없이 덮어쓰기.
    let result = doc
        .set_table_caption_text(0, pi as u32, ci as u32, "요약", false)
        .expect("캡션 텍스트 재설정 실패");
    let parsed: Value = serde_json::from_str(&result).expect("결과 JSON 파싱 실패");
    assert_eq!(parsed["captionText"].as_str(), Some("요약"));
}

#[test]
fn formula_result_honors_number_format() {
    let (mut doc, pi, ci) = blank_doc_with_table();

    let result = doc
        .evaluate_table_formula_formatted(
            0,
            pi,
            ci,
            1,
            1,
            "=1234.5+1000",
            true,
            "{\"decimalPlaces\":2,\"thousandsSeparator\":true,\"suffix\":\"원\"}",
        )
        .expect("계산식 실행 실패");
    let parsed: Value = serde_json::from_str(&result).expect("결과 JSON 파싱 실패");
    assert_eq!(parsed["result"], 2234.5);
    assert_eq!(parsed["display"].as_str(), Some("2,234.50원"));

    let table = table_at(doc.document(), pi, ci);
    let cell = table
        .cells
        .iter()
        .find(|c| c.row == 1 && c.col == 1)
        .expect("대상 셀 없음");
    assert_eq!(
        cell.paragraphs[0].text, "2,234.50원",
        "서식 적용된 결과가 셀에 기록되어야 한다"
    );
}
