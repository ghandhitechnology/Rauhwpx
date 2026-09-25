//! 양쪽 정렬은 글자로 가득 찬 자동 줄바꿈 줄만 늘린다.
//!
//! 강제 줄바꿈(Shift+Enter)으로 끝난 줄과, 다음 글자처럼 취급 그림이 남은 폭에
//! 들어가지 않아 끝난 줄은 앞쪽 정렬로 둔다. 그림 앞에서 줄을 나눌 때 마침표 같은
//! 줄 머리 금칙 글자가 그림과 함께 다음 줄로 넘어가지 않아야 한다.

use rhwp::document_core::DocumentCore;
use rhwp::model::style::Alignment;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

/// 1x1 투명 PNG.
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

/// (줄 텍스트, 가장 큰 단어 간격 보정) 목록.
fn text_lines(core: &DocumentCore) -> Vec<(String, f64)> {
    fn walk(node: &RenderNode, out: &mut Vec<(String, f64)>) {
        if let RenderNodeType::TextLine(_) = node.node_type {
            let mut text = String::new();
            let mut extra = 0.0f64;
            for child in &node.children {
                if let RenderNodeType::TextRun(run) = &child.node_type {
                    text.push_str(&run.text);
                    extra = extra.max(run.style.extra_word_spacing);
                }
            }
            out.push((text, extra));
        }
        for child in &node.children {
            walk(child, out);
        }
    }
    let mut out = Vec::new();
    for page in 0..core.page_count() {
        walk(&core.build_page_render_tree(page).unwrap().root, &mut out);
    }
    out
}

#[test]
fn 강제_줄바꿈과_그림_앞_줄은_양쪽_정렬로_늘리지_않는다() {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let para_shape = core.document().sections[0].paragraphs[0].para_shape_id as usize;
    assert_eq!(
        core.document().doc_info.para_shapes[para_shape].alignment,
        Alignment::Justify,
        "빈 문서 기본 문단은 양쪽 정렬이어야 한다"
    );

    // 짧은 줄 + 강제 줄바꿈 + 두 줄 이상으로 흐르는 본문 + 짧은 끝 문장.
    let body = "짧은 첫 줄\n가나다 라마바 사아자 차카타 파하 가나다 라마바 사아자 차카타 파하 \
                가나다 라마바 사아자 차카타 파하 가나다 라마바 사아자 차카타 파하 간섭무늬를 형성한다.";
    core.insert_text_native(0, 0, 0, body).unwrap();
    let end = body.chars().count();
    // 본문 폭보다 넓은 그림을 다음 문단에 글자처럼 취급으로 넣고, 편집기 끌어 놓기처럼
    // 문단 끝(마침표 뒤)으로 옮긴다.
    core.split_paragraph_native(0, 0, end, None).unwrap();
    let inserted = core
        .insert_picture_native(
            0,
            1,
            0,
            &[],
            TINY_PNG,
            40000,
            6000,
            1,
            1,
            "png",
            "wide",
            None,
            None,
        )
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&inserted).unwrap();
    let ci = json["controlIdx"].as_u64().unwrap() as usize;
    core.set_picture_properties_native(0, 1, ci, r#"{"treatAsChar":true}"#)
        .unwrap();
    core.move_picture_control_native(0, 1, ci, 0, end).unwrap();
    let para = &core.document().sections[0].paragraphs[0];
    assert_eq!(
        para.control_text_positions().last(),
        Some(&end),
        "그림이 문단 끝으로 옮겨지지 않았다"
    );
    assert!(
        para.line_segs.len() >= 4,
        "그림이 별도 줄로 넘어가지 않았다"
    );

    let lines = text_lines(&core);
    let forced = lines
        .iter()
        .find(|(t, _)| t.starts_with("짧은 첫 줄"))
        .expect("강제 줄바꿈 줄");
    assert_eq!(forced.1, 0.0, "강제 줄바꿈 줄이 늘어났다: {lines:?}");

    let before_picture = lines
        .iter()
        .find(|(t, _)| t.contains("형성한다"))
        .expect("그림 앞 줄");
    assert!(
        before_picture.0.trim_end().ends_with("형성한다."),
        "마침표가 그림과 함께 넘어갔다: {lines:?}"
    );
    assert_eq!(
        before_picture.1, 0.0,
        "그림이 들어가지 않아 끝난 줄이 늘어났다: {lines:?}"
    );

    // 가득 찬 자동 줄바꿈 줄은 계속 양쪽 정렬된다.
    assert!(
        lines
            .iter()
            .any(|(t, extra)| t.starts_with("가나다") && *extra > 0.0),
        "가득 찬 줄이 양쪽 정렬되지 않았다: {lines:?}"
    );

    // 나눔 정렬은 짧은 줄도 배분한다. 개체 앞 줄에 대한 양쪽 정렬 규칙을 섞지 않는다.
    let mut split_document = core.document().clone();
    let shape = split_document.sections[0].paragraphs[0].para_shape_id as usize;
    split_document.doc_info.para_shapes[shape].alignment = Alignment::Split;
    let core =
        DocumentCore::from_bytes(&rhwp::serializer::hwpx::serialize_hwpx(&split_document).unwrap())
            .unwrap();
    let split_lines = text_lines(&core);
    assert!(
        split_lines
            .iter()
            .any(|(text, extra)| text.contains("형성한다.") && *extra > 0.0),
        "그림 앞 줄의 나눔 정렬이 사라졌다: {split_lines:?}"
    );
}
