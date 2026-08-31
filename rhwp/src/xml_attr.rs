//! Small, allocation-free helpers for scanning preserved XML fragments.
//!
//! This is deliberately not a general XML parser. It only identifies exact
//! quoted attributes in lexical start tags while skipping text, comments,
//! CDATA, processing instructions, declarations, and malformed unquoted
//! values. The owning XML parser remains responsible for validating XML.

pub(crate) struct ExactXmlAttributeScanner<'a> {
    bytes: &'a [u8],
    cursor: usize,
    in_start_tag: bool,
}

impl<'a> ExactXmlAttributeScanner<'a> {
    pub(crate) fn new(xml: &'a str) -> Self {
        Self {
            bytes: xml.as_bytes(),
            cursor: 0,
            in_start_tag: false,
        }
    }

    fn is_xml_space(byte: u8) -> bool {
        matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
    }

    fn advance_past(&mut self, marker: &[u8]) -> bool {
        let Some(relative) = self.bytes[self.cursor..]
            .windows(marker.len())
            .position(|window| window == marker)
        else {
            self.cursor = self.bytes.len();
            return false;
        };
        self.cursor += relative + marker.len();
        true
    }

    fn advance_past_declaration(&mut self) -> bool {
        let mut quote = None;
        let mut bracket_depth = 0usize;
        while let Some(&byte) = self.bytes.get(self.cursor) {
            self.cursor += 1;
            if let Some(active_quote) = quote {
                if byte == active_quote {
                    quote = None;
                }
                continue;
            }
            match byte {
                b'\'' | b'"' => quote = Some(byte),
                b'[' => bracket_depth = bracket_depth.saturating_add(1),
                b']' => bracket_depth = bracket_depth.saturating_sub(1),
                b'>' if bracket_depth == 0 => return true,
                _ => {}
            }
        }
        false
    }

    /// Returns the byte range of the next quoted attribute with exactly this
    /// name. A malformed unquoted value is consumed through whitespace or the
    /// tag end, so its contents cannot be reinterpreted as another attribute.
    pub(crate) fn next_value(&mut self, attribute: &str) -> Option<(usize, usize)> {
        let attribute = attribute.as_bytes();
        loop {
            if !self.in_start_tag {
                let relative = self.bytes[self.cursor..]
                    .iter()
                    .position(|byte| *byte == b'<')?;
                self.cursor += relative + 1;
                if self.bytes[self.cursor..].starts_with(b"!--") {
                    self.cursor += 3;
                    self.advance_past(b"-->");
                    continue;
                }
                if self.bytes[self.cursor..].starts_with(b"![CDATA[") {
                    self.cursor += 8;
                    self.advance_past(b"]]>");
                    continue;
                }
                if self.bytes.get(self.cursor) == Some(&b'?') {
                    self.cursor += 1;
                    self.advance_past(b"?>");
                    continue;
                }
                if self
                    .bytes
                    .get(self.cursor)
                    .is_some_and(|byte| matches!(*byte, b'!' | b'/'))
                {
                    self.cursor += 1;
                    self.advance_past_declaration();
                    continue;
                }

                while self
                    .bytes
                    .get(self.cursor)
                    .is_some_and(|byte| Self::is_xml_space(*byte))
                {
                    self.cursor += 1;
                }
                while self.bytes.get(self.cursor).is_some_and(|byte| {
                    !Self::is_xml_space(*byte) && !matches!(*byte, b'/' | b'>' | b'=')
                }) {
                    self.cursor += 1;
                }
                self.in_start_tag = true;
            }

            while self
                .bytes
                .get(self.cursor)
                .is_some_and(|byte| Self::is_xml_space(*byte))
            {
                self.cursor += 1;
            }
            if self.bytes[self.cursor..].starts_with(b"/>") {
                self.cursor += 2;
                self.in_start_tag = false;
                continue;
            }
            if self.bytes.get(self.cursor) == Some(&b'>') {
                self.cursor += 1;
                self.in_start_tag = false;
                continue;
            }
            if self.cursor >= self.bytes.len() {
                return None;
            }

            let name_start = self.cursor;
            while self.bytes.get(self.cursor).is_some_and(|byte| {
                !Self::is_xml_space(*byte) && !matches!(*byte, b'=' | b'/' | b'>')
            }) {
                self.cursor += 1;
            }
            let name_end = self.cursor;
            if name_start == name_end {
                self.cursor += 1;
                continue;
            }
            while self
                .bytes
                .get(self.cursor)
                .is_some_and(|byte| Self::is_xml_space(*byte))
            {
                self.cursor += 1;
            }
            if self.bytes.get(self.cursor) != Some(&b'=') {
                continue;
            }
            self.cursor += 1;
            while self
                .bytes
                .get(self.cursor)
                .is_some_and(|byte| Self::is_xml_space(*byte))
            {
                self.cursor += 1;
            }
            let Some(quote @ (b'\'' | b'"')) = self.bytes.get(self.cursor).copied() else {
                while self
                    .bytes
                    .get(self.cursor)
                    .is_some_and(|byte| !Self::is_xml_space(*byte) && *byte != b'>')
                {
                    self.cursor += 1;
                }
                continue;
            };
            let value_start = self.cursor + 1;
            let Some(relative_end) = self.bytes[value_start..]
                .iter()
                .position(|byte| *byte == quote)
            else {
                self.cursor = self.bytes.len();
                return None;
            };
            let value_end = value_start + relative_end;
            self.cursor = value_end + 1;
            if &self.bytes[name_start..name_end] == attribute {
                return Some((value_start, value_end));
            }
        }
    }
}

pub(crate) fn decimal_u32_ascii(value: u32, buffer: &mut [u8; 10]) -> &str {
    let mut value = value;
    let mut start = buffer.len();
    loop {
        start -= 1;
        buffer[start] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    std::str::from_utf8(&buffer[start..]).expect("decimal reference is ASCII")
}

pub(crate) fn image_ref_u16_ascii(value: u16, buffer: &mut [u8; 10]) -> &str {
    buffer[..5].copy_from_slice(b"image");
    let mut reversed = [0u8; 5];
    let mut value = value;
    let mut count = 0usize;
    loop {
        reversed[count] = b'0' + (value % 10) as u8;
        count += 1;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    for index in 0..count {
        buffer[5 + index] = reversed[count - index - 1];
    }
    std::str::from_utf8(&buffer[..5 + count]).expect("canonical image reference is ASCII")
}

#[cfg(test)]
mod tests {
    use super::ExactXmlAttributeScanner;

    #[test]
    fn exact_scanner_skips_non_markup_and_lookalikes() {
        let xml = concat!(
            r#"<!-- binaryItemIDRef="image1" -->"#,
            r#"<![CDATA[binaryItemIDRef="image1"]]>"#,
            r#"<t>binaryItemIDRef="image1"</t>"#,
            r#"<x x:binaryItemIDRef="image1" binaryItemIDRefExtra="image1" binaryItemIDRef="image2"/>"#,
        );
        let mut scanner = ExactXmlAttributeScanner::new(xml);
        let (start, end) = scanner.next_value("binaryItemIDRef").unwrap();
        assert_eq!(&xml[start..end], "image2");
        assert!(scanner.next_value("binaryItemIDRef").is_none());
    }

    #[test]
    fn malformed_unquoted_value_is_not_rescanned_as_an_attribute() {
        let xml = r#"<x a=binaryItemIDRef="image1" binaryItemIDRef="image2"/>"#;
        let mut scanner = ExactXmlAttributeScanner::new(xml);
        let (start, end) = scanner.next_value("binaryItemIDRef").unwrap();
        assert_eq!(&xml[start..end], "image2");
        assert!(scanner.next_value("binaryItemIDRef").is_none());
    }
}
