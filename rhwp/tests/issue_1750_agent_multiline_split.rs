//! Task #1750 후속: 에이전트 다줄 삽입의 문단 분할 의미 회귀.
//!
//! `samples/task1750/split_guard_spacing_before.*` 는 1쪽 말미 spacing_before
//! 경계(pi=22 가 2쪽 시작)를 가진 실문서다. 논리 continuation 분할(에이전트
//! 다줄 삽입)은 저작된 쪽 나눔·문단 순서·쪽 밀도·저장 재열기 쪽수를 보존해야
//! 하고, Enter 분할은 종전 상속 의미를 유지해야 한다.

use rhwp::wasm_api::HwpDocument;

const HWP: &str = "samples/task1750/split_guard_spacing_before.hwp";
const HWPX: &str = "samples/task1750/split_guard_spacing_before.hwpx";

fn load(path: &str) -> HwpDocument {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let mut doc = HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {path}: {e}"));
    if path.ends_with(".hwp") {
        doc.convert_to_editable_native()
            .unwrap_or_else(|e| panic!("convert {path}: {e:?}"));
    }
    doc
}

/// 텍스트가 충분한 첫 본문 문단 인덱스.
fn first_text_para(doc: &HwpDocument) -> usize {
    let count = doc.get_paragraph_count_native(0).expect("문단 수");
    for pi in 0..count {
        if doc.get_paragraph_length_native(0, pi).unwrap_or(0) >= 4 {
            return pi;
        }
    }
    panic!("텍스트 문단이 없다");
}

fn body_text(doc: &HwpDocument) -> String {
    let count = doc.get_paragraph_count_native(0).expect("문단 수");
    let mut out = String::new();
    for pi in 0..count {
        let len = doc.get_paragraph_length_native(0, pi).unwrap_or(0);
        out.push_str(&doc.get_text_range_native(0, pi, 0, len).unwrap_or_default());
        out.push('\n');
    }
    out
}

fn page_break_before(doc: &HwpDocument, para: usize) -> bool {
    doc.get_para_properties_at_native(0, para)
        .expect("문단 속성")
        .contains("\"pageBreakBefore\":true")
}

/// performInsert 와 같은 순서로 다줄 텍스트를 논리 삽입한다.
fn agent_multiline_insert(doc: &mut HwpDocument, para: usize, off: usize, text: &str) {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut cur_para = para;
    let mut cur_off = off;
    if !lines[0].is_empty() {
        doc.insert_text_native(0, cur_para, cur_off, lines[0])
            .expect("insert");
        cur_off += lines[0].chars().count();
    }
    for line in &lines[1..] {
        doc.split_paragraph_logical_native(0, cur_para, cur_off)
            .expect("logical split");
        cur_para += 1;
        cur_off = 0;
        if !line.is_empty() {
            doc.insert_text_native(0, cur_para, 0, line)
                .expect("insert");
            cur_off = line.chars().count();
        }
    }
}

fn multiline_logical_insert_contract(path: &str) {
    let mut doc = load(path);
    let para_count = doc.get_paragraph_count_native(0).expect("문단 수");
    let pages = doc.page_count();
    assert!(
        pages < para_count as u32,
        "실문서 밀도: 쪽수({pages})는 문단 수({para_count})보다 훨씬 작아야 한다"
    );

    // 대상 문단에 강제 쪽 나눔을 저작한 뒤 다줄 삽입 — continuation 이 나눔을
    // 복제하면 줄마다 새 쪽이 생긴다.
    let target = first_text_para(&doc);
    doc.apply_para_format_native(0, target, r#"{"pageBreakBefore":true}"#)
        .expect("쪽 나눔 저작");
    let pages_with_break = doc.page_count();
    let target_text_before = {
        let len = doc.get_paragraph_length_native(0, target).unwrap();
        doc.get_text_range_native(0, target, 0, len).unwrap()
    };
    let text_before = body_text(&doc);

    agent_multiline_insert(&mut doc, target, 1, "가나\n다라\n마바");

    // 문단 순서·텍스트: 원본 첫 글자 + "가나" / "다라" / "마바" + 나머지
    assert_eq!(
        doc.get_paragraph_count_native(0).expect("문단 수"),
        para_count + 2,
        "다줄 삽입은 줄 수 - 1 개의 문단을 추가한다"
    );
    let t0 = doc
        .get_text_range_native(
            0,
            target,
            0,
            doc.get_paragraph_length_native(0, target).unwrap(),
        )
        .unwrap();
    assert!(t0.ends_with("가나"), "첫 줄이 대상 문단에 붙는다: {t0}");
    let t1 = doc.get_text_range_native(0, target + 1, 0, 2).unwrap();
    assert_eq!(t1, "다라", "둘째 줄이 continuation 문단이 된다");

    // 저작된 나눔은 대상 문단에만 남는다
    assert!(page_break_before(&doc, target), "저작된 쪽 나눔 유지");
    assert!(
        !page_break_before(&doc, target + 1),
        "continuation 은 쪽 나눔을 상속하지 않는다"
    );
    assert!(
        !page_break_before(&doc, target + 2),
        "마지막 continuation 도 쪽 나눔을 상속하지 않는다"
    );

    // 쪽 밀도: 짧은 세 줄 삽입의 쪽수 증가는 1 이내
    let pages_after = doc.page_count();
    assert!(
        pages_after as i64 - pages_with_break as i64 <= 1,
        "다줄 삽입 후 쪽수 {pages_with_break} → {pages_after} (증가는 1 이내)"
    );

    // 저장/재열기 정합: 쪽수와 텍스트 순서가 보존된다
    let out = doc.export_hwpx_native().expect("HWPX 직렬화");
    let reparsed = HwpDocument::from_bytes(&out).expect("재파싱");
    assert_eq!(
        reparsed.page_count(),
        pages_after,
        "저장·재열기 쪽수가 편집본과 같아야 한다"
    );
    let text_after = body_text(&reparsed);
    // 편집한 대상 문단은 텍스트가 바뀌었으므로 보존 검사에서 제외한다
    for chunk in text_before
        .split('\n')
        .filter(|t| !t.is_empty() && *t != target_text_before)
        .take(5)
    {
        assert!(
            text_after.contains(chunk),
            "저장·재열기 후 원본 텍스트가 보존돼야 한다: {chunk}"
        );
    }
    assert!(text_after.contains("다라"), "삽입 텍스트도 보존된다");
}

#[test]
fn hwp_multiline_logical_insert_contract() {
    multiline_logical_insert_contract(HWP);
}

#[test]
fn hwpx_multiline_logical_insert_contract() {
    multiline_logical_insert_contract(HWPX);
}

fn user_enter_split_contract(path: &str) {
    let mut doc = load(path);
    let target = first_text_para(&doc);
    doc.apply_para_format_native(0, target, r#"{"pageBreakBefore":true}"#)
        .expect("쪽 나눔 저작");

    doc.split_paragraph_native(0, target, 1, None)
        .expect("Enter 분할");

    assert!(
        page_break_before(&doc, target + 1),
        "Enter 분할 새 문단은 문단 모양(쪽 나눔 포함)을 상속한다"
    );

    // 편집본과 저장/재열기 쪽수 정합
    let out = doc.export_hwpx_native().expect("HWPX 직렬화");
    let reparsed = HwpDocument::from_bytes(&out).expect("재파싱");
    assert_eq!(reparsed.page_count(), doc.page_count());
}

#[test]
fn hwp_user_enter_split_contract() {
    user_enter_split_contract(HWP);
}

#[test]
fn hwpx_user_enter_split_contract() {
    user_enter_split_contract(HWPX);
}
