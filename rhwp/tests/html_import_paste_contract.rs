//! HTML clipboard input is observed through the public native paste API.
//!
//! Ports the #6450/#6464 contracts from edwardkim/rhwp (`tests/cases/html_import_paste_contract.rs`).
#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::DocumentCore;
use rhwp::model::style::UnderlineType;

const HTML_PASTE_MAX_BYTES: usize = 400_000;
const FLUSH_LINE_CHAR_CAP: usize = 4_000;

fn paste_html(html: &str) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native()
        .expect("public blank document");
    core.paste_html_native(0, 0, 0, html)
        .expect("public HTML paste");
    core
}

fn paragraphs(core: &DocumentCore) -> &[rhwp::model::paragraph::Paragraph] {
    &core.document().sections[0].paragraphs
}

#[test]
fn top_level_span_paste_keeps_inline_text_and_styles_without_raw_tags() {
    let core =
        paste_html("<span style=\"color:#ff0000\"><strong>홍길동</strong><u> 부장</u></span>");
    let paragraph = &paragraphs(&core)[0];

    assert_eq!(paragraph.text, "홍길동 부장");
    assert!(
        !paragraph.text.contains('<'),
        "최상위 span 내부 태그가 문서 문자로 남으면 안 된다"
    );

    let applied_shapes: Vec<_> = paragraph
        .char_shapes
        .iter()
        .map(|run| &core.document().doc_info.char_shapes[run.char_shape_id as usize])
        .collect();
    assert!(
        applied_shapes.iter().any(|shape| shape.bold),
        "중첩 strong 서식이 붙여넣은 문단에 적용돼야 함"
    );
    assert!(
        applied_shapes
            .iter()
            .any(|shape| matches!(shape.underline_type, UnderlineType::Bottom)),
        "중첩 u 서식이 붙여넣은 문단에 적용돼야 함"
    );
}

#[test]
fn list_item_paste_becomes_bulleted_paragraphs() {
    let core = paste_html("<ul><li>첫 번째 <strong>항목</strong></li><li>둘째 항목</li></ul>");
    let texts: Vec<_> = paragraphs(&core)
        .iter()
        .map(|paragraph| paragraph.text.as_str())
        .collect();

    assert_eq!(texts, ["• 첫 번째 항목", "• 둘째 항목"]);
}

#[test]
fn gmail_like_nested_span_and_list_paste_without_raw_tags() {
    let html = concat!(
        "<div jscontroller=\"ignored\" data-copy-service-computed-style=\"color:#000\">",
        "<span style=\"font-size:14px\"><u><span>🇰🇷 서울 사무소 (한국 지사)</span></u></span>",
        "<ul>",
        "<li><strong>전화번호:</strong> 02-2135-3428</li>",
        "<li><strong>이메일:</strong> koreacs@trungnguyenlegend.com</li>",
        "<li><strong>주소:</strong> 서울특별시 강남구 도산대로 145</li>",
        "</ul>",
        "</div>",
    );
    let core = paste_html(html);
    let texts: Vec<_> = paragraphs(&core)
        .iter()
        .map(|paragraph| paragraph.text.as_str())
        .collect();

    assert_eq!(
        texts,
        [
            "🇰🇷 서울 사무소 (한국 지사)",
            "• 전화번호: 02-2135-3428",
            "• 이메일: koreacs@trungnguyenlegend.com",
            "• 주소: 서울특별시 강남구 도산대로 145",
        ]
    );
    assert!(
        texts
            .iter()
            .all(|text| !text.contains('<') && !text.contains("jscontroller")),
        "Gmail 속성/태그가 문서 문자로 남으면 안 된다: {texts:?}"
    );
}

#[test]
fn nested_span_paste_finishes_without_raw_markup() {
    let mut html = String::from("본문");
    for _ in 0..80 {
        html = format!(r#"<span style="color:#111111">{html}</span>"#);
    }
    let core = paste_html(&html);
    let text: String = paragraphs(&core)
        .iter()
        .map(|paragraph| paragraph.text.as_str())
        .collect();

    assert!(
        text.contains("본문"),
        "중첩 span 본문이 보존돼야 함: {text:?}"
    );
    assert!(
        !text.contains('<') && !text.contains("style="),
        "중첩 span 마크업이 문서 문자로 남으면 안 된다: {text:?}"
    );
}

#[test]
fn long_plain_text_paste_is_split_before_layout() {
    let core = paste_html(&"가".repeat(FLUSH_LINE_CHAR_CAP * 2 + 1));
    let paragraphs = paragraphs(&core);

    assert_eq!(paragraphs.len(), 3);
    assert_eq!(paragraphs[0].text.chars().count(), FLUSH_LINE_CHAR_CAP);
    assert_eq!(paragraphs[1].text.chars().count(), FLUSH_LINE_CHAR_CAP);
    assert_eq!(paragraphs[2].text, "가");
}

#[test]
fn oversized_markup_paste_falls_back_to_capped_paragraphs() {
    let text = "가".repeat(HTML_PASTE_MAX_BYTES + 1);
    let core = paste_html(&format!("<div>{text}</div>"));
    let paragraphs = paragraphs(&core);

    assert_eq!(paragraphs.len(), 101);
    assert!(paragraphs
        .iter()
        .all(|paragraph| paragraph.text.chars().count() <= FLUSH_LINE_CHAR_CAP));
    assert_eq!(paragraphs.last().expect("마지막 문단").text, "가");
}
