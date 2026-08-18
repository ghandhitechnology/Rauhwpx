//! HWPX 직렬화 공용 헬퍼 — XML escape / 공통 이벤트 쓰기

use std::io::Write;

use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::Writer;

use super::SerializeError;

/// `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` 선언을 쓴다.
pub fn write_xml_decl<W: Write>(w: &mut Writer<W>) -> Result<(), SerializeError> {
    w.write_event(Event::Decl(BytesDecl::new(
        "1.0",
        Some("UTF-8"),
        Some("yes"),
    )))
    .map_err(|e| SerializeError::XmlError(e.to_string()))?;
    Ok(())
}

/// 속성 없는 시작 태그
pub fn start_tag<W: Write>(w: &mut Writer<W>, name: &str) -> Result<(), SerializeError> {
    w.write_event(Event::Start(BytesStart::new(name)))
        .map_err(|e| SerializeError::XmlError(e.to_string()))?;
    Ok(())
}

/// 속성 있는 시작 태그
pub fn start_tag_attrs<W: Write>(
    w: &mut Writer<W>,
    name: &str,
    attrs: &[(&str, &str)],
) -> Result<(), SerializeError> {
    let mut el = BytesStart::new(name);
    for (k, v) in attrs {
        el.push_attribute((*k, *v));
    }
    w.write_event(Event::Start(el))
        .map_err(|e| SerializeError::XmlError(e.to_string()))?;
    Ok(())
}

/// 종료 태그
pub fn end_tag<W: Write>(w: &mut Writer<W>, name: &str) -> Result<(), SerializeError> {
    w.write_event(Event::End(BytesEnd::new(name)))
        .map_err(|e| SerializeError::XmlError(e.to_string()))?;
    Ok(())
}

/// 자기 닫힘 태그 (`<name a="..."/>`)
pub fn empty_tag<W: Write>(
    w: &mut Writer<W>,
    name: &str,
    attrs: &[(&str, &str)],
) -> Result<(), SerializeError> {
    let mut el = BytesStart::new(name);
    for (k, v) in attrs {
        el.push_attribute((*k, *v));
    }
    w.write_event(Event::Empty(el))
        .map_err(|e| SerializeError::XmlError(e.to_string()))?;
    Ok(())
}

/// 텍스트 노드 (자동 이스케이프)
pub fn text<W: Write>(w: &mut Writer<W>, content: &str) -> Result<(), SerializeError> {
    w.write_event(Event::Text(BytesText::new(content)))
        .map_err(|e| SerializeError::XmlError(e.to_string()))?;
    Ok(())
}

/// XML 1.0 속성·텍스트 이스케이프 (&, <, >, ", ').
///
/// XML 1.0에서 허용되지 않는 제어문자는 U+FFFD로 치환한다. HWP 문자열은 임의의
/// UTF-16을 담을 수 있으므로 수식 스크립트 등에 U+000B 같은 값이 들어온 상태로 그대로
/// 방출하면 section XML 전체가 파싱 불가능해져 HWPX가 손상된다.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\u{0009}'
            | '\u{000A}'
            | '\u{000D}'
            | '\u{0020}'..='\u{D7FF}'
            | '\u{E000}'..='\u{FFFD}'
            | '\u{10000}'..='\u{10FFFF}' => out.push(c),
            _ => out.push('\u{FFFD}'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::xml_escape;

    #[test]
    fn xml_escape_preserves_equation_text_and_filters_invalid_xml_controls() {
        assert_eq!(
            xml_escape("a < b & c > d; \"q\" 'p'\n\t"),
            "a &lt; b &amp; c &gt; d; &quot;q&quot; &apos;p&apos;\n\t"
        );
        assert_eq!(xml_escape("x\u{000B}y\u{FFFF}z"), "x\u{FFFD}y\u{FFFD}z");
    }
}
