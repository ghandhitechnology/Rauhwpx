use std::collections::HashSet;

use skia_safe::{
    font, paint, Canvas, Color, Font, FontMgr, FontStyle, Paint, PathEffect, Point, Rect, Typeface,
};

use crate::model::style::UnderlineType;
use crate::paint::LayerOutputOptions;
use crate::renderer::composer::{
    decode_pua_overlap_number, expand_pua_render_text, pua_to_display_text, CharOverlapInfo,
};
use crate::renderer::layout::{
    compute_char_positions, compute_glyph_positions, is_halfwidth_forced_punct, split_into_clusters,
};
use crate::renderer::render_tree::BoundingBox;
use crate::renderer::{clamp_tab_leader_end_x, TextStyle};

use super::font_lookup::{
    legacy_typeface_for_style, match_system_family_style, SystemFontFamilies,
};
use super::renderer::{colorref_to_skia, typeface_for_style, TypefaceCatalog};

const HANCOM_PUA_FALLBACK_FAMILIES: &[&str] = &[
    "HCR Batang Ext-B",
    "HCR Batang ExtB",
    "함초롬바탕 확장B",
    "HCR Batang Ext",
    "함초롬바탕 확장",
    "HCR Batang",
    "함초롬바탕",
];

/// 픽셀 캔버스에서는 글리프를 윤곽선(path)으로 직접 채워 그린다.
///
/// macOS 의 Skia 글리프 마스크는 CoreText 가 `glyf` 헤더 bbox 크기로 만든다.
/// 합성 글리프 헤더 bbox 가 실제 component 합집합보다 작은 한컴 서체
/// (HY헤드라인M, 돋움체 등)는 초성 윗획이 잘려 '초→조', '즉→슥'처럼 보인다.
/// 윤곽선은 bbox 와 무관하게 온전하고, 한컴 PDF 처럼 힌팅·글꼴 스무딩 없는
/// 면적 안티앨리어싱으로 칠해져 획 두께도 한컴 출력과 맞는다.
/// PDF 등 벡터 캔버스는 글자를 텍스트로 남기도록 기존 draw_str 을 쓴다.
/// 윤곽선이 없는 글리프(컬러 이모지 비트맵 등)가 섞이면 draw_str 로 되돌린다.
pub(super) fn draw_text_run(
    canvas: &Canvas,
    text: &str,
    origin: impl Into<Point>,
    font: &Font,
    paint: &Paint,
) {
    let origin = origin.into();
    if canvas.peek_pixels().is_none() {
        canvas.draw_str(text, origin, font, paint);
        return;
    }
    let glyphs = font.str_to_glyphs_vec(text);
    if glyphs.is_empty() {
        return;
    }
    let mut bounds = vec![Rect::default(); glyphs.len()];
    font.get_bounds(&glyphs, &mut bounds, None);
    let mut outlines = Vec::with_capacity(glyphs.len());
    for (glyph, bounds) in glyphs.iter().zip(&bounds) {
        match font.get_path(*glyph) {
            Some(path) => outlines.push(Some(path)),
            // 공백처럼 잉크가 없는 글리프는 윤곽선도 없다.
            None if bounds.is_empty() => outlines.push(None),
            None => {
                canvas.draw_str(text, origin, font, paint);
                return;
            }
        }
    }
    let mut positions = vec![Point::default(); glyphs.len()];
    font.get_pos(&glyphs, &mut positions, Some(origin));
    // draw_str 은 글리프 안티앨리어싱을 paint 가 아니라 font edging 으로 정한다.
    let mut outline_paint = paint.clone();
    outline_paint.set_anti_alias(font.edging() != font::Edging::Alias);
    for (outline, position) in outlines.iter().zip(&positions) {
        if let Some(path) = outline {
            canvas.draw_path(&path.with_offset(*position), &outline_paint);
        }
    }
}

/// 한컴 사각 숫자: 단일 1~9, 또는 테두리 포함 십의 자리와 오른쪽 일의 자리.
/// 일반 Unicode나 다른 PUA 영역은 변환하지 않는다.
fn hancom_boxed_number(chars: &[char]) -> Option<String> {
    match chars {
        [ch] if (0xF02B1..=0xF02B9).contains(&(*ch as u32)) => {
            Some((*ch as u32 - 0xF02B0).to_string())
        }
        [left, right]
            if (0xF02BA..=0xF02C2).contains(&(*left as u32))
                && (0xF02C3..=0xF02CC).contains(&(*right as u32)) =>
        {
            Some(format!(
                "{}{}",
                *left as u32 - 0xF02B9,
                *right as u32 - 0xF02C3
            ))
        }
        _ => None,
    }
}

/// 문서/한컴 폰트에 전용 글리프가 없으면 숫자와 사각형으로 표시한다.
/// 임의 시스템 PUA 폴백은 같은 코드의 Nerd Font 그림문자를 선택할 수 있다.
fn draw_hancom_boxed_number(
    canvas: &Canvas,
    font: &Font,
    number: &str,
    origin: (f32, f32),
    font_size: f32,
    text_paint: &Paint,
) {
    let box_size = font_size * 0.72;
    let top = origin.1 - font_size * 0.76;
    let mut border_paint = text_paint.clone();
    border_paint.set_style(paint::Style::Stroke);
    border_paint.set_stroke_width((font_size * 0.04).max(0.6));
    canvas.draw_rect(
        Rect::from_xywh(origin.0, top, box_size, box_size),
        &border_paint,
    );
    let (width, bounds) = font.measure_str(number, Some(text_paint));
    draw_text_run(
        canvas,
        number,
        (
            origin.0 + (box_size - width) / 2.0,
            top + box_size / 2.0 - (bounds.top + bounds.bottom) / 2.0,
        ),
        font,
        text_paint,
    );
}

const SANS_CJK_FALLBACK_FAMILIES: &[&str] = &[
    "Noto Sans KR",
    "Noto Sans CJK KR",
    "Nanum Gothic",
    "Malgun Gothic",
    "맑은 고딕",
    "Apple SD Gothic Neo",
    // 동-장르 한컴 번들을 이종(세리프) 계열 후보보다 앞에 둔다 — 위
    // SERIF_CJK_FALLBACK_FAMILIES 와 같은 규칙.
    "Haansoft Dotum",
    "한컴돋움",
    "HCR Dotum",
    "함초롬돋움",
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
    // 세리프 계열이 하나도 없는 호스트(한글 팩 미설치 Windows Server 등)에서
    // 명조 본문이 산세리프(Malgun Gothic)로 떨어지는 것을 막는다 — 한컴은
    // 미설치 폰트를 자체 번들 서체로 치환하므로(generic_fallback CSS 체인과
    // 같은 규칙) 동-장르 한컴 번들을 이종 계열 후보보다 앞에 둔다.
    "Haansoft Batang",
    "한컴바탕",
    "HCR Batang",
    "함초롬바탕",
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

fn single_char(cluster: &str) -> Option<char> {
    let mut chars = cluster.chars();
    match (chars.next(), chars.next()) {
        (Some(ch), None) => Some(ch),
        _ => None,
    }
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
                // 합성 진하게 대상(macOS 한컴이 Bold face 를 제공하지 않거나 DB 에
                // Bold 메트릭이 없는 서체)은 Regular face 를 해석해 획으로 굵게를
                // 만든다 — SVG/Canvas 와 같은 규칙. Bold face 파일이 해석돼도
                // 한컴 출력과 모양·폭이 다르므로 내려준다.
                let font_style = if style.bold
                    && crate::renderer::faux_bold_stroke_width(style, f64::from(font_size))
                        .is_some()
                {
                    if style.italic {
                        FontStyle::italic()
                    } else {
                        FontStyle::normal()
                    }
                } else {
                    font_style
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
                // 문서 선언 대체 글꼴(<hh:substFont>/HWP5 alt_name): 원본 face 가
                // 없을 때 한컴이 쓰는 지정 대체 — generic CJK 폴백보다 먼저 시도.
                if !style.font_subst.is_empty() {
                    families.push(style.font_subst.as_str());
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
                    let resolve_family = |family: &str| {
                        typeface_for_style(self.custom_typefaces, family, font_style)
                            .or_else(|| {
                                match_system_family_style(
                                    self.font_mgr,
                                    self.system_families,
                                    family,
                                    font_style,
                                )
                            })
                            .or_else(|| {
                                typeface_for_style(self.bundled_typefaces, family, font_style)
                            })
                    };
                    // 설치되지 않은 한컴 HFT 영문 글꼴·표준 Windows 한글 폰트는
                    // 대체 서체를 선호 순서대로 하나씩 해석한다 (한컴 FontMap 치환과
                    // 같다 — 바탕 계열은 한컴바탕, 돋움 계열은 한컴돋움).
                    // custom 우선 루프에 섞으면 --font-path 의 Palatino Linotype
                    // Regular 가 시스템 Palatino(Bold 보유)를 앞질러 굵은 글자가 가늘어진다.
                    // 이 대체가 없으면 세리프 요청(바탕)이 generic 산세리프
                    // (맑은 고딕 등)에 떨어져 본문 전체가 굵은 고딕으로 렌더된다.
                    let substitutes: Vec<&str> =
                        crate::renderer::hft_substitute_faces(&style.font_family)
                            .iter()
                            .chain(crate::renderer::hancom_substitute_faces(&style.font_family))
                            .copied()
                            .collect();
                    if !substitutes.is_empty() && resolve_family(&style.font_family).is_none() {
                        for family in substitutes {
                            if let Some(tf) = resolve_family(family) {
                                push(&mut chain, &mut seen, tf);
                            }
                        }
                    }
                    // family 우선(CSS 순서)으로 custom→system을 잇는다.
                    // 소스 우선(custom 전체 → system 전체)으로 두면 --font-path 의
                    // 깊은 폴백이 시스템의 더 앞선 후보를 제친다 — exam_kor 의
                    // '제 1 교시'(한양견명조, 세리프)가 serif 계열 AppleMyungjo
                    // (후보 5) 대신 custom Malgun Gothic(후보 9)으로 그려졌다.
                    for family in &families {
                        if let Some(tf) =
                            typeface_for_style(self.custom_typefaces, family, font_style).or_else(
                                || {
                                    match_system_family_style(
                                        self.font_mgr,
                                        self.system_families,
                                        family,
                                        font_style,
                                    )
                                },
                            )
                        {
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
                    // 전용 PUA 폰트는 기존 본문 후보 뒤에 추가한다. custom 폰트여도
                    // 시스템의 문서 지정 서체보다 앞서 본문 전체를 바꾸지 않는다.
                    for family in HANCOM_PUA_FALLBACK_FAMILIES {
                        let typeface =
                            typeface_for_style(self.custom_typefaces, family, font_style)
                                .or_else(|| {
                                    match_system_family_style(
                                        self.font_mgr,
                                        self.system_families,
                                        family,
                                        font_style,
                                    )
                                })
                                .or_else(|| {
                                    typeface_for_style(self.bundled_typefaces, family, font_style)
                                });
                        if let Some(tf) = typeface {
                            push(&mut chain, &mut seen, tf);
                        }
                    }
                    if let Some(tf) = legacy_typeface_for_style(self.font_mgr, font_style) {
                        push(&mut chain, &mut seen, tf);
                    }
                    chain
                };
                if std::env::var_os("RHWP_DEBUG_FONTS").is_some() {
                    eprintln!(
                        "[FONT] text={:?} family={:?} chain={:?}",
                        text,
                        style.font_family,
                        typeface_chain
                            .iter()
                            .map(|tf| tf.family_name())
                            .collect::<Vec<_>>()
                    );
                }
                let primary_typeface = typeface_chain.first().cloned();
                let has_explicit_glyph = |ch: char| {
                    typeface_chain
                        .iter()
                        .any(|tf| tf.unichar_to_glyph(ch as i32) != 0)
                };
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
                // 세로쓰기 레이아웃이 한글 0도, 영문 눕힘 90도를 이미 결정한다.
                // is_vertical은 문단부호 배치용이며 글자 회전을 추가하지 않는다.
                let effective_rotation = rotation;
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

                    if overlap.border_type == 0 && chars.iter().any(|&ch| !has_explicit_glyph(ch)) {
                        if let Some(number) = hancom_boxed_number(&chars) {
                            if let Some(font) = font_for_text(&number, font_size * 0.5) {
                                let mut text_paint = Paint::default();
                                text_paint.set_anti_alias(true);
                                text_paint.set_color(colorref_to_skia(style.color, 1.0));
                                draw_hancom_boxed_number(
                                    canvas,
                                    &font,
                                    &number,
                                    (bbox.x as f32, y as f32),
                                    font_size,
                                    &text_paint,
                                );
                            }
                            if effective_rotation != 0.0 {
                                canvas.restore();
                            }
                            return;
                        }
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
                            draw_text_run(
                                canvas,
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
                // 위/아래 첨자: 줄어든 advance 는 측정 단계가 반영하므로 glyph 크기와
                // 기준선만 조정한다 (svg/web_canvas draw_text 와 같은 규칙).
                let (font_size, y) = {
                    let (size, dy) =
                        crate::renderer::script_glyph_size_and_shift(style, f64::from(font_size));
                    (size as f32, y + dy)
                };
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

                let cluster_advance = |char_idx: usize, cluster: &str| -> f32 {
                    let end = char_idx + cluster.chars().count();
                    if end < char_positions.len() {
                        (char_positions[end] - char_positions[char_idx]) as f32
                    } else {
                        0.0
                    }
                };
                // 반각으로 줄인 전각 구두점: glyph 를 줄이지 않고 halt 규칙으로 배치한다
                // (svg/web_canvas 와 같은 `halfwidth_punct_glyph_offset`).
                let glyph_positions = compute_glyph_positions(text, style);
                let halt_offset = |char_idx: usize, cluster: &str, font: &Font| -> f32 {
                    if !cluster
                        .chars()
                        .next()
                        .is_some_and(is_halfwidth_forced_punct)
                    {
                        return 0.0;
                    }
                    let end = char_idx + cluster.chars().count();
                    let (Some(start_x), Some(end_x)) =
                        (glyph_positions.get(char_idx), glyph_positions.get(end))
                    else {
                        return 0.0;
                    };
                    let (natural, _) = font.measure_str(cluster, None);
                    crate::renderer::halfwidth_punct_glyph_offset(
                        cluster,
                        f64::from(natural) * f64::from(ratio),
                        end_x - start_x,
                        style,
                    )
                    .unwrap_or(0.0) as f32
                };
                let is_middle_dot = |cluster: &str| cluster == "\u{00B7}";
                // 합성 진하게: 해석된 서체에 Bold face 가 없으면 한컴처럼 fill+stroke 로
                // 획을 더한다. 두께는 svg/web_canvas 의 faux_bold_stroke_width 와 같은 비율.
                // 서체별 실측 비율(맑은 고딕 1/30 등)을 우선 쓰고 아니면 기본 1/40.
                let faux_bold_width =
                    crate::renderer::faux_bold_stroke_width(style, f64::from(font_size))
                        .map(|w| w as f32)
                        .or_else(|| {
                            style
                                .bold
                                .then(|| font_size * crate::renderer::FAUX_BOLD_STROKE_EM as f32)
                        });
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
                    let mut faux_bold_paint = text_paint.clone();
                    if let Some(width) = faux_bold_width.filter(|_| stroke_width <= 0.0) {
                        faux_bold_paint.set_style(paint::Style::StrokeAndFill);
                        faux_bold_paint.set_stroke_width(width);
                    }
                    let paint_for = |font: &Font| {
                        if font.typeface().is_bold() {
                            &text_paint
                        } else {
                            &faux_bold_paint
                        }
                    };
                    for (char_idx, cluster) in &clusters {
                        if cluster == " " || cluster == "\t" || cluster == "\u{2007}" {
                            continue;
                        }
                        if cluster.starts_with(|ch: char| {
                            ch < '\u{0020}' && !matches!(ch, '\t' | '\n' | '\r')
                        }) {
                            continue;
                        }
                        if let Some(ch) = cluster.chars().next().filter(|ch| {
                            (0xF02B1..=0xF02B9).contains(&(*ch as u32))
                                && !has_explicit_glyph(*ch)
                                && cluster.chars().count() == 1
                        }) {
                            let number = hancom_boxed_number(&[ch]).unwrap();
                            if let Some(font) = font_for_text(&number, font_size * 0.5) {
                                let char_x = bbox.x as f32
                                    + char_positions.get(*char_idx).copied().unwrap_or(0.0) as f32
                                    + dx;
                                canvas.save();
                                canvas.translate((char_x, y as f32 + dy));
                                canvas.scale((ratio, 1.0));
                                draw_hancom_boxed_number(
                                    canvas,
                                    &font,
                                    &number,
                                    (0.0, 0.0),
                                    font_size,
                                    &text_paint,
                                );
                                canvas.restore();
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
                        if let Some(substitute) = single_char(cluster)
                            .filter(|ch| !has_explicit_glyph(*ch))
                            .and_then(crate::renderer::composer::pua_missing_glyph_substitute)
                        {
                            // 한컴 PUA 글리프가 명시 체인에 없으면 대체 글리프를 원문 advance 에
                            // 맞춘다. 시스템 문자 폴백은 같은 코드의 Nerd Font 그림문자를 고를 수
                            // 있어 쓰지 않는다 (Studio Canvas/CanvasKit 과 같은 규칙).
                            let substitute = substitute.to_string();
                            if let Some(font) = font_for_text(&substitute, font_size) {
                                let advance = cluster_advance(*char_idx, cluster);
                                let (glyph_w, _) = font.measure_str(&substitute, None);
                                let char_x = bbox.x as f32
                                    + char_positions.get(*char_idx).copied().unwrap_or(0.0) as f32
                                    + dx;
                                canvas.save();
                                canvas.translate((char_x, y as f32 + dy));
                                if glyph_w > advance && glyph_w > 0.0 {
                                    canvas.scale((advance / glyph_w, 1.0));
                                }
                                canvas.draw_str(&substitute, (0.0, 0.0), &font, &text_paint);
                                canvas.restore();
                            }
                        } else if let Some(font) = font_for_text(cluster, font_size) {
                            let char_x = bbox.x as f32
                                + char_positions.get(*char_idx).copied().unwrap_or(0.0) as f32
                                + halt_offset(*char_idx, cluster, &font)
                                + dx;
                            let char_y = y as f32 + dy;
                            let glyph_paint = paint_for(&font);
                            if has_ratio {
                                canvas.save();
                                canvas.translate((char_x, char_y));
                                canvas.scale((ratio, 1.0));
                                draw_text_run(canvas, cluster, (0.0, 0.0), &font, glyph_paint);
                                canvas.restore();
                            } else {
                                draw_text_run(
                                    canvas,
                                    cluster,
                                    (char_x, char_y),
                                    &font,
                                    glyph_paint,
                                );
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
                if style.emboss {
                    draw_text_pass(Color::WHITE, 0.0, -1.0, -1.0);
                    draw_text_pass(Color::from_argb(255, 96, 96, 96), 0.0, 1.0, 1.0);
                } else if style.engrave {
                    draw_text_pass(Color::from_argb(255, 96, 96, 96), 0.0, -1.0, -1.0);
                    draw_text_pass(Color::WHITE, 0.0, 1.0, 1.0);
                }
                if style.outline_type > 0 && !style.emboss && !style.engrave {
                    // Canvas2D 효과와 동일하게 내부는 흰색, 외곽은 글자색으로 그린다.
                    // 이후 일반 fill을 덧그리면 외곽선 글자가 다시 검게 채워진다.
                    let bold_width = if style.bold {
                        (font_size * 0.04).clamp(0.25, 1.4)
                    } else {
                        0.0
                    };
                    draw_text_pass(Color::WHITE, 0.0, 0.0, 0.0);
                    draw_text_pass(
                        colorref_to_skia(style.color, 1.0),
                        (font_size / 25.0).max(0.5) + bold_width,
                        0.0,
                        0.0,
                    );
                } else {
                    draw_text_pass(colorref_to_skia(style.color, 1.0), 0.0, 0.0, 0.0);
                }

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
                                draw_text_run(
                                    canvas,
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
                        draw_text_run(canvas, "\u{2228}", (mark_x, y as f32), &font, &mark_paint);
                    } else if ch == '\t' {
                        let mark_x = bbox.x as f32
                            + char_positions.get(index).copied().unwrap_or(0.0) as f32;
                        draw_text_run(canvas, "\u{2192}", (mark_x, y as f32), &font, &mark_paint);
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
                draw_text_run(canvas, mark, (mark_x, y as f32), &end_font, &mark_paint);
            }
            if effective_rotation != 0.0 {
                canvas.restore();
            }
        };

        draw_text(text, bbox, style, baseline, rotation, char_overlap);
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
    fn hancom_boxed_numbers_decode_only_their_digit_components() {
        for digit in 1..=9 {
            assert_eq!(
                hancom_boxed_number(&[char::from_u32(0xF02B0 + digit).unwrap()]),
                Some(digit.to_string())
            );
        }
        for (ones, expected) in [
            ('\u{F02C3}', "10"),
            ('\u{F02C4}', "11"),
            ('\u{F02C5}', "12"),
        ] {
            assert_eq!(
                hancom_boxed_number(&['\u{F02BA}', ones]),
                Some(expected.into())
            );
        }
        for chars in [
            vec!['1'],
            vec!['\u{F02BA}'],
            vec!['\u{F02C3}'],
            vec!['\u{F02BA}', '0'],
        ] {
            assert_eq!(hancom_boxed_number(&chars), None);
        }
    }

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

    /// `glyf` 글리프 헤더의 yMax 만 바꾼 폰트 바이트를 만든다.
    fn with_glyf_header_y_max(font: &[u8], glyph: u16, y_max: i16) -> Vec<u8> {
        let be16 = |at: usize| u16::from_be_bytes([font[at], font[at + 1]]) as usize;
        let be32 = |at: usize| {
            u32::from_be_bytes([font[at], font[at + 1], font[at + 2], font[at + 3]]) as usize
        };
        let table = |tag: &[u8; 4]| {
            (0..be16(4))
                .map(|index| 12 + index * 16)
                .find(|record| &font[*record..*record + 4] == tag)
                .map(|record| be32(record + 8))
                .expect("fixture table")
        };
        let loca = table(b"loca");
        let glyph = glyph as usize;
        let offset = if be16(table(b"head") + 50) == 1 {
            be32(loca + glyph * 4)
        } else {
            be16(loca + glyph * 2) * 2
        };
        let y_max_at = table(b"glyf") + offset + 8;
        let mut out = font.to_vec();
        out[y_max_at..y_max_at + 2].copy_from_slice(&y_max.to_be_bytes());
        out
    }

    #[test]
    fn raster_text_keeps_outline_above_understated_glyf_header_bounds() {
        // HY헤드라인M·돋움체의 합성 글리프는 헤더 bbox 가 실제 윤곽보다 낮다.
        // macOS CoreText 글리프 마스크는 헤더 bbox 에서 잘려 '초'가 '조'로 보였다.
        let fixture = include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf");
        let glyph = ttf_parser::Face::parse(fixture, 0)
            .unwrap()
            .glyph_index('한')
            .unwrap()
            .0;
        // 윤곽 yMax 700/1000 을 헤더에서는 300 으로 줄인다.
        let data = with_glyf_header_y_max(fixture, glyph, 300);
        let typeface = FontMgr::default().new_from_data(&data, None).unwrap();
        let mut font = Font::new(typeface, 100.0);
        font.set_edging(font::Edging::AntiAlias);
        let mut paint = Paint::default();
        paint.set_color(Color::BLACK);

        let mut surface = skia_safe::surfaces::raster_n32_premul((120, 120)).unwrap();
        surface.canvas().clear(Color::WHITE);
        draw_text_run(surface.canvas(), "한", (0.0, 100.0), &font, &paint);

        let info = surface.image_info();
        let mut pixels = vec![0_u8; 120 * 120 * 4];
        assert!(surface.read_pixels(&info, &mut pixels, 120 * 4, (0, 0)));
        // baseline(y=100) 위 30~70px, 즉 헤더 yMax 위쪽 윤곽이 칠해져야 한다.
        let ink_above_header = pixels[30 * 120 * 4..70 * 120 * 4]
            .chunks_exact(4)
            .filter(|px| px[..3].iter().all(|channel| *channel < 128))
            .count();
        assert!(
            ink_above_header > 500,
            "ink above header bbox: {ink_above_header}"
        );
    }
}
