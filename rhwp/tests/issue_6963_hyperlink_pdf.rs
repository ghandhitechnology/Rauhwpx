//! #6963 출력 레이어의 링크 영역과 실제 PDF annotation 계약.
#![cfg(not(target_arch = "wasm32"))]
use rhwp::document_core::{hyperlink::HyperlinkTarget, DocumentCore};
use rhwp::paint::RenderProfile;
use rhwp::renderer::hyperlinks::{export_uri, PdfLink};
use rhwp::renderer::pdf::{svgs_to_pdf_with_links, PdfExportOptions};
use rhwp::renderer::render_tree::BoundingBox;

fn blank(text: &str) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    core.insert_text_native(0, 0, 0, text).unwrap();
    core
}

fn tiny_svg(width: u32) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="100"><rect x="10" y="20" width="30" height="10"/></svg>"#
    )
}

fn link(uri: &str) -> Vec<PdfLink> {
    vec![PdfLink {
        uri: uri.into(),
        rect: BoundingBox::new(10.0, 20.0, 30.0, 10.0),
    }]
}

fn page_uris(pdf: &[u8]) -> Vec<Vec<String>> {
    let text = String::from_utf8_lossy(pdf);
    let objects: Vec<_> = text
        .split("endobj")
        .filter_map(|object| {
            let (header, body) = object.rsplit_once(" 0 obj")?;
            Some((
                header.split_whitespace().last()?.to_string(),
                body.to_string(),
            ))
        })
        .collect();
    objects
        .iter()
        .filter(|(_, body)| {
            body.split_once("/Type ")
                .is_some_and(|(_, tail)| tail.split_whitespace().next() == Some("/Page"))
        })
        .map(|(page_id, body)| {
            let Some((_, annots)) = body.split_once("/Annots [") else {
                return Vec::new();
            };
            let refs: Vec<_> = annots
                .split(']')
                .next()
                .unwrap()
                .split_whitespace()
                .collect();
            refs.chunks_exact(3)
                .map(|reference| {
                    assert_eq!(&reference[1..], &["0", "R"]);
                    let body = &objects.iter().find(|(id, _)| id == reference[0]).unwrap().1;
                    assert!(body.contains(&format!("/P {page_id} 0 R")));
                    assert!(body.contains("/Subtype /Link"));
                    body.split_once("/URI (")
                        .unwrap()
                        .1
                        .split(')')
                        .next()
                        .unwrap()
                        .to_string()
                })
                .collect()
        })
        .collect()
}

#[test]
fn pdf_coordinates_uri_encoding_and_border_are_correct() {
    let pdf = svgs_to_pdf_with_links(
        &[tiny_svg(100)],
        &[link("https://example.com/한글?q=a;b#c")],
        &PdfExportOptions::default(),
    )
    .unwrap();
    let text = String::from_utf8_lossy(&pdf);
    assert!(text.contains("/Rect [7.5 52.5 30 60]"), "{text}");
    assert!(text.contains("/Border [0 0 0]"));
    assert_eq!(
        page_uris(&pdf),
        vec![vec!["https://example.com/%ED%95%9C%EA%B8%80?q=a;b#c"]]
    );
}

#[test]
fn invalid_scheme_outside_page_and_mismatched_lists_are_not_emitted() {
    assert_eq!(
        export_uri("mailto:a@example.com").unwrap(),
        "mailto:a@example.com"
    );
    assert!(export_uri("javascript:alert(1)").is_none());
    assert!(export_uri("file:///private/test").is_none());
    assert!(svgs_to_pdf_with_links(&[tiny_svg(100)], &[], &PdfExportOptions::default()).is_err());
    let mut links = link("javascript:alert(1)");
    links.push(PdfLink {
        uri: "https://example.com".into(),
        rect: BoundingBox::new(150.0, 0.0, 20.0, 20.0),
    });
    let pdf =
        svgs_to_pdf_with_links(&[tiny_svg(100)], &[links], &PdfExportOptions::default()).unwrap();
    assert_eq!(page_uris(&pdf), vec![Vec::<String>::new()]);
}

#[test]
fn exported_pdf_contains_link_uri_annotation() {
    let mut core = blank("링크본문");
    core.insert_hyperlink_native(
        &HyperlinkTarget::body(0, 0),
        0,
        4,
        "https://example.com/문서",
    )
    .unwrap();
    let pdf = core
        .render_pages_pdf_native_with_profile_and_options(
            &[0],
            RenderProfile::Print,
            &PdfExportOptions::default(),
        )
        .unwrap();
    let text = String::from_utf8_lossy(&pdf);
    assert!(text.contains("/Subtype /Link"), "{text}");
    assert!(
        text.contains("/URI (https://example.com/%EB%AC%B8%EC%84%9C)")
            || text.contains("https://example.com/%EB%AC%B8%EC%84%9C"),
        "{text}"
    );
}
