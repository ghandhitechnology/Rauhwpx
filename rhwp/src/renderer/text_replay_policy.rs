use super::{contains_old_hangul_jamo, TextStyle};

/// Canvas 2D cannot paint a Rust-shaped glyph-id stream. Keep its text fallback
/// as one browser-shaped run when that preserves the same kerning and ligature
/// boundaries. Runs that need per-character placement stay on the legacy path.
pub(crate) fn canvas_uses_native_run_shaping(
    has_positioned_glyph_sidecar: bool,
    text: &str,
    style: &TextStyle,
) -> bool {
    has_positioned_glyph_sidecar
        && style.kerning
        && style.letter_spacing.abs() <= f64::EPSILON
        && style.extra_char_spacing.abs() <= f64::EPSILON
        && style.extra_word_spacing.abs() <= f64::EPSILON
        && style.extra_dash_advance.abs() <= f64::EPSILON
        && !contains_old_hangul_jamo(text)
        && !text.chars().any(|ch| {
            matches!(
                ch,
                '\t' | '\u{2007}' | '\u{20A9}' | '\u{20AC}' | '\u{00A3}' | '\u{00A5}' | '\u{2018}'
                    ..='\u{2027}' | '\u{00B7}' | '\u{300C}' | '\u{300D}'
            ) || (ch < '\u{0020}' && !matches!(ch, '\n' | '\r'))
        })
}

/// Canvas 2D exposes Unicode shaping through `fillText`, but has no API for
/// painting the glyph ids and offsets carried by a positioned glyph sidecar.
pub(crate) const fn web_canvas_supports_positioned_glyph_replay() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_kerning_and_ligature_candidates_in_one_browser_run() {
        let style = TextStyle {
            kerning: true,
            ..Default::default()
        };

        assert!(canvas_uses_native_run_shaping(true, "AV", &style));
        assert!(canvas_uses_native_run_shaping(true, "office", &style));
        assert!(!canvas_uses_native_run_shaping(false, "office", &style));
        assert!(!web_canvas_supports_positioned_glyph_replay());
    }

    #[test]
    fn uses_cluster_replay_when_native_shaping_would_change_layout() {
        let mut style = TextStyle {
            kerning: true,
            ..Default::default()
        };
        style.letter_spacing = 1.0;
        assert!(!canvas_uses_native_run_shaping(true, "office", &style));

        style.letter_spacing = 0.0;
        style.kerning = false;
        assert!(!canvas_uses_native_run_shaping(true, "AV", &style));
        style.kerning = true;
        assert!(!canvas_uses_native_run_shaping(true, "A\tV", &style));
        assert!(!canvas_uses_native_run_shaping(true, "A\u{300C}V", &style));
    }
}
