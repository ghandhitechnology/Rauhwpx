//! [Issue #6186] 꼬리말 `vertAlign=BOTTOM` 이 안 걸려 쪽번호가 밴드 위쪽에 붙는다
//! (156755659). 같은 자리에 겹쳐 놓은 글상자로도 `2 - 2` 를 그리는데, 꼬리말만
//! 21.8px 위에 놓여 **두 줄로 갈라져** 보인다.
//!
//! 근인: 파서는 HWPX `<hp:subList vertAlign="BOTTOM">` 을 이미 `list_attr` 비트
//! 21~22 로 싣고 모델까지 온전히 전달하는데, **레이아웃이 그 값을 읽지 않아** 늘
//! 밴드 맨 위에 놓았다. 직렬화기는 `vertAlign` 을 늘 `"TOP"` 으로 굳혀 저장해
//! 왕복에서도 유실됐다.
//!
//! 정렬 기준은 **문서가 선언한 밴드 높이**(`<hp:subList textHeight="2834">`
//! = 37.79px)다. 공유 `layout.footer_area` 는 아래 여백까지 품고 있고 그 rect 는
//! 쪽 계산에도 쓰여 건드리면 쪽수가 흔들린다(issue_1733 등 8핀 실측).
//!
//! 원본 재현물은 비공개 korea_downloads 문서라 가져오지 않는다. 공개 IR 로
//! 같은 계약(텍스트 전용 꼬리말 + 선언 textHeight + BOTTOM)을 잠근다.
#![cfg(not(target_arch = "wasm32"))]

use std::io::{Cursor, Read};

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::header_footer::Footer;
use rhwp::model::paragraph::LineSeg;
use rhwp::renderer::hwpunit_to_px;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::renderer::DEFAULT_DPI;

/// 이슈 문서와 같은 선언 밴드 높이(2834 HU ≈ 37.79px @96dpi).
const BAND_HEIGHT_HU: u32 = 2834;
/// 줄바꿈 회귀용 — 두 줄(2200 HU)보다 높고 footer_area(A4 기본 4252 HU)보다 낮음.
const MULTILINE_BAND_HEIGHT_HU: u32 = 4000;
/// 이슈 문서와 같은 줄 높이(1100 HU ≈ 14.67px). BOTTOM 정렬 여백 ≈ 23px.
const LINE_HEIGHT_HU: i32 = 1100;

fn footer_with_bottom_align() -> DocumentCore {
    footer_with_bottom_align_lines(1, BAND_HEIGHT_HU)
}

fn footer_with_wrapped_bottom_align() -> DocumentCore {
    footer_with_bottom_align_lines(2, MULTILINE_BAND_HEIGHT_HU)
}

fn footer_with_bottom_align_lines(line_count: usize, band_height_hu: u32) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().expect("blank");
    core.create_header_footer_native(0, false, 0)
        .expect("create footer");
    let text = if line_count > 1 {
        "첫째줄\n둘째줄"
    } else {
        "2 - N"
    };
    core.insert_text_in_header_footer_native(0, false, 0, 0, 0, text)
        .expect("footer text");

    let mut ir = core.document().clone();
    for para in &mut ir.sections[0].paragraphs {
        for ctrl in &mut para.controls {
            if let Control::Footer(footer) = ctrl {
                apply_bottom_band(footer, line_count, band_height_hu);
            }
        }
    }
    core.set_document(ir);
    core
}

fn apply_bottom_band(footer: &mut Footer, line_count: usize, band_height_hu: u32) {
    footer.list_attr = 2 << 21;
    footer.text_height = band_height_hu;
    footer.text_width = 48188;
    for para in &mut footer.paragraphs {
        para.line_segs = (0..line_count)
            .map(|i| LineSeg {
                text_start: i as u32 * 4,
                line_height: LINE_HEIGHT_HU,
                text_height: LINE_HEIGHT_HU,
                tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
                ..Default::default()
            })
            .collect();
    }
}

fn footer_ir(core: &DocumentCore) -> &Footer {
    for para in &core.document().sections[0].paragraphs {
        for ctrl in &para.controls {
            if let Control::Footer(footer) = ctrl {
                return footer;
            }
        }
    }
    panic!("꼬리말 컨트롤이 없다");
}

fn content_height_px(footer: &Footer) -> f64 {
    footer
        .paragraphs
        .iter()
        .map(|para| {
            let segs = &para.line_segs;
            let has_line_starts = segs.iter().any(LineSeg::is_first_segment);
            segs.iter()
                .filter(|seg| !has_line_starts || seg.is_first_segment())
                .map(|seg| hwpunit_to_px(seg.line_height, DEFAULT_DPI))
                .sum::<f64>()
        })
        .sum()
}

fn max_only_content_height_px(footer: &Footer) -> f64 {
    footer
        .paragraphs
        .iter()
        .filter_map(|para| para.line_segs.iter().map(|seg| seg.line_height).max())
        .map(|lh| hwpunit_to_px(lh, DEFAULT_DPI))
        .sum()
}

fn expected_line_top(core: &DocumentCore, footer_node: &RenderNode) -> f64 {
    let footer = footer_ir(core);
    let content_h = content_height_px(footer);
    let band_h = hwpunit_to_px(footer.text_height as i32, DEFAULT_DPI).min(footer_node.bbox.height);
    footer_node.bbox.y + (band_h - content_h).max(0.0)
}

fn max_only_line_top(core: &DocumentCore, footer_node: &RenderNode) -> f64 {
    let footer = footer_ir(core);
    let content_h = max_only_content_height_px(footer);
    let band_h = hwpunit_to_px(footer.text_height as i32, DEFAULT_DPI).min(footer_node.bbox.height);
    footer_node.bbox.y + (band_h - content_h).max(0.0)
}

fn footer_node(node: &RenderNode) -> Option<&RenderNode> {
    if matches!(node.node_type, RenderNodeType::Footer) {
        return Some(node);
    }
    node.children.iter().find_map(footer_node)
}

fn first_line_top(node: &RenderNode) -> Option<f64> {
    let own = matches!(node.node_type, RenderNodeType::TextLine(_)).then_some(node.bbox.y);
    node.children
        .iter()
        .filter_map(first_line_top)
        .chain(own)
        .fold(None, |acc: Option<f64>, top| {
            Some(acc.map_or(top, |best: f64| best.min(top)))
        })
}

fn last_line_bottom(node: &RenderNode) -> Option<f64> {
    let own = matches!(node.node_type, RenderNodeType::TextLine(_))
        .then_some(node.bbox.y + node.bbox.height);
    node.children
        .iter()
        .filter_map(last_line_bottom)
        .chain(own)
        .fold(None, |acc: Option<f64>, bottom| {
            Some(acc.map_or(bottom, |best: f64| best.max(bottom)))
        })
}

fn assert_footer_bottom_aligned(core: &DocumentCore) {
    let page = core.build_page_render_tree(0).expect("page 1 render tree");
    let footer = footer_node(&page.root).expect("꼬리말 노드");
    let line_top = first_line_top(footer).expect("꼬리말 줄");
    let expected = expected_line_top(core, footer);

    assert!(
        (line_top - expected).abs() <= 2.0,
        "꼬리말은 밴드 아래쪽 정렬이어야 한다 — 줄 위끝 {line_top:.1} \
         (기대 {expected:.1}, 밴드 {:.1}..{:.1})",
        footer.bbox.y,
        footer.bbox.y + footer.bbox.height
    );
    assert!(
        line_top > footer.bbox.y + 10.0,
        "밴드 맨 위에 붙으면 안 된다 — 밴드 위끝 {:.1}, 줄 위끝 {line_top:.1}",
        footer.bbox.y
    );
}

fn hwpx_section0_xml(bytes: &[u8]) -> String {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("open hwpx zip");
    for index in 0..zip.len() {
        let mut file = zip.by_index(index).expect("zip entry");
        if file.name().contains("section0.xml") {
            let mut xml = String::new();
            file.read_to_string(&mut xml).expect("read section0.xml");
            return xml;
        }
    }
    panic!("section0.xml not found");
}

fn footer_sublist_vertalign(xml: &str) -> &str {
    let start = xml.find("<hp:footer").expect("footer tag");
    let rest = &xml[start..];
    let end = rest.find("</hp:footer>").expect("footer close");
    let footer = &rest[..end];
    let needle = "vertAlign=\"";
    let va_start = footer.find(needle).expect("vertAlign attr") + needle.len();
    let va_end = footer[va_start..].find('"').expect("vertAlign close");
    &footer[va_start..va_start + va_end]
}

#[test]
fn issue_6186_footer_bottom_alignment_matches_declared_band() {
    let core = footer_with_bottom_align();
    let footer = footer_ir(&core);
    assert_eq!(
        (footer.list_attr >> 21) & 0b11,
        2,
        "IR 에 BOTTOM 이 실려야 한다"
    );
    assert_eq!(footer.text_height, BAND_HEIGHT_HU);
    assert_footer_bottom_aligned(&core);
}

/// 저장 왕복에서도 세로 정렬이 보존되어야 한다 — 직렬화기가 `vertAlign` 을 늘
/// `"TOP"` 으로 굳혀 저장하면 재렌더가 밴드 맨 위로 돌아간다.
#[test]
fn issue_6186_footer_vertalign_survives_hwpx_roundtrip() {
    let core = footer_with_bottom_align();
    let saved = core.export_hwpx_native().expect("serialize");
    let xml = hwpx_section0_xml(&saved);
    assert_eq!(
        footer_sublist_vertalign(&xml),
        "BOTTOM",
        "HWPX 저장이 꼬리말 vertAlign 을 보존해야 한다"
    );

    let again = DocumentCore::from_bytes(&saved).expect("reopen");
    let footer = footer_ir(&again);
    assert_eq!(
        (footer.list_attr >> 21) & 0b11,
        2,
        "재파싱 뒤에도 list_attr 비트 21~22 가 BOTTOM 이어야 한다"
    );
    assert_eq!(footer.text_height, BAND_HEIGHT_HU);
    assert_footer_bottom_aligned(&again);
}

/// 한 문단에 줄이 둘이면 `content_h` 는 줄 높이 합이어야 한다. 문단 max() 만
/// 쓰면 BOTTOM 여백이 한 줄분 과대해져 마지막 줄이 선언 밴드를 넘는다.
#[test]
fn issue_6186_multiline_footer_sums_every_rendered_line() {
    let core = footer_with_wrapped_bottom_align();
    let footer = footer_ir(&core);
    assert_eq!(footer.paragraphs[0].line_segs.len(), 2, "한 문단 두 줄");
    assert_eq!(footer.text_height, MULTILINE_BAND_HEIGHT_HU);

    let page = core.build_page_render_tree(0).expect("page 1 render tree");
    let node = footer_node(&page.root).expect("꼬리말 노드");
    let line_top = first_line_top(node).expect("꼬리말 줄");
    let expected = expected_line_top(&core, node);
    let max_only = max_only_line_top(&core, node);

    assert!(
        (max_only - expected).abs() > 8.0,
        "max() 계약과 줄 합 계약이 갈라져야 회귀를 잠글 수 있다 — \
         합 {expected:.1}, max {max_only:.1}"
    );
    assert!(
        (line_top - expected).abs() <= 2.0,
        "줄바꿈 꼬리말은 모든 줄 높이를 합산해 정렬해야 한다 — 줄 위끝 {line_top:.1} \
         (기대 {expected:.1}, max-only {max_only:.1})"
    );
    assert!(
        (line_top - max_only).abs() > 8.0,
        "한 줄 max 여백으로 내려가면 안 된다 — 줄 위끝 {line_top:.1}, max-only {max_only:.1}"
    );

    let band_bottom = node.bbox.y
        + hwpunit_to_px(MULTILINE_BAND_HEIGHT_HU as i32, DEFAULT_DPI).min(node.bbox.height);
    if let Some(last_bottom) = last_line_bottom(node) {
        assert!(
            last_bottom <= band_bottom + 2.0,
            "마지막 줄이 선언 밴드를 넘으면 안 된다 — 줄 아래끝 {last_bottom:.1}, \
             밴드 아래끝 {band_bottom:.1}"
        );
    }
}
