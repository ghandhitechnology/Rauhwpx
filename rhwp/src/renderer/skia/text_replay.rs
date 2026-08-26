use std::collections::HashSet;

use skia_safe::{
    font, paint, Canvas, Color, Font, FontMgr, FontStyle, Paint, PathEffect, Rect, Typeface,
};

use crate::model::style::UnderlineType;
use crate::paint::LayerOutputOptions;
use crate::renderer::composer::{
    decode_pua_overlap_number, expand_pua_render_text, pua_to_display_text, CharOverlapInfo,
};
use crate::renderer::layout::{compute_char_positions, split_into_clusters};
use crate::renderer::render_tree::BoundingBox;
use crate::renderer::{clamp_tab_leader_end_x, TextStyle};

use super::font_lookup::{
    legacy_typeface_for_style, match_system_family_style, SystemFontFamilies,
};
use super::renderer::{colorref_to_skia, typeface_for_style, TypefaceCatalog};

const SANS_CJK_FALLBACK_FAMILIES: &[&str] = &[
    "Noto Sans KR",
    "Noto Sans CJK KR",
    "Nanum Gothic",
    "Malgun Gothic",
    "맑은 고딕",
    "Apple SD Gothic Neo",
    "Noto Serif KR",
    "Noto Serif CJK KR",
    "Nanum Myeongjo",
    "Batang",
    "바탕",
    "AppleMyungjo",
    "DejaVu Sans",
    "Arial",
    "sans-serif",
];

const SERIF_CJK_FALLBACK_FAMILIES: &[&str] = &[
    "Noto Serif KR",
    "Noto Serif CJK KR",
    "Nanum Myeongjo",
    "Batang",
    "바탕",
    "AppleMyungjo",
    "Noto Sans KR",
    "Noto Sans CJK KR",
    "Nanum Gothic",
    "Malgun Gothic",
    "맑은 고딕",
    "Apple SD Gothic Neo",
    "DejaVu Serif",
    "Times New Roman",
    "serif",
];

const MONO_CJK_FALLBACK_FAMILIES: &[&str] = &[
    "GulimChe",
    "굴림체",
    "D2Coding",
    "Noto Sans Mono",
    "monospace",
];

fn prefers_monospace_cjk_fallback(family: &str) -> bool {
    let lower = family.trim().to_lowercase();
    if lower.is_empty() {
        return false;
    }
    // KoPub uses `돋움체`/`바탕체` in proportional publication-face names.
    if lower.starts_with("kopub")
        && (lower.contains("돋움체")
            || lower.contains("바탕체")
            || lower.contains("dotum")
            || lower.contains("batang"))
    {
        return false;
    }
    let has_mono_token = lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|token| matches!(token, "mono" | "monospace"));
    family.contains("굴림체")
        || family.contains("바탕체")
        || lower.contains("gulimche")
        || lower.contains("batangche")
        || lower.contains("coding")
        || lower.contains("courier")
        || has_mono_token
}

fn prefers_serif_cjk_fallback(family: &str) -> bool {
    let lower = family.trim().to_lowercase();
    if lower.is_empty() {
        return false;
    }
    let explicitly_sans = [
        "고딕",
        "돋움",
        "굴림",
        "그래픽",
        "헤드라인",
        "gothic",
        "dotum",
        "gulim",
        "graphic",
        "headline",
        "sans",
    ]
    .iter()
    .any(|token| lower.contains(token));
    !explicitly_sans
        && [
            "명조", "바탕", "궁서", "myeong", "myung", "batang", "gungsuh", "gungseo", "serif",
        ]
        .iter()
        .any(|token| lower.contains(token))
}

fn cjk_fallback_families(family: &str) -> &'static [&'static str] {
    if prefers_monospace_cjk_fallback(family) {
        MONO_CJK_FALLBACK_FAMILIES
    } else if prefers_serif_cjk_fallback(family) {
        SERIF_CJK_FALLBACK_FAMILIES
    } else {
        SANS_CJK_FALLBACK_FAMILIES
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CharacterTypefaceSource {
    ExplicitChain,
    SystemCharacterFallback,
}

fn typeface_for_character(
    typeface_chain: &[Typeface],
    font_mgr: &FontMgr,
    font_style: FontStyle,
    codepoint: i32,
) -> Option<(Typeface, CharacterTypefaceSource)> {
    if let Some(typeface) = typeface_chain
        .iter()
        .find(|typeface| typeface.unichar_to_glyph(codepoint) != 0)
        .cloned()
    {
        return Some((typeface, CharacterTypefaceSource::ExplicitChain));
    }

    // Use an empty family name deliberately. Asking CoreText for an arbitrary missing
    // document family can trigger downloadable-font IPC and hang a headless macOS render.
    // The explicit chain above already tried every installed requested/fallback family;
    // this final query asks only for a system face that owns the character.
    font_mgr
        .match_family_style_character("", font_style, &[], codepoint)
        .filter(|typeface| typeface.unichar_to_glyph(codepoint) != 0)
        .map(|typeface| (typeface, CharacterTypefaceSource::SystemCharacterFallback))
}

pub(super) struct SkiaTextReplay<'a> {
    pub(super) canvas: &'a Canvas,
    pub(super) font_mgr: &'a FontMgr,
    pub(super) custom_typefaces: &'a TypefaceCatalog,
    pub(super) bundled_typefaces: &'a TypefaceCatalog,
    pub(super) system_families: &'a SystemFontFamilies,
    pub(super) output_options: &'a LayerOutputOptions,
}

impl SkiaTextReplay<'_> {
    pub(super) fn draw_text(
        &self,
        text: &str,
        bbox: BoundingBox,
        style: &TextStyle,
        baseline: f64,
        rotation: f64,
        is_vertical: bool,
        char_overlap: Option<&CharOverlapInfo>,
        is_marker: bool,
        is_para_end: bool,
        is_line_break_end: bool,
    ) {
        let canvas = self.canvas;
        let output_options = self.output_options;
        let draw_text =
            |text: &str,
             bbox: crate::renderer::render_tree::BoundingBox,
             style: &crate::renderer::TextStyle,
             baseline: f64,
             rotation: f64,
             is_vertical: bool,
             char_overlap: Option<&crate::renderer::composer::CharOverlapInfo>| {
                if text.is_empty() && style.tab_leaders.is_empty() {
                    return;
                }
                let font_size = if style.font_size > 0.0 {
                    style.font_size as f32
                } else {
                    12.0
                };
                let font_style = match (style.bold, style.italic) {
                    (true, true) => FontStyle::bold_italic(),
                    (true, false) => FontStyle::bold(),
                    (false, true) => FontStyle::italic(),
                    (false, false) => FontStyle::normal(),
                };
                let mut families = Vec::new();
                // [#3314] 접미사 face("Noto Serif KR Black") 미설치 시 base
                // family 가 아래 generic 폴백보다 먼저 구제 — SVG 체인과 정합.
                let base_family =
                    crate::renderer::base_family_without_weight_suffix(&style.font_family);
                if !style.font_family.trim().is_empty() {
                    families.push(style.font_family.as_str());
                }
                if let Some(base) = base_family.as_deref() {
                    families.push(base);
                }
                // 한글 fallback (CJK glyph 미보유 폰트로 fallback 시 사각형 방지).
                // 명조/바탕/궁서 계열을 sans로 바꾸면 글리프 폭·획·줄바꿈이 모두
                // 달라지므로 원본 family 분류에 맞는 계열을 먼저 시도한다.
                families.extend(cjk_fallback_families(&style.font_family));
                // 1) 사용자 지정 폰트 (--font-path) 우선 검색
                // 2) 시스템 FontMgr 검색 (한글 fallback chain 포함)
                // 3) 마지막 fallback (legacy_make_typeface)
                //
                // 모든 후보를 chain 으로 보존 — char 단위 fallback 에 사용.
                let typeface_chain: Vec<Typeface> = {
                    let mut chain: Vec<Typeface> = Vec::new();
                    let mut seen: HashSet<String> = HashSet::new();
                    let mut push =
                        |chain: &mut Vec<Typeface>, seen: &mut HashSet<String>, tf: Typeface| {
                            let key = tf.family_name();
                            if seen.insert(key) {
                                chain.push(tf);
                            }
                        };
                    for family in &families {
                        if let Some(tf) =
                            typeface_for_style(self.custom_typefaces, family, font_style)
                        {
                            push(&mut chain, &mut seen, tf);
                        }
                    }
                    for family in &families {
                        if let Some(tf) = match_system_family_style(
                            self.font_mgr,
                            self.system_families,
                            family,
                            font_style,
                        ) {
                            push(&mut chain, &mut seen, tf);
                        }
                    }
                    // [#3300] 번들 최후-폴백(ttfs/opensource)은 custom·시스템
                    // 뒤에만 선다. #2864 가 번들을 custom 에 섞은 뒤 깊은 폴백
                    // (Noto Sans KR)이 시스템 1순위를 제치고 본문 전체를 폴백
                    // 서체로 렌더했다(r23 발산 −6.9pp). 폰트 미설치 환경(#2293)
                    // 에서는 앞 단계가 비므로 종전대로 번들이 한국어를 구제한다.
                    for family in &families {
                        if let Some(tf) =
                            typeface_for_style(self.bundled_typefaces, family, font_style)
                        {
                            push(&mut chain, &mut seen, tf);
                        }
                    }
                    if let Some(tf) = legacy_typeface_for_style(self.font_mgr, font_style) {
                        push(&mut chain, &mut seen, tf);
                    }
                    chain
                };
                let primary_typeface = typeface_chain.first().cloned();
                let font_for_text = |sample: &str, size: f32| -> Option<Font> {
                    let visible_char = sample.chars().find(|ch| !ch.is_whitespace());
                    if let Some(ch) = visible_char {
                        let codepoint = ch as i32;
                        // Keep the explicit chain compact for deterministic body-text
                        // metrics, but do not drop symbols which live outside that chain.
                        // SVG/browser rendering performs a character-aware system fallback
                        // here (notably for U+25B8 numbering markers in Arial tables), so
                        // ask Skia's FontMgr for an equivalent last-resort face.
                        if let Some((tf, _source)) = typeface_for_character(
                            &typeface_chain,
                            self.font_mgr,
                            font_style,
                            codepoint,
                        ) {
                            let mut font = Font::new(tf, size);
                            font.set_edging(font::Edging::AntiAlias);
                            return Some(font);
                        }
                        return None;
                    }
                    if let Some(tf) = primary_typeface.clone() {
                        let mut font = Font::new(tf, size);
                        font.set_edging(font::Edging::AntiAlias);
                        Some(font)
                    } else {
                        let mut font = Font::default();
                        font.set_size(size);
                        font.set_edging(font::Edging::AntiAlias);
                        Some(font)
                    }
                };
                let y = if baseline > 0.0 {
                    bbox.y + baseline
                } else {
                    bbox.y + bbox.height
                };
                let effective_rotation = if is_vertical {
                    rotation + 90.0
                } else {
                    rotation
                };
                if effective_rotation != 0.0 {
                    canvas.save();
                    canvas.rotate(
                        effective_rotation as f32,
                        Some(
                            (
                                (bbox.x + bbox.width / 2.0) as f32,
                                (bbox.y + bbox.height / 2.0) as f32,
                            )
                                .into(),
                        ),
                    );
                }

                if let Some(overlap) = char_overlap {
                    let chars: Vec<char> = text.chars().collect();
                    if chars.is_empty() {
                        if effective_rotation != 0.0 {
                            canvas.restore();
                        }
                        return;
                    }

                    let size_ratio = if overlap.inner_char_size > 0 {
                        overlap.inner_char_size as f32 / 100.0
                    } else {
                        1.0
                    };
                    let inner_size = (font_size * size_ratio).max(1.0);
                    let box_size = font_size.max(1.0);
                    let is_combined = decode_pua_overlap_number(&chars);
                    let effective_border = if overlap.border_type == 0 && is_combined.is_some() {
                        1
                    } else {
                        overlap.border_type
                    };
                    let is_reversed = effective_border == 2 || effective_border == 4;
                    let is_circle = effective_border == 1 || effective_border == 2;
                    let is_rect = effective_border == 3 || effective_border == 4;
                    let fill_color = if is_reversed {
                        Color::BLACK
                    } else {
                        Color::TRANSPARENT
                    };
                    let text_color = if is_reversed {
                        Color::WHITE
                    } else {
                        colorref_to_skia(style.color, 1.0)
                    };
                    let stroke_color = colorref_to_skia(style.color, 1.0);
                    let mut shape_paint = Paint::default();
                    shape_paint.set_anti_alias(true);
                    let mut stroke_paint = Paint::default();
                    stroke_paint.set_anti_alias(true);
                    stroke_paint.set_style(paint::Style::Stroke);
                    stroke_paint.set_stroke_width(0.8);
                    stroke_paint.set_color(stroke_color);
                    let mut text_paint = Paint::default();
                    text_paint.set_anti_alias(true);
                    text_paint.set_color(text_color);
                    let draw_overlap_text = |display: &str, cx: f32, cy: f32| {
                        if let Some(font) = font_for_text(display, inner_size) {
                            let width = font.measure_str(display, Some(&text_paint)).0;
                            canvas.draw_str(
                                display,
                                (cx - width / 2.0, cy + inner_size * 0.35),
                                &font,
                                &text_paint,
                            );
                        }
                    };
                    let mut draw_overlap_box = |display: &str, cx: f32, cy: f32| {
                        if is_circle {
                            shape_paint.set_style(paint::Style::Fill);
                            shape_paint.set_color(fill_color);
                            if is_reversed {
                                canvas.draw_circle((cx, cy), box_size / 2.0, &shape_paint);
                            }
                            canvas.draw_circle((cx, cy), box_size / 2.0, &stroke_paint);
                        } else if is_rect {
                            let rect = Rect::from_xywh(
                                cx - box_size / 2.0,
                                cy - box_size / 2.0,
                                box_size,
                                box_size,
                            );
                            shape_paint.set_style(paint::Style::Fill);
                            shape_paint.set_color(fill_color);
                            if is_reversed {
                                canvas.draw_rect(rect, &shape_paint);
                            }
                            canvas.draw_rect(rect, &stroke_paint);
                        }
                        draw_overlap_text(display, cx, cy);
                    };

                    if let Some(number) = is_combined {
                        draw_overlap_box(
                            &number,
                            (bbox.x + bbox.width / 2.0) as f32,
                            (bbox.y + bbox.height / 2.0) as f32,
                        );
                    } else if chars.len() > 1 {
                        let cx = (bbox.x + bbox.width / 2.0) as f32;
                        let cy = (bbox.y + bbox.height / 2.0) as f32;
                        if is_circle {
                            shape_paint.set_style(paint::Style::Fill);
                            shape_paint.set_color(fill_color);
                            if is_reversed {
                                canvas.draw_circle((cx, cy), box_size / 2.0, &shape_paint);
                            }
                            canvas.draw_circle((cx, cy), box_size / 2.0, &stroke_paint);
                        } else if is_rect {
                            let rect = Rect::from_xywh(
                                cx - box_size / 2.0,
                                cy - box_size / 2.0,
                                box_size,
                                box_size,
                            );
                            shape_paint.set_style(paint::Style::Fill);
                            shape_paint.set_color(fill_color);
                            if is_reversed {
                                canvas.draw_rect(rect, &shape_paint);
                            }
                            canvas.draw_rect(rect, &stroke_paint);
                        }

                        for ch in chars.iter() {
                            let display = {
                                let codepoint = *ch as u32;
                                if (0x2460..=0x2473).contains(&codepoint) {
                                    (codepoint - 0x2460 + 1).to_string()
                                } else if let Some(display) = pua_to_display_text(*ch) {
                                    display
                                } else {
                                    ch.to_string()
                                }
                            };
                            draw_overlap_text(&display, cx, cy);
                        }
                    } else {
                        for (index, ch) in chars.iter().enumerate() {
                            let display = {
                                let codepoint = *ch as u32;
                                if (0x2460..=0x2473).contains(&codepoint) {
                                    (codepoint - 0x2460 + 1).to_string()
                                } else if let Some(display) = pua_to_display_text(*ch) {
                                    display
                                } else {
                                    ch.to_string()
                                }
                            };
                            draw_overlap_box(
                                &display,
                                bbox.x as f32 + index as f32 * box_size + box_size / 2.0,
                                (bbox.y + bbox.height / 2.0) as f32,
                            );
                        }
                    }
                    if effective_rotation != 0.0 {
                        canvas.restore();
                    }
                    return;
                }

                let text = expand_pua_render_text(text);
                let text = text.as_str();
                let char_positions = compute_char_positions(text, style);
                let clusters = split_into_clusters(text);
                let text_width = *char_positions.last().unwrap_or(&0.0) as f32;
                let ratio = if style.ratio > 0.0 {
                    style.ratio as f32
                } else {
                    1.0
                };
                let has_ratio = (ratio - 1.0).abs() > 0.01;
                let shade_rgb = style.shade_color & 0x00FF_FFFF;
                if shade_rgb != 0x00FF_FFFF && shade_rgb != 0 && text_width > 0.0 {
                    let mut shade = Paint::default();
                    shade.set_anti_alias(true);
                    shade.set_style(paint::Style::Fill);
                    shade.set_color(colorref_to_skia(style.shade_color, 1.0));
                    canvas.draw_rect(
                        Rect::from_xywh(
                            bbox.x as f32,
                            y as f32 - font_size,
                            text_width,
                            font_size * 1.2,
                        ),
                        &shade,
                    );
                }

                let draw_styled_line = |x1: f32,
                                        y: f32,
                                        x2: f32,
                                        color: Color,
                                        width: f32,
                                        dash: &[f32],
                                        round: bool| {
                    if x2 <= x1 {
                        return;
                    }
                    let mut line_paint = Paint::default();
                    line_paint.set_anti_alias(true);
                    line_paint.set_style(paint::Style::Stroke);
                    line_paint.set_stroke_width(width);
                    line_paint.set_color(color);
                    if round {
                        line_paint.set_stroke_cap(paint::Cap::Round);
                    }
                    if !dash.is_empty() {
                        if let Some(effect) = PathEffect::dash(dash, 0.0) {
                            line_paint.set_path_effect(effect);
                        }
                    }
                    canvas.draw_line((x1, y), (x2, y), &line_paint);
                };
                let draw_line_shape =
                    |x1: f32, y: f32, x2: f32, color: Color, shape: u8| match shape {
                        7 => {
                            draw_styled_line(x1, y - 1.0, x2, color, 0.7, &[], false);
                            draw_styled_line(x1, y + 1.0, x2, color, 0.7, &[], false);
                        }
                        8 => {
                            draw_styled_line(x1, y - 1.2, x2, color, 0.5, &[], false);
                            draw_styled_line(x1, y + 0.8, x2, color, 1.2, &[], false);
                        }
                        9 => {
                            draw_styled_line(x1, y - 0.8, x2, color, 1.2, &[], false);
                            draw_styled_line(x1, y + 1.2, x2, color, 0.5, &[], false);
                        }
                        10 => {
                            draw_styled_line(x1, y - 1.5, x2, color, 0.5, &[], false);
                            draw_styled_line(x1, y, x2, color, 0.5, &[], false);
                            draw_styled_line(x1, y + 1.5, x2, color, 0.5, &[], false);
                        }
                        1 => draw_styled_line(x1, y, x2, color, 1.0, &[3.0, 3.0], false),
                        2 => draw_styled_line(x1, y, x2, color, 1.0, &[1.0, 2.0], false),
                        3 => draw_styled_line(x1, y, x2, color, 1.0, &[6.0, 2.0, 1.0, 2.0], false),
                        4 => draw_styled_line(
                            x1,
                            y,
                            x2,
                            color,
                            1.0,
                            &[6.0, 2.0, 1.0, 2.0, 1.0, 2.0],
                            false,
                        ),
                        5 => draw_styled_line(x1, y, x2, color, 1.0, &[8.0, 4.0], false),
                        6 => draw_styled_line(x1, y, x2, color, 1.0, &[0.1, 2.5], true),
                        _ => draw_styled_line(x1, y, x2, color, 1.0, &[], false),
                    };

                let suppress_dash_leader_line = !matches!(style.underline, UnderlineType::None);
                let dash_run_groups: Vec<(usize, usize)> = {
                    let mut groups = Vec::new();
                    let mut run_start: Option<usize> = None;
                    for (idx, (_, cluster)) in clusters.iter().enumerate() {
                        if cluster == "-" {
                            if run_start.is_none() {
                                run_start = Some(idx);
                            }
                        } else if let Some(start) = run_start.take() {
                            if idx - start >= 3 {
                                groups.push((start, idx));
                            }
                        }
                    }
                    if let Some(start) = run_start {
                        if clusters.len() - start >= 3 {
                            groups.push((start, clusters.len()));
                        }
                    }
                    groups
                };
                let cluster_in_dash_run = |cluster_idx: usize| -> Option<(f32, f32)> {
                    for &(start, end) in &dash_run_groups {
                        if cluster_idx == start {
                            let start_char_idx = clusters[start].0;
                            let last = &clusters[end - 1];
                            let end_char_idx = last.0 + last.1.chars().count();
                            let x1 = char_positions.get(start_char_idx).copied().unwrap_or(0.0);
                            let x2 = char_positions
                                .get(end_char_idx)
                                .copied()
                                .unwrap_or_else(|| *char_positions.last().unwrap_or(&0.0));
                            return Some((x1 as f32, x2 as f32));
                        }
                        if cluster_idx > start && cluster_idx < end {
                            return Some((f32::NAN, f32::NAN));
                        }
                    }
                    None
                };
                let cluster_advance = |char_idx: usize, cluster: &str| -> f32 {
                    let end = char_idx + cluster.chars().count();
                    if end < char_positions.len() {
                        (char_positions[end] - char_positions[char_idx]) as f32
                    } else {
                        0.0
                    }
                };
                let is_middle_dot = |cluster: &str| cluster == "\u{00B7}";
                let draw_text_pass = |color: Color, stroke_width: f32, dx: f32, dy: f32| {
                    let mut text_paint = Paint::default();
                    text_paint.set_anti_alias(true);
                    text_paint.set_color(color);
                    if stroke_width > 0.0 {
                        text_paint.set_style(paint::Style::Stroke);
                        text_paint.set_stroke_width(stroke_width);
                    } else {
                        text_paint.set_style(paint::Style::Fill);
                    }
                    for (cluster_idx, (char_idx, cluster)) in clusters.iter().enumerate() {
                        if cluster == " " || cluster == "\t" || cluster == "\u{2007}" {
                            continue;
                        }
                        if cluster.starts_with(|ch: char| {
                            ch < '\u{0020}' && !matches!(ch, '\t' | '\n' | '\r')
                        }) {
                            continue;
                        }
                        if let Some((x1_rel, x2_rel)) = cluster_in_dash_run(cluster_idx) {
                            if x1_rel.is_finite() && !suppress_dash_leader_line {
                                draw_styled_line(
                                    bbox.x as f32 + x1_rel + dx,
                                    y as f32 - font_size * 0.32 + dy,
                                    bbox.x as f32 + x2_rel + dx,
                                    color,
                                    (font_size * 0.07).max(0.5),
                                    &[],
                                    false,
                                );
                            }
                            continue;
                        }
                        if is_middle_dot(cluster) {
                            let advance = cluster_advance(*char_idx, cluster);
                            let cx = bbox.x as f32
                                + char_positions.get(*char_idx).copied().unwrap_or(0.0) as f32
                                + advance / 2.0
                                + dx;
                            let cy = y as f32
                                - font_size
                                    * crate::renderer::render_tree::MIDDLE_DOT_CY_OFFSET_EM as f32
                                + dy;
                            let mut dot_paint = Paint::default();
                            dot_paint.set_anti_alias(true);
                            dot_paint.set_style(paint::Style::Fill);
                            dot_paint.set_color(color);
                            canvas.draw_circle(
                                (cx, cy),
                                font_size
                                    * crate::renderer::render_tree::MIDDLE_DOT_RADIUS_EM as f32,
                                &dot_paint,
                            );
                            continue;
                        }
                        if let Some(font) = font_for_text(cluster, font_size) {
                            let char_x = bbox.x as f32
                                + char_positions.get(*char_idx).copied().unwrap_or(0.0) as f32
                                + dx;
                            let char_y = y as f32 + dy;
                            if has_ratio {
                                canvas.save();
                                canvas.translate((char_x, char_y));
                                canvas.scale((ratio, 1.0));
                                canvas.draw_str(cluster, (0.0, 0.0), &font, &text_paint);
                                canvas.restore();
                            } else {
                                canvas.draw_str(cluster, (char_x, char_y), &font, &text_paint);
                            }
                        }
                    }
                };

                if style.shadow_type > 0 {
                    draw_text_pass(
                        colorref_to_skia(style.shadow_color, 1.0),
                        0.0,
                        style.shadow_offset_x as f32,
                        style.shadow_offset_y as f32,
                    );
                }
                if style.outline_type > 0 {
                    draw_text_pass(
                        colorref_to_skia(style.color, 1.0),
                        (font_size * 0.08).max(0.8),
                        0.0,
                        0.0,
                    );
                }
                if style.emboss {
                    draw_text_pass(Color::WHITE, 0.0, -1.0, -1.0);
                    draw_text_pass(Color::from_argb(255, 96, 96, 96), 0.0, 1.0, 1.0);
                } else if style.engrave {
                    draw_text_pass(Color::from_argb(255, 96, 96, 96), 0.0, -1.0, -1.0);
                    draw_text_pass(Color::WHITE, 0.0, 1.0, 1.0);
                }
                draw_text_pass(colorref_to_skia(style.color, 1.0), 0.0, 0.0, 0.0);

                if !matches!(style.underline, UnderlineType::None) && text_width > 0.0 {
                    let color = if style.underline_color != 0 {
                        colorref_to_skia(style.underline_color, 1.0)
                    } else {
                        colorref_to_skia(style.color, 1.0)
                    };
                    let line_y = match style.underline {
                        UnderlineType::Top => y as f32 - font_size + 1.0,
                        _ => y as f32 + 2.0,
                    };
                    draw_line_shape(
                        bbox.x as f32,
                        line_y,
                        bbox.x as f32 + text_width,
                        color,
                        style.underline_shape,
                    );
                }
                if style.strikethrough && text_width > 0.0 {
                    let color = if style.strike_color != 0 {
                        colorref_to_skia(style.strike_color, 1.0)
                    } else {
                        colorref_to_skia(style.color, 1.0)
                    };
                    draw_line_shape(
                        bbox.x as f32,
                        y as f32 - font_size * 0.3,
                        bbox.x as f32 + text_width,
                        color,
                        style.strike_shape,
                    );
                }
                if style.emphasis_dot > 0 {
                    let dot = match style.emphasis_dot {
                        1 => "●",
                        2 => "○",
                        3 => "ˇ",
                        4 => "˜",
                        5 => "･",
                        6 => "˸",
                        _ => "",
                    };
                    if !dot.is_empty() {
                        let dot_size = font_size * 0.3;
                        let dot_y = y as f32 - font_size * 1.05;
                        if let Some(font) = font_for_text(dot, dot_size) {
                            let mut dot_paint = Paint::default();
                            dot_paint.set_anti_alias(true);
                            dot_paint.set_color(colorref_to_skia(style.color, 1.0));
                            for cx in &char_positions[..char_positions.len().saturating_sub(1)] {
                                canvas.draw_str(
                                    dot,
                                    (bbox.x as f32 + *cx as f32 + font_size * ratio * 0.5, dot_y),
                                    &font,
                                    &dot_paint,
                                );
                            }
                        }
                    }
                }
                for leader in &style.tab_leaders {
                    if leader.fill_type == 0 {
                        continue;
                    }
                    let x1 = bbox.x as f32 + leader.start_x as f32;
                    let leader_end_x =
                        clamp_tab_leader_end_x(text, &char_positions, leader, font_size as f64);
                    let x2 = bbox.x as f32 + leader_end_x as f32;
                    let line_y = y as f32 - font_size * 0.35;
                    let color = colorref_to_skia(style.color, 1.0);
                    match leader.fill_type {
                        1 => draw_styled_line(x1, line_y, x2, color, 0.5, &[], false),
                        2 => draw_styled_line(x1, line_y, x2, color, 0.5, &[3.0, 3.0], false),
                        3 => draw_styled_line(x1, line_y, x2, color, 1.0, &[0.1, 3.0], true),
                        4 => draw_styled_line(
                            x1,
                            line_y,
                            x2,
                            color,
                            0.5,
                            &[6.0, 2.0, 1.0, 2.0],
                            false,
                        ),
                        5 => draw_styled_line(
                            x1,
                            line_y,
                            x2,
                            color,
                            0.5,
                            &[6.0, 2.0, 1.0, 2.0, 1.0, 2.0],
                            false,
                        ),
                        6 => draw_styled_line(x1, line_y, x2, color, 0.5, &[8.0, 4.0], false),
                        7 => draw_styled_line(x1, line_y, x2, color, 0.7, &[0.1, 2.5], true),
                        8 => {
                            draw_styled_line(x1, line_y - 1.0, x2, color, 0.3, &[], false);
                            draw_styled_line(x1, line_y + 1.0, x2, color, 0.3, &[], false);
                        }
                        9 => {
                            draw_styled_line(x1, line_y - 1.2, x2, color, 0.3, &[], false);
                            draw_styled_line(x1, line_y + 0.8, x2, color, 0.8, &[], false);
                        }
                        10 => {
                            draw_styled_line(x1, line_y - 0.8, x2, color, 0.8, &[], false);
                            draw_styled_line(x1, line_y + 1.2, x2, color, 0.3, &[], false);
                        }
                        11 => {
                            draw_styled_line(x1, line_y - 2.0, x2, color, 0.3, &[], false);
                            draw_styled_line(x1, line_y, x2, color, 0.8, &[], false);
                            draw_styled_line(x1, line_y + 2.0, x2, color, 0.3, &[], false);
                        }
                        _ => draw_styled_line(x1, line_y, x2, color, 0.5, &[1.0, 2.0], false),
                    }
                }
                if effective_rotation != 0.0 {
                    canvas.restore();
                }
            };
        let draw_text_marks = |text: &str,
                               bbox: crate::renderer::render_tree::BoundingBox,
                               style: &crate::renderer::TextStyle,
                               baseline: f64,
                               rotation: f64,
                               is_vertical: bool,
                               is_marker: bool,
                               is_para_end: bool,
                               is_line_break_end: bool| {
            if !output_options.show_paragraph_marks && !output_options.show_control_codes {
                return;
            }
            let font_size = if style.font_size > 0.0 {
                style.font_size as f32
            } else {
                12.0
            };
            let make_mark_font = |size: f32| {
                let mut font = match_system_family_style(
                    self.font_mgr,
                    self.system_families,
                    "DejaVu Sans",
                    FontStyle::normal(),
                )
                .or_else(|| legacy_typeface_for_style(self.font_mgr, FontStyle::normal()))
                .map(|tf| Font::new(tf, size))
                .unwrap_or_else(|| {
                    let mut font = Font::default();
                    font.set_size(size);
                    font
                });
                font.set_edging(font::Edging::AntiAlias);
                font
            };
            let font = make_mark_font(font_size * 0.5);
            let mut mark_paint = Paint::default();
            mark_paint.set_anti_alias(true);
            mark_paint.set_color(Color::from_argb(255, 0, 102, 255));
            let y = if baseline > 0.0 {
                bbox.y + baseline
            } else {
                bbox.y + bbox.height
            };
            let effective_rotation = if is_vertical {
                rotation + 90.0
            } else {
                rotation
            };
            if effective_rotation != 0.0 {
                canvas.save();
                canvas.rotate(
                    effective_rotation as f32,
                    Some(
                        (
                            (bbox.x + bbox.width / 2.0) as f32,
                            (bbox.y + bbox.height / 2.0) as f32,
                        )
                            .into(),
                    ),
                );
            }
            if !text.is_empty() && !is_marker {
                let char_positions = compute_char_positions(text, style);
                for (index, ch) in text.chars().enumerate() {
                    if ch == ' ' {
                        let x = bbox.x + char_positions.get(index).copied().unwrap_or(0.0);
                        let next_x = if index + 1 < char_positions.len() {
                            bbox.x + char_positions[index + 1]
                        } else {
                            bbox.x + bbox.width
                        };
                        let mark_x = ((x + next_x) / 2.0) as f32 - font_size * 0.125;
                        canvas.draw_str("\u{2228}", (mark_x, y as f32), &font, &mark_paint);
                    } else if ch == '\t' {
                        let mark_x = bbox.x as f32
                            + char_positions.get(index).copied().unwrap_or(0.0) as f32;
                        canvas.draw_str("\u{2192}", (mark_x, y as f32), &font, &mark_paint);
                    }
                }
            }
            if is_para_end || is_line_break_end {
                let end_font = make_mark_font(font_size);
                let mark = if is_line_break_end {
                    "\u{2193}"
                } else {
                    "\u{21B5}"
                };
                let mark_x = if text.is_empty() {
                    bbox.x as f32
                } else {
                    (bbox.x + bbox.width) as f32
                };
                canvas.draw_str(mark, (mark_x, y as f32), &end_font, &mark_paint);
            }
            if effective_rotation != 0.0 {
                canvas.restore();
            }
        };

        draw_text(
            text,
            bbox,
            style,
            baseline,
            rotation,
            is_vertical,
            char_overlap,
        );
        draw_text_marks(
            text,
            bbox,
            style,
            baseline,
            rotation,
            is_vertical,
            is_marker,
            is_para_end,
            is_line_break_end,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_myeongjo_batang_and_gungseo_families_prefer_serif_cjk_fallbacks() {
        for family in [
            "한양신명조",
            "HYSinMyeongJo-Medium",
            "휴먼명조",
            "-윤명조120",
            "바탕",
            "궁서",
        ] {
            assert!(
                prefers_serif_cjk_fallback(family),
                "{family} should be classified as a serif CJK family"
            );
            assert_eq!(cjk_fallback_families(family)[0], "Noto Serif KR");
        }
    }

    #[test]
    fn gothic_dotum_gulim_and_headline_families_keep_sans_cjk_fallbacks() {
        for family in ["한양중고딕", "HY헤드라인M", "굴림", "돋움", "Noto Sans KR"] {
            assert!(
                !prefers_serif_cjk_fallback(family),
                "{family} should be classified as a sans CJK family"
            );
            assert_eq!(cjk_fallback_families(family)[0], "Noto Sans KR");
        }
    }

    #[test]
    fn unknown_and_empty_families_preserve_the_existing_sans_default() {
        for family in ["", "Unknown Legacy Font"] {
            assert!(!prefers_serif_cjk_fallback(family));
            assert_eq!(cjk_fallback_families(family)[0], "Noto Sans KR");
        }
    }

    #[test]
    fn fixed_width_korean_families_match_the_shared_monospace_contract() {
        for family in [
            "굴림체",
            "바탕체",
            "GulimChe",
            "BatangChe",
            "D2Coding ligature",
            "Courier New",
            "Noto Sans Mono",
        ] {
            assert!(prefers_monospace_cjk_fallback(family), "{family}");
            assert_eq!(cjk_fallback_families(family)[0], "GulimChe");
        }
        for proportional_kopub in [
            "KoPub돋움체 Light",
            "KoPub바탕체 Medium",
            "KOPUB바탕체",
            "KoPub Dotum Light",
            "KoPub Batang Medium",
        ] {
            assert!(
                !prefers_monospace_cjk_fallback(proportional_kopub),
                "{proportional_kopub}"
            );
        }
        for proportional_monotype in ["Monotype Corsiva", "Monotype Sorts"] {
            assert!(
                !prefers_monospace_cjk_fallback(proportional_monotype),
                "{proportional_monotype}"
            );
        }
    }

    #[test]
    fn empty_explicit_chain_reaches_character_aware_system_fallback() {
        let font_mgr = FontMgr::default();
        let (typeface, source) =
            typeface_for_character(&[], &font_mgr, FontStyle::normal(), '\u{25B8}' as i32)
                .expect("supported platforms provide a system face for the common triangle marker");

        assert_eq!(source, CharacterTypefaceSource::SystemCharacterFallback);
        assert_ne!(typeface.unichar_to_glyph('\u{25B8}' as i32), 0);
    }
}
