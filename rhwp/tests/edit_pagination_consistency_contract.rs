//! 편집 → 저장 → 재열기 쪽수 정합 계약.
//!
//! 편집 직후 편집기가 보여주는 쪽수와, HWPX 로 저장해 다시 연 쪽수는 같아야 한다.
//! 50개 대형 HWPX 편집 스트레스 스윕에서 세 갈래의 표류가 확인되어 고정한다:
//!
//! 1. 흐름 영향 글자 서식(apply_char_format_native)이 line_segs 를 비우고
//!    리플로우해 흐름 앵커(vertical_pos)를 0 으로 만들던 문제 — 문서 중간의
//!    vpos=0 은 저장흐름 리셋으로 읽혀 가짜 페이지가 생겼다.
//! 2. 쪽 나눔 삽입(insert_page_break_native)이 문단 삽입 후 측정 캐시 인덱스를
//!    밀지 않아 삽입점 뒤의 표가 이웃 표의 측정 geometry 를 재사용하던 문제 —
//!    표 밀집 문서에서 쪽수가 오히려 줄었다 (29 → 27).
//! 3. 표 행 삽입/삭제(insert/delete_table_row_native)가 TAC 표 높이 변경을 host
//!    문단 LINE_SEG 에 동기화하지 않던 문제 — 재파싱 시 구역 전체 vpos 사다리가
//!    재계산되어 편집 지점보다 앞선 쪽 경계까지 이동했다.

use rhwp::wasm_api::HwpDocument;

fn load(name: &str) -> HwpDocument {
    let bytes = std::fs::read(format!("samples/{name}")).expect("샘플 읽기");
    HwpDocument::from_bytes(&bytes).expect("샘플 파싱")
}

fn reparse_pages(doc: &HwpDocument) -> u32 {
    let out = doc.export_hwpx_native().expect("HWPX 직렬화");
    HwpDocument::from_bytes(&out).expect("재파싱").page_count()
}

/// 흐름 영향 글자 서식 편집 후 쪽수가 저장/재열기와 일치한다 (표류 1).
/// 수정 전: 복학원서에서 fontSize 편집 하나로 편집본 2쪽 / 재파싱 1쪽.
/// (글자가 커져 쪽이 실제로 늘어나는 것은 정당하다 — 계약은 저장·재열기 일치다.)
#[test]
fn char_format_flow_edit_keeps_saved_page_count() {
    let mut doc = load("복학원서.hwpx");
    doc.apply_char_format_native(0, 6, 0, 8, r#"{"fontSize":1600}"#)
        .expect("글자 크기 적용");
    assert_eq!(
        doc.page_count(),
        reparse_pages(&doc),
        "편집본 쪽수와 저장·재열기 쪽수가 달라지면 안 된다"
    );
}

/// 쪽 나눔 삽입은 쪽수를 늘리고, 저장/재열기와 일치한다 (표류 2).
/// 수정 전: hwpx_sample2 에서 29쪽 → 27쪽(감소), 재파싱은 30쪽.
#[test]
fn page_break_insert_grows_pages_and_matches_reparse() {
    let mut doc = load("hwpx_sample2.hwpx");
    let before = doc.page_count();
    doc.insert_page_break_native(0, 34, 0)
        .expect("쪽 나눔 삽입");
    let after = doc.page_count();
    assert!(
        after > before,
        "쪽 나눔 삽입 후 쪽수가 늘어야 한다: {before} → {after}"
    );
    assert_eq!(
        after,
        reparse_pages(&doc),
        "편집본 쪽수와 저장·재열기 쪽수가 달라지면 안 된다"
    );
}

/// 표 행 삽입/삭제 후 쪽수가 저장/재열기와 일치한다 (표류 3).
#[test]
fn table_row_insert_delete_keeps_saved_page_count() {
    let mut doc = load("복학원서.hwpx");
    doc.insert_table_row_native(0, 2, 0, 0, true)
        .expect("행 삽입");
    assert_eq!(
        doc.page_count(),
        reparse_pages(&doc),
        "행 삽입 후 편집본 쪽수와 저장·재열기 쪽수가 달라지면 안 된다"
    );
    doc.delete_table_row_native(0, 2, 0, 1).expect("행 삭제");
    assert_eq!(
        doc.page_count(),
        reparse_pages(&doc),
        "행 삭제 후 편집본 쪽수와 저장·재열기 쪽수가 달라지면 안 된다"
    );
}
