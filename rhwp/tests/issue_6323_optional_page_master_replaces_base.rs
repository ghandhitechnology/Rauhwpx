//! HWPX `OPTIONAL_PAGE pageDuplicate="0"` 바탕쪽이 기본 홀/짝 바탕쪽을 대체하는지
//! 고정한다. 종전에는 파서가 이 선언을 `LAST_PAGE` 에만 반영해 임의 쪽 바탕쪽이
//! 기본 바탕쪽 위에 덧그려졌고, 쪽번호가 같은 좌표에 포개졌다.
//!
//! 비공개 korea 샘플은 가져오지 않는다. IR 왕복과 렌더 트리로 같은 형상을 잠근다.
#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::DocumentCore;
use rhwp::model::document::{Document, Section};
use rhwp::model::header_footer::{HeaderFooterApply, MasterPage};
use rhwp::model::paragraph::Paragraph;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::serializer::hwpx::serialize_hwpx;

fn doc_with_odd_and_optional_master(replace_base: bool) -> Document {
    let mut odd_para = Paragraph::default();
    odd_para.text = "홀수 바탕".to_string();
    let mut optional_para = Paragraph::default();
    optional_para.text = "임의 쪽".to_string();
    let mut body = Paragraph::default();
    body.text = "본문".to_string();

    let mut section = Section::default();
    section.paragraphs.push(body);
    section.section_def.master_pages.push(MasterPage {
        apply_to: HeaderFooterApply::Odd,
        text_width: 10_000,
        text_height: 10_000,
        paragraphs: vec![odd_para],
        ..Default::default()
    });
    section.section_def.master_pages.push(MasterPage {
        apply_to: HeaderFooterApply::Both,
        is_extension: true,
        overlap: true,
        replace_base,
        ext_flags: 0x0007,
        hwpx_page_number: Some(4),
        text_width: 10_000,
        text_height: 10_000,
        paragraphs: vec![optional_para],
        ..Default::default()
    });

    let mut doc = Document::default();
    doc.sections.push(section);
    doc
}

fn master_page_children(root: &RenderNode) -> Vec<&RenderNode> {
    root.children
        .iter()
        .filter(|c| matches!(c.node_type, RenderNodeType::MasterPage))
        .collect()
}

fn visible_texts(node: &RenderNode, out: &mut Vec<String>) {
    if let RenderNodeType::TextRun(tr) = &node.node_type {
        let text = tr.display_or_text().trim();
        if !text.is_empty() {
            out.push(text.to_string());
        }
    }
    for child in &node.children {
        visible_texts(child, out);
    }
}

#[test]
fn optional_page_page_duplicate_0_roundtrips_replace_base() {
    let bytes = serialize_hwpx(&doc_with_odd_and_optional_master(true)).expect("serialize");
    let core = DocumentCore::from_bytes(&bytes).expect("parse");
    let optional = core.document().sections[0]
        .section_def
        .master_pages
        .iter()
        .find(|mp| mp.is_extension)
        .expect("OPTIONAL_PAGE");
    assert!(
        optional.replace_base,
        "pageDuplicate=0 왕복 후 replace_base 가 유지돼야 한다"
    );
    assert!(optional.overlap);
}

#[test]
fn optional_page_master_does_not_stack_on_the_base_master() {
    let bytes = serialize_hwpx(&doc_with_odd_and_optional_master(true)).expect("serialize");
    let core = DocumentCore::from_bytes(&bytes).expect("parse");
    let tree = core.build_page_render_tree(0).expect("render tree");
    let masters = master_page_children(&tree.root);
    let rendered: Vec<Vec<String>> = masters
        .iter()
        .map(|m| {
            let mut t = Vec::new();
            visible_texts(m, &mut t);
            t
        })
        .collect();

    assert_eq!(
        masters.len(),
        1,
        "바탕쪽이 겹쳐 그려지면 쪽번호·머리말이 같은 좌표에 포개진다. \
         그려진 바탕쪽 {}겹, 각 글자: {rendered:?}",
        masters.len()
    );
    assert!(
        rendered
            .iter()
            .any(|t| t.iter().any(|s| s.contains("임의"))),
        "확장 바탕쪽 글자가 그려져야 한다: {rendered:?}"
    );
    assert!(
        !rendered
            .iter()
            .any(|t| t.iter().any(|s| s.contains("홀수"))),
        "기본 홀수 바탕쪽 글자가 남아 있으면 덧그리기다: {rendered:?}"
    );
}
