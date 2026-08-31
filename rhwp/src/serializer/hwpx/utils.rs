//! HWPX 직렬화 공용 헬퍼 — XML escape / 공통 이벤트 쓰기

use std::io::Write;

use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::Writer;

use super::SerializeError;

fn bounded_growth_target(current_capacity: usize, next: usize, max_bytes: usize) -> usize {
    debug_assert!(next <= max_bytes);
    current_capacity.saturating_mul(2).max(next).min(max_bytes)
}

/// A fallible `String` used while generating one bounded XML member.
///
/// `String::push_str` may abort the process on allocation failure and only lets
/// callers discover a size limit after the allocation. This wrapper checks the
/// logical member limit and reserves fallibly before every growth operation.
pub(crate) struct BoundedXmlString {
    value: String,
    max_bytes: usize,
}

impl BoundedXmlString {
    pub(crate) fn new(max_bytes: usize) -> Self {
        Self {
            value: String::new(),
            max_bytes,
        }
    }

    pub(crate) fn from_str(value: &str, max_bytes: usize) -> Result<Self, SerializeError> {
        let mut output = Self::new(max_bytes);
        output.push_str(value)?;
        Ok(output)
    }

    pub(crate) fn len(&self) -> usize {
        self.value.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.value.is_empty()
    }

    pub(crate) fn as_str(&self) -> &str {
        self.value.as_str()
    }

    pub(crate) fn remaining(&self) -> usize {
        self.max_bytes.saturating_sub(self.value.len())
    }

    pub(crate) fn clear(&mut self) {
        self.value.clear();
    }

    pub(crate) fn push(&mut self, character: char) -> Result<(), SerializeError> {
        let mut encoded = [0u8; 4];
        self.push_str(character.encode_utf8(&mut encoded))
    }

    pub(crate) fn push_str(&mut self, value: &str) -> Result<(), SerializeError> {
        let next = self
            .value
            .len()
            .checked_add(value.len())
            .ok_or_else(|| SerializeError::XmlError("HWPX XML size overflow".to_string()))?;
        if next > self.max_bytes {
            return Err(SerializeError::XmlError(format!(
                "HWPX XML exceeds the {} byte generation limit",
                self.max_bytes
            )));
        }
        if next > self.value.capacity() {
            let target = bounded_growth_target(self.value.capacity(), next, self.max_bytes);
            self.value
                .try_reserve_exact(target - self.value.len())
                .map_err(|error| {
                    SerializeError::XmlError(format!("HWPX XML allocation failed: {error}"))
                })?;
        }
        self.value.push_str(value);
        Ok(())
    }

    pub(crate) fn into_inner(self) -> String {
        self.value
    }
}

impl std::fmt::Write for BoundedXmlString {
    fn write_str(&mut self, value: &str) -> std::fmt::Result {
        self.push_str(value).map_err(|_| std::fmt::Error)
    }
}

pub(crate) fn push_xml_escaped(
    output: &mut BoundedXmlString,
    value: &str,
) -> Result<(), SerializeError> {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;")?,
            '<' => output.push_str("&lt;")?,
            '>' => output.push_str("&gt;")?,
            '"' => output.push_str("&quot;")?,
            '\'' => output.push_str("&apos;")?,
            '\u{0009}'
            | '\u{000A}'
            | '\u{000D}'
            | '\u{0020}'..='\u{D7FF}'
            | '\u{E000}'..='\u{FFFD}'
            | '\u{10000}'..='\u{10FFFF}' => output.push(character)?,
            _ => output.push('\u{FFFD}')?,
        }
    }
    Ok(())
}

/// Fallible XML accumulation buffer. The limit is checked before extending the
/// backing `Vec`, so generated package parts cannot cross their member or
/// remaining aggregate budget before the ZIP writer sees them.
pub(crate) struct BoundedXmlBuffer {
    bytes: Vec<u8>,
    max_bytes: usize,
}

impl BoundedXmlBuffer {
    pub(crate) fn new(max_bytes: usize) -> Self {
        Self {
            // Leave the first allocation to `write`, where it is both bounded
            // and fallible. Preallocating here would make even a tiny XML part
            // perform an infallible 64 KiB allocation.
            bytes: Vec::new(),
            max_bytes,
        }
    }

    pub(crate) fn into_inner(self) -> Vec<u8> {
        self.bytes
    }

    pub(crate) fn remaining(&self) -> usize {
        self.max_bytes.saturating_sub(self.bytes.len())
    }
}

impl Write for BoundedXmlBuffer {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let next = self
            .bytes
            .len()
            .checked_add(data.len())
            .ok_or_else(|| std::io::Error::other("HWPX XML size overflow"))?;
        if next > self.max_bytes {
            return Err(std::io::Error::other(format!(
                "HWPX XML exceeds {} byte generation limit",
                self.max_bytes
            )));
        }
        if next > self.bytes.capacity() {
            let target = bounded_growth_target(self.bytes.capacity(), next, self.max_bytes);
            self.bytes
                .try_reserve_exact(target - self.bytes.len())
                .map_err(|error| {
                    std::io::Error::other(format!("HWPX XML allocation failed: {error}"))
                })?;
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

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
    use super::{push_xml_escaped, xml_escape, BoundedXmlBuffer, BoundedXmlString};
    use std::io::Write;

    #[test]
    fn bounded_xml_buffer_rejects_before_extending() {
        let mut output = BoundedXmlBuffer::new(4);
        output.write_all(b"1234").unwrap();
        assert!(output.write_all(b"5").is_err());
        assert_eq!(output.into_inner(), b"1234");
    }

    #[test]
    fn bounded_xml_buffers_grow_amortized_under_repeated_small_writes() {
        const WRITES: usize = 100_000;
        let mut bytes = BoundedXmlBuffer::new(WRITES);
        for _ in 0..WRITES {
            bytes.write_all(b"x").unwrap();
        }
        assert_eq!(bytes.into_inner().len(), WRITES);

        let source = "&".repeat(20_000);
        let mut escaped = BoundedXmlString::new(source.len() * 5);
        push_xml_escaped(&mut escaped, &source).unwrap();
        assert_eq!(escaped.len(), source.len() * 5);
        assert!(escaped.as_str().starts_with("&amp;&amp;"));
    }

    #[test]
    fn xml_escape_preserves_equation_text_and_filters_invalid_xml_controls() {
        assert_eq!(
            xml_escape("a < b & c > d; \"q\" 'p'\n\t"),
            "a &lt; b &amp; c &gt; d; &quot;q&quot; &apos;p&apos;\n\t"
        );
        assert_eq!(xml_escape("x\u{000B}y\u{FFFF}z"), "x\u{FFFD}y\u{FFFD}z");
    }
}
