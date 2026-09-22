//! Keep the package version compatible with the HwpUnitChar values we emit.

use std::borrow::Cow;

use quick_xml::{events::Event, Reader};

/// Mac Hancom 12.30.0 halves HwpUnitChar margins when version.xml declares
/// XML 1.2 or 1.3. Controlled single-attribute probes retain the correct
/// values with 1.4 and 1.5. This writer always emits HwpUnitChar switches.
pub(super) const MIN_XML_VERSION: &str = "1.4";

pub(super) fn emitted_xml_version(version: Option<&str>) -> &str {
    let Some(version) = version else {
        return MIN_XML_VERSION;
    };
    let Some((major, minor)) = version.split_once('.') else {
        return version;
    };
    match (major.parse::<u32>(), minor.parse::<u32>()) {
        (Ok(1), Ok(0..=3)) => MIN_XML_VERSION,
        _ => version,
    }
}

/// Change only the root's xmlVersion value. Preserve the original producer,
/// platform, unrelated attributes, whitespace and comments byte for byte.
/// Unknown auxiliary XML remains untouched rather than being replaced.
pub(super) fn for_regenerated_hwpx(bytes: &[u8]) -> Cow<'_, [u8]> {
    let Ok(xml) = std::str::from_utf8(bytes) else {
        return Cow::Borrowed(bytes);
    };
    let mut reader = Reader::from_str(xml);
    loop {
        let position = reader.buffer_position() as usize;
        let (root, empty) = match reader.read_event() {
            Ok(Event::Start(root)) => (root, false),
            Ok(Event::Empty(root)) => (root, true),
            Ok(Event::Decl(_) | Event::Comment(_) | Event::PI(_) | Event::Text(_)) => continue,
            _ => return Cow::Borrowed(bytes),
        };
        if root.local_name().as_ref() != b"HCFVersion" {
            return Cow::Borrowed(bytes);
        }
        let end = reader.buffer_position() as usize;
        let Ok(attributes) = root.attributes().collect::<Result<Vec<_>, _>>() else {
            return Cow::Borrowed(bytes);
        };
        for attribute in attributes {
            if attribute.key.as_ref() == b"xmlVersion" {
                let Ok(current) = std::str::from_utf8(attribute.value.as_ref()) else {
                    return Cow::Borrowed(bytes);
                };
                let emitted = emitted_xml_version(Some(current));
                if emitted == current {
                    return Cow::Borrowed(bytes);
                }
                let mut scanner =
                    crate::xml_attr::ExactXmlAttributeScanner::new(&xml[position..end]);
                let Some((start, finish)) = scanner.next_value("xmlVersion") else {
                    return Cow::Borrowed(bytes);
                };
                let mut result = xml.to_owned();
                result.replace_range(position + start..position + finish, emitted);
                return Cow::Owned(result.into_bytes());
            }
        }
        let mut result = xml.to_owned();
        result.insert_str(end - if empty { 2 } else { 1 }, " xmlVersion=\"1.4\"");
        return Cow::Owned(result.into_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modern_units_require_xml_14_without_downgrading_newer_versions() {
        for version in [None, Some("1.0"), Some("1.1"), Some("1.2"), Some("1.3")] {
            assert_eq!(emitted_xml_version(version), "1.4");
        }
        for version in ["1.4", "1.5", "1.10", "2.0", "unknown"] {
            assert_eq!(emitted_xml_version(Some(version)), version);
        }
    }

    #[test]
    fn updates_only_root_xml_version_and_retains_original_metadata() {
        let original = b"<?xml version='1.0'?><!-- xmlVersion='1.2' --><hv:HCFVersion application='Original app' os='10' xmlVersion = '1.2' appVersion='original build'/>";
        let expected = std::str::from_utf8(original).unwrap().replacen(
            "xmlVersion = '1.2'",
            "xmlVersion = '1.4'",
            1,
        );
        let updated = for_regenerated_hwpx(original);
        assert_eq!(updated.as_ref(), expected.as_bytes());
        assert!(matches!(for_regenerated_hwpx(&updated), Cow::Borrowed(_)));
    }

    #[test]
    fn absent_version_is_added_but_unknown_auxiliary_xml_is_preserved() {
        assert_eq!(
            for_regenerated_hwpx(b"<HCFVersion os='1'/>").as_ref(),
            b"<HCFVersion os='1' xmlVersion=\"1.4\"/>"
        );
        for original in [
            b"<custom-version platform='Mac'/>".as_slice(),
            b"<HCFVersion xmlVersion='1.5'/>",
            b"<HCFVersion xmlVersion='unknown'/>",
            b"<custom-version><HCFVersion xmlVersion='1.2'/></custom-version>",
        ] {
            assert_eq!(for_regenerated_hwpx(original).as_ref(), original);
        }
    }
}
