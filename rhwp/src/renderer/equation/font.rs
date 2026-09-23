//! 수식 글꼴 fallback. 문서가 지정한 서체는 항상 첫 후보로 보존한다.

const DEFAULT_FAMILIES: &[&str] = &[
    "Latin Modern Math",
    "STIX Two Text",
    "STIX Two Math",
    "Times New Roman",
    "Times",
    "serif",
];

// HYhwpEQ의 라틴 변수에는 Times 계열의 실제 italic 자형이 가깝다.
// regular만 있는 math face를 앞에 두면 브라우저가 직립 자형을 기울여 그린다.
const LEGACY_FAMILIES: &[&str] = &[
    "Times New Roman",
    "Times",
    "STIX Two Text",
    "Latin Modern Math",
    "STIX Two Math",
    "serif",
];

pub(crate) fn equation_font_families(font_name: Option<&str>) -> Vec<&str> {
    let requested = font_name.map(str::trim).filter(|name| !name.is_empty());
    let fallbacks = if requested.is_some_and(|name| name.eq_ignore_ascii_case("HYhwpEQ")) {
        LEGACY_FAMILIES
    } else {
        DEFAULT_FAMILIES
    };
    requested
        .into_iter()
        .chain(fallbacks.iter().copied())
        .collect()
}

pub(crate) fn equation_css_font_family(font_name: Option<&str>) -> String {
    equation_font_families(font_name)
        .into_iter()
        // Unicode SVG/Canvas fallback에는 legacy cmap의 본문 ASCII 자형을 섞지 않는다.
        // 정확한 HYhwpEQ 경로는 로드/coverage를 확인한 renderer adapter가 선택한다.
        .filter(|name| !is_legacy_equation_font(name))
        .map(|name| {
            if name == "serif" {
                name.to_string()
            } else {
                format!("'{}'", name.replace('\\', "\\\\").replace('\'', "\\'"))
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub(crate) fn is_legacy_equation_font(name: &str) -> bool {
    name.trim().eq_ignore_ascii_case("HYhwpEQ")
}

/// HYhwpEQ의 수식 전용 cmap. ASCII 영역은 본문 자형이며, 수식 자형은 PUA에 있다.
/// 호출자는 실제 서체와 해당 글립의 존재를 먼저 확인해야 한다.
/// 반환 bool은 남아 있는 합성 기울임이다. 소문자/그리스 문자는 이미 기울어진 자형이다.
pub(crate) fn legacy_equation_glyph(character: char, italic: bool) -> (char, bool) {
    let code = match character {
        'A'..='Z' => {
            return (
                char::from_u32(0xe000 + character as u32 - 'A' as u32).unwrap(),
                italic,
            )
        }
        'a'..='z' => 0xe01a + character as u32 - 'a' as u32 + if italic { 0xcb } else { 0 },
        '1'..='9' => 0xe034 + character as u32 - '1' as u32,
        '0' => 0xe03d,
        _ => {
            if italic {
                if let Some(index) = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω"
                    .chars()
                    .position(|greek| greek == character)
                {
                    return (char::from_u32(0xe085 + index as u32).unwrap(), false);
                }
            }
            match character {
                '!' => 0xe03e,
                '@' => 0xe03f,
                '#' => 0xe040,
                '$' => 0xe041,
                '%' => 0xe042,
                '*' => 0xe043,
                '(' => 0xe044,
                ')' => 0xe045,
                '-' | '−' => 0xe046,
                '=' => 0xe047,
                '+' => 0xe048,
                '[' => 0xe049,
                ']' => 0xe04a,
                '{' => 0xe04b,
                '}' => 0xe04c,
                '|' => 0xe04d,
                ';' => 0xe04e,
                ':' => 0xe04f,
                ',' => 0xe052,
                '.' => 0xe053,
                '/' => 0xe054,
                '<' => 0xe055,
                '>' => 0xe056,
                '?' => 0xe057,
                _ => return (character, italic),
            }
        }
    };
    (char::from_u32(code).unwrap(), false)
}

pub(crate) fn is_greek_variable(text: &str) -> bool {
    text.chars().any(|c| matches!(c, '\u{0391}'..='\u{03c9}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_equation_fallback_keeps_real_italic_faces_before_regular_math_faces() {
        let families = equation_font_families(Some("HYhwpEQ"));
        assert_eq!(
            &families[..4],
            ["HYhwpEQ", "Times New Roman", "Times", "STIX Two Text"]
        );
        assert_eq!(families.last(), Some(&"serif"));
        assert!(!equation_css_font_family(Some("HYhwpEQ")).contains("HYhwpEQ"));
        for requested in ["Latin Modern Math", "Cambria Math", "STIX Two Math"] {
            assert_eq!(equation_font_families(Some(requested))[0], requested);
        }
    }

    #[test]
    fn legacy_math_cmap_keeps_roman_and_intrinsic_italic_distinct() {
        assert_eq!(legacy_equation_glyph('p', true), ('\u{e0f4}', false));
        assert_eq!(legacy_equation_glyph('i', true), ('\u{e0ed}', false));
        assert_eq!(legacy_equation_glyph('f', true), ('\u{e0ea}', false));
        assert_eq!(legacy_equation_glyph('p', false), ('\u{e029}', false));
        assert_eq!(legacy_equation_glyph('1', false), ('\u{e034}', false));
        assert_eq!(legacy_equation_glyph('L', true), ('\u{e00b}', true));
        assert_eq!(legacy_equation_glyph('α', true), ('\u{e09d}', false));
        assert_eq!(legacy_equation_glyph('Ω', true), ('\u{e09c}', false));
        assert_eq!(legacy_equation_glyph('α', false), ('α', false));
        assert_eq!(legacy_equation_glyph('한', false), ('한', false));
    }
}
