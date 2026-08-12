//! 줄 나눔 엔진 (Line Breaking Engine)
//!
//! 문단 텍스트를 토큰화하고 줄 나눔을 수행한다.
//! 한글 어절/글자, 영어 단어/하이픈, CJK 개별 분할을 지원한다.

use super::{find_active_char_shape, is_lang_neutral};
use crate::model::control::Control;
use crate::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
use crate::model::shape::{TextWrap, VertRelTo};
use crate::model::style::LineSpacingType;
use crate::renderer::float_placement::{
    available_text_intervals, float_exclusion, object_frame, FloatExclusion,
    ObjectPlacementContext, WrapGeometry,
};
use crate::renderer::hwpunit_to_px;
use crate::renderer::layout::{
    estimate_text_width, estimate_text_width_unrounded, is_cjk_char, resolved_to_text_style,
};
use crate::renderer::page_layout::LayoutRect;
use crate::renderer::px_to_hwpunit;
use crate::renderer::style_resolver::{detect_lang_category, ResolvedStyleSet};
use unicode_segmentation::UnicodeSegmentation;

/// 줄 나눔 토큰
#[derive(Debug, Clone)]
pub(crate) enum BreakToken {
    /// 분할 불가 텍스트 조각 (어절/단어/글자)
    /// char_widths: 글자별 px 폭 (char_level_break용, 단일 글자 토큰은 비어있음)
    Text {
        start_idx: usize,
        end_idx: usize,
        width: f64,
        max_font_size: f64,
        char_widths: Vec<f64>,
    },
    /// 공백 (줄 바꿈 가능 지점, 줄 끝에서 흡수)
    Space {
        idx: usize,
        width: f64,
        max_font_size: f64,
    },
    /// 탭 (줄 바꿈 가능 지점, 폭은 줄 위치에 따라 동적)
    Tab { idx: usize, max_font_size: f64 },
    /// 강제 줄 바꿈 (\n)
    LineBreak { idx: usize },
    /// 인라인 개체 (treat_as_char 수식/그림/표 등).
    /// 문자를 소비하지 않고 지정 폭(HWPUNIT)만큼 가로 공간만 예약한다.
    /// idx는 개체가 삽입된 문자 위치 (개체 바로 다음 문자 인덱스와 동일).
    /// own_line: 한컴이 전용 줄을 부여하는 블록형 개체(표/그림/도형) 여부.
    /// true 이면 개체 줄에 뒤따르는 토큰이 넘칠 때 토큰 통째를 다음 줄로 본내
    /// 글자 단위 분할(한 글자 run 조각남)을 피한다. 수식(false)은 텍스트 흐름
    /// 개처이므로 기존 첫 글자 고정(pin) 동작을 유지한다.
    InlineControl {
        idx: usize,
        width_hwp: i32,
        max_font_size: f64,
        own_line: bool,
    },
}

/// 줄 채움 결과
#[derive(Debug)]
struct LineBreakResult {
    start_idx: usize,
    end_idx: usize, // exclusive
    max_font_size: f64,
    has_line_break: bool, // 강제 줄 바꿈 여부
}

/// 문단-로컬 어울림(Square/Tight/Through) 배제 계획.
///
/// 편집 재배치(reflow)는 저장 LINE_SEG 의 column_start/segment_width 를 통째로
/// 재생성하는데, 종전에는 전 줄을 단 전체 폭으로 채워 같은 문단에 앵커된 어울림
/// 개체 위로 텍스트가 그대로 겹쳤다(감사 finding #7: available_text_intervals 는
/// 사장 코드였다). 이 계획은 문단 자신이 소유한 비-TAC 어울림 개체의 배제
/// 사각형을 문단-로컬 좌표(단 좌측=0, 문단 상단=0)로 만들어 두고, 줄 채움과
/// 재생성 seg 지오메트리가 **동일한 결정적 계산**으로 줄별 (시작 x, 폭)을
/// 얻게 한다. 렌더러(paragraph_layout)는 이렇게 기록된 wrap zone 을 저장
/// 지오메트리와 똑같이 재생하므로 별도 재생 경로가 필요 없다.
///
/// 근사 2가지(주석 계약): ① 앵커 줄 y 는 전폭 1차 채움으로 추정한다(그림 옆
/// 문단의 지배적 케이스인 문단 선두 앵커에서는 오차 0). ② 줄 대역 조회는
/// 해당 줄의 실제 폰트가 아니라 직전 줄들의 누적 전진량을 쓴다.
pub(crate) struct LineBandPlan {
    exclusions: Vec<FloatExclusion>,
    column_w_px: f64,
    ls_type: LineSpacingType,
    ls_value: f64,
    dpi: f64,
}

impl LineBandPlan {
    /// make_line_seg 와 동일 산식의 줄 전진량(px).
    fn advance_px(&self, max_font_size: f64) -> f64 {
        let fs = if max_font_size > 0.0 { max_font_size } else { 12.0 };
        let line_height_hwp = font_size_to_line_height(fs, self.dpi);
        let line_spacing_hwp =
            compute_line_spacing_hwp(self.ls_type, self.ls_value, line_height_hwp, self.dpi);
        hwpunit_to_px(line_height_hwp + line_spacing_hwp, self.dpi)
    }

    /// 앞선 줄들의 폰트 크기 목록으로 현재 줄 대역 상단 y 를 얻는다.
    fn band_top(&self, prior_font_sizes: impl Iterator<Item = f64>) -> f64 {
        prior_font_sizes.map(|fs| self.advance_px(fs)).sum()
    }

    /// 대역 [y, y+한 줄 전진량) 에서 쓸 수 있는 가장 넓은 구간 (시작 x, 폭).
    /// 렌더러 재생이 줄당 단일 세그먼트만 지원하므로 구간이 갈리면 넓은 쪽을
    /// 택한다(양쪽 어울림의 반대편은 비워 둔다 — 겹침 없음이 우선).
    /// 배제가 대역을 전부 덮으면 전폭으로 되돌린다(현행과 동일한 안전망).
    fn interval_at(&self, band_top: f64, band_font_size: f64) -> (f64, f64) {
        let column = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: self.column_w_px,
            height: f64::INFINITY,
        };
        let band_bottom = band_top + self.advance_px(band_font_size).max(1.0);
        let widest = available_text_intervals(column, band_top, band_bottom, &self.exclusions)
            .into_iter()
            .max_by(|a, b| (a.1 - a.0).total_cmp(&(b.1 - b.0)));
        match widest {
            Some((start, end)) if end - start >= 1.0 => (start, end - start),
            _ => (0.0, self.column_w_px),
        }
    }

    /// 계획이 실제로 어떤 줄이라도 좁히는지 (전부 전폭이면 seg 기록 생략).
    fn narrows(&self, x: f64, w: f64) -> bool {
        x > 0.5 || w < self.column_w_px - 0.5
    }
}

/// 같은 문단에 앵커된 비-TAC 어울림(Square/Tight/Through) 그림/도형에서
/// 문단-로컬 배제 계획을 만든다. 대상이 없으면 None (기존 경로 그대로).
///
/// 문단-로컬로 해석 가능한 기준만 다룬다: VertRelTo::Para (앵커 줄 기준),
/// HorzRelTo 는 단/문단 박스를 available_width 로 근사한다. 쪽/용지 기준
/// 세로 배치는 쪽 배치가 끝나야 위치가 정해지므로 여기서 다루지 않는다.
fn paragraph_local_wrap_plan(
    para: &Paragraph,
    available_width_px: f64,
    anchor_line_y: impl Fn(usize) -> f64,
    ls_type: LineSpacingType,
    ls_value: f64,
    dpi: f64,
) -> Option<LineBandPlan> {
    let control_positions = para.control_text_positions();
    let mut exclusions = Vec::new();
    for (ci, ctrl) in para.controls.iter().enumerate() {
        let common = match ctrl {
            Control::Picture(pic) => &pic.common,
            Control::Shape(shape) => shape.common(),
            _ => continue,
        };
        if common.treat_as_char
            || !matches!(
                common.text_wrap,
                TextWrap::Square | TextWrap::Tight | TextWrap::Through
            )
            || !matches!(common.vert_rel_to, VertRelTo::Para)
        {
            continue;
        }
        let w_px = hwpunit_to_px(common.width as i32, dpi);
        let h_px = hwpunit_to_px(common.height as i32, dpi);
        if w_px <= 0.0 || h_px <= 0.0 {
            continue;
        }
        let anchor_pos = control_positions.get(ci).copied().unwrap_or(0);
        let line_y = anchor_line_y(anchor_pos);
        let local_box = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: available_width_px,
            height: f64::INFINITY,
        };
        let frame = object_frame(
            common,
            w_px,
            h_px,
            ObjectPlacementContext {
                paper: local_box,
                page: local_box,
                column: local_box,
                paragraph: local_box,
                line_y,
            },
            dpi,
        );
        if let Some(excl) = float_exclusion(common, frame, dpi) {
            // 자리차지(TopAndBottom)는 줄 폭이 아니라 흐름 예약으로 처리된다.
            if matches!(excl.geometry, WrapGeometry::Side(_)) {
                exclusions.push(excl);
            }
        }
    }
    if exclusions.is_empty() {
        return None;
    }
    Some(LineBandPlan {
        exclusions,
        column_w_px: available_width_px,
        ls_type,
        ls_value,
        dpi,
    })
}

/// 줄 머리 금칙: 줄 시작에 올 수 없는 문자
pub(crate) fn is_line_start_forbidden(ch: char) -> bool {
    matches!(
        ch,
        ')' | ']'
            | '}'
            | ','
            | '.'
            | '!'
            | '?'
            | ';'
            | ':'
            | '\''
            | '"'
            | '\u{3001}'
            | '\u{3002}'
            | '\u{2026}'
            | '\u{00B7}'
            | '\u{2015}'
            | '\u{30FC}'
            | '\u{300B}'
            | '\u{300D}'
            | '\u{300F}'
            | '\u{3011}'
            | '\u{FF09}'
            | '\u{FF5D}'
            | '\u{3015}'
            | '\u{3009}'
            | '\u{FF1E}'
            | '\u{226B}'
            | '\u{FF3D}'
            | '\u{FE5E}'
            | '\u{301E}'
            | '\u{2019}'
            | '\u{201D}'
            | '\u{FF0C}'
            | '\u{FF0E}'
            | '\u{FF01}'
            | '\u{FF1F}'
            | '\u{FF1B}'
            | '\u{FF1A}'
            | '%'
            | '\u{2030}'
            | '\u{2103}'
            | '\u{00B0}'
            | '\u{FF05}'
    )
}

/// 줄 꼬리 금칙: 줄 끝에 올 수 없는 문자
pub(crate) fn is_line_end_forbidden(ch: char) -> bool {
    matches!(
        ch,
        '(' | '['
            | '{'
            | '\''
            | '"'
            | '\u{300A}'
            | '\u{300C}'
            | '\u{300E}'
            | '\u{3010}'
            | '\u{FF08}'
            | '\u{FF5B}'
            | '\u{3014}'
            | '\u{3008}'
            | '\u{FF1C}'
            | '\u{226A}'
            | '\u{FF3B}'
            | '\u{301D}'
            | '\u{2018}'
            | '\u{201C}'
            | '$'
            | '\u{20A9}'
            | '\u{00A3}'
            | '\u{20AC}'
            | '\u{00A5}'
            | '\u{FF04}'
            | '\u{FFE5}'
    )
}

/// 한글 음절/자모 여부 (옛한글 확장 자모 포함)
fn is_hangul(ch: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&ch)       // 한글 음절
        || ('\u{1100}'..='\u{11FF}').contains(&ch) // 한글 자모
        || ('\u{3130}'..='\u{318F}').contains(&ch) // 한글 호환 자모 (ㆍ U+318D 포함)
        || ('\u{A960}'..='\u{A97F}').contains(&ch) // 한글 자모 확장-A (옛한글 초성)
        || ('\u{D7B0}'..='\u{D7FF}').contains(&ch) // 한글 자모 확장-B (옛한글 중/종성)
}

/// 라틴 문자 여부 (영문+숫자)
fn is_latin(ch: char) -> bool {
    let lang = detect_lang_category(ch);
    lang == 1 // English/Latin
}

/// CJK 문자 여부 (한자/일본어 — 개별 분할 대상)
fn is_cjk_ideograph(ch: char) -> bool {
    let lang = detect_lang_category(ch);
    lang == 2 || lang == 3 // Chinese or Japanese
}

fn grapheme_end_map(chars: &[char]) -> Vec<usize> {
    let text: String = chars.iter().collect();
    let mut ends = vec![0; chars.len()];
    let mut start = 0;
    for grapheme in text.graphemes(true) {
        let end = start + grapheme.chars().count();
        for slot in &mut ends[start..end] {
            *slot = end;
        }
        start = end;
    }
    ends
}

fn grapheme_char_widths(width: f64, len: usize) -> Vec<f64> {
    let mut widths = vec![0.0; len];
    if let Some(first) = widths.first_mut() {
        *first = width;
    }
    widths
}

fn measure_grapheme_metrics(
    text_chars: &[char],
    start: usize,
    end: usize,
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    default_lang: usize,
) -> (f64, f64, usize) {
    let cluster: String = text_chars[start..end].iter().collect();
    let width = measure_token_width(
        &cluster,
        start,
        char_offsets,
        char_shapes,
        styles,
        default_lang,
    );
    let mut max_font_size = 0.0f64;
    let mut current_lang = default_lang;
    for (offset, ch) in text_chars[start..end].iter().copied().enumerate() {
        let index = start + offset;
        let utf16_pos = char_offsets.get(index).copied().unwrap_or(index as u32);
        let style_id = find_active_char_shape(char_shapes, utf16_pos);
        let lang = if is_lang_neutral(ch) {
            current_lang
        } else {
            current_lang = detect_lang_category(ch);
            current_lang
        };
        let style = resolved_to_text_style(styles, style_id, lang);
        max_font_size = max_font_size.max(style.font_size.max(12.0));
    }
    (width, max_font_size, current_lang)
}

fn measure_grapheme_advances(
    text_chars: &[char],
    start: usize,
    end: usize,
    grapheme_ends: &[usize],
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    default_lang: usize,
) -> Vec<f64> {
    let mut widths = vec![0.0; end - start];
    let mut previous_prefix_width = 0.0;
    let mut index = start;
    while index < end {
        let cluster_end = grapheme_ends[index].min(end).max(index + 1);
        let prefix: String = text_chars[start..cluster_end].iter().collect();
        let prefix_width = measure_token_width(
            &prefix,
            start,
            char_offsets,
            char_shapes,
            styles,
            default_lang,
        );
        widths[index - start] = prefix_width - previous_prefix_width;
        previous_prefix_width = prefix_width;
        index = cluster_end;
    }
    widths
}

/// 문단 텍스트를 줄 나눔 토큰으로 분할한다.
pub(crate) fn tokenize_paragraph(
    text_chars: &[char],
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    english_break_unit: u8,
    korean_break_unit: u8,
) -> Vec<BreakToken> {
    tokenize_paragraph_with_controls(
        text_chars,
        char_offsets,
        char_shapes,
        styles,
        english_break_unit,
        korean_break_unit,
        &[],
    )
}

/// 문단 텍스트를 줄 나눔 토큰으로 분할한다. 인라인 개체를 토큰에 포함하는 버전.
///
/// `inline_controls`: (문자 위치, HWPUNIT 폭, own_line) 목록 — 위치 오름차순 정렬 필요.
/// 개체 위치에서 텍스트 토큰(어절/단어)을 강제로 분할하고 InlineControl 토큰을
/// 삽입해 fill_lines가 개체 폭만큼 가로 공간을 예약하게 한다.
fn tokenize_paragraph_with_controls(
    text_chars: &[char],
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    english_break_unit: u8,
    korean_break_unit: u8,
    inline_controls: &[(usize, i32, bool)],
) -> Vec<BreakToken> {
    let text_len = text_chars.len();
    if text_len == 0 {
        return Vec::new();
    }

    let mut tokens = Vec::new();
    let grapheme_ends = grapheme_end_map(text_chars);
    let mut i = 0;
    let mut current_lang: usize = 0;
    let mut ctrls = inline_controls.iter().copied().peekable();

    // 현재 문자 위치 i에 삽입된 인라인 개체 토큰을 방출한다 (문자를 소비하지 않음).
    // 텍스트 토큰 폰트와 같은 활성 글자 모양 크기를 써서 줄 높이 계산이 흔들리지
    // 않게 한다 (개체 실제 높이는 reflow의 metrics 패치가 별도로 반영).
    macro_rules! emit_inline_controls_at {
        ($pos:expr) => {{
            let pos = $pos;
            while let Some(&(cpos, width_hwp, own_line)) = ctrls.peek() {
                if cpos > pos {
                    break;
                }
                if cpos == pos {
                    let utf16_pos = if pos < char_offsets.len() {
                        char_offsets[pos]
                    } else {
                        pos as u32
                    };
                    let style_id = find_active_char_shape(char_shapes, utf16_pos);
                    let ts = resolved_to_text_style(styles, style_id, current_lang);
                    let fs = if ts.font_size > 0.0 {
                        ts.font_size
                    } else {
                        12.0
                    };
                    tokens.push(BreakToken::InlineControl {
                        idx: pos,
                        width_hwp,
                        max_font_size: fs,
                        own_line,
                    });
                }
                // cpos < pos 는 정렬 깨짐/중복 방어 — 건너뛴다
                ctrls.next();
            }
        }};
    }

    while i < text_len {
        emit_inline_controls_at!(i);
        let ch = text_chars[i];

        // 강제 줄 바꿈
        if ch == '\n' {
            tokens.push(BreakToken::LineBreak { idx: i });
            i += 1;
            continue;
        }

        // 탭
        if ch == '\t' {
            let utf16_pos = if i < char_offsets.len() {
                char_offsets[i]
            } else {
                i as u32
            };
            let style_id = find_active_char_shape(char_shapes, utf16_pos);
            let ts = resolved_to_text_style(styles, style_id, current_lang);
            let font_size = if ts.font_size > 0.0 {
                ts.font_size
            } else {
                12.0
            };
            tokens.push(BreakToken::Tab {
                idx: i,
                max_font_size: font_size,
            });
            i += 1;
            continue;
        }

        // 공백 (줄 바꿈 지점) — NonBreakingSpace(\u{00A0})는 제외
        if ch == ' ' {
            let utf16_pos = if i < char_offsets.len() {
                char_offsets[i]
            } else {
                i as u32
            };
            let style_id = find_active_char_shape(char_shapes, utf16_pos);
            let ts = resolved_to_text_style(styles, style_id, current_lang);
            let font_size = if ts.font_size > 0.0 {
                ts.font_size
            } else {
                12.0
            };
            let w = estimate_text_width_unrounded(" ", &ts);
            tokens.push(BreakToken::Space {
                idx: i,
                width: w,
                max_font_size: font_size,
            });
            i += 1;
            continue;
        }

        // 한글 어절 또는 글자.
        // [#2185] bit7=1(KEEP_WORD)이 **글자 단위**, bit7=0(BREAK_WORD)이
        // 어절 단위 — 스키마 명목과 반대 (한컴 통제 실측 3중 확증: #2169
        // kbu 사다리, 80168 r10, #2185 giant-cell LINE_SEG [0,44,84,122]
        // 보존 대조). 종전 == 1 어절 분기는 역해석 (0da18bbc 회귀).
        if is_hangul(ch) {
            if korean_break_unit == 0 {
                // 어절 모드: 연속 한글 + 후행 금칙 문자를 하나의 토큰으로
                let start = i;
                let mut max_fs = 0.0f64;
                let mut token_text = String::new();
                let mut token_lang = current_lang;

                while i < text_len {
                    let c = text_chars[i];
                    if c == ' ' || c == '\n' || c == '\t' {
                        break;
                    }
                    // 인라인 개체 위치에서는 어절 토큰을 분할
                    if ctrls.peek().is_some_and(|&(p, ..)| p == i) {
                        break;
                    }
                    // 한글이 아니고 라틴이면 다른 토큰으로 분리
                    if !is_hangul(c) && is_latin(c) {
                        break;
                    }
                    // CJK 한자/일본어는 개별 토큰
                    if is_cjk_ideograph(c) {
                        break;
                    }

                    let utf16_pos = if i < char_offsets.len() {
                        char_offsets[i]
                    } else {
                        i as u32
                    };
                    let style_id = find_active_char_shape(char_shapes, utf16_pos);
                    let lang = if is_lang_neutral(c) {
                        token_lang
                    } else {
                        let detected = detect_lang_category(c);
                        token_lang = detected;
                        current_lang = detected;
                        detected
                    };
                    let ts = resolved_to_text_style(styles, style_id, lang);
                    let fs = if ts.font_size > 0.0 {
                        ts.font_size
                    } else {
                        12.0
                    };
                    if fs > max_fs {
                        max_fs = fs;
                    }
                    token_text.push(c);
                    i += 1;
                }

                // 후행 금칙 문자 (줄 머리 금칙) 흡수
                while i < text_len
                    && is_line_start_forbidden(text_chars[i])
                    && text_chars[i] != '\n'
                    && text_chars[i] != '\t'
                    && !ctrls.peek().is_some_and(|&(p, ..)| p == i)
                {
                    let c = text_chars[i];
                    let utf16_pos = if i < char_offsets.len() {
                        char_offsets[i]
                    } else {
                        i as u32
                    };
                    let style_id = find_active_char_shape(char_shapes, utf16_pos);
                    let lang = if is_lang_neutral(c) {
                        current_lang
                    } else {
                        let detected = detect_lang_category(c);
                        current_lang = detected;
                        detected
                    };
                    let ts = resolved_to_text_style(styles, style_id, lang);
                    let fs = if ts.font_size > 0.0 {
                        ts.font_size
                    } else {
                        12.0
                    };
                    if fs > max_fs {
                        max_fs = fs;
                    }
                    token_text.push(c);
                    i += 1;
                }

                if !token_text.is_empty() {
                    let width = measure_token_width(
                        &token_text,
                        start,
                        char_offsets,
                        char_shapes,
                        styles,
                        current_lang,
                    );
                    tokens.push(BreakToken::Text {
                        start_idx: start,
                        end_idx: i,
                        width,
                        max_font_size: max_fs,
                        char_widths: vec![],
                    });
                }
                continue;
            } else {
                // 글자 모드에서도 Unicode grapheme cluster는 분할하지 않는다.
                current_lang = detect_lang_category(ch);
                let end = grapheme_ends[i];
                let (w, fs, lang) = measure_grapheme_metrics(
                    text_chars,
                    i,
                    end,
                    char_offsets,
                    char_shapes,
                    styles,
                    current_lang,
                );
                current_lang = lang;
                tokens.push(BreakToken::Text {
                    start_idx: i,
                    end_idx: end,
                    width: w,
                    max_font_size: fs,
                    char_widths: grapheme_char_widths(w, end - i),
                });
                i = end;
                continue;
            }
        }

        // 라틴 단어 또는 글자
        if is_latin(ch) {
            if english_break_unit == 0 || english_break_unit == 1 {
                // 단어/하이픈 모드: 연속 라틴 문자를 하나의 토큰으로
                let start = i;
                let mut max_fs = 0.0f64;
                let mut token_text = String::new();

                while i < text_len {
                    let c = text_chars[i];
                    if c == ' ' || c == '\n' || c == '\t' {
                        break;
                    }
                    // 인라인 개체 위치에서는 단어 토큰을 분할
                    if ctrls.peek().is_some_and(|&(p, ..)| p == i) {
                        break;
                    }
                    if !is_latin(c) && !is_lang_neutral(c) {
                        break;
                    }
                    // 하이픈 모드: 하이픈에서 분할 (하이픈 포함 후 분리)
                    if english_break_unit == 1 && c == '-' && !token_text.is_empty() {
                        let utf16_pos = if i < char_offsets.len() {
                            char_offsets[i]
                        } else {
                            i as u32
                        };
                        let style_id = find_active_char_shape(char_shapes, utf16_pos);
                        let lang = 1usize; // English
                        let ts = resolved_to_text_style(styles, style_id, lang);
                        let fs = if ts.font_size > 0.0 {
                            ts.font_size
                        } else {
                            12.0
                        };
                        if fs > max_fs {
                            max_fs = fs;
                        }
                        token_text.push(c);
                        i += 1;
                        break; // 하이픈 뒤에서 분할
                    }

                    let utf16_pos = if i < char_offsets.len() {
                        char_offsets[i]
                    } else {
                        i as u32
                    };
                    let style_id = find_active_char_shape(char_shapes, utf16_pos);
                    let lang = if is_lang_neutral(c) {
                        current_lang
                    } else {
                        current_lang = 1; // English
                        1
                    };
                    let ts = resolved_to_text_style(styles, style_id, lang);
                    let fs = if ts.font_size > 0.0 {
                        ts.font_size
                    } else {
                        12.0
                    };
                    if fs > max_fs {
                        max_fs = fs;
                    }
                    token_text.push(c);
                    i += 1;
                }

                if !token_text.is_empty() {
                    let width = measure_token_width(
                        &token_text,
                        start,
                        char_offsets,
                        char_shapes,
                        styles,
                        current_lang,
                    );
                    // 개별 글자 폭 수집 (char_level_break용)
                    let cw = measure_grapheme_advances(
                        text_chars,
                        start,
                        i,
                        &grapheme_ends,
                        char_offsets,
                        char_shapes,
                        styles,
                        current_lang,
                    );
                    tokens.push(BreakToken::Text {
                        start_idx: start,
                        end_idx: i,
                        width,
                        max_font_size: max_fs,
                        char_widths: cw,
                    });
                }
                continue;
            } else {
                // 글자 모드 (grapheme cluster 단위)
                current_lang = 1;
                let end = grapheme_ends[i];
                let (w, fs, lang) = measure_grapheme_metrics(
                    text_chars,
                    i,
                    end,
                    char_offsets,
                    char_shapes,
                    styles,
                    current_lang,
                );
                current_lang = lang;
                tokens.push(BreakToken::Text {
                    start_idx: i,
                    end_idx: end,
                    width: w,
                    max_font_size: fs,
                    char_widths: grapheme_char_widths(w, end - i),
                });
                i = end;
                continue;
            }
        }

        // CJK 한자/일본어: 항상 개별 토큰
        if is_cjk_ideograph(ch) {
            current_lang = detect_lang_category(ch);
            let end = grapheme_ends[i];
            let (w, fs, lang) = measure_grapheme_metrics(
                text_chars,
                i,
                end,
                char_offsets,
                char_shapes,
                styles,
                current_lang,
            );
            current_lang = lang;
            tokens.push(BreakToken::Text {
                start_idx: i,
                end_idx: end,
                width: w,
                max_font_size: fs,
                char_widths: grapheme_char_widths(w, end - i),
            });
            i = end;
            continue;
        }

        // 기타 문자 (기호, NonBreakingSpace 등): 개별 Text 토큰
        {
            let lang = if is_lang_neutral(ch) {
                current_lang
            } else {
                let detected = detect_lang_category(ch);
                current_lang = detected;
                detected
            };
            let end = grapheme_ends[i];
            let (w, fs, lang) = measure_grapheme_metrics(
                text_chars,
                i,
                end,
                char_offsets,
                char_shapes,
                styles,
                lang,
            );
            current_lang = lang;
            tokens.push(BreakToken::Text {
                start_idx: i,
                end_idx: end,
                width: w,
                max_font_size: fs,
                char_widths: grapheme_char_widths(w, end - i),
            });
            i = end;
        }
    }

    // 텍스트 끝에 위치한 인라인 개체 (painter는 문단 끝 TAC를 마지막 줄에 방출)
    emit_inline_controls_at!(text_len);

    tokens
}

/// 토큰 텍스트의 폭을 글자별 언어 인식 측정으로 합산한다.
fn measure_token_width(
    text: &str,
    start_char_idx: usize,
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    default_lang: usize,
) -> f64 {
    let mut total = 0.0;
    let mut current_lang = default_lang;
    let mut run_text = String::new();
    let mut run_style = None;
    let mut run_lang = current_lang;
    for (offset, ch) in text.chars().enumerate() {
        let idx = start_char_idx + offset;
        let utf16_pos = if idx < char_offsets.len() {
            char_offsets[idx]
        } else {
            idx as u32
        };
        let style_id = find_active_char_shape(char_shapes, utf16_pos);
        let lang = if is_lang_neutral(ch) {
            current_lang
        } else {
            let detected = detect_lang_category(ch);
            current_lang = detected;
            detected
        };
        if run_style != Some(style_id) || run_lang != lang {
            if let Some(active_style) = run_style {
                let ts = resolved_to_text_style(styles, active_style, run_lang);
                total += estimate_text_width_unrounded(&run_text, &ts);
                run_text.clear();
            }
            run_style = Some(style_id);
            run_lang = lang;
        }
        run_text.push(ch);
    }
    if let Some(active_style) = run_style {
        let ts = resolved_to_text_style(styles, active_style, run_lang);
        total += estimate_text_width_unrounded(&run_text, &ts);
    }
    total
}

/// px를 HWPUNIT(i32)로 변환 (내림, DPI=96 기준: px * 75)
#[inline]
fn to_hwp(px: f64) -> i32 {
    (px * 75.0) as i32
}

fn condense_space_savings_hwp(space_width_hwp: i32, condense_min_space: u8) -> i32 {
    if condense_min_space == 0 || space_width_hwp <= 0 {
        return 0;
    }
    let shrink_percent = condense_min_space.min(75) as i32;
    space_width_hwp * shrink_percent / 100
}

fn condensed_line_width_hwp(width_hwp: i32, space_savings_hwp: i32) -> i32 {
    width_hwp - space_savings_hwp
}

fn condense_fit_can_pull_next_token(
    current_width_hwp: i32,
    current_space_savings_hwp: i32,
    effective_width_hwp: i32,
    max_font_size: f64,
) -> bool {
    let current_condensed_width =
        condensed_line_width_hwp(current_width_hwp, current_space_savings_hwp);
    let remaining_hwp = effective_width_hwp - current_condensed_width;
    // Hancom uses condense to rescue a line that still has a meaningful
    // natural gap, but it does not pull the next word into an already tight
    // line. The p03 PDF preface is sensitive to that distinction.
    let min_remaining_hwp = to_hwp((max_font_size * 2.5).max(20.0));
    remaining_hwp >= min_remaining_hwp
}

/// 토큰을 줄에 배치하는 Greedy 알고리즘
/// 한컴과 동일한 결과를 위해 HWPUNIT 정수로 폭을 누적한다.
fn fill_lines(
    tokens: &[BreakToken],
    text_chars: &[char],
    available_width_px: f64,
    indent_px: f64,
    default_tab_width: f64,
    korean_break_unit: u8,
    condense_min_space: u8,
    band_plan: Option<&LineBandPlan>,
) -> Vec<LineBreakResult> {
    if tokens.is_empty() {
        return vec![LineBreakResult {
            start_idx: 0,
            end_idx: 0,
            max_font_size: 0.0,
            has_line_break: false,
        }];
    }

    let tab_w_hwp = to_hwp(if default_tab_width > 0.0 {
        default_tab_width
    } else {
        48.0
    });
    let tab_w_px = if default_tab_width > 0.0 {
        default_tab_width
    } else {
        48.0
    };
    let mut results = Vec::new();
    let mut line_start_idx = 0usize;
    let mut lw = 0i32; // HWPUNIT 정수 누적
    let mut line_space_savings = 0i32;
    let mut line_max_fs = 0.0f64;
    let mut is_first_line = true;

    let mut last_break_token_idx: Option<usize> = None;
    let mut last_break_char_idx: usize = 0;
    let mut width_at_last_break = 0i32;
    let mut space_savings_at_last_break = 0i32;
    let mut fs_at_last_break = 0.0f64;

    // 한컴은 HWPUNIT 정수 양자화 시 미세한 반올림 차이를 허용
    // 12 HU(~0.17mm) 이내의 초과는 줄에 포함 (경험적 허용 오차)
    const LINE_BREAK_TOLERANCE: i32 = 15;

    // 어울림 배제 계획이 있으면 현재 줄의 가용 폭을 대역별로 좁힌다. 줄이
    // 확정될 때마다(results.push 직후) 다음 줄 대역으로 갱신한다. 계획이 없으면
    // 항상 전폭 — 기존 동작과 바이트 동일.
    let current_line_w = std::cell::Cell::new(match band_plan {
        Some(plan) => plan.interval_at(0.0, 0.0).1,
        None => available_width_px,
    });
    let advance_band = |results: &[LineBreakResult]| {
        if let Some(plan) = band_plan {
            let y = plan.band_top(results.iter().map(|r| r.max_font_size));
            let fs = results.last().map(|r| r.max_font_size).unwrap_or(0.0);
            current_line_w.set(plan.interval_at(y, fs).1);
        }
    };
    let eff_w = |first: bool| -> i32 {
        let base_w = current_line_w.get();
        if indent_px > 0.0 {
            if first {
                to_hwp((base_w - indent_px).max(1.0))
            } else {
                to_hwp(base_w)
            }
        } else if indent_px < 0.0 {
            if first {
                to_hwp(base_w)
            } else {
                to_hwp((base_w + indent_px).max(1.0))
            }
        } else {
            to_hwp(base_w)
        }
    };

    for (ti, token) in tokens.iter().enumerate() {
        match token {
            BreakToken::LineBreak { idx } => {
                results.push(LineBreakResult {
                    start_idx: line_start_idx,
                    end_idx: *idx + 1,
                    max_font_size: line_max_fs,
                    has_line_break: true,
                });
                advance_band(&results);
                line_start_idx = *idx + 1;
                lw = 0;
                line_space_savings = 0;
                line_max_fs = 0.0;
                is_first_line = false;
                last_break_token_idx = None;
            }
            BreakToken::Tab { idx, max_font_size } => {
                // 탭 계산은 px로 수행 후 HWPUNIT 변환 (정밀도 유지)
                let lw_px = lw as f64 / 75.0;
                let next_tab_px = ((lw_px / tab_w_px).floor() + 1.0) * tab_w_px;
                let next_tab_hwp = to_hwp(next_tab_px);
                if *max_font_size > line_max_fs {
                    line_max_fs = *max_font_size;
                }

                if next_tab_hwp > eff_w(is_first_line) && line_start_idx < *idx {
                    if let Some(_) = last_break_token_idx {
                        results.push(LineBreakResult {
                            start_idx: line_start_idx,
                            end_idx: last_break_char_idx,
                            max_font_size: fs_at_last_break,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = last_break_char_idx;
                        lw = lw - width_at_last_break;
                        line_space_savings -= space_savings_at_last_break;
                    } else {
                        results.push(LineBreakResult {
                            start_idx: line_start_idx,
                            end_idx: *idx,
                            max_font_size: line_max_fs,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = *idx;
                        lw = 0;
                        line_space_savings = 0;
                        line_max_fs = *max_font_size;
                    }
                    is_first_line = false;
                    last_break_token_idx = None;
                    let lw_px2 = lw as f64 / 75.0;
                    let next_tab2 = ((lw_px2 / tab_w_px).floor() + 1.0) * tab_w_px;
                    lw = to_hwp(next_tab2);
                } else {
                    last_break_token_idx = Some(ti);
                    last_break_char_idx = *idx;
                    width_at_last_break = lw;
                    space_savings_at_last_break = line_space_savings;
                    fs_at_last_break = line_max_fs;
                    lw = next_tab_hwp;
                }
            }
            BreakToken::Space {
                idx,
                width,
                max_font_size,
            } => {
                if *max_font_size > line_max_fs {
                    line_max_fs = *max_font_size;
                }
                last_break_token_idx = Some(ti);
                last_break_char_idx = *idx;
                width_at_last_break = lw;
                space_savings_at_last_break = line_space_savings;
                fs_at_last_break = line_max_fs;
                let space_hwp = to_hwp(*width);
                lw += space_hwp;
                line_space_savings += condense_space_savings_hwp(space_hwp, condense_min_space);
            }
            BreakToken::InlineControl {
                idx,
                width_hwp,
                max_font_size,
                ..
            } => {
                if *max_font_size > line_max_fs {
                    line_max_fs = *max_font_size;
                }
                // 개체가 현재 줄에 들어가지 않으면 개체 앞에서 줄을 나눈다
                // (줄 시작 개체는 넘치더라도 그대로 배치 — 분할 불가).
                // 개체 직후는 break point로 등록하지 않는다: 줄 끝 경계와 개체
                // 위치가 정확히 겹치면 painter/metrics가 개체를 다음 줄로 판정해
                // (char_pos_in_line 반열림 규칙) anchor 줄이 어긋나기 때문이다.
                if lw + width_hwp > eff_w(is_first_line) + LINE_BREAK_TOLERANCE
                    && *idx > line_start_idx
                {
                    if last_break_token_idx.is_some() {
                        let mut break_char = last_break_char_idx;
                        let mut next_start = break_char;
                        while next_start < text_chars.len() && text_chars[next_start] == ' ' {
                            next_start += 1;
                        }
                        // 공백 흡수가 개체 위치를 지나치면 개체가 이전 줄 끝에
                        // 좌초한다 (painter는 run 끝의 TAC를 현재 줄에 방출) —
                        // 폭 예약은 다음 줄인데 잉크는 이전 줄에 그려지는 어긋남.
                        // last_break 를 등록한 토큰이 단일 글자 토큰(kbu=1 한글/
                        // CJK 글자 나눔 — 글자 경계 분할 허용)이면 한 글자 앞에서
                        // 다시 나눠, 개체가 다음 줄 텍스트 중간에 놓이고 양 줄이
                        // 공백으로 시작/끝나지 않게 한다 (경계 공백은 justify 로
                        // 늘어나 그려져 컬럼을 넘는다). 그 외에는 개체가 새 줄
                        // 선두가 되도록 되돌린다.
                        if *idx < next_start {
                            let step_back = last_break_token_idx.and_then(|bi| match &tokens[bi] {
                                BreakToken::Text {
                                    start_idx, end_idx, ..
                                } if *end_idx == break_char
                                    && *end_idx - *start_idx == 1
                                    && *start_idx > line_start_idx =>
                                {
                                    Some(*start_idx)
                                }
                                _ => None,
                            });
                            if let Some(bp) = step_back {
                                break_char = bp;
                                next_start = bp;
                            } else {
                                next_start = *idx;
                            }
                        }
                        results.push(LineBreakResult {
                            start_idx: line_start_idx,
                            end_idx: break_char,
                            max_font_size: fs_at_last_break,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = next_start;
                        lw = recalc_width_hwp(tokens, ti, next_start);
                        line_space_savings =
                            recalc_space_savings_hwp(tokens, ti, next_start, condense_min_space);
                        lw += width_hwp;
                        line_max_fs = *max_font_size;
                        is_first_line = false;
                        last_break_token_idx = None;
                    } else {
                        // 같은 위치에 연속으로 배치된 인라인 개체가 현재 줄에 있으면
                        // 함께 다음 줄로 본낸다 — painter는 줄 끝 경계에 걸린 개체를
                        // 다음 줄 선두로 판정하므로, 폭 예약 줄과 그리는 줄을 맞춘다.
                        let mut carry_w = 0i32;
                        let mut k = ti;
                        while k > 0 {
                            match &tokens[k - 1] {
                                BreakToken::InlineControl {
                                    idx: prev_idx,
                                    width_hwp: prev_w,
                                    ..
                                } if *prev_idx == *idx => {
                                    carry_w += prev_w;
                                    k -= 1;
                                }
                                _ => break,
                            }
                        }
                        results.push(LineBreakResult {
                            start_idx: line_start_idx,
                            end_idx: *idx,
                            max_font_size: line_max_fs,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = *idx;
                        lw = *width_hwp + carry_w;
                        line_space_savings = 0;
                        line_max_fs = *max_font_size;
                        is_first_line = false;
                        last_break_token_idx = None;
                    }
                } else {
                    lw += width_hwp;
                }
            }
            BreakToken::Text {
                start_idx,
                end_idx,
                width,
                max_font_size,
                ref char_widths,
            } => {
                if *max_font_size > line_max_fs {
                    line_max_fs = *max_font_size;
                }

                let w_hwp = to_hwp(*width);
                // 단일 문자 CJK/한글 토큰의 줄바꿈 가능 지점 처리
                // 이 글자를 포함한 후 break point 갱신 (end_idx 사용)
                // → 초과 시 이 글자까지 L0에 포함하고 다음 토큰부터 다음 줄
                let is_single_grapheme = !char_widths.is_empty()
                    && char_widths.iter().skip(1).all(|width| *width == 0.0);
                if (*end_idx - *start_idx == 1 || is_single_grapheme) && *start_idx > line_start_idx
                {
                    let c = text_chars[*start_idx];
                    let allow_break = if is_hangul(c) {
                        // [#2185] bit7=1 = 글자 단위 break 허용 (위 주석 참조)
                        korean_break_unit == 1
                    } else {
                        is_cjk_ideograph(c)
                    };
                    let candidate_w = lw + w_hwp;
                    // 이 글자가 줄에 들어가는 경우에만 break point 갱신
                    if allow_break
                        && condensed_line_width_hwp(candidate_w, line_space_savings)
                            <= eff_w(is_first_line) + LINE_BREAK_TOLERANCE
                    {
                        last_break_token_idx = Some(ti);
                        last_break_char_idx = *end_idx; // 이 글자 다음 (이 글자 포함)
                        width_at_last_break = candidate_w; // 이 글자 폭 포함
                        space_savings_at_last_break = line_space_savings;
                        fs_at_last_break = line_max_fs;
                    }
                }
                // 한컴은 HWPUNIT 정수 양자화 시 미세한 반올림 차이를 허용
                // (LINE_BREAK_TOLERANCE — 함수 상단 선언 참조)
                let effective_width = eff_w(is_first_line);
                let natural_candidate = lw + w_hwp;
                let condensed_candidate =
                    condensed_line_width_hwp(natural_candidate, line_space_savings);
                let needs_condense_to_fit = natural_candidate
                    > effective_width + LINE_BREAK_TOLERANCE
                    && condensed_candidate <= effective_width + LINE_BREAK_TOLERANCE;
                let condense_pull_allowed = !needs_condense_to_fit
                    || condense_fit_can_pull_next_token(
                        lw,
                        line_space_savings,
                        effective_width,
                        *max_font_size,
                    );
                if condensed_candidate > effective_width + LINE_BREAK_TOLERANCE
                    || !condense_pull_allowed
                {
                    if *start_idx > line_start_idx {
                        if let Some(_) = last_break_token_idx {
                            results.push(LineBreakResult {
                                start_idx: line_start_idx,
                                end_idx: last_break_char_idx,
                                max_font_size: fs_at_last_break,
                                has_line_break: false,
                            });
                            advance_band(&results);
                            let mut next_start = last_break_char_idx;
                            while next_start < text_chars.len() && text_chars[next_start] == ' ' {
                                next_start += 1;
                            }
                            line_start_idx = next_start;
                            lw = recalc_width_hwp(tokens, ti, next_start);
                            line_space_savings = recalc_space_savings_hwp(
                                tokens,
                                ti,
                                next_start,
                                condense_min_space,
                            );
                            lw += w_hwp;
                            line_max_fs = *max_font_size;
                            is_first_line = false;
                            last_break_token_idx = None;
                            continue;
                        }
                    }
                    // [pr_2219] 블록형 인라인 개체(표/그림/도형)만 놓인 줄의 선두
                    // 토큰이 넘치면 토큰 통째를 다음 줄로 본내고 개체 줄을 빈 텍스트
                    // 줄로 확정한다. char 분할로 첫 글자를 개체 줄에 억지 배치하면
                    // 한 char shape 의 단어가 "e"+"fg" 처럼 한 글자 run 으로 조각나
                    // paint/run 경계가 깨진다. 수식(own_line=false) 줄은 기존 첫 글자
                    // 고정(pin) 동작을 유지한다 (painter anchor 모호성 회피).
                    if *start_idx == line_start_idx
                        && line_hosts_own_line_control(tokens, ti, line_start_idx)
                    {
                        results.push(LineBreakResult {
                            start_idx: line_start_idx,
                            end_idx: *start_idx, // == line_start_idx — 빈 텍스트 줄 (개체 호스트)
                            max_font_size: line_max_fs,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        // line_start_idx 는 유지 — 토큰이 새 줄 선두가 된다.
                        lw = 0;
                        line_space_savings = 0;
                        line_max_fs = *max_font_size;
                        is_first_line = false;
                        last_break_token_idx = None;
                        if w_hwp <= eff_w(false) + LINE_BREAK_TOLERANCE {
                            lw += w_hwp;
                        } else {
                            // 빈 줄에도 넘치는 장문: 새 줄에서 글자 단위 분할.
                            let cw_hwp: Vec<i32> = char_widths.iter().map(|w| to_hwp(*w)).collect();
                            let (results_part, remaining_w, remaining_fs) = char_level_break_hwp(
                                text_chars,
                                *start_idx,
                                *end_idx,
                                &mut line_start_idx,
                                lw,
                                line_max_fs,
                                eff_w(false),
                                eff_w(false),
                                false,
                                &cw_hwp,
                                false,
                            );
                            for r in results_part {
                                results.push(r);
                                advance_band(&results);
                            }
                            lw = remaining_w;
                            line_max_fs = remaining_fs;
                        }
                        continue;
                    }
                    // 토큰에 저장된 개별 글자 폭을 HWPUNIT로 변환
                    let cw_hwp: Vec<i32> = char_widths.iter().map(|w| to_hwp(*w)).collect();
                    // 직전 토큰이 이 줄에 배치된 인라인 개체인 경우, 첫 글자에서 자륵면
                    // 줄 끝이 개체 위치와 정확히 겹쳐 painter가 개체를 다음 줄로
                    // 판정한다 (anchor 모호성). 첫 글자는 현재 줄에 고정해 피한다.
                    let pin_first_char = *start_idx > line_start_idx
                        && matches!(
                            ti.checked_sub(1).and_then(|p| tokens.get(p)),
                            Some(BreakToken::InlineControl { idx, .. }) if *idx == *start_idx
                        );
                    let (results_part, remaining_w, remaining_fs) = char_level_break_hwp(
                        text_chars,
                        *start_idx,
                        *end_idx,
                        &mut line_start_idx,
                        lw,
                        line_max_fs,
                        eff_w(is_first_line),
                        eff_w(false),
                        is_first_line,
                        &cw_hwp,
                        pin_first_char,
                    );
                    for r in results_part {
                        results.push(r);
                        advance_band(&results);
                        is_first_line = false;
                    }
                    lw = remaining_w;
                    line_space_savings = 0;
                    line_max_fs = remaining_fs;
                    last_break_token_idx = None;
                    continue;
                } else {
                    lw += w_hwp;
                }
            }
        }
    }

    let last_end = tokens
        .last()
        .map(|t| match t {
            BreakToken::Text { end_idx, .. } => *end_idx,
            BreakToken::Space { idx, .. }
            | BreakToken::Tab { idx, .. }
            | BreakToken::LineBreak { idx } => *idx + 1,
            // 인라인 개체는 문자를 소비하지 않으므로 삽입 위치를 그대로 반환
            BreakToken::InlineControl { idx, .. } => *idx,
        })
        .unwrap_or(text_chars.len());

    if line_start_idx <= last_end {
        results.push(LineBreakResult {
            start_idx: line_start_idx,
            end_idx: last_end,
            max_font_size: line_max_fs,
            has_line_break: false,
        });
    }

    if results.is_empty() {
        results.push(LineBreakResult {
            start_idx: 0,
            end_idx: text_chars.len(),
            max_font_size: 0.0,
            has_line_break: false,
        });
    }

    results
}

/// 현재 줄에 own_line 인라인 개체(표/그림/도형)가 배치됐는지 판별한다.
/// 개체 토큰은 문자를 소비하지 않으므로, idx >= line_start 인 개체가
/// 현재 줄에 놓인 것으로 본다 (개체는 줄 바꿈과 함께 앞으로 이동하므로
/// 이전 줄에 남은 개체가 현재 line_start 이상의 idx 를 가지는 일은 없다).
fn line_hosts_own_line_control(
    tokens: &[BreakToken],
    current_token_idx: usize,
    line_start: usize,
) -> bool {
    tokens[..current_token_idx].iter().any(|t| {
        matches!(
            t,
            BreakToken::InlineControl {
                idx,
                own_line: true,
                ..
            } if *idx >= line_start
        )
    })
}

/// 줄 바꿈 지점 이후 토큰의 누적 폭 재계산 (HWPUNIT)
fn recalc_width_hwp(tokens: &[BreakToken], current_token_idx: usize, new_line_start: usize) -> i32 {
    let mut w = 0i32;
    for t in &tokens[..current_token_idx] {
        match t {
            BreakToken::Text {
                start_idx, width, ..
            } if *start_idx >= new_line_start => {
                w += to_hwp(*width);
            }
            BreakToken::Space { idx, width, .. } if *idx >= new_line_start => {
                w += to_hwp(*width);
            }
            BreakToken::InlineControl { idx, width_hwp, .. } if *idx >= new_line_start => {
                w += width_hwp;
            }
            _ => {}
        }
    }
    w
}

/// 줄 바꿈 지점 이후 공백 압축 가능 폭 재계산 (HWPUNIT)
fn recalc_space_savings_hwp(
    tokens: &[BreakToken],
    current_token_idx: usize,
    new_line_start: usize,
    condense_min_space: u8,
) -> i32 {
    let mut w = 0i32;
    for t in &tokens[..current_token_idx] {
        match t {
            BreakToken::Space {
                idx,
                width,
                max_font_size,
            } if *idx >= new_line_start => {
                let space_hwp = to_hwp(*width);
                w += condense_space_savings_hwp(space_hwp, condense_min_space);
            }
            _ => {}
        }
    }
    w
}

/// 긴 단어 폴백: 글자 단위 분할 (HWPUNIT)
/// char_widths_hwp: 토큰 내 각 글자의 HWPUNIT 폭 (None이면 휴리스틱)
/// pin_first_char: true이면 첫 글자는 줄이 넘쳐도 현재 줄에 고정한다
/// (직전 인라인 개체와의 anchor 모호성 회피 — fill_lines 호출부 주석 참조)
fn char_level_break_hwp(
    text_chars: &[char],
    token_start: usize,
    token_end: usize,
    line_start_idx: &mut usize,
    mut lw: i32,
    mut line_max_fs: f64,
    first_line_w: i32,
    normal_w: i32,
    mut is_first_line: bool,
    char_widths_hwp: &[i32], // 토큰 내 글자별 HWPUNIT 폭
    pin_first_char: bool,
) -> (Vec<LineBreakResult>, i32, f64) {
    let mut results = Vec::new();
    let mut current_w = if is_first_line {
        first_line_w
    } else {
        normal_w
    };

    let grapheme_ends = grapheme_end_map(text_chars);
    let mut ci = token_start;
    while ci < token_end {
        let cluster_end = grapheme_ends[ci].min(token_end).max(ci + 1);
        let rel_idx = ci - token_start;
        let cluster_w = if rel_idx < char_widths_hwp.len() {
            char_widths_hwp[rel_idx..(cluster_end - token_start).min(char_widths_hwp.len())]
                .iter()
                .sum()
        } else {
            let ch = text_chars[ci];
            let char_w_px = if is_cjk_char(ch) {
                line_max_fs.max(12.0)
            } else {
                line_max_fs.max(12.0) * 0.5
            };
            to_hwp(char_w_px)
        };

        if lw + cluster_w > current_w && ci > *line_start_idx && !(pin_first_char && rel_idx == 0) {
            results.push(LineBreakResult {
                start_idx: *line_start_idx,
                end_idx: ci,
                max_font_size: line_max_fs,
                has_line_break: false,
            });
            *line_start_idx = ci;
            lw = cluster_w;
            is_first_line = false;
            current_w = normal_w;
        } else {
            lw += cluster_w;
        }
        ci = cluster_end;
    }

    (results, lw, line_max_fs)
}

#[cfg(test)]
mod grapheme_reflow_tests {
    use super::*;
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle};

    fn styles() -> ResolvedStyleSet {
        ResolvedStyleSet {
            char_styles: vec![
                ResolvedCharStyle {
                    font_family: "Noto Sans KR".to_string(),
                    font_families: vec!["Noto Sans KR".to_string(); 7],
                    font_size: 12.0,
                    ..Default::default()
                },
                ResolvedCharStyle {
                    font_family: "Noto Sans KR".to_string(),
                    font_families: vec!["Noto Sans KR".to_string(); 7],
                    font_size: 24.0,
                    ..Default::default()
                },
            ],
            para_styles: vec![ResolvedParaStyle {
                english_break_unit: 2,
                korean_break_unit: 1,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn overwide_grapheme_is_not_split_by_long_token_fallback() {
        let chars: Vec<char> = "e\u{301}x".chars().collect();
        let mut line_start = 0;
        let (lines, remaining_width, _) = char_level_break_hwp(
            &chars,
            0,
            chars.len(),
            &mut line_start,
            0,
            12.0,
            1000,
            1000,
            true,
            &[1500, 0, 500],
            false,
        );

        assert_eq!(lines.len(), 1);
        assert_eq!((lines[0].start_idx, lines[0].end_idx), (0, 2));
        assert_eq!(line_start, 2);
        assert_eq!(remaining_width, 500);
    }

    #[test]
    fn grapheme_measurement_respects_style_boundary_after_field_gap() {
        let chars: Vec<char> = "e\u{301}x".chars().collect();
        // A field/control stream gap precedes the combining mark. The char-shape
        // boundary uses stream offsets, not visible character indexes.
        let offsets = vec![0, 9, 10];
        let shapes = vec![
            CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            },
            CharShapeRef {
                start_pos: 9,
                char_shape_id: 1,
            },
        ];
        let tokens = tokenize_paragraph(&chars, &offsets, &shapes, &styles(), 2, 1);
        let BreakToken::Text {
            start_idx,
            end_idx,
            width,
            max_font_size,
            ..
        } = &tokens[0]
        else {
            panic!("expected grapheme text token");
        };
        assert_eq!((*start_idx, *end_idx), (0, 2));
        assert_eq!(*max_font_size, 24.0);
        let expected = measure_token_width("e\u{301}", 0, &offsets, &shapes, &styles(), 1);
        assert!((*width - expected).abs() < 1e-9);
    }

    #[test]
    fn inline_control_after_grapheme_keeps_token_and_anchor_order() {
        let chars: Vec<char> = "e\u{301}x".chars().collect();
        let offsets = vec![0, 1, 2];
        let shapes = vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }];
        let tokens = tokenize_paragraph_with_controls(
            &chars,
            &offsets,
            &shapes,
            &styles(),
            2,
            1,
            &[(2, 500, false)],
        );

        assert!(matches!(
            tokens.as_slice(),
            [
                BreakToken::Text {
                    start_idx: 0,
                    end_idx: 2,
                    ..
                },
                BreakToken::InlineControl { idx: 2, .. },
                BreakToken::Text {
                    start_idx: 2,
                    end_idx: 3,
                    ..
                }
            ]
        ));
    }
}

/// 문단의 line_segs를 텍스트 내용과 컬럼 너비에 맞게 재계산한다.
///
/// 텍스트 편집(삽입/삭제) 후 호출하여 줄 바꿈을 재배치한다.
/// `available_width_px`는 문단 여백을 제외한 사용 가능 너비(px)이다.
#[derive(Debug, Clone, Copy)]
struct InlineControlMetricsHwp {
    width: i32,
    height: i32,
    baseline: i32,
}

fn inline_control_metrics_hwp(ctrl: &Control) -> Option<InlineControlMetricsHwp> {
    let (width, height, baseline) = match ctrl {
        Control::Picture(pic) if pic.common.treat_as_char => {
            let height = pic.common.height as i32;
            (
                pic.common.width as i32,
                height,
                (height as f64 * 0.85).round() as i32,
            )
        }
        Control::Shape(shape) if shape.common().treat_as_char => {
            let common = shape.common();
            let shape_attr = shape.shape_attr();
            let height = (common.height as i32).max(shape_attr.current_height as i32);
            let width = (common.width as i32).max(shape_attr.current_width as i32);
            (width, height, (height as f64 * 0.85).round() as i32)
        }
        Control::Table(table) if table.common.treat_as_char => {
            let width = table.get_column_widths().iter().sum::<u32>() as i32;
            let height = table.common.height as i32;
            (width, height, (height as f64 * 0.85).round() as i32)
        }
        Control::Equation(eq) if eq.common.treat_as_char => {
            let (natural_width, natural_height, natural_baseline) =
                crate::renderer::equation::intrinsic_metrics_hwp(&eq.script, eq.font_size);
            let width = (eq.common.width as i32).max(natural_width as i32);
            let stored_height = eq.common.height as i32;
            let natural_height = natural_height as i32;
            let extra = (stored_height - natural_height).max(0);
            // The painter uses the EqEdit layout baseline.  Split any larger
            // stored object slot evenly around that visual box so the line
            // still reserves the author's requested height without shifting
            // the equation ink away from the surrounding text baseline.
            let top_leading = extra / 2;
            (
                width,
                natural_height + extra,
                natural_baseline as i32 + top_leading,
            )
        }
        Control::Form(form) => {
            let height = form.height as i32;
            (
                form.width as i32,
                height,
                (height as f64 * 0.85).round() as i32,
            )
        }
        _ => return None,
    };

    if width > 0 && height > 0 {
        Some(InlineControlMetricsHwp {
            width,
            height,
            baseline: baseline.clamp(0, height),
        })
    } else {
        None
    }
}

fn non_equation_inline_control_height_hwp(para: &Paragraph) -> Option<i32> {
    para.controls
        .iter()
        .filter(|control| !matches!(control, Control::Equation(_)))
        .filter_map(inline_control_metrics_hwp)
        .map(|metrics| metrics.height)
        .max()
}

fn apply_inline_control_line_metrics(seg: &mut LineSeg, metrics: InlineControlMetricsHwp) {
    let current_ascent = seg.baseline_distance.clamp(0, seg.line_height.max(0));
    let current_descent = (seg.line_height - current_ascent).max(0);
    let control_ascent = metrics.baseline;
    let control_descent = (metrics.height - metrics.baseline).max(0);
    let ascent = current_ascent.max(control_ascent);
    let descent = current_descent.max(control_descent);
    let height = ascent.saturating_add(descent);

    if height > seg.line_height || ascent > seg.baseline_distance {
        seg.line_height = height;
        seg.text_height = height;
        seg.baseline_distance = ascent;
    }
}

fn line_index_for_text_position(line_breaks: &[LineBreakResult], position: usize) -> usize {
    line_breaks
        .partition_point(|line| line.start_idx <= position)
        .saturating_sub(1)
        .min(line_breaks.len().saturating_sub(1))
}

fn apply_inline_control_metrics_to_text_lines(
    para: &Paragraph,
    line_breaks: &[LineBreakResult],
    line_segs: &mut [LineSeg],
) {
    if line_breaks.is_empty() || line_segs.is_empty() {
        return;
    }

    let positions = para.control_text_positions();
    for (control_index, control) in para.controls.iter().enumerate() {
        if !matches!(control, Control::Equation(_)) {
            continue;
        }
        let Some(metrics) = inline_control_metrics_hwp(control) else {
            continue;
        };
        let position = positions
            .get(control_index)
            .copied()
            .unwrap_or_else(|| para.text.chars().count());
        let line_index = line_index_for_text_position(line_breaks, position);
        if let Some(line_seg) = line_segs.get_mut(line_index) {
            apply_inline_control_line_metrics(line_seg, metrics);
        }
    }
}

#[cfg(test)]
mod inline_equation_metric_tests {
    use super::*;
    use crate::model::control::Equation;
    use crate::model::shape::CommonObjAttr;

    #[test]
    fn equation_metrics_are_applied_to_the_anchored_wrapped_line() {
        let script = "W = sum_{i=1}^{n} u_i";
        let (width, height, equation_baseline) =
            crate::renderer::equation::intrinsic_metrics_hwp(script, 1000);
        let equation = Equation {
            common: CommonObjAttr {
                treat_as_char: true,
                width,
                height,
                ..Default::default()
            },
            script: script.to_string(),
            font_size: 1000,
            ..Default::default()
        };
        let mut para = Paragraph {
            text: "abcdefghij".to_string(),
            // One 8-code-unit control gap before character 5.
            char_offsets: (0..10)
                .map(|index| if index < 5 { index } else { index + 8 })
                .collect(),
            controls: vec![Control::Equation(Box::new(equation))],
            ..Default::default()
        };
        para.char_count = 19;

        let line_breaks = vec![
            LineBreakResult {
                start_idx: 0,
                end_idx: 5,
                max_font_size: 10.0,
                has_line_break: false,
            },
            LineBreakResult {
                start_idx: 5,
                end_idx: 10,
                max_font_size: 10.0,
                has_line_break: false,
            },
        ];
        let plain_line = LineSeg {
            line_height: 1000,
            text_height: 1000,
            baseline_distance: 850,
            ..Default::default()
        };
        let mut line_segs = vec![plain_line.clone(), plain_line.clone()];

        apply_inline_control_metrics_to_text_lines(&para, &line_breaks, &mut line_segs);

        assert_eq!(line_segs[0].line_height, plain_line.line_height);
        assert_eq!(line_segs[0].baseline_distance, plain_line.baseline_distance);
        assert_eq!(
            line_segs[1].baseline_distance,
            (equation_baseline as i32).max(plain_line.baseline_distance)
        );
        assert!(line_segs[1].line_height >= height as i32);
    }
}

#[cfg(test)]
mod inline_equation_15pt_wrap_tests {
    //! 회귀: 에이전트 삽입 인라인 수식의 줄넘침 (footnote-01.hwp e2e 결함 보고).
    //!
    //! 상속된 15pt(20px) 한글 문단에서 reflow 가 한글을 10pt 기본 서식(한글 ≈12.9~13.3px/char)으로
    //! 잘못 측정하면 수식 폭 예약이 줄 끝에서 어긋나 수식 잉크가 컬럼 밖으로 나간다.
    //! ① 토큰화가 각 위치의 유효 char shape(15pt)으로 측정하는지, ② 넓은 수식이
    //! 삽입돼도 모든 줄이 컬럼 안에 들어오는지를 고정한다.
    use super::*;
    use crate::model::control::Equation;
    use crate::model::shape::CommonObjAttr;
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle, ResolvedStyleSet};

    /// footnote-01.hwp 구조 재현: id 0 = 기본 10pt(13.33px), id 1 = 본문 15pt(20px).
    fn styles_10pt_default_15pt_body() -> ResolvedStyleSet {
        ResolvedStyleSet {
            hwp3_variant: false,
            char_styles: vec![
                ResolvedCharStyle {
                    font_family: "함초롬바탕".to_string(),
                    font_size: 40.0 / 3.0, // 10pt
                    ratio: 1.0,
                    ..Default::default()
                },
                ResolvedCharStyle {
                    font_family: "한컴바탕".to_string(),
                    font_size: 20.0, // 15pt
                    ratio: 1.0,
                    ..Default::default()
                },
            ],
            para_styles: vec![ResolvedParaStyle::default()],
            ..Default::default()
        }
    }

    /// e2e 채움 문단 (76자) — agent-edit-loop.test.mjs 의 FILLER 와 동일.
    const FILLER: &str = "에이전트 줄바꿈 검증용 채움 문단입니다 이 문장은 첫 줄을 가득 채우고 다음 줄로 넘어가야 하므로 일부러 아주 길게 작성한 문장입니다 끝";

    /// footnote-01.hwp 본문 컬럼 폭 (48190 HWP = 642.53px).
    const COLUMN_PX: f64 = 642.5333333333333;

    fn tac_equation(width_hwp: u32, height_hwp: u32) -> Control {
        Control::Equation(Box::new(Equation {
            common: CommonObjAttr {
                treat_as_char: true,
                width: width_hwp,
                height: height_hwp,
                ..Default::default()
            },
            script: "x = {-b +- sqrt {b^2 - 4ac}} over {2a}".to_string(),
            font_size: 1500,
            ..Default::default()
        }))
    }

    /// 각 줄의 잉크 폭(px): canonical 측정(estimate_text_width)으로 줄 텍스트를 합산하고,
    /// 그 줄에 anchor 된 인라인 개체의 예약 폭을 더한다.
    fn line_ink_widths_px(para: &Paragraph, styles: &ResolvedStyleSet) -> Vec<f64> {
        let text_chars: Vec<char> = para.text.chars().collect();
        let ctrl_positions = para.control_text_positions();
        para.line_segs
            .iter()
            .enumerate()
            .map(|(li, seg)| {
                let end_u16 = para
                    .line_segs
                    .get(li + 1)
                    .map(|s| s.text_start)
                    .unwrap_or(u32::MAX);
                let start_ci = para
                    .char_offsets
                    .iter()
                    .position(|&o| o >= seg.text_start)
                    .unwrap_or(0);
                let end_ci = para
                    .char_offsets
                    .iter()
                    .position(|&o| o >= end_u16)
                    .unwrap_or(text_chars.len());
                let mut w = 0.0f64;
                let mut lang = 0usize;
                for ci in start_ci..end_ci.min(text_chars.len()) {
                    let c = text_chars[ci];
                    if !is_lang_neutral(c) {
                        lang = detect_lang_category(c);
                    }
                    let sid = find_active_char_shape(&para.char_shapes, para.char_offsets[ci]);
                    let ts = resolved_to_text_style(styles, sid, lang);
                    w += estimate_text_width(&c.to_string(), &ts);
                }
                for (k, &pos) in ctrl_positions.iter().enumerate() {
                    if pos >= start_ci && pos < end_ci.max(start_ci + 1) {
                        if let Some(m) = inline_control_metrics_hwp(&para.controls[k]) {
                            w += m.width as f64 / 75.0;
                        }
                    }
                }
                w
            })
            .collect()
    }

    /// 문자 위치(인라인 개체 anchor)를 포함하는 줄의 시작 문자 인덱스.
    fn line_start_char_of(para: &Paragraph, char_pos: usize) -> Option<usize> {
        let mut starts: Vec<usize> = para
            .line_segs
            .iter()
            .map(|seg| {
                para.char_offsets
                    .iter()
                    .position(|&o| o >= seg.text_start)
                    .unwrap_or(usize::MAX)
            })
            .collect();
        starts.push(usize::MAX);
        starts.windows(2).find_map(|w| {
            if char_pos >= w[0] && char_pos < w[1] {
                Some(w[0])
            } else {
                None
            }
        })
    }

    /// 15pt char shape 를 참조하는 한글 토큰은 글자당 20px 로 측정되어야 한다.
    /// 기본 10pt 서식으로 잘못 해석되면 13.33px/char 가 된다 (보고된 오측정치).
    #[test]
    fn tokenize_measures_hangul_with_effective_15pt_shape_not_default_10pt() {
        let styles = styles_10pt_default_15pt_body();
        let text: Vec<char> = "에이전트 줄바꿈 검증".chars().collect();
        let offsets: Vec<u32> = (0..text.len() as u32).collect();

        for (shape_id, expect_w) in [(1u32, 80.0f64), (0u32, 51.733333)] {
            let shapes = vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: shape_id,
            }];
            let tokens = tokenize_paragraph(&text, &offsets, &shapes, &styles, 0, 0);
            let width = tokens
                .iter()
                .find_map(|t| match t {
                    BreakToken::Text {
                        start_idx,
                        end_idx,
                        width,
                        ..
                    } if *start_idx == 0 && *end_idx == 4 => Some(*width),
                    _ => None,
                })
                .expect("어절 토큰 '에이전트' 가 있어야 한다");
            assert!(
                (width - expect_w).abs() < 0.5,
                "char_shape_id={} → '에이전트' 폭 {:.2}px (기대 {:.2}px)",
                shape_id,
                width,
                expect_w
            );
        }
    }

    /// 15pt 한글 문단 첫 줄 끝에 컬럼 남은 폭보다 넓은 인라인 수식을 삽입하면
    /// 수식이 다음 줄로 밀리고, 모든 줄의 잉크 폭이 컬럼 안에 들어와야 한다.
    #[test]
    fn reflow_wraps_wide_equation_inside_column_15pt_hangul() {
        let styles = styles_10pt_default_15pt_body();
        let n_chars = FILLER.chars().count();
        let eq_pos = 34usize; // 첫 줄 끝(lineEnd=36) 근처 — e2e 삽입점과 동일
        let char_offsets: Vec<u32> = (0..n_chars)
            .map(|i| if i < eq_pos { i } else { i + 8 })
            .map(|v| v as u32)
            .collect();
        let mut para = Paragraph {
            text: FILLER.to_string(),
            char_offsets,
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 1,
            }],
            controls: vec![tac_equation(13380, 5000)],
            line_segs: vec![LineSeg::default()],
            ..Default::default()
        };
        para.char_count = (n_chars + 8 + 1) as u32;

        reflow_line_segs(&mut para, COLUMN_PX, &styles, 96.0);

        // 수식(178.4px)이 첫 줄 남은 폭(~52px)보다 넓어 자기 줄로 밀려난다:
        // anchor(문자 34)가 줄 시작(흡수된 공백 1자 이내)에 놓인다.
        assert_eq!(
            para.line_segs.len(),
            3,
            "수식 예약으로 3줄이 되어야 한다 (line_segs={:?})",
            para.line_segs
                .iter()
                .map(|ls| ls.text_start)
                .collect::<Vec<_>>()
        );
        let anchor_line_start =
            line_start_char_of(&para, eq_pos).expect("수식 anchor 를 포함하는 줄이 있어야 한다");
        assert!(
            anchor_line_start >= eq_pos - 2 && anchor_line_start <= eq_pos,
            "수식 anchor 가 줄 시작 근처에 와야 한다: line_start={} anchor={} (line_segs={:?})",
            anchor_line_start,
            eq_pos,
            para.line_segs
                .iter()
                .map(|ls| ls.text_start)
                .collect::<Vec<_>>()
        );
        // 모든 줄의 잉크 폭이 컬럼 안.
        for (li, w) in line_ink_widths_px(&para, &styles).iter().enumerate() {
            assert!(
                *w <= COLUMN_PX + 0.2,
                "line {} 잉크 폭 {:.1}px 가 컬럼 {:.1}px 를 넘는다",
                li,
                w,
                COLUMN_PX
            );
        }
    }

    /// 실물 문서 회귀: footnote-01.hwp 로드 → 에이전트 편집 시퀀스(채움 문단 삽입
    /// → 서식 편집 → 쪽 나눔 → 수식 삽입)를 그대로 재현해, 수식이 든 문단의
    /// 모든 줄이 컬럼 안에 들어오는지 검증한다.
    #[test]
    fn footnote01_agent_equation_insert_stays_inside_column() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/footnote-01.hwp");
        if !path.exists() {
            eprintln!("테스트 파일 없음: {} — 건너뜀", path.display());
            return;
        }
        let bytes = std::fs::read(&path).unwrap();
        let mut core = crate::document_core::DocumentCore::from_bytes(&bytes).unwrap();

        // e2e performInsert 재현: 마지막 문단 끝에서 줄 단위 insertText + splitParagraph.
        let seed_base = core.document().sections[0].paragraphs.len();
        let seed_len = core.document().sections[0].paragraphs[seed_base - 1]
            .text
            .chars()
            .count();
        core.insert_text_native(0, seed_base - 1, seed_len, " ")
            .unwrap();
        let lines = [
            "",
            FILLER,
            "첫째 에이전트 목록 항목입니다",
            "둘째 항목의 원본 텍스트 구간입니다",
            "셋째 에이전트 목록 항목입니다",
        ];
        let mut cur_para = seed_base - 1;
        let mut cur_off = seed_len + 1;
        for (li, line) in lines.iter().enumerate() {
            if li > 0 {
                core.split_paragraph_native(0, cur_para, cur_off, None)
                    .unwrap();
                cur_para += 1;
                cur_off = 0;
            }
            if !line.is_empty() {
                core.insert_text_native(0, cur_para, cur_off, line).unwrap();
                cur_off += line.chars().count();
            }
        }
        let filler_p = seed_base;
        let l2_p = seed_base + 2;

        // e2e 중간 편집: L2 볼드(새 char shape 추가) + 채움 문단 pageBreakBefore.
        core.apply_char_format_native(0, l2_p, 6, 14, "{\"bold\":true}")
            .unwrap();
        core.apply_para_format_native(0, filler_p, "{\"pageBreakBefore\":true}")
            .unwrap();

        // 상속 서식이 15pt(20px)인지 먼저 고정한다.
        let filler = &core.document().sections[0].paragraphs[filler_p];
        let shape_id = filler
            .char_shapes
            .first()
            .map(|cs| cs.char_shape_id)
            .unwrap();
        let font_size = core.styles.char_styles[shape_id as usize].font_size;
        assert_eq!(font_size, 20.0, "채움 문단 상속 서식은 15pt(20px)여야 한다");

        // 첫 줄 끝 근처(lineEnd - 2)에 15pt 수식 삽입.
        let first_line_end_u16 = filler
            .line_segs
            .get(1)
            .map(|ls| ls.text_start)
            .unwrap_or(u32::MAX);
        let line_end = filler
            .char_offsets
            .iter()
            .position(|&o| o >= first_line_end_u16)
            .unwrap_or(filler.char_offsets.len())
            .saturating_sub(1);
        core.insert_equation_native(
            0,
            filler_p,
            line_end - 2,
            "x = {-b +- sqrt {b^2 - 4ac}} over {2a}",
            1500,
            0,
        )
        .unwrap();

        // 컬럼 폭: insert_equation_native 의 reflow 와 동일 산식.
        let (column_px, eq_pos) = {
            let core_styles = &core.styles;
            let section = &core.document().sections[0];
            let page_def = &section.section_def.page_def;
            let text_width =
                page_def.width as i32 - page_def.margin_left as i32 - page_def.margin_right as i32;
            let para = &section.paragraphs[filler_p];
            let para_style = core_styles.para_styles.get(para.para_shape_id as usize);
            let ml = para_style.map(|s| s.margin_left).unwrap_or(0.0);
            let mr = para_style.map(|s| s.margin_right).unwrap_or(0.0);
            let col = (crate::renderer::hwpunit_to_px(text_width, 96.0) - ml - mr).max(0.0);
            let pos = para.control_text_positions()[0];
            (col, pos)
        };

        let para = &core.document().sections[0].paragraphs[filler_p];
        let anchor_line_start =
            line_start_char_of(para, eq_pos).expect("수식 anchor 를 포함하는 줄이 있어야 한다");
        assert!(
            anchor_line_start >= eq_pos - 2 && anchor_line_start <= eq_pos,
            "수식이 자기 줄 시작으로 밀려야 한다: line_start={} anchor={} (line_segs={:?})",
            anchor_line_start,
            eq_pos,
            para.line_segs
                .iter()
                .map(|ls| ls.text_start)
                .collect::<Vec<_>>()
        );
        for (li, w) in line_ink_widths_px(para, &core.styles).iter().enumerate() {
            assert!(
                *w <= column_px + 0.5,
                "line {} 잉크 폭 {:.1}px 가 컬럼 {:.1}px 를 넘는다",
                li,
                w,
                column_px
            );
        }
    }

    /// 브라우저 e2e(agent-edit-loop f절)와 동일 경로의 실물 회귀.
    ///
    /// getCursorRect 로 찾은 첫 줄 끝 두 글자 앞에 15pt 수식을 삽입한다 — 이
    /// 삽입점에서는 수식 anchor 가 공백과 같은 문자 위치에 놓인다. 공백 흡수형
    /// 줄나눔이 개체를 이전 줄 끝에 좌초시켜(폭 예약 줄 ≠ painter 방출 줄)
    /// 수식 잉크가 컬럼 밖으로 나가던 결함(eqRight=824 > rightEdge=718.1)을
    /// 고정한다. anchor 가 줄 경계에 걸리는 이 시나리오만 잡는다 — 단순
    /// line_segs 기반 삽입점(어절 경계)으로는 재현되지 않았다.
    #[test]
    fn footnote01_cursor_probe_equation_insert_matches_browser_layout() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/footnote-01.hwp");
        if !path.exists() {
            eprintln!("테스트 파일 없음: {} — 건너뜀", path.display());
            return;
        }
        let bytes = std::fs::read(&path).unwrap();
        let mut doc = crate::wasm_api::HwpDocument::from_bytes(&bytes).unwrap();
        doc.convert_to_editable().unwrap();

        // TS performInsert 동형 시드 삽입 (마지막 문단 뒤에 4개 문단)
        let seed_base = doc.document().sections[0].paragraphs.len();
        let seed_len = doc.document().sections[0].paragraphs[seed_base - 1]
            .text
            .chars()
            .count();
        doc.insert_text_native(0, seed_base - 1, seed_len, " ")
            .unwrap();
        let lines = [
            "",
            FILLER,
            "첫째 에이전트 목록 항목입니다",
            "둘째 항목의 원본 텍스트 구간입니다",
            "셋째 에이전트 목록 항목입니다",
        ];
        let mut cur_para = seed_base - 1;
        let mut cur_off = seed_len + 1;
        for (li, line) in lines.iter().enumerate() {
            if li > 0 {
                doc.split_paragraph_native(0, cur_para, cur_off, None)
                    .unwrap();
                cur_para += 1;
                cur_off = 0;
            }
            if !line.is_empty() {
                doc.insert_text_native(0, cur_para, cur_off, line).unwrap();
                cur_off += line.chars().count();
            }
        }
        let filler_p = seed_base;
        doc.apply_para_format_native(0, filler_p, "{\"pageBreakBefore\":true}")
            .unwrap();

        // e2e probe: getCursorRect y 가 처음 바뀌는 지점 = 첫 줄 끝
        let len = doc.document().sections[0].paragraphs[filler_p]
            .text
            .chars()
            .count();
        let r0 = doc.get_cursor_rect(0, filler_p as u32, 0).unwrap();
        let r0y = json_f64(&r0, "y");
        let page = json_f64(&r0, "pageIndex");
        let mut line_end = len;
        for o in 1..=len {
            let r = doc.get_cursor_rect(0, filler_p as u32, o as u32).unwrap();
            if json_f64(&r, "pageIndex") != page || json_f64(&r, "y") > r0y + 1.0 {
                line_end = o - 1;
                break;
            }
        }
        let eq_offset = line_end - 2;
        doc.insert_equation_native(
            0,
            filler_p,
            eq_offset,
            "x = {-b +- sqrt {b^2 - 4ac}} over {2a}",
            1500,
            0,
        )
        .unwrap();

        let page_def = &doc.document().sections[0].section_def.page_def;
        let margin_left = crate::renderer::hwpunit_to_px(page_def.margin_left as i32, 96.0);
        let right_edge = crate::renderer::hwpunit_to_px(
            page_def.width as i32 - page_def.margin_right as i32,
            96.0,
        );

        // 수식 bbox (painter 가 실제 그린 위치)
        let layout = doc.get_page_control_layout(page as u32).unwrap();
        let (eq_x, eq_w) = find_equation_bbox(&layout, filler_p).expect("수식 bbox 가 있어야 한다");
        assert!(
            eq_x <= margin_left + 40.0,
            "남은 폭보다 넓은 수식이 다음 줄로 밀려야 함: eq.x={:.1} marginLeft={:.1}",
            eq_x,
            margin_left
        );
        assert!(
            eq_x + eq_w <= right_edge + 4.0,
            "수식 bbox 가 열 안이어야 함: eqRight={:.1} rightEdge={:.1}",
            eq_x + eq_w,
            right_edge
        );

        // 어떤 커서 위치도 열 오른쪽을 넘지 않아야 한다 (e2e caretOk)
        let mut max_x = 0.0f64;
        for o in 0..=(len + 10) {
            if let Ok(r) = doc.get_cursor_rect(0, filler_p as u32, o as u32) {
                let x = json_f64(&r, "x");
                if x > max_x {
                    max_x = x;
                }
            }
        }
        assert!(
            max_x <= right_edge + 4.0,
            "수식 문단 어떤 런도 열 오른쪽을 넘지 않아야 함: maxX={:.1} rightEdge={:.1}",
            max_x,
            right_edge
        );
    }

    fn json_f64(json: &str, key: &str) -> f64 {
        let pat = format!("\"{}\":", key);
        let Some(i) = json.find(&pat) else {
            return -1.0;
        };
        let rest = &json[i + pat.len()..];
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
            .unwrap_or(rest.len());
        rest[..end].parse().unwrap_or(-1.0)
    }

    fn find_equation_bbox(layout: &str, para_idx: usize) -> Option<(f64, f64)> {
        let marker = format!("\"paraIdx\":{}", para_idx);
        let mut rest = layout;
        while let Some(i) = rest.find("\"type\":\"equation\"") {
            let start = rest[..i].rfind('{')?;
            let end = rest[i..].find('}').map(|e| i + e)?;
            let obj = &rest[start..end];
            if obj.contains(&marker) {
                return Some((json_f64(obj, "x"), json_f64(obj, "w")));
            }
            rest = &rest[end..];
        }
        None
    }
}

#[cfg(test)]
mod inline_control_wrap_tests {
    use super::*;
    use crate::model::control::Equation;
    use crate::model::shape::CommonObjAttr;
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle, ResolvedStyleSet};

    fn styles_16px() -> ResolvedStyleSet {
        ResolvedStyleSet {
            hwp3_variant: false,
            char_styles: vec![ResolvedCharStyle {
                font_size: 16.0,
                ratio: 1.0,
                ..Default::default()
            }],
            para_styles: vec![ResolvedParaStyle::default()],
            ..Default::default()
        }
    }

    fn tac_equation(width_hwp: u32, height_hwp: u32) -> Control {
        Control::Equation(Box::new(Equation {
            common: CommonObjAttr {
                treat_as_char: true,
                width: width_hwp,
                height: height_hwp,
                ..Default::default()
            },
            script: "x".to_string(),
            font_size: 1000,
            ..Default::default()
        }))
    }

    /// 줄이 거의 찬 텍스트에 넓은 인라인 수식이 삽입되면 수식 폭을 예약해
    /// 뒤따르는 텍스트가 다음 줄로 밀려나야 한다 (컬럼 밖 overflow 방지).
    #[test]
    fn reflow_reserves_inline_equation_width_and_wraps_trailing_text() {
        let styles = styles_16px();
        // 라틴 19자, 문자 위치 10 앞에 8 code-unit 컨트롤 갭 (수식 anchor)
        let mut para = Paragraph {
            text: "aaaa bbbb cccc dddd".to_string(),
            char_offsets: (0..19u32).map(|i| if i < 10 { i } else { i + 8 }).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            controls: vec![tac_equation(4000, 5000)],
            line_segs: vec![LineSeg::default()],
            ..Default::default()
        };
        para.char_count = 28;

        // 컬럼 100px(7500 HWP): 단어 32px(2400 HWP), 수식 4000 HWP.
        // 폭 예약이 없으면 2줄 [0,9),[10,19) — 2번째 줄이 수식+텍스트 8800+ HWP로
        // 컬럼을 넘는다. 예약이 있으면 3줄로 나뉘고 각 줄이 컬럼 안에 들어간다.
        reflow_line_segs(&mut para, 100.0, &styles, 96.0);

        assert_eq!(para.line_segs.len(), 3);
        assert_eq!(para.line_segs[0].text_start, 0);
        // 2번째 줄은 수식 anchor(문자 10 → UTF-16 18)에서 시작
        assert_eq!(para.line_segs[1].text_start, 18);
        // 3번째 줄은 "dddd"(문자 15 → UTF-16 23)
        assert_eq!(para.line_segs[2].text_start, 23);
        // 수식이 놓인 2번째 줄만 수식 높이(5000 HWP)로 커진다
        assert!(para.line_segs[1].line_height >= 5000);
        assert_eq!(para.line_segs[0].line_height, 1200);
        assert_eq!(para.line_segs[2].line_height, 1200);
    }

    /// 인라인 수식이 줄에 들어가면 불필요한 줄 나눔이 생기지 않는다.
    #[test]
    fn reflow_keeps_fitting_inline_equation_on_single_line() {
        let styles = styles_16px();
        // "aaaa bbbb", 문자 위치 5 앞에 컨트롤 갭
        let mut para = Paragraph {
            text: "aaaa bbbb".to_string(),
            char_offsets: (0..9u32).map(|i| if i < 5 { i } else { i + 8 }).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            controls: vec![tac_equation(1000, 1200)],
            line_segs: vec![LineSeg::default()],
            ..Default::default()
        };
        para.char_count = 18;

        // 2400 + 공백 + 1000 + 2400 = 5800+ HWP < 7500 HWP → 1줄 유지
        reflow_line_segs(&mut para, 100.0, &styles, 96.0);
        assert_eq!(para.line_segs.len(), 1);
    }

    /// 단어 중간(straddle)에 삽입된 수식도 토큰을 분할해 폭을 예약한다.
    /// break point(공백)가 없는 줄에서는 수식 바로 뒤 글자에서 잘리지 않고
    /// (painter anchor 모호성) 그 다음 글자에서 줄이 나뉜다.
    #[test]
    fn reflow_splits_word_token_at_inline_equation() {
        let styles = styles_16px();
        // 라틴 10자 단어, 문자 위치 5 앞에 컨트롤 갭
        let mut para = Paragraph {
            text: "aaaaaaaaaa".to_string(),
            char_offsets: (0..10u32).map(|i| if i < 5 { i } else { i + 8 }).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            controls: vec![tac_equation(4000, 5000)],
            line_segs: vec![LineSeg::default()],
            ..Default::default()
        };
        para.char_count = 19;

        // 3000(5글자) + 4000(수식) = 7000 ≤ 7500이라 수식은 1번째 줄에 배치.
        // 뒤 5글자(3000)는 넘치므로 글자 단위 분할 — 단 첫 글자는 수식과 같은 줄에
        // 고정되어 [0,6),[6,10) 으로 나뉜다 ([0,5),[5,10) 가 아님).
        reflow_line_segs(&mut para, 100.0, &styles, 96.0);

        assert_eq!(para.line_segs.len(), 2);
        // 2번째 줄은 문자 6 (UTF-16 6+8=14)에서 시작
        assert_eq!(para.line_segs[1].text_start, 14);
        // 수식 anchor(위치 5)는 1번째 줄 [0,6) 안 → 1번째 줄만 높이 보정
        assert!(para.line_segs[0].line_height >= 5000);
        assert_eq!(para.line_segs[1].line_height, 1200);
    }
}

pub(crate) fn reflow_line_segs(
    para: &mut Paragraph,
    available_width_px: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
) {
    // 기존 LineSeg에서 dimension 값 보존 (원본 HWP 호환성 유지)
    let seg_width_hwp = px_to_hwpunit(available_width_px, dpi);
    let orig = para.line_segs.first().cloned();
    let has_valid_orig = orig.as_ref().map(|ls| ls.line_height > 0).unwrap_or(false);

    // ParaPr의 줄간격 설정 (합성 LineSeg에서 line_spacing 계산에 사용)
    let para_style = styles.para_styles.get(para.para_shape_id as usize);
    let ls_type = para_style
        .map(|s| s.line_spacing_type)
        .unwrap_or(LineSpacingType::Percent);
    let ls_value = para_style.map(|s| s.line_spacing).unwrap_or(160.0);

    // 줄별 max_font_size에 따라 line_height/text_height/baseline_distance를 계산
    // 한컴은 줄마다 최대 폰트 크기에 맞게 다른 치수를 사용
    let make_line_seg = |utf16_start: u32, max_font_size: f64| -> LineSeg {
        let fs = if max_font_size > 0.0 {
            max_font_size
        } else {
            12.0
        };
        let line_height_hwp = font_size_to_line_height(fs, dpi);
        let text_height_hwp = line_height_hwp;
        let baseline_distance_hwp = (line_height_hwp as f64 * 0.85) as i32;
        let line_spacing_hwp = compute_line_spacing_hwp(ls_type, ls_value, line_height_hwp, dpi);
        // [Task #1811] 원본 linesegarray 부재(orig=None) 시 합성 seg 에 구현속성
        // 태그를 부여 — vpos 보정 등에서 실제 저장 증거와 구분한다 (컨버터의
        // 합성 lineseg flags=0x8000_0000 관례와 정합).
        let orig_tag = orig
            .as_ref()
            .map(|ls| ls.tag)
            .unwrap_or(LineSeg::TAG_SINGLE_SEGMENT_LINE | LineSeg::TAG_IMPLEMENTATION_PROPERTY);
        LineSeg {
            text_start: utf16_start,
            line_height: line_height_hwp,
            text_height: text_height_hwp,
            baseline_distance: baseline_distance_hwp,
            line_spacing: line_spacing_hwp,
            segment_width: seg_width_hwp,
            tag: if orig_tag != 0 {
                orig_tag
            } else {
                LineSeg::TAG_SINGLE_SEGMENT_LINE
            },
            ..Default::default()
        }
    };

    if para.text.is_empty() {
        let inline_sizes = para
            .controls
            .iter()
            .filter_map(inline_control_metrics_hwp)
            .collect::<Vec<_>>();
        if !inline_sizes.is_empty() {
            let max_line_width = seg_width_hwp.max(1);
            let mut line_specs: Vec<(usize, i32, i32, i32)> = Vec::new();
            let mut line_start = 0usize;
            let mut line_width = 0i32;
            let mut line_ascent = 0i32;
            let mut line_descent = 0i32;

            for (idx, metrics) in inline_sizes.iter().copied().enumerate() {
                if line_width > 0 && line_width + metrics.width > max_line_width {
                    line_specs.push((line_start, line_width, line_ascent, line_descent));
                    line_start = idx;
                    line_width = 0;
                    line_ascent = 0;
                    line_descent = 0;
                }
                line_width += metrics.width;
                line_ascent = line_ascent.max(metrics.baseline);
                line_descent = line_descent.max(metrics.height - metrics.baseline);
            }
            line_specs.push((line_start, line_width, line_ascent, line_descent));

            let orig_line_segs = para.line_segs.clone();
            let mut new_line_segs = Vec::with_capacity(line_specs.len());
            for (line_idx, (start_pos, _line_width, ascent_hwp, descent_hwp)) in
                line_specs.into_iter().enumerate()
            {
                let mut seg = make_line_seg(start_pos as u32, 0.0);
                if let Some(template) = orig_line_segs
                    .get(line_idx)
                    .or_else(|| orig_line_segs.first())
                {
                    seg.line_spacing = template.line_spacing;
                    seg.segment_width = if template.segment_width > 0 {
                        template.segment_width
                    } else {
                        seg_width_hwp
                    };
                    seg.tag = if template.tag != 0 {
                        template.tag
                    } else {
                        seg.tag
                    };
                }
                apply_inline_control_line_metrics(
                    &mut seg,
                    InlineControlMetricsHwp {
                        width: 0,
                        height: ascent_hwp.saturating_add(descent_hwp),
                        baseline: ascent_hwp,
                    },
                );
                new_line_segs.push(seg);
            }

            let mut vpos = orig.as_ref().map(|ls| ls.vertical_pos).unwrap_or(0);
            for seg in &mut new_line_segs {
                seg.vertical_pos = vpos;
                vpos += seg.line_height + seg.line_spacing;
            }
            para.line_segs = new_line_segs;
        } else {
            // 빈 문단도 활성 글자 모양의 크기로 줄을 만든다. 앞 문단 LINE_SEG의
            // 치수를 복사하면 TAC 그림 높이까지 상속되므로 vpos 원점만 보존한다.
            let font_size = para
                .char_shapes
                .first()
                .and_then(|char_shape| styles.char_styles.get(char_shape.char_shape_id as usize))
                .map(|style| style.font_size)
                .unwrap_or(12.0);
            let mut seg = make_line_seg(0, font_size);
            if let Some(template) = orig.as_ref() {
                seg.vertical_pos = template.vertical_pos;
            }
            para.line_segs = vec![seg];
        }
        return;
    }

    let text_chars: Vec<char> = para.text.chars().collect();
    let text_len = text_chars.len();

    // 문단 스타일에서 들여쓰기 및 줄 나눔 설정 조회
    let para_style = styles.para_styles.get(para.para_shape_id as usize);
    let indent_px = para_style.map(|s| s.indent).unwrap_or(0.0);
    let english_break_unit = para_style.map(|s| s.english_break_unit).unwrap_or(0);
    let korean_break_unit = para_style.map(|s| s.korean_break_unit).unwrap_or(0);
    let condense_min_space = para_style.map(|s| s.condense_min_space).unwrap_or(0);
    let tab_width = para_style.map(|s| s.default_tab_width).unwrap_or(0.0);

    // 인라인(treat_as_char) 개체를 줄 나눔 토큰에 반영한다 — 개체 폭을 예약하지
    // 않으면 개체 삽입 편집 후 재배치 시 뒤따르는 텍스트가 컬럼 밖으로 밀려난다.
    // Form은 인라인 흐름 개체가 아니므로 제외한다.
    // own_line: 표/그림/도형은 한컴이 전용 줄을 부여하는 블록형 개체로 취급한다
    // (수식은 텍스트 흐름 개체). 블록형 개체 줄에서 넘치는 후행 토큰은 통째로
    // 다음 줄로 본내 한 글자 run 조각남을 피한다 (pr_2219).
    let control_positions = para.control_text_positions();
    let mut inline_controls: Vec<(usize, i32, bool)> = para
        .controls
        .iter()
        .enumerate()
        .filter(|(_, ctrl)| !matches!(ctrl, Control::Form(_)))
        .filter_map(|(ci, ctrl)| {
            inline_control_metrics_hwp(ctrl)
                .map(|m| (ci, m.width, !matches!(ctrl, Control::Equation(_))))
        })
        .map(|(ci, width, own_line)| {
            let pos = control_positions
                .get(ci)
                .copied()
                .unwrap_or(text_len)
                .min(text_len);
            (pos, width, own_line)
        })
        .collect();
    inline_controls.sort_by_key(|&(pos, _, _)| pos);

    // 토큰화 → 줄 채움 → LineSeg 생성
    let tokens = tokenize_paragraph_with_controls(
        &text_chars,
        &para.char_offsets,
        &para.char_shapes,
        styles,
        english_break_unit,
        korean_break_unit,
        &inline_controls,
    );
    // 1차: 전폭 채움. 어울림 개체가 있으면 여기서 앵커 줄 y 를 추정해 배제
    // 계획을 만들고, 2차 채움과 seg 지오메트리가 같은 계산으로 wrap zone 을 쓴다.
    let advance_px_of = |fs: f64| -> f64 {
        let f = if fs > 0.0 { fs } else { 12.0 };
        let lh = font_size_to_line_height(f, dpi);
        let sp = compute_line_spacing_hwp(ls_type, ls_value, lh, dpi);
        hwpunit_to_px(lh + sp, dpi)
    };
    let line_breaks_full = fill_lines(
        &tokens,
        &text_chars,
        available_width_px,
        indent_px,
        tab_width,
        korean_break_unit,
        condense_min_space,
        None,
    );
    let wrap_plan = paragraph_local_wrap_plan(
        para,
        available_width_px,
        |anchor_pos: usize| -> f64 {
            let mut y = 0.0;
            for lb in &line_breaks_full {
                if anchor_pos < lb.end_idx {
                    break;
                }
                y += advance_px_of(lb.max_font_size);
            }
            y
        },
        ls_type,
        ls_value,
        dpi,
    );
    let line_breaks = match &wrap_plan {
        Some(plan) => fill_lines(
            &tokens,
            &text_chars,
            available_width_px,
            indent_px,
            tab_width,
            korean_break_unit,
            condense_min_space,
            Some(plan),
        ),
        None => line_breaks_full,
    };
    let mut new_line_segs: Vec<LineSeg> = Vec::new();
    for lb in &line_breaks {
        let utf16_start = if new_line_segs.is_empty() {
            0 // 첫 번째 줄의 text_start는 항상 0 (문단 시작)
        } else if lb.start_idx < para.char_offsets.len() {
            para.char_offsets[lb.start_idx]
        } else if !para.char_offsets.is_empty() {
            // start_idx가 텍스트 끝을 넘을 때: 마지막 문자 다음 UTF-16 위치
            let last_idx = para.char_offsets.len() - 1;
            let last_char_utf16_len = para
                .text
                .chars()
                .nth(last_idx)
                .map(|c| c.len_utf16() as u32)
                .unwrap_or(1);
            para.char_offsets[last_idx] + last_char_utf16_len
        } else {
            lb.start_idx as u32
        };
        let fs = if lb.max_font_size > 0.0 {
            lb.max_font_size
        } else {
            12.0
        };
        new_line_segs.push(make_line_seg(utf16_start as u32, fs));
    }

    if new_line_segs.is_empty() {
        new_line_segs.push(make_line_seg(0, 12.0));
    }

    // 기존 비수식 TAC 개체의 첫 줄 보정은 유지한다. 수식만은 실제 anchor가
    // 속한 줄에 painter와 동일한 EqEdit ascent/descent를 적용해야 tall
    // operator/fraction이 인접 줄을 덮지 않고 주변 텍스트와 한 baseline에 놓인다.
    if let Some(height_hwp) = non_equation_inline_control_height_hwp(para) {
        if let Some(first_line) = new_line_segs.first_mut() {
            apply_inline_control_line_metrics(
                first_line,
                InlineControlMetricsHwp {
                    width: 0,
                    height: height_hwp,
                    baseline: (height_hwp as f64 * 0.85).round() as i32,
                },
            );
        }
    }
    apply_inline_control_metrics_to_text_lines(para, &line_breaks, &mut new_line_segs);

    // 어울림 배제 계획이 있으면 줄별 wrap zone 을 seg 에 기록한다 — 채움(2차
    // fill_lines)과 동일한 결정적 대역 계산이라 텍스트가 기록 폭을 넘지 않는다.
    // 렌더러는 이 column_start/segment_width 를 저장 지오메트리처럼 재생한다.
    if let Some(plan) = &wrap_plan {
        let mut y = 0.0;
        for i in 0..new_line_segs.len() {
            let band_fs = if i == 0 {
                0.0
            } else {
                line_breaks.get(i - 1).map(|lb| lb.max_font_size).unwrap_or(0.0)
            };
            let (x, w) = plan.interval_at(y, band_fs);
            if plan.narrows(x, w) {
                new_line_segs[i].column_start = px_to_hwpunit(x, dpi);
                new_line_segs[i].segment_width = px_to_hwpunit(w, dpi).max(1);
            }
            let line_fs = line_breaks.get(i).map(|lb| lb.max_font_size).unwrap_or(0.0);
            y += advance_px_of(line_fs);
        }
    }

    // vertical_pos 누적 계산 (각 줄의 문단 내 Y 오프셋)
    // 원본 첫 LineSeg의 vertical_pos를 보존하여 vpos 체계 연속성 유지
    // (layout.rs의 vpos 보정이 문단 간 vpos 연속성을 가정하므로)
    let vpos_start = orig.as_ref().map(|ls| ls.vertical_pos).unwrap_or(0);
    let mut vpos = vpos_start;
    for i in 0..new_line_segs.len() {
        new_line_segs[i].vertical_pos = vpos;
        vpos += new_line_segs[i].line_height + new_line_segs[i].line_spacing;
    }

    para.line_segs = new_line_segs;
}

/// 구역 내 문단들의 vertical_pos를 순차적으로 재계산한다.
///
/// `start_para`부터 구역 끝까지 각 문단의 vpos를 이전 문단의 vpos_end 기준으로 재계산.
/// 표 등 특수 문단의 line_height는 보존하고 vpos만 갱신한다.
///
/// [Task #2299] 저장 vpos 리셋(단/쪽 경계 인코딩) 보존: 편집발 재계산이 구역 전체를
/// 선형 누적 좌표로 이어붙이면 다단 zone 의 단-상대 리셋(급감)이 소멸해
/// typeset(#321/#470/#702)·pagination 의 단/쪽 진행 신호가 무력화된다
/// (shortcut.hwp 앞문단 편집 시 col=[0,1]→[0], 7→9쪽). 현재 문단의 저장 first 가
/// 직전 문단의 "이동 전(저장)" end 보다 감소하면 경계 인코딩으로 보고 delta=0 으로
/// 보존한다. 저장 좌표는 밴드 내 정상 흐름에서 단조 증가하므로 감소 감지에 임계가
/// 필요 없다.
///
/// 좌표 갱신은 경계 성격별로 셋으로 나뉜다.
///
/// - **리셋 경계**: delta=0 보존.
/// - **변조 인접 경계**(현재 문단이 편집 대상 `start_para` 이거나 신규
///   문단(`ignore_reset_range`)이거나, 직전 문단이 그중 하나): 직전 이동 후 end 에
///   문단 여백 gap(spacing_after + spacing_before, 셀 recalc `boundary_gaps` 동일
///   산식)을 더해 다시 잇는다. reflow/신규 생성으로 저장 gap 이 소실된 경계라
///   스타일에서 재유도한다. gap 없는 abutment 는 문단 간격을 압축해 near-top
///   리셋(#1086/#1921)의 `prev_vpos_end > 60000` 임계를 무너뜨렸다
///   (SO-SUEOP.hwpx 46→44).
/// - **미변조 연속 경계**: 직전 문단의 delta 를 그대로 캐리해 저장(또는 로드 합성
///   #927) 문단 간격을 정확히 보존한다. 스타일 gap 재유도는 저장 gap 과의
///   오차(px 왕복 절삭 ±1HU, 스타일-저장 불일치)를 밴드 전체에 누적시키고 로드
///   합성 gap-less 체인과도 어긋나므로 쓰지 않는다. delta==0 이면 순수 no-op.
///
/// 리셋 감지는 저장 좌표끼리의 비교여야 한다. 직전 문단이 변조 대상이면 그 end 는
/// 저장 좌표가 아니므로(성장 편집이 다음 문단을 가짜 리셋으로 동결시키고,
/// placeholder 는 기준을 붕괴시킨다) reflow 가 보존하는 **first** 로 비교한다.
/// 미변조 경계는 end 기준을 유지한다(연속 0-first 밴드 감지에 필요).
///
/// placeholder 저지선 2종: ① split/insert/paste 가 방금 만든 신규 문단의 vpos=0 은
/// 경계 인코딩이 아니다 — 보존하면 문단마다 가짜 쪽나눔이 생긴다
/// (test_page_boundary_with_incremental_spacing_increase 핀). 호출자가 신규 구간을
/// `ignore_reset_range` 로 지정하면 보존 없이 흐름에 연결한다(셀 경로
/// `recalculate_cell_paragraph_vpos` 의 ignore_reset_at 과 동일 취지, 다중 삽입을
/// 위해 범위형). ② lineseg 부재였다가 on-demand reflow(#177/#927)로 합성된
/// seg(TAG_IMPLEMENTATION_PROPERTY, #1811)도 보존하지 않는다.
///
/// 줄 전진량은 로드 경로(document.rs 의 vpos 체인)와 동일하게 TAC 호스트
/// 줄(lh>th)을 th 기준으로 센다 — lh 기준이면 인라인 개체 호스트의 end 가 저장
/// 후속 first 를 넘어서 가짜 리셋을 만든다.
pub(crate) fn recalculate_section_vpos(
    paragraphs: &mut [Paragraph],
    start_para: usize,
    ignore_reset_range: Option<std::ops::Range<usize>>,
    start_stored_end: Option<i32>,
    styles: &ResolvedStyleSet,
    dpi: f64,
    is_hwp3_variant: bool,
) {
    if paragraphs.is_empty() || start_para >= paragraphs.len() {
        return;
    }

    // 문단 경계 gap (HWPUNIT) = 앞 문단 spacing_after + 뒤 문단 spacing_before.
    // recalculate_cell_paragraph_vpos 의 boundary_gaps 와 동일 산식.
    let boundary_gap = |prev: &Paragraph, curr: &Paragraph| -> i32 {
        let spacing_after = styles
            .para_styles
            .get(prev.para_shape_id as usize)
            .map(|style| style.spacing_after)
            .unwrap_or(0.0);
        let spacing_before = styles
            .para_styles
            .get(curr.para_shape_id as usize)
            .map(|style| style.spacing_before)
            .unwrap_or(0.0);
        let spacing_before =
            crate::renderer::hwp3_variant_flow_spacing_before(spacing_before, is_hwp3_variant);
        px_to_hwpunit(spacing_after + spacing_before, dpi)
    };

    // 줄 전진량 — 로드 경로와 동일한 TAC th-관례. saturating: 조작 파일의 극단
    // spacing/좌표로 i32 가 넘치지 않게 한다 (release wasm 은 overflow-check 가
    // 없어 무음 랩 → 전 문단 오판으로 이어진다).
    let seg_advance = |ls: &LineSeg| -> i32 {
        let height = if ls.line_height > ls.text_height && ls.text_height > 0 {
            ls.text_height
        } else {
            ls.line_height
        };
        height.saturating_add(ls.line_spacing)
    };
    let seg_end = |p: &Paragraph| -> Option<i32> {
        p.line_segs
            .last()
            .map(|ls| ls.vertical_pos.saturating_add(seg_advance(ls)))
    };
    let is_ignored = |pi: usize| {
        ignore_reset_range
            .as_ref()
            .is_some_and(|range| range.contains(&pi))
    };

    // 직전 문단(마지막 비어있지 않은 lineseg 보유 문단) 인덱스.
    // start_para 이전 문단들은 이 호출에서 이동하지 않으므로 현재 좌표가 곧 저장 좌표다.
    let mut prev_idx: Option<usize> = paragraphs[..start_para]
        .iter()
        .rposition(|p| !p.line_segs.is_empty());
    let mut next_vpos = match prev_idx {
        Some(pp) => seg_end(&paragraphs[pp]).unwrap_or(0),
        // 첫 문단: 기존 vpos 유지
        None => paragraphs[start_para]
            .line_segs
            .first()
            .map(|ls| ls.vertical_pos)
            .unwrap_or(0),
    };
    // 리셋 감지 기준 — 직전 문단의 "이동 전(저장)" first/end.
    let mut orig_prev_first: Option<i32> = prev_idx
        .and_then(|pp| paragraphs[pp].line_segs.first())
        .map(|ls| ls.vertical_pos);
    let mut orig_prev_end: Option<i32> = prev_idx.and_then(|pp| seg_end(&paragraphs[pp]));
    // 직전 문단이 이번 편집의 변조 대상이었는가 + 직전 문단에 적용된 delta.
    let mut prev_modified = false;
    let mut prev_delta: i32 = 0;

    for pi in start_para..paragraphs.len() {
        if paragraphs[pi].line_segs.is_empty() {
            continue;
        }

        let para_modified = pi == start_para || is_ignored(pi);
        let current_start = paragraphs[pi].line_segs[0].vertical_pos;
        let is_original_lineseg =
            paragraphs[pi].line_segs[0].tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0;

        // 리셋 감지: 신규 문단(placeholder)·합성 seg 는 제외. 기준은 직전 문단의
        // "저장" 좌표여야 한다 — 직전이 편집 문단(start_para)이면 reflow 로 end 가
        // 이미 변조됐으므로 호출자가 캡처해 준 reflow 이전 저장 end 를 쓰고(성장
        // 편집의 가짜 리셋과 저장-겹침 문서의 정당한 리셋을 모두 정확히 판별),
        // 없으면 reflow 가 보존하는 first 로 보수적으로 비교한다. 신규 문단이
        // 직전이면 placeholder 라 first(=0) 기준. 미변조 경계는 end 기준을
        // 유지한다(연속 0-first 밴드 감지에 필요).
        let prev_stored_bound = if prev_idx == Some(start_para) && !is_ignored(start_para) {
            start_stored_end.or(orig_prev_first)
        } else if prev_modified {
            orig_prev_first
        } else {
            orig_prev_end
        };
        let is_reset = is_original_lineseg
            && !is_ignored(pi)
            && prev_stored_bound.is_some_and(|bound| current_start < bound);

        let delta = if is_reset {
            // 단/쪽 리셋 경계 — 저장 좌표 유지.
            0
        } else if para_modified || prev_modified {
            // 변조 인접 경계 — 이동 후 흐름에 스타일 여백 gap 으로 다시 잇는다.
            let gap = prev_idx
                .map(|pp| boundary_gap(&paragraphs[pp], &paragraphs[pi]))
                .unwrap_or(0);
            next_vpos.saturating_add(gap) - current_start
        } else {
            // 미변조 연속 경계 — 직전 delta 캐리로 기존 간격을 정확히 보존.
            prev_delta
        };

        // 다음 문단의 리셋 감지 기준은 "이동 전(저장)" first/end 로 기록한다.
        let orig_first = current_start;
        let orig_end = seg_end(&paragraphs[pi]);

        if delta != 0 {
            // 모든 LineSeg의 vpos를 delta만큼 이동
            for seg in &mut paragraphs[pi].line_segs {
                seg.vertical_pos = seg.vertical_pos.saturating_add(delta);
            }
        }

        // 다음 문단의 시작 vpos 계산 (이동 후 end = 저장 end + delta)
        if let Some(end) = orig_end {
            next_vpos = end.saturating_add(delta);
        }
        orig_prev_first = Some(orig_first);
        orig_prev_end = orig_end;
        prev_modified = para_modified;
        prev_delta = delta;
        prev_idx = Some(pi);
    }
}

/// [Task #2299] 문단의 흐름 end (마지막 LineSeg 의 vpos + 전진량, TAC th-관례).
/// 편집 호출자가 reflow 이전에 캡처해 `recalculate_section_vpos` 의
/// `start_stored_end` 로 전달하기 위한 헬퍼 — reflow 가 end 를 덮은 뒤에는 저장
/// 좌표를 복원할 수 없다.
pub(crate) fn paragraph_flow_end(para: &Paragraph) -> Option<i32> {
    para.line_segs.last().map(|ls| {
        let height = if ls.line_height > ls.text_height && ls.text_height > 0 {
            ls.text_height
        } else {
            ls.line_height
        };
        ls.vertical_pos
            .saturating_add(height.saturating_add(ls.line_spacing))
    })
}

/// font_size(px)를 LineSeg의 line_height(HWPUNIT)로 변환한다.
/// HWP의 LineSeg.line_height = 폰트 크기 (HWPUNIT).
/// 실증 데이터: 10pt → lh=1000, 12pt → lh=1200, 25pt → lh=2500
fn font_size_to_line_height(font_size_px: f64, dpi: f64) -> i32 {
    px_to_hwpunit(font_size_px, dpi)
}

/// ParaPr의 줄간격 설정으로부터 LineSeg.line_spacing(HWPUNIT)을 계산한다.
///
/// line_spacing = 현재 줄 하단 → 다음 줄 상단 사이의 추가 간격.
/// Y advance = line_height + line_spacing.
fn compute_line_spacing_hwp(
    ls_type: LineSpacingType,
    ls_value: f64,
    line_height_hwp: i32,
    dpi: f64,
) -> i32 {
    match ls_type {
        LineSpacingType::Percent => {
            // ls_value = 비율값 (예: 160 = 160%)
            // 전체 줄 피치 = line_height * percent / 100
            // line_spacing = 전체 줄 피치 - line_height
            // [#2279] sub-100% 퍼센트는 음수 gap(압축)으로 존중 — 한글은
            // line=60% 를 advance 13.6px(=lh×0.6)로 렌더한다 (36398700 pi20
            // 한글 재저장 anchor 1020HU 실측). 종전 .max(0) 클램프는 fresh
            // 합성을 lh 그대로(+9px/문단) 팽창시켰다.
            // ls_value<=0 은 결손 데이터(속성 미지정 파싱 0) — 음수 적용 금지.
            if ls_value > 0.0 {
                (line_height_hwp as f64 * (ls_value - 100.0) / 100.0) as i32
            } else {
                0
            }
        }
        LineSpacingType::Fixed => {
            // ls_value = 고정 줄 피치 (px, resolver가 HWPUNIT→px 변환 완료)
            // line_spacing = 고정값 - line_height
            let fixed_hwp = px_to_hwpunit(ls_value, dpi);
            (fixed_hwp - line_height_hwp).max(0)
        }
        LineSpacingType::SpaceOnly => {
            // ls_value = 줄 사이 추가 간격만 (px)
            px_to_hwpunit(ls_value, dpi)
        }
        LineSpacingType::Minimum => {
            // 최소값: 콘텐츠가 최소값보다 크면 추가 간격 없음
            let min_hwp = px_to_hwpunit(ls_value, dpi);
            (min_hwp - line_height_hwp).max(0)
        }
    }
}
