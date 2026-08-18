//! 번호/글머리표 문단의 캐럿 위치 계약.
//!
//! 빈 문단에 번호를 적용하면 캐럿(커서 사각형)과 히트테스트 결과가 모두
//! 번호 마커의 오른쪽에 놓여야 한다. 회귀: `layout_empty_runs_line` 이 빈 문단의
//! anchor TextRun 을 마커 앞(문단 좌단) x 에 배치해, 클릭 시 캐럿이 번호를 덮었다.

use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

fn rect(doc: &HwpDocument, sec: u32, para: u32, off: u32) -> Value {
    let s = doc
        .get_cursor_rect(sec, para, off)
        .expect("커서 사각형 조회 실패");
    serde_json::from_str(&s).expect("커서 사각형 JSON 파싱 실패")
}

fn numbered_blank_doc(head_type: &str) -> (HwpDocument, f64) {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native()
        .expect("빈 문서 생성 실패");
    let plain_x = rect(&doc, 0, 0, 0)["x"].as_f64().unwrap();

    let id = match head_type {
        "Bullet" => doc.ensure_default_bullet("●"),
        _ => doc.ensure_default_numbering(),
    };
    doc.apply_para_format(
        0,
        0,
        &format!(
            "{{\"headType\":\"{}\",\"numberingId\":{},\"paraLevel\":0}}",
            head_type, id
        ),
    )
    .expect("문단 번호 적용 실패");
    (doc, plain_x)
}

#[test]
fn caret_sits_right_of_number_marker_on_empty_paragraph() {
    let (doc, plain_x) = numbered_blank_doc("Number");
    let after = rect(&doc, 0, 0, 0);
    let after_x = after["x"].as_f64().unwrap();
    assert!(
        after_x > plain_x + 1.0,
        "번호 적용 후 캐럿은 마커 오른쪽이어야 한다: plain_x={plain_x}, after_x={after_x}"
    );
}

#[test]
fn caret_sits_right_of_bullet_marker_on_empty_paragraph() {
    let (doc, plain_x) = numbered_blank_doc("Bullet");
    let after_x = rect(&doc, 0, 0, 0)["x"].as_f64().unwrap();
    assert!(
        after_x > plain_x + 1.0,
        "글머리표 적용 후 캐럿은 마커 오른쪽이어야 한다: plain_x={plain_x}, after_x={after_x}"
    );
}

#[test]
fn hit_test_on_marker_returns_caret_right_of_marker() {
    let (doc, plain_x) = numbered_blank_doc("Number");
    let after = rect(&doc, 0, 0, 0);
    let after_x = after["x"].as_f64().unwrap();
    let y_mid = after["y"].as_f64().unwrap() + after["height"].as_f64().unwrap() / 2.0;

    // 번호 마커 위를 클릭해도 캐럿은 마커 오른쪽(본문 시작)에 놓여야 한다.
    let hit: Value = serde_json::from_str(
        &doc.hit_test(0, plain_x + 1.0, y_mid)
            .expect("히트테스트 실패"),
    )
    .expect("히트테스트 JSON 파싱 실패");
    assert_eq!(hit["paragraphIndex"], 0);
    assert_eq!(hit["charOffset"], 0);
    let hit_x = hit["cursorRect"]["x"].as_f64().expect("cursorRect.x 없음");
    assert!(
        (hit_x - after_x).abs() <= 0.6,
        "히트테스트 캐럿 x({hit_x})는 커서 사각형 x({after_x})와 일치해야 한다"
    );
}
