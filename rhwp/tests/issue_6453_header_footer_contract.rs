//! [#6453] 머리말/꼬리말 편집 resolver와 원자 text event 계약.
#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use rhwp::wasm_api::HwpDocument;

fn header_with_text(text: &str) -> HwpDocument {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().expect("blank2010 생성");
    doc.create_header_footer_native(0, true, 0)
        .expect("양쪽 머리말 생성");
    doc.insert_text_in_header_footer_native(0, true, 0, 0, 0, text)
        .expect("머리말 입력");
    doc
}

fn only_event(raw: &str) -> serde_json::Value {
    let value: serde_json::Value = serde_json::from_str(raw).expect("event log JSON");
    let events = value["events"].as_array().expect("events array");
    assert_eq!(
        events.len(),
        1,
        "text mutation은 원자 event 하나여야 함: {raw}"
    );
    events[0].clone()
}

fn assert_range_event(
    event: &serde_json::Value,
    start: (usize, usize),
    end: (usize, usize),
    inserted_end: (usize, usize),
) {
    assert_eq!(event["type"], "HeaderFooterTextReplaced");
    assert_eq!(event["section"], 0);
    assert_eq!(event["isHeader"], true);
    assert_eq!(event["applyTo"], 0);
    assert_eq!(event["start"]["para"], start.0);
    assert_eq!(event["start"]["offset"], start.1);
    assert_eq!(event["end"]["para"], end.0);
    assert_eq!(event["end"]["offset"], end.1);
    assert_eq!(event["insertedEnd"]["para"], inserted_end.0);
    assert_eq!(event["insertedEnd"]["offset"], inserted_end.1);
}

#[test]
fn edit_query_and_preview_renderer_resolve_the_same_hf_definition() {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().expect("blank2010 생성");
    for (apply_to, text) in [(1, "E"), (2, "ODD-LONG")] {
        doc.create_header_footer_native(0, false, apply_to)
            .expect("홀짝 꼬리말 생성");
        doc.insert_text_in_header_footer_native(0, false, apply_to, 0, 0, text)
            .expect("홀짝 꼬리말 입력");
    }
    let preview_page: serde_json::Value = serde_json::from_str(
        &doc.get_header_footer_preview_page_native(0)
            .expect("대표 페이지 조회"),
    )
    .expect("대표 페이지 JSON");
    let preview_page = preview_page["pageIndex"].as_u64().expect("pageIndex") as u32;

    let mut widths = Vec::new();
    for (apply_to, expected_text) in [(1, "E"), (2, "ODD-LONG")] {
        let edit_query: serde_json::Value = serde_json::from_str(
            &doc.get_header_footer_native(0, false, apply_to)
                .expect("편집 command resolver 조회"),
        )
        .expect("HF JSON");
        assert_eq!(edit_query["text"], expected_text);

        let rendered: serde_json::Value = serde_json::from_str(
            &doc.get_selection_rects_in_header_footer_native(
                0,
                false,
                apply_to,
                preview_page,
                0,
                0,
                0,
                expected_text.chars().count(),
            )
            .expect("대표 페이지 renderer resolver 조회"),
        )
        .expect("selection rect JSON");
        widths.push(rendered[0]["width"].as_f64().expect("selection width"));
    }
    assert!(
        widths[1] > widths[0],
        "편집 조회와 renderer가 각각 요청한 동일 HF 정의를 사용해야 함: {widths:?}"
    );
}

#[test]
fn single_paragraph_insert_delete_and_replace_events_are_exact() {
    let mut insertion = header_with_text("AB");
    insertion.begin_batch_native().expect("event log 초기화");
    insertion
        .replace_range_in_header_footer_native(0, true, 0, 0, 1, 0, 1, "X")
        .expect("단일 문단 삽입");
    let event = only_event(&insertion.end_batch_native().expect("삽입 event log"));
    assert_range_event(&event, (0, 1), (0, 1), (0, 2));

    let mut deletion = header_with_text("AB");
    deletion.begin_batch_native().expect("event log 초기화");
    deletion
        .replace_range_in_header_footer_native(0, true, 0, 0, 0, 0, 1, "")
        .expect("단일 문단 삭제");
    let event = only_event(&deletion.end_batch_native().expect("삭제 event log"));
    assert_range_event(&event, (0, 0), (0, 1), (0, 0));

    let mut replacement = header_with_text("AB");
    replacement.begin_batch_native().expect("event log 초기화");
    replacement
        .replace_range_in_header_footer_native(0, true, 0, 0, 0, 0, 1, "XY")
        .expect("단일 문단 치환");
    let event = only_event(&replacement.end_batch_native().expect("치환 event log"));
    assert_range_event(&event, (0, 0), (0, 1), (0, 2));
}

#[test]
fn direct_insert_and_delete_events_report_the_actual_clamped_range() {
    let mut insertion = header_with_text("AB");
    insertion.begin_batch_native().expect("event log 초기화");
    insertion
        .insert_text_in_header_footer_native(0, true, 0, 0, 99, "X")
        .expect("문단 끝에 삽입");
    let event = only_event(&insertion.end_batch_native().expect("삽입 event log"));
    assert_range_event(&event, (0, 2), (0, 2), (0, 3));

    let mut deletion = header_with_text("AB");
    deletion.begin_batch_native().expect("event log 초기화");
    deletion
        .delete_text_in_header_footer_native(0, true, 0, 0, 1, 99)
        .expect("문단 끝까지 삭제");
    let event = only_event(&deletion.end_batch_native().expect("삭제 event log"));
    assert_range_event(&event, (0, 1), (0, 2), (0, 1));
}

#[test]
fn multi_paragraph_insert_delete_and_replace_events_are_exact() {
    let mut insertion = header_with_text("AB");
    insertion.begin_batch_native().expect("event log 초기화");
    insertion
        .replace_range_in_header_footer_native(0, true, 0, 0, 1, 0, 1, "X\nY")
        .expect("다문단 삽입");
    let event = only_event(&insertion.end_batch_native().expect("삽입 event log"));
    assert_range_event(&event, (0, 1), (0, 1), (1, 1));

    let mut deletion = header_with_text("AB");
    deletion
        .split_paragraph_in_header_footer_native(0, true, 0, 0, 1, None)
        .expect("삭제용 문단 분할");
    deletion.begin_batch_native().expect("event log 초기화");
    deletion
        .replace_range_in_header_footer_native(0, true, 0, 0, 1, 1, 1, "")
        .expect("다문단 삭제");
    let event = only_event(&deletion.end_batch_native().expect("삭제 event log"));
    assert_range_event(&event, (0, 1), (1, 1), (0, 1));

    let mut replacement = header_with_text("ABCD");
    replacement
        .split_paragraph_in_header_footer_native(0, true, 0, 0, 2, None)
        .expect("치환용 문단 분할");
    replacement.begin_batch_native().expect("event log 초기화");
    replacement
        .replace_range_in_header_footer_native(0, true, 0, 0, 1, 1, 1, "X\nYZ")
        .expect("다문단 치환");
    let event = only_event(&replacement.end_batch_native().expect("치환 event log"));
    assert_range_event(&event, (0, 1), (1, 1), (1, 2));
}

#[test]
fn header_footer_preview_page_is_document_global_for_later_sections() {
    let bytes =
        std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/hwp-multi-001.hwp"))
            .expect("다구역 샘플");
    let mut doc = HwpDocument::from_bytes(&bytes).expect("다구역 문서 파싱");
    assert!(doc.document().sections.len() > 1, "다구역 샘플이어야 한다");

    let mut section1_first_page = None;
    for page_num in 0..doc.page_count() {
        let info: serde_json::Value =
            serde_json::from_str(&doc.get_page_info_native(page_num).expect("페이지 정보"))
                .expect("페이지 JSON");
        if info["sectionIndex"].as_u64() == Some(1) {
            section1_first_page = Some(page_num);
            break;
        }
    }
    let section1_first_page = section1_first_page.expect("2번째 구역의 첫 전역 쪽을 찾아야 한다");
    assert!(
        section1_first_page > 0,
        "2번째 구역 첫 쪽은 문서 전역 0이 아니어야 한다"
    );

    doc.create_header_footer_native(1, true, 0)
        .expect("2번째 구역 머리말 생성");
    let preview: serde_json::Value = serde_json::from_str(
        &doc.get_header_footer_preview_page_native(1)
            .expect("대표 페이지 조회"),
    )
    .expect("대표 페이지 JSON");
    assert_eq!(
        preview["pageIndex"].as_u64().expect("pageIndex"),
        u64::from(section1_first_page),
        "2번째 구역 대표 페이지는 구역 로컬 0이 아니라 문서 전역 쪽이어야 한다"
    );

    doc.insert_text_in_header_footer_native(1, true, 0, 0, 0, "SEC1")
        .expect("2번째 구역 머리말 입력");
    let rects: serde_json::Value = serde_json::from_str(
        &doc.get_selection_rects_in_header_footer_native(
            1,
            true,
            0,
            section1_first_page,
            0,
            0,
            0,
            4,
        )
        .expect("2번째 구역 대표 쪽 selection"),
    )
    .expect("selection JSON");
    assert_eq!(rects[0]["pageIndex"], section1_first_page);
}
