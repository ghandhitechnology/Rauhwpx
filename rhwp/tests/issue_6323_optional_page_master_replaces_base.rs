//! HWPX `OPTIONAL_PAGE pageDuplicate="0"` 바탕쪽이 기본 홀/짝 바탕쪽을 대체하는지
//! 고정한다. 종전에는 파서가 이 선언을 `LAST_PAGE` 에만 반영해 임의 쪽 바탕쪽이
//! 기본 바탕쪽 위에 덧그려졌고, 쪽번호가 같은 좌표에 포개졌다.
//!
//! 비공개 korea 샘플은 가져오지 않는다. IR 왕복과 pagination 계약으로 같은 형상을 잠근다.
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

fn last_page_masters(core: &DocumentCore) -> (bool, usize) {
    let page = core
        .pagination
        .first()
        .and_then(|r| r.pages.last())
        .expect("구역에 쪽이 있어야 함");
    let extra = page.extra_master_pages.len();
    let active_is_extension = page
        .active_master_page
        .as_ref()
        .and_then(|mp_ref| {
            core.document()
                .sections
                .get(mp_ref.section_index)
                .and_then(|s| s.section_def.master_pages.get(mp_ref.master_page_index))
        })
        .map(|mp| mp.is_extension && mp.replace_base)
        .unwrap_or(false);
    (active_is_extension, extra)
}

fn master_page_children(root: &RenderNode) -> usize {
    root.children
        .iter()
        .filter(|c| matches!(c.node_type, RenderNodeType::MasterPage))
        .count()
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
    let (active_is_extension, extra) = last_page_masters(&core);
    assert!(
        active_is_extension,
        "임의 쪽 바탕쪽이 기본 홀/짝 바탕쪽을 대체해야 한다"
    );
    assert_eq!(
        extra, 0,
        "extra_master_pages 가 있으면 쪽번호·머리말이 같은 좌표에 포개진다"
    );

    let tree = core.build_page_render_tree(0).expect("render tree");
    assert_eq!(
        master_page_children(&tree.root),
        1,
        "그려진 바탕쪽이 한 겹이어야 한다"
    );
}
