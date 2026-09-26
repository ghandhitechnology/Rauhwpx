use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use skia_safe::{FontMgr, FontStyle, Typeface};

pub(super) type SystemFontFamilies = HashSet<String>;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FontStyleCacheKey {
    weight: i32,
    width: i32,
    slant: i32,
}

impl FontStyleCacheKey {
    fn new(style: FontStyle) -> Self {
        Self {
            weight: *style.weight(),
            width: *style.width(),
            slant: style.slant() as i32,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FontLookupKey {
    family: String,
    style: FontStyleCacheKey,
}

thread_local! {
    static SYSTEM_TYPEFACE_CACHE: RefCell<HashMap<FontLookupKey, Option<Typeface>>> =
        RefCell::new(HashMap::new());
    static LEGACY_TYPEFACE_CACHE: RefCell<HashMap<FontStyleCacheKey, Option<Typeface>>> =
        RefCell::new(HashMap::new());
    /// 현지화 family 이름("나눔고딕") → 시스템 family 이름("Nanum Gothic").
    static LOCALIZED_FAMILY_CACHE: RefCell<Option<HashMap<String, String>>> =
        const { RefCell::new(None) };
}

pub(super) fn collect_system_families(font_mgr: &FontMgr) -> SystemFontFamilies {
    font_mgr.family_names().collect()
}

pub(super) fn has_system_family(system_families: &SystemFontFamilies, family: &str) -> bool {
    system_families.contains(family)
}

/// 설치된 시스템 family 가 가진 현지화 이름(비 ASCII)을 원래 family 이름으로 찾는다.
///
/// CoreText 등은 family 목록을 영문 이름으로만 열거한다. 한컴(macOS)과 브라우저는
/// 문서가 요청한 "나눔고딕" 을 설치된 NanumGothic 의 한글 이름으로 해석하므로, 여기서
/// 이 대응이 없으면 문서 대체 글꼴(substFont)로 떨어져 다른 서체로 그려진다.
/// 목록은 처음 필요할 때 한 번 만든다. 설치 목록에 있는 family 만 열어 보므로 미설치
/// 다운로드형 글꼴 질의(headless macOS 정지 원인)는 생기지 않는다.
fn localized_system_family(
    font_mgr: &FontMgr,
    system_families: &SystemFontFamilies,
    family: &str,
) -> Option<String> {
    if family.is_ascii() {
        return None;
    }
    LOCALIZED_FAMILY_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let map = cache.get_or_insert_with(|| {
            let mut names: Vec<&String> = system_families.iter().collect();
            names.sort();
            let mut map = HashMap::new();
            for name in names {
                let mut style_set = font_mgr.match_family(name);
                if style_set.count() == 0 {
                    continue;
                }
                let Some(typeface) = style_set.new_typeface(0) else {
                    continue;
                };
                for localized in typeface.new_family_name_iterator() {
                    if !localized.string.is_ascii() {
                        map.entry(localized.string).or_insert_with(|| name.clone());
                    }
                }
            }
            map
        });
        map.get(family).cloned()
    })
}

pub(super) fn match_system_family_style(
    font_mgr: &FontMgr,
    system_families: &SystemFontFamilies,
    family: &str,
    style: FontStyle,
) -> Option<Typeface> {
    let canonical;
    let family = if has_system_family(system_families, family) {
        family
    } else {
        canonical = localized_system_family(font_mgr, system_families, family)?;
        canonical.as_str()
    };

    let key = FontLookupKey {
        family: family.to_string(),
        style: FontStyleCacheKey::new(style),
    };
    SYSTEM_TYPEFACE_CACHE.with(|cache| {
        if let Some(cached) = { cache.borrow().get(&key).cloned() } {
            return cached;
        }

        let matched = font_mgr.match_family_style(family, style);
        cache.borrow_mut().insert(key, matched.clone());
        matched
    })
}

pub(super) fn legacy_typeface_for_style(font_mgr: &FontMgr, style: FontStyle) -> Option<Typeface> {
    let key = FontStyleCacheKey::new(style);
    LEGACY_TYPEFACE_CACHE.with(|cache| {
        if let Some(cached) = { cache.borrow().get(&key).cloned() } {
            return cached;
        }

        let matched = font_mgr.legacy_make_typeface(None::<&str>, style);
        cache.borrow_mut().insert(key, matched.clone());
        matched
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_family_is_filtered_before_system_lookup() {
        let font_mgr = FontMgr::default();
        let system_families = SystemFontFamilies::new();

        assert!(match_system_family_style(
            &font_mgr,
            &system_families,
            "Definitely Missing RHWP Test Font",
            FontStyle::normal(),
        )
        .is_none());
    }

    #[test]
    fn system_family_membership_uses_exact_family_name() {
        let mut system_families = SystemFontFamilies::new();
        system_families.insert("AppleGothic".to_string());

        assert!(has_system_family(&system_families, "AppleGothic"));
        assert!(!has_system_family(&system_families, "applegothic"));
        assert!(!has_system_family(&system_families, "Missing Family"));
    }
}
