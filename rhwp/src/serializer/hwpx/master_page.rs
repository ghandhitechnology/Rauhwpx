//! 바탕쪽(MasterPage) HWPX 직렬화.
//!
//! 바탕쪽은 패키지의 별도 파일 `Contents/masterpage{N}.xml` (`<masterPage>` 루트)로 저장되고,
//! content.hpf manifest 의 `<opf:item id="masterpage{N}">` 로 등록되며, section XML 의 secPr
//! 내부 `<hp:masterPage idRef="masterpage{N}"/>` 로 참조된다. 파서(parse_hwpx_master_page)의 역.
//!
//! 종전 HWPX 직렬화는 바탕쪽을 전혀 쓰지 않아 라운드트립에서 소실되었다(렌더 노드 손실 →
//! 시각 회귀). 본 모듈이 그 직렬화 축을 채운다.

use crate::model::header_footer::{HeaderFooterApply, MasterPage};

use super::context::SerializeContext;
use super::section::{
    ensure_paragraph_graph_within_limit, render_hp_p_open, render_paragraph_parts_limited,
};
use super::utils::BoundedXmlString;
use super::SerializeError;

/// `<masterPage>`/section XML 공용 네임스페이스 블록 (empty_section0.xml 와 동일).
const XMLNS: &str = r#"xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0""#;

/// 바탕쪽 적용 유형 문자열 (parser `parse_hwpx_master_page_type` 의 역).
/// 확장 바탕쪽(is_extension)은 ext_flags 의 optional 비트(0x04)로 LAST_PAGE/OPTIONAL_PAGE 구분.
fn master_page_type_str(mp: &MasterPage) -> &'static str {
    if mp.is_extension {
        if mp.ext_flags & 0x04 != 0 {
            "OPTIONAL_PAGE"
        } else {
            "LAST_PAGE"
        }
    } else {
        match mp.apply_to {
            HeaderFooterApply::Even => "EVEN",
            HeaderFooterApply::Odd => "ODD",
            HeaderFooterApply::Both => "BOTH",
        }
    }
}

/// pageDuplicate 문자열 (parser 의 역). 확장 바탕쪽은 replace_base 면 "0", 그 외 overlap 기준.
fn page_duplicate_str(mp: &MasterPage) -> &'static str {
    if mp.is_extension {
        if mp.replace_base {
            "0"
        } else {
            "1"
        }
    } else if mp.overlap {
        "1"
    } else {
        "0"
    }
}

/// 바탕쪽 1개를 `Contents/masterpage{N}.xml` 내용으로 직렬화한다.
/// `id` 는 manifest/idRef 와 일치해야 하는 식별자(예: `masterpage0`).
pub fn render_master_page_xml(
    mp: &MasterPage,
    id: &str,
    ctx: &mut SerializeContext,
) -> Result<String, SerializeError> {
    render_master_page_xml_inner(mp, id, ctx, usize::MAX)
}

pub(crate) fn render_master_page_xml_limited(
    mp: &MasterPage,
    id: &str,
    ctx: &mut SerializeContext,
    max_bytes: usize,
) -> Result<String, SerializeError> {
    const MASTER_PAGE_FIXED_SLACK: usize = 2048;
    let fixed_bytes = XMLNS
        .len()
        .checked_add(MASTER_PAGE_FIXED_SLACK)
        .and_then(|bytes| {
            id.len()
                .checked_mul(6)
                .and_then(|id_bytes| bytes.checked_add(id_bytes))
        })
        .ok_or_else(|| master_page_generation_limit_error(id, max_bytes))?;
    let graph_limit = max_bytes
        .checked_sub(fixed_bytes)
        .ok_or_else(|| master_page_generation_limit_error(id, max_bytes))?;
    ensure_paragraph_graph_within_limit(&mp.paragraphs, graph_limit)?;
    render_master_page_xml_inner(mp, id, ctx, max_bytes)
}

fn render_master_page_xml_inner(
    mp: &MasterPage,
    id: &str,
    ctx: &mut SerializeContext,
    max_bytes: usize,
) -> Result<String, SerializeError> {
    use std::fmt::Write as _;

    let mut output = BoundedXmlString::new(max_bytes);
    write!(
        output,
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>"#,
            r#"<masterPage {xmlns} id="{id}" type="{ty}" pageNumber="{pn}" pageDuplicate="{pd}" pageFront="{pf}">"#,
            r#"<hp:subList id="" textDirection="{td}" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="{tw}" textHeight="{th}" hasTextRef="{tr}" hasNumRef="{nr}">"#,
        ),
        xmlns = XMLNS,
        id = id,
        ty = master_page_type_str(mp),
        pn = mp.hwpx_page_number.unwrap_or(0),
        pd = page_duplicate_str(mp),
        pf = mp.page_front as u8,
        td = if mp.text_direction == 1 {
            "VERTICAL"
        } else {
            "HORIZONTAL"
        },
        tw = mp.text_width,
        th = mp.text_height,
        tr = mp.text_ref,
        nr = mp.num_ref,
    )
    .map_err(|_| master_page_generation_limit_error(id, max_bytes))?;

    let mut vert_cursor: u32 = 0;
    for p in &mp.paragraphs {
        let (runs, linesegs, advance) =
            render_paragraph_parts_limited(p, vert_cursor, ctx, output.remaining())?;
        vert_cursor = advance;
        let pid = ctx.next_para_id();
        let sid = ctx.effective_style_id(p.style_id);
        output.push_str(&render_hp_p_open(p, pid, sid))?;
        output.push_str(&runs)?;
        output.push_str(&linesegs)?;
        output.push_str("</hp:p>")?;
    }
    output.push_str("</hp:subList></masterPage>")?;
    Ok(output.into_inner())
}

fn master_page_generation_limit_error(id: &str, max_bytes: usize) -> SerializeError {
    SerializeError::XmlError(format!(
        "master page {id} exceeds the {max_bytes} byte generation limit"
    ))
}

/// secPr 내부에 삽입할 `<hp:masterPage idRef="..."/>` 참조 묶음.
/// `ids` 는 이 섹션 바탕쪽들의 식별자(전역 인덱스 기반).
pub fn render_master_page_refs(ids: &[String]) -> String {
    ids.iter()
        .map(|id| format!(r#"<hp:masterPage idRef="{id}"/>"#))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::document::Document;

    #[test]
    fn master_page_generation_rejects_an_exhausted_member_budget_before_rendering() {
        let page = MasterPage::default();
        let doc = Document::default();
        let mut ctx = SerializeContext::collect_from_document(&doc);

        let error = render_master_page_xml_limited(&page, "masterpage0", &mut ctx, 1)
            .expect_err("master-page XML must honor its prospective ZIP member budget");

        assert!(error.to_string().contains("generation limit"), "{error}");
    }

    #[test]
    fn master_page_limit_reaches_nested_table_paragraphs_before_rendering() {
        const LIMIT: usize = 64 * 1024;
        let table = crate::model::table::Table {
            row_count: 1,
            col_count: 1,
            cells: vec![crate::model::table::Cell {
                paragraphs: vec![crate::model::paragraph::Paragraph {
                    text: "&".repeat(20_000),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let page = MasterPage {
            paragraphs: vec![crate::model::paragraph::Paragraph {
                controls: vec![crate::model::control::Control::Table(Box::new(table))],
                ..Default::default()
            }],
            ..Default::default()
        };
        let doc = Document::default();
        let mut ctx = SerializeContext::collect_from_document(&doc);

        let error = render_master_page_xml_limited(&page, "masterpage0", &mut ctx, LIMIT)
            .expect_err("nested escaped content must be rejected before table XML allocation");

        assert!(error.to_string().contains("generation limit"), "{error}");
    }

    #[test]
    fn master_page_page_front_round_trips() {
        // pageFront(표지 전용 바탕쪽)이 render→parse 왕복에서 보존돼야 한다.
        // 종전엔 serializer 가 pageFront="0" 고정, 파서 미독으로 유실됐다.
        let mp = MasterPage {
            page_front: true,
            ..Default::default()
        };
        let doc = Document::default();
        let mut ctx = SerializeContext::collect_from_document(&doc);
        let xml = render_master_page_xml(&mp, "0", &mut ctx).unwrap();
        assert!(xml.contains(r#"pageFront="1""#), "pageFront=1 방출: {xml}");

        let parsed =
            crate::parser::hwpx::section::parse_hwpx_master_page(&xml).expect("master page parse");
        assert!(parsed.page_front, "pageFront 이 왕복에서 보존돼야 함");
    }

    #[test]
    fn master_page_text_direction_round_trips() {
        // 세로쓰기 바탕쪽(hp:subList@textDirection="VERTICAL")이 render→parse 왕복에서
        // 보존돼야 한다. 종전엔 serializer 가 textDirection="HORIZONTAL" 고정, 파서 미독으로
        // 세로쓰기가 유실됐다.
        let mp = MasterPage {
            text_direction: 1,
            ..Default::default()
        };
        let doc = Document::default();
        let mut ctx = SerializeContext::collect_from_document(&doc);
        let xml = render_master_page_xml(&mp, "0", &mut ctx).unwrap();
        assert!(
            xml.contains(r#"textDirection="VERTICAL""#),
            "textDirection=VERTICAL 방출: {xml}"
        );

        let parsed =
            crate::parser::hwpx::section::parse_hwpx_master_page(&xml).expect("master page parse");
        assert_eq!(
            parsed.text_direction, 1,
            "text_direction 이 왕복에서 보존돼야 함"
        );
    }

    #[test]
    fn optional_page_page_duplicate_0_round_trips() {
        let mp = MasterPage {
            is_extension: true,
            overlap: true,
            replace_base: true,
            ext_flags: 0x0007,
            hwpx_page_number: Some(4),
            ..Default::default()
        };
        let doc = Document::default();
        let mut ctx = SerializeContext::collect_from_document(&doc);
        let xml = render_master_page_xml(&mp, "masterpage8", &mut ctx).unwrap();
        assert!(
            xml.contains(r#"pageDuplicate="0""#),
            "OPTIONAL_PAGE replace_base 는 pageDuplicate=0 으로 나가야 한다: {xml}"
        );
        assert!(xml.contains(r#"type="OPTIONAL_PAGE""#), "{xml}");

        let parsed =
            crate::parser::hwpx::section::parse_hwpx_master_page(&xml).expect("master page parse");
        assert!(parsed.is_extension);
        assert!(parsed.overlap);
        assert!(
            parsed.replace_base,
            "왕복 후 replace_base 가 뒤집히면 임의 쪽 바탕쪽이 기본 바탕쪽 위에 덧그려진다"
        );
    }
}
