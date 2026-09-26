//! 수식 레이아웃 엔진
//!
//! AST(EqNode)를 레이아웃 박스(LayoutBox)로 변환하여
//! 각 요소의 크기와 위치를 계산한다.

use super::ast::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen::prelude::wasm_bindgen(catch, js_namespace = globalThis, js_name = measureEquationTextMetrics)]
    fn measure_equation_text(
        source: &str,
        text: &str,
        size: f64,
        italic: bool,
        hft: bool,
        literal: bool,
        bold: bool,
    ) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue>;
}

/// 수식 레이아웃 박스
#[derive(Debug, Clone, serde::Serialize)]
pub struct LayoutBox {
    /// X 위치 (부모 기준 상대 좌표)
    pub x: f64,
    /// Y 위치 (부모 기준 상대 좌표)
    pub y: f64,
    /// 폭
    pub width: f64,
    /// 높이
    pub height: f64,
    /// 기준선 (상단으로부터의 거리, 텍스트 정렬의 기준)
    pub baseline: f64,
    /// 렌더링 요소
    pub kind: LayoutKind,
}

/// 레이아웃 요소 종류
#[derive(Debug, Clone, serde::Serialize)]
pub enum LayoutKind {
    /// 수평 나열
    Row(Vec<LayoutBox>),
    /// 일반 텍스트 (이탤릭)
    Text(String),
    /// 숫자
    Number(String),
    /// 기호
    Symbol(String),
    /// 수학 기호 (Unicode)
    MathSymbol(String),
    /// 함수 이름 (로만체)
    Function(String),
    /// 분수
    Fraction {
        numer: Box<LayoutBox>,
        denom: Box<LayoutBox>,
        /// 분수 개체의 왼쪽/오른쪽 경계에서 선까지의 거리.
        bar_inset: f64,
    },
    /// 위아래 배치 (분수선 없음)
    Atop {
        top: Box<LayoutBox>,
        bottom: Box<LayoutBox>,
    },
    /// 제곱근
    Sqrt {
        index: Option<Box<LayoutBox>>,
        body: Box<LayoutBox>,
    },
    /// 위첨자
    Superscript {
        base: Box<LayoutBox>,
        sup: Box<LayoutBox>,
    },
    /// 아래첨자
    Subscript {
        base: Box<LayoutBox>,
        sub: Box<LayoutBox>,
    },
    /// 위·아래첨자
    SubSup {
        base: Box<LayoutBox>,
        sub: Box<LayoutBox>,
        sup: Box<LayoutBox>,
    },
    /// 큰 연산자
    BigOp {
        symbol: String,
        sub: Option<Box<LayoutBox>>,
        sup: Option<Box<LayoutBox>>,
    },
    /// 극한
    Limit {
        is_upper: bool,
        sub: Option<Box<LayoutBox>>,
    },
    /// 행렬
    Matrix {
        cells: Vec<Vec<LayoutBox>>,
        style: MatrixStyle,
    },
    /// 관계식 (REL/BUILDREL) — 화살표 위/아래 내용
    Rel {
        arrow: Box<LayoutBox>,
        over: Box<LayoutBox>,
        under: Option<Box<LayoutBox>>,
    },
    /// 칸 맞춤 정렬 (EQALIGN)
    EqAlign {
        rows: Vec<(LayoutBox, LayoutBox)>, // (왼쪽, 오른쪽) 쌍
    },
    /// 괄호
    Paren {
        left: String,
        right: String,
        body: Box<LayoutBox>,
    },
    /// 장식
    Decoration {
        kind: super::symbols::DecoKind,
        body: Box<LayoutBox>,
    },
    /// 글꼴 스타일
    FontStyle {
        style: super::symbols::FontStyleKind,
        body: Box<LayoutBox>,
    },
    /// 공백
    Space(f64),
    /// 줄바꿈 (세로 쌓기용 마커)
    Newline,
    /// 빈 박스
    Empty,
}

/// 수식 레이아웃 계산기
#[derive(Clone)]
pub struct EqLayout {
    /// 기본 글꼴 크기 (px)
    pub font_size: f64,
    font_family: Option<String>,
    hft: bool,
    italic: bool,
    bold: bool,
    /// 원자 사이 수식 간격(thin/medium/thick)의 배율. 저장 개체 폭에 맞출 때만 줄인다.
    operator_padding_scale: f64,
}

/// 비율 상수
pub(crate) const SCRIPT_SCALE: f64 = 0.7; // 첨자 크기 비율
const FRAC_LINE_PAD: f64 = 0.2; // 분수선 상하 여백 (font_size 비율)
const FRAC_LINE_THICK: f64 = 0.04; // 분수선 두께 (font_size 비율)
const SQRT_PAD: f64 = 0.1; // 제곱근 내부 상단 여백
const PAREN_PAD: f64 = 0.08; // 괄호 내부 좌우 여백
pub(crate) const BIG_OP_SCALE: f64 = 1.5; // 큰 연산자(∑/∏) 크기 비율
/// 적분(∫/∮ 등) 전용 크기 비율 — Task #1313.
/// 적분 글리프는 ∑/∏ 보다 세로로 길게 그려져야 정답(한글 2022)과 정합한다. BIG_OP_SCALE
/// (1.5) 로는 글리프가 작아 상·하한이 기호와 벌어져 보이므로 적분만 별도 스케일을 쓴다.
pub(crate) const INTEGRAL_SCALE: f64 = 2.5;

/// 적분 글리프 path 기하 — Task #1317.
///
/// 적분기호(∫)를 폰트 `<text>` 가 아닌 stroke path 로 그릴 때의 글리프 형상과,
/// layout 의 상·하한 attach point 가 **공유하는 단일 기준(SSOT)**. SVG/Canvas/Skia 가
/// 동일한 path·attach point 를 써서 폰트 대체에 무관하게 정합한다.
///
/// 모든 좌표는 글리프 박스(좌상단 원점, 높이 = `fs*INTEGRAL_SCALE`) 기준 상대 px 이며,
/// y 는 아래로 증가한다. 비율은 정답(한글 2022) `pdf/3-10월_교육_통합_2022.pdf` 9p 적분
/// (`∫_0^2(-2x^2+6x)dx`) 시각 정합 기준.
#[derive(Clone, Copy, Debug)]
pub(crate) struct IntegralGeom {
    /// 글리프 가로 폭(상·하 갈고리 포함, trailing pad 제외)
    pub width: f64,
    /// 줄기 stroke 두께
    pub stroke_w: f64,
    /// path 상단(상단 갈고리 끝) y
    pub top_y: f64,
    /// path 하단(하단 갈고리 끝) y
    pub bottom_y: f64,
    /// 상단 갈고리 우측 끝 x — 상한(sup) attach 기준
    pub top_hook_x: f64,
    /// 하단 갈고리 좌측 끝 x — 하한(sub) attach 기준
    pub bottom_hook_x: f64,
}

/// 글꼴 크기 `fs` 에 대한 적분 글리프 기하를 산출한다(SSOT).
pub(crate) fn integral_geom(fs: f64) -> IntegralGeom {
    let h = fs * INTEGRAL_SCALE;
    IntegralGeom {
        width: fs * 0.52,
        stroke_w: fs * 0.06,
        top_y: h * 0.04,
        bottom_y: h * 0.96,
        top_hook_x: fs * 0.50,
        bottom_hook_x: fs * 0.04,
    }
}

/// 큰 연산자(Σ/∏/∫) 뒤 피연산자와의 trailing 간격 (font_size 비율) — Task #1233.
/// layout_row 는 형제를 간격 0으로 붙이므로, 큰 연산자 box width 에 이 trailing 공백을
/// 더해 피연산자가 연산자에 붙지 않게 한다(TeX thin/med space 관례, 한컴 PDF 정합).
///
/// 인라인 수식은 svg.rs 에서 컨트롤 advance(tac_w)로 가로 스케일(scale_x = tac_w/자연폭)
/// 되므로, 자연폭에 더한 pad 는 scale_x 만큼 줄어 렌더된다. 분수·괄호를 포함한 큰 수식은
/// scale_x 가 작아(0.6~0.9) pad 가 약화되므로, 압축 후에도 충분한 간격이 남도록 0.45 로
/// 둔다(작업지시자 시각 판정 — 0.25 는 부족, 0.45 가 적정).
///
/// 렌더러(svg_render/canvas_render)는 limits 연산자를 `max_w = lb.width - fs*PAD` 에
/// 중앙정렬하므로(이 const 참조), pad 전체가 **순수 trailing** 이 되고 연산자는 첨자와 정렬된다.
pub(crate) const BIG_OP_TRAIL_PAD: f64 = 0.45;
const MATRIX_COL_GAP: f64 = 0.8; // 행렬 열 간격 (font_size 비율)
const MATRIX_ROW_GAP: f64 = 0.3; // 행렬 행 간격 (font_size 비율)
/// 수식 축 높이 (TeX axis_height = 0.25em) — 분수선이 배치되는 기준 위치
pub(crate) const AXIS_HEIGHT: f64 = 0.25;
/// 텍스트 기본 baseline 비율 (상단에서 baseline까지)
const TEXT_BASELINE: f64 = 0.8;

/// 분수선은 분자의 em box와 padding 뒤에 둔다. 버전별 baseline/axis와 분리한다.
pub(crate) fn fraction_line_y(numerator: &LayoutBox, font_size: f64) -> f64 {
    numerator.height + font_size * (FRAC_LINE_PAD + FRAC_LINE_THICK / 2.0)
}

impl EqLayout {
    pub fn new(font_size: f64) -> Self {
        Self {
            font_size,
            font_family: None,
            hft: false,
            italic: true,
            bold: false,
            operator_padding_scale: 1.0,
        }
    }

    pub fn with_font(font_size: f64, font_family: &str) -> Self {
        Self {
            font_size,
            font_family: (!font_family.trim().is_empty()).then(|| font_family.to_string()),
            hft: false,
            italic: true,
            bold: false,
            operator_padding_scale: 1.0,
        }
    }

    pub fn with_version(mut self, version: &str) -> Self {
        self.hft = version.is_empty()
            && self
                .font_family
                .as_deref()
                .is_some_and(super::font::is_legacy_equation_font);
        self
    }

    /// 인접 원자 사이 간격 (em). 한컴 수식의 legacy 서체(HYhwpEQ 등)는 글립을
    /// advance가 아니라 잉크 가장자리끼리 포개고, 원자 종류별 고정 간격을 둔다
    /// (eq-002 PDF 잉크 간격 실측: `=`→`−` 0.00em, `=`→숫자 0.20em,
    /// `×`→`3` 0.21em, `)`→`=` 0.27em, `f`→`(` 0.05em 등).
    /// 그 외는 TeX 표.
    fn atom_space_em(
        &self,
        prev_node: &EqNode,
        prev: Atom,
        next_node: &EqNode,
        next: Atom,
        script: bool,
    ) -> f64 {
        if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            // 복합 원자(√·큰 괄호·분수·대형 연산자) 앞 thin space
            // (eq-002 실측: `−`→√`³` 1.4pt@9pt, `)`→`×` 1.5pt).
            let mut node = next_node;
            loop {
                match node {
                    EqNode::FontStyle { body, .. } | EqNode::Color { body, .. } => node = body,
                    EqNode::Sqrt { .. }
                    | EqNode::Paren { .. }
                    | EqNode::Fraction { .. }
                    | EqNode::Atop { .. }
                    | EqNode::BigOp { .. }
                    | EqNode::Matrix { .. }
                    | EqNode::Limit { .. }
                    | EqNode::Cases { .. }
                    | EqNode::Pile { .. }
                    | EqNode::EqAlign { .. }
                    | EqNode::Decoration { .. }
                    | EqNode::Rel { .. } => return THIN_SPACE_EM,
                    _ => break,
                }
            }
            // resolve_atoms로 Ord로 강등된 단항 부호(단항 − 등): 앞 원자에는
            // 붙고(0) 뒤 피연산자에는 0.15em 간격을 둔다
            // (eq-002 실측 `=`→`−` 0pt, `−`→`3` 1.35pt@9pt).
            let is_unary_sign = |node: &EqNode, atom: Atom| {
                atom.left == MathClass::Ord
                    && matches!(node, EqNode::Symbol(s) | EqNode::MathSymbol(s)
                        if symbol_class(s) == MathClass::Bin)
            };
            if is_unary_sign(next_node, next) {
                return 0.0;
            }
            if is_unary_sign(prev_node, prev) {
                return 0.15;
            }
            // 이항·관계 기호 앞 간격 — 앞 원자 종류에 따라 다르다
            // (실측 `=`→`−` 0pt, `)`→`=` 2.45pt, sup→`×` 0.3pt@9pt).
            if matches!(next.left, MathClass::Bin | MathClass::Rel) {
                // Ord 복합 원자(첨자 상자 등) 뒤의 이항/관계는 좀 더 넓다
                // (실측 sup→`×` 2.03pt, sup→`=` 1.23pt@9.06).
                let composite_ord = prev.right == MathClass::Ord
                    && !matches!(
                        prev_node,
                        EqNode::Symbol(_)
                            | EqNode::MathSymbol(_)
                            | EqNode::Number(_)
                            | EqNode::Text(_)
                            | EqNode::Quoted(_)
                            | EqNode::Function(_)
                    );
                if composite_ord {
                    return if next.left == MathClass::Bin {
                        0.22
                    } else {
                        0.14
                    };
                }
                return match prev.right {
                    MathClass::Rel => 0.0,
                    MathClass::Open => 0.08,
                    MathClass::Close => {
                        if next.left == MathClass::Rel {
                            0.27
                        } else {
                            THIN_SPACE_EM
                        }
                    }
                    MathClass::Ord => 0.03,
                    _ => THIN_SPACE_EM,
                };
            }
            // 여는 기호 앞 소간격 (실측 `f`→`(` 0.48pt@9pt).
            if next.left == MathClass::Open {
                return 0.05;
            }
            // 닫는 기호 앞 소간격 (실측 `n`→`)` 0.56pt@9pt).
            if next.left == MathClass::Close {
                return 0.06;
            }
            // 보통 원자 앞: 앞 원자 종류별 간격
            // (실측 `=`→`3` 1.77pt, `×`→`3` 1.91pt, `(`→`n` 0.56pt, `⋯`→`⋯` 0.71pt@9pt).
            return match prev.right {
                MathClass::Rel => 0.20,
                MathClass::Bin => 0.21,
                MathClass::Open => 0.06,
                MathClass::Inner => 0.07,
                MathClass::Ord => 0.08,
                // 도형 접두 기호(△x 등)는 뒤 피연산자와 thin space로 떨어진다.
                MathClass::Op => THIN_SPACE_EM,
                _ => 0.0,
            };
        }
        math_space_em(prev, next, script)
    }

    /// legacy 글립 원자의 실측치 — painter가 칠할 문자→PUA 매핑·이탤릭·볼드를
    /// 그대로 따라간다. 비글립 원자(복합·공백·줄바꿈)나 측정 불가 시 None.
    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    fn node_run_metrics(&self, node: &EqNode, fs: f64) -> Option<super::measure::LegacyRunMetrics> {
        let (text, italic, bold) = match node {
            EqNode::Text(s) => (s.as_str(), self.is_italic_text(s), self.bold),
            EqNode::Number(s) | EqNode::Quoted(s) => (s.as_str(), false, self.bold),
            EqNode::Symbol(s) => (s.as_str(), false, false),
            EqNode::MathSymbol(s) => {
                if matches!(symbol_class(s), MathClass::Rel | MathClass::Bin)
                    || is_integral_symbol(s)
                {
                    (s.as_str(), false, false)
                } else {
                    (
                        s.as_str(),
                        self.italic && super::font::is_greek_variable(s),
                        false,
                    )
                }
            }
            EqNode::Function(s) => (s.as_str(), false, false),
            EqNode::FontStyle { style, body } => {
                return self.styled(*style).node_run_metrics(body, fs);
            }
            EqNode::Color { body, .. } => return self.node_run_metrics(body, fs),
            _ => return None,
        };
        super::measure::measure_legacy_run_native(text, fs, italic, bold)
    }

    /// 브라우저에서도 네이티브와 같은 원본 glyf/hmtx 잉크 경계를 사용한다.
    #[cfg(target_arch = "wasm32")]
    fn node_run_metrics_wasm(&self, node: &EqNode, fs: f64) -> Option<(f64, f64)> {
        let (text, italic, bold) = match node {
            EqNode::Text(s) => (s.as_str(), self.is_italic_text(s), self.bold),
            EqNode::Number(s) | EqNode::Quoted(s) => (s.as_str(), false, self.bold),
            EqNode::Symbol(s) => (s.as_str(), false, false),
            EqNode::MathSymbol(s) => {
                if matches!(symbol_class(s), MathClass::Rel | MathClass::Bin)
                    || is_integral_symbol(s)
                {
                    (s.as_str(), false, false)
                } else {
                    (
                        s.as_str(),
                        self.italic && super::font::is_greek_variable(s),
                        false,
                    )
                }
            }
            EqNode::Function(s) => (s.as_str(), false, false),
            EqNode::FontStyle { style, body } => {
                return self.styled(*style).node_run_metrics_wasm(body, fs);
            }
            EqNode::Color { body, .. } => return self.node_run_metrics_wasm(body, fs),
            _ => return None,
        };
        let family = self.font_family.as_deref()?;
        let value = measure_equation_text(family, text, fs, italic, self.hft, true, bold).ok()?;
        let advance = super::measure::RunMetrics::from_js(value.clone())?.advance;
        let ink_left = js_sys::Reflect::get(&value, &wasm_bindgen::JsValue::from_str("inkLeft"))
            .ok()?
            .as_f64()?;
        (ink_left.is_finite() && advance.is_finite()).then_some((advance, ink_left))
    }

    /// 글립 원자의 좌측 베어링(lsb, px). 한컴 legacy 수식은 글립을 advance가 아니라
    /// 앞 글립의 잉크 끝에 붙여 식자한다 — layout_row가 다음 원자 원점을
    /// `앞 잉크 끝 − 이 원자 lsb`로 놓는다 (eq-002 실측). 비글립 원자·측정 불가 시 0.
    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    fn node_ink_left(&self, node: &EqNode, fs: f64) -> f64 {
        self.node_run_metrics(node, fs)
            .map(|m| m.ink_left)
            .unwrap_or(0.0)
    }

    #[cfg(target_arch = "wasm32")]
    fn node_ink_left(&self, node: &EqNode, fs: f64) -> f64 {
        self.node_run_metrics_wasm(node, fs)
            .map(|(_, left)| left)
            .unwrap_or(0.0)
    }

    #[cfg(all(not(target_arch = "wasm32"), not(feature = "native-skia")))]
    fn node_ink_left(&self, _node: &EqNode, _fs: f64) -> f64 {
        0.0
    }

    /// 글립 run의 advance 오른쪽 끝(px, run 원점 기준) — 잉크 오른쪽 끝에 마지막
    /// 글립의 우측 베어링을 더한 값이다. 비글립 원자·측정 불가 시 None.
    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    fn node_advance_right(&self, node: &EqNode, fs: f64) -> Option<f64> {
        self.node_run_metrics(node, fs).map(|m| m.advance)
    }

    #[cfg(target_arch = "wasm32")]
    fn node_advance_right(&self, node: &EqNode, fs: f64) -> Option<f64> {
        self.node_run_metrics_wasm(node, fs)
            .map(|(advance, _)| advance)
    }

    #[cfg(all(not(target_arch = "wasm32"), not(feature = "native-skia")))]
    fn node_advance_right(&self, _node: &EqNode, _fs: f64) -> Option<f64> {
        None
    }

    fn text_width(&self, text: &str, font_size: f64, italic: bool, literal: bool) -> f64 {
        self.text_metrics(text, font_size, italic, self.bold, literal)
            .0
    }

    /// (advance, 이탤릭 보정) — painter가 실제로 칠하는 서체 기준.
    ///
    /// 세션에 로드된 원본 수식 서체(HYhwpEQ PUA/HFT bank), painter의 CSS fallback
    /// 체인을 같은 font 문자열로 canvas 측정, 같은 체인의 내장 메트릭, 추정 순이다.
    /// 추정 폭으로 배치하고 fallback 서체로 칠하면 △처럼 넓은 글립이 옆 원자를 덮는다.
    fn text_metrics(
        &self,
        text: &str,
        font_size: f64,
        italic: bool,
        bold: bool,
        literal: bool,
    ) -> (f64, f64) {
        #[cfg(target_arch = "wasm32")]
        if let Some(metrics) = self
            .font_family
            .as_deref()
            .and_then(|family| {
                measure_equation_text(family, text, font_size, italic, self.hft, literal, bold).ok()
            })
            .and_then(super::measure::RunMetrics::from_js)
        {
            let legacy = self
                .font_family
                .as_deref()
                .is_some_and(super::font::is_legacy_equation_font);
            return (
                if legacy {
                    metrics.ink_right
                } else {
                    metrics.advance
                },
                if italic && !legacy {
                    metrics.overhang()
                } else {
                    0.0
                },
            );
        }
        let family = super::font::equation_css_font_family(self.font_family.as_deref());
        if let Some(metrics) =
            self.measure_painted_run(&family, text, font_size, italic, bold, literal)
        {
            let overhang = if italic { metrics.overhang() } else { 0.0 };
            return (metrics.advance, overhang);
        }
        // 네이티브: painter가 실제 legacy 서체로 칠할 수 있으면 같은 서체로 실측한다.
        #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
        if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            if let Some(metrics) =
                super::measure::measure_legacy_run_native(text, font_size, italic, bold)
            {
                // 박스 폭 = 마지막 글립의 잉크 오른쪽 끝 — 행 커서가 잉크 가장자리를
                // 쫓아가도록 advance가 아닌 잉크 경계를 돌려준다.
                return (metrics.ink_right, 0.0);
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        let _ = literal;
        let measure = |family: &str, text: &str| {
            crate::renderer::layout::measure_known_font_run_width(
                family, bold, italic, text, font_size,
            )
        };
        // 요청 서체의 내장 메트릭이 있으면 그 폭을 쓴다(잉크 정보 없음).
        if let Some(width) = self
            .font_family
            .as_deref()
            .and_then(|name| measure(name, text))
        {
            return (width, 0.0);
        }
        // 그 외에는 painter fallback 체인(Times 계열)의 메트릭과 이탤릭 보정표를 쓴다.
        let chain = super::font::equation_font_families(self.font_family.as_deref()).join(", ");
        let width = measure(&chain, text).unwrap_or_else(|| {
            text.chars()
                .map(|ch| {
                    let glyph = ch.to_string();
                    measure(&chain, &glyph)
                        .unwrap_or_else(|| estimate_text_width(&glyph, font_size, italic))
                })
                .sum()
        });
        let overhang = match text.chars().last() {
            Some(last) if italic => super::measure::italic_overhang_em(last) * font_size,
            _ => 0.0,
        };
        (width, overhang)
    }

    /// canvas painter의 fallback 경로와 같은 글꼴·run 단위로 측정한다.
    fn measure_painted_run(
        &self,
        family: &str,
        text: &str,
        font_size: f64,
        italic: bool,
        bold: bool,
        literal: bool,
    ) -> Option<super::measure::RunMetrics> {
        use super::measure::{css_font, measure_css_run, RunMetrics};
        if !(self.hft && literal && !text.is_ascii()) {
            return measure_css_run(&css_font(font_size, italic, bold, family), text);
        }
        // HFT literal은 글자마다 칠한다. 비ASCII 글자는 직립이다(canvas_render::draw_legacy_literal).
        let mut advance = 0.0;
        let mut ink_right = 0.0;
        for ch in text.chars() {
            let glyph_italic = italic && ch.is_ascii();
            let run = measure_css_run(
                &css_font(font_size, glyph_italic, bold, family),
                &ch.to_string(),
            )?;
            ink_right = advance + run.ink_right;
            advance += run.advance;
        }
        Some(RunMetrics { advance, ink_right })
    }

    /// AST를 레이아웃 박스로 변환
    pub fn layout(&self, node: &EqNode) -> LayoutBox {
        self.layout_node(node, self.font_size)
    }

    /// 원본 개체의 여유 폭 안에 자연 크기의 수식을 왼쪽에 둔다. 글립은 늘이지 않는다.
    pub fn layout_in_control_width(&self, node: &EqNode, width: f64) -> LayoutBox {
        let mut result = self.layout(node);
        if !width.is_finite() || width <= 0.0 {
            return result;
        }
        if result.width > width {
            // 저장 폭은 font stretch가 아닌 개체 크기다. 추정 연산자 여백만 줄인다.
            // 최소 여백으로도 못 맞추는 폰트 대체/수동 크기 변경은 자연 배치를 유지한다.
            let mut compact = self.clone();
            compact.operator_padding_scale = 0.0;
            let minimum = compact.layout(node);
            if minimum.width <= width && minimum.width < result.width {
                let mut low = 0.0;
                let mut high = 1.0;
                let mut scale = (width - minimum.width) / (result.width - minimum.width);
                for _ in 0..16 {
                    compact.operator_padding_scale = scale;
                    result = compact.layout(node);
                    if (result.width - width).abs() < 0.0001 {
                        break;
                    }
                    if result.width > width {
                        high = scale;
                    } else {
                        low = scale;
                    }
                    scale = (low + high) / 2.0;
                }
            }
        }
        // 한컴은 저장 폭보다 짧은 수식을 상자 왼쪽(여백 뒤)에 두지 가운데 정렬하지
        // 않는다 (eq-002 실측: 선언 72.98pt 상자에 `=` 글립이 좌측 여백 바로 뒤).
        result
    }

    fn layout_node(&self, node: &EqNode, fs: f64) -> LayoutBox {
        match node {
            EqNode::Row(children) => self.layout_row(children, fs),
            EqNode::Text(s) => self.layout_text(s, fs),
            EqNode::Number(s) => self.layout_number(s, fs),
            EqNode::Symbol(s) => self.layout_symbol(s, fs),
            EqNode::MathSymbol(s) => self.layout_math_symbol(s, fs),
            EqNode::Function(s) => self.layout_function(s, fs),
            EqNode::Quoted(s) => self.layout_number(s, fs),
            EqNode::Fraction { numer, denom } => self.layout_fraction(numer, denom, fs),
            EqNode::Atop { top, bottom } => self.layout_atop(top, bottom, fs),
            EqNode::Sqrt { index, body } => self.layout_sqrt(index, body, fs),
            EqNode::Superscript { base, sup } => self.layout_superscript(base, sup, fs),
            EqNode::Subscript { base, sub } => self.layout_subscript(base, sub, fs),
            EqNode::SubSup { base, sub, sup } => self.layout_subsup(base, sub, sup, fs),
            EqNode::BigOp { symbol, sub, sup } => self.layout_big_op(symbol, sub, sup, fs),
            EqNode::Limit { is_upper, sub } => self.layout_limit(*is_upper, sub, fs),
            EqNode::Matrix { rows, style } => self.layout_matrix(rows, *style, fs),
            EqNode::Cases { rows } => self.layout_cases(rows, fs),
            EqNode::EqAlign { rows } => self.layout_eqalign(rows, fs),
            EqNode::Rel { arrow, over, under } => self.layout_rel(arrow, over, under, fs),
            EqNode::Pile { rows, align } => self.layout_pile(rows, *align, fs),
            EqNode::Paren { left, right, body } => self.layout_paren(left, right, body, fs),
            EqNode::Decoration { kind, body } => self.layout_decoration(*kind, body, fs),
            EqNode::FontStyle { style, body } => self.layout_font_style(*style, body, fs),
            EqNode::Color { body, .. } => self.layout_node(body, fs),
            EqNode::Space(kind) => self.layout_space(*kind, fs),
            EqNode::Newline => LayoutBox {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
                baseline: 0.0,
                kind: LayoutKind::Newline,
            },
            EqNode::Empty => LayoutBox {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
                baseline: 0.0,
                kind: LayoutKind::Empty,
            },
        }
    }

    fn layout_row(&self, children: &[EqNode], fs: f64) -> LayoutBox {
        let laid: Vec<(&EqNode, LayoutBox)> = children
            .iter()
            .map(|c| (c, self.layout_node(c, fs)))
            .filter(|(_, b)| b.width > 0.0 || matches!(b.kind, LayoutKind::Newline))
            .collect();

        if laid.is_empty() {
            return LayoutBox {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: fs,
                baseline: fs * 0.8,
                kind: LayoutKind::Row(Vec::new()),
            };
        }

        // 기준선 정렬: 가장 높은 baseline과 가장 깊은 descent
        let max_ascent = laid.iter().map(|(_, b)| b.baseline).fold(0.0f64, f64::max);
        let max_descent = laid
            .iter()
            .map(|(_, b)| b.height - b.baseline)
            .fold(0.0f64, f64::max);
        let total_height = max_ascent + max_descent;

        let atoms = resolve_atoms(laid.iter().map(|(node, _)| atom_of(node)).collect());
        let mut extent = 0.0f64;
        let script = fs < self.font_size * 0.95;
        let legacy = self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font);
        let mut previous: Option<(&EqNode, Atom)> = None;
        let mut x = 0.0;
        let mut boxes = Vec::with_capacity(laid.len());
        for ((node, mut b), atom) in laid.into_iter().zip(atoms) {
            match atom {
                AtomSlot::Atom(atom) => {
                    if let Some((prev_node, prev)) = previous {
                        x += self.atom_space_em(prev_node, prev, node, atom, script)
                            * fs
                            * self.operator_padding_scale;
                    }
                    previous = Some((node, atom));
                }
                AtomSlot::Break => previous = None,
                // 명시 공백(~, `)은 원자 간격에 더해지며 양옆 원자의 관계를 끊지 않는다.
                AtomSlot::Glue => {}
            }
            // legacy 서체는 글립을 advance가 아닌 잉크 가장자리로 포갠다:
            // 원점 = 커서(앞 글립 잉크 끝) − 이 글립 lsb. 첫 원자는 원점을
            // 상자 왼쪽에 둔다 (eq-002: `=` 원점이 좌측 여백 바로 뒤).
            let lsb = if legacy && !boxes.is_empty() {
                self.node_ink_left(node, fs)
            } else {
                0.0
            };
            b.x = x - lsb;
            b.y = max_ascent - b.baseline;
            x = b.x + b.width;
            // 행 폭 = 커서가 아니라 각 원자의 advance 오른쪽 끝 — 한컴이 개체의
            // paint 폭으로 쓰는 값은 마지막 글립의 우측 베어링까지 포함한다
            // (eq-002 실측: `f(n)` 개체 advance 18.0pt ≈ 마지막 글립 advance 끝).
            let end = if legacy {
                self.node_advance_right(node, fs)
                    .map(|adv| b.x + adv)
                    .unwrap_or_else(|| b.x + b.width)
            } else {
                b.x + b.width
            };
            extent = extent.max(end);
            boxes.push(b);
        }

        let width = if legacy { extent } else { x };
        LayoutBox {
            x: 0.0,
            y: 0.0,
            width,
            height: total_height,
            baseline: max_ascent,
            kind: LayoutKind::Row(boxes),
        }
    }

    fn is_italic_text(&self, text: &str) -> bool {
        self.italic && !text.chars().any(is_cjk_char)
    }

    fn layout_text(&self, text: &str, fs: f64) -> LayoutBox {
        // CJK/한글 텍스트는 이탤릭이 아니므로 italic 보정 제외.
        // 이탤릭 보정(잉크가 advance를 넘는 폭)은 TeX처럼 글자 폭에 포함한다.
        let (advance, overhang) =
            self.text_metrics(text, fs, self.is_italic_text(text), self.bold, true);
        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: advance + overhang,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::Text(text.to_string()),
        }
    }

    /// 첨자 기준 글자의 이탤릭 보정. 아래첨자는 이만큼 왼쪽(글자 advance)에 붙는다.
    fn trailing_italic_correction(&self, node: &EqNode, fs: f64) -> f64 {
        match node {
            EqNode::Text(text) if self.is_italic_text(text) => {
                self.text_metrics(text, fs, true, self.bold, true).1
            }
            EqNode::MathSymbol(text)
                if self.italic
                    && super::font::is_greek_variable(text)
                    && !is_integral_symbol(text)
                    && symbol_class(text) == MathClass::Ord =>
            {
                self.text_metrics(text, fs, true, false, false).1
            }
            EqNode::FontStyle { style, body } => {
                self.styled(*style).trailing_italic_correction(body, fs)
            }
            EqNode::Color { body, .. } => self.trailing_italic_correction(body, fs),
            EqNode::Row(children) => children
                .last()
                .map_or(0.0, |last| self.trailing_italic_correction(last, fs)),
            _ => 0.0,
        }
    }

    fn layout_number(&self, text: &str, fs: f64) -> LayoutBox {
        let w = self.text_metrics(text, fs, false, self.bold, false).0;
        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: w,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::Number(text.to_string()),
        }
    }

    /// 연산자·구두점 기호. 좌우 간격은 layout_row의 원자 간격이 정한다.
    fn layout_symbol(&self, text: &str, fs: f64) -> LayoutBox {
        let w = self.text_metrics(text, fs, false, false, false).0;
        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: w,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::Symbol(text.to_string()),
        }
    }

    fn layout_math_symbol(&self, text: &str, fs: f64) -> LayoutBox {
        // 적분 기호: 큰 크기로 렌더링 (INTEGRAL_SCALE 적용 — Task #1313)
        // Task #1317: 글리프를 path 로 그리므로 advance 는 path 폭(geom.width)을 쓴다.
        if is_integral_symbol(text) {
            let op_fs = fs * INTEGRAL_SCALE;
            let geom = integral_geom(fs);
            return LayoutBox {
                x: 0.0,
                y: 0.0,
                // Task #1233: 첨자 없는 bare 적분도 뒤 피연산자와 trailing 간격 유지.
                width: geom.width + fs * BIG_OP_TRAIL_PAD,
                height: op_fs,
                baseline: op_fs * 0.7, // 적분 기호 baseline: 기호 높이의 70%
                kind: LayoutKind::MathSymbol(text.to_string()),
            };
        }
        // 관계·이항 연산 기호는 Symbol 로 두어 가운데에 그린다.
        if matches!(symbol_class(text), MathClass::Rel | MathClass::Bin) {
            return self.layout_symbol(text, fs);
        }
        let italic = self.italic && super::font::is_greek_variable(text);
        let (advance, overhang) = self.text_metrics(text, fs, italic, false, false);
        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: advance + overhang,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::MathSymbol(text.to_string()),
        }
    }

    fn layout_function(&self, name: &str, fs: f64) -> LayoutBox {
        // 함수 이름은 Op 원자다. 뒤 피연산자와의 thin space는 layout_row가 넣는다.
        let w = self.text_metrics(name, fs, false, false, false).0;
        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: w,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::Function(name.to_string()),
        }
    }

    fn layout_fraction(&self, numer: &EqNode, denom: &EqNode, fs: f64) -> LayoutBox {
        let n = self.layout_node(numer, fs);
        let d = self.layout_node(denom, fs);

        let pad = fs * FRAC_LINE_PAD;
        let line_thick = fs * FRAC_LINE_THICK;
        let axis = fs * if self.hft { 0.375 } else { AXIS_HEIGHT };
        let child_width = n.width.max(d.width);
        let natural_width = child_width + pad * 2.0;
        // 현대 HY 분수는 최소 1em 개체/0.8em 선을 사용한다. 좁은 분수를
        // 글립 advance까지 줄이면 같은 분자도 분모에 따라 시작점이 달라진다.
        // 긴 분수는 기존 0.15em 선 여백을 유지한다 (eq-01의 12pt 분수).
        let modern_hy = !self.hft
            && self
                .font_family
                .as_deref()
                .is_some_and(super::font::is_legacy_equation_font);
        let (w, bar_inset) = if modern_hy {
            // 한컴 legacy 분수는 자식을 thin 여백에 좌측 정렬하고 폭은
            // thin + 자식 advance + thin 이다. 막대(e06d)는 상자 폭까지 늘어난다
            // (eq-002 실측: ¼ 막대 7.2pt = thin+0.5em 자식+thin @9.06).
            let child_advance = |node: &EqNode, lb: &LayoutBox| {
                self.node_advance_right(node, fs).unwrap_or(lb.width)
            };
            let width = (child_advance(numer, &n).max(child_advance(denom, &d))
                + fs * THIN_SPACE_EM * 2.0)
                .max(fs * 0.628);
            (width, 0.0)
        } else {
            (natural_width, fs * 0.05)
        };

        let numer_h = n.height + pad;
        let denom_h = d.height + pad;

        // TeX 방식: 분수선은 baseline에서 axis_height 위에 배치
        // baseline(상단에서) = 분자높이 + 분수선두께/2 + axis_height
        // 즉, 분수선 y = baseline - axis_height (상단 기준)
        let frac_line_from_top = numer_h + line_thick / 2.0;
        let baseline = frac_line_from_top + axis;
        let mut total_h = numer_h + line_thick + denom_h;

        let mut n_box = n;
        // 한컴 legacy 분수는 분자/분모를 thin 여백 위치에 좌측 정렬한다
        // (eq-002 실측: ¼의 1·4가 같은 x — 폭 다른 글립이 중앙 정렬이면 어긋난다).
        n_box.x = if modern_hy {
            fs * THIN_SPACE_EM
        } else {
            (w - n_box.width) / 2.0
        };
        n_box.y = pad;

        let mut d_box = d;
        d_box.x = if modern_hy {
            fs * THIN_SPACE_EM
        } else {
            (w - d_box.width) / 2.0
        };
        d_box.y = numer_h + line_thick;

        // HYhwpEQ는 분자/분모의 baseline을 수식 baseline 위/아래에 놓는다.
        // em box의 시작점에 같은 padding을 더하면 실제 간격이 1.04em으로 줄어든다.
        // 한컴 원본 PDF(eq-01-2022의 12/13pt, 11pt 광학 실험지)에서는 약 1.3em이다.
        if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            // 분자/분모 baseline은 상자 baseline에서 ±0.65em 대칭이다
            // (eq-002 실측: ¼의 1·4가 baseline 위아래 각각 5.9pt@9.06).
            // HFT serif cap은 약 0.70em이다. 분모 cap과 bar 사이의 기존
            // FRAC_LINE_PAD clearance를 유지하고 HFT axis(0.375em)를 뺀다.
            let numer_shift = if self.hft { 0.625 } else { 0.65 };
            n_box.y = (baseline - fs * numer_shift - n_box.baseline).max(0.0);
            let denom_shift = if self.hft {
                0.70 + FRAC_LINE_PAD - 0.375
            } else {
                0.65
            };
            let clear_top = if self.hft {
                let cap_ascent = if matches!(
                    d_box.kind,
                    LayoutKind::Text(_) | LayoutKind::Number(_) | LayoutKind::MathSymbol(_)
                ) {
                    fs * 0.70
                } else {
                    d_box.baseline
                };
                frac_line_from_top + fs * FRAC_LINE_PAD - (d_box.baseline - cap_ascent)
            } else {
                // 분수선 아래만 넘지 않으면 된다 — baseline 대칭이 우선이다.
                frac_line_from_top + line_thick
            };
            d_box.y = (baseline + fs * denom_shift - d_box.baseline).max(clear_top);
            total_h = total_h.max(d_box.y + d_box.height);
        }

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: w,
            height: total_h,
            baseline,
            kind: LayoutKind::Fraction {
                numer: Box::new(n_box),
                denom: Box::new(d_box),
                bar_inset,
            },
        }
    }

    fn layout_atop(&self, top: &EqNode, bottom: &EqNode, fs: f64) -> LayoutBox {
        let t = self.layout_node(top, fs);
        let b = self.layout_node(bottom, fs);

        let pad = fs * FRAC_LINE_PAD;
        let axis = fs * AXIS_HEIGHT;
        let w = t.width.max(b.width) + pad * 2.0;

        let top_h = t.height + pad;
        let bottom_h = b.height + pad;
        let baseline = top_h + axis;
        let total_h = top_h + bottom_h;

        let mut top_box = t;
        top_box.x = (w - top_box.width) / 2.0;
        top_box.y = pad;

        let mut bottom_box = b;
        bottom_box.x = (w - bottom_box.width) / 2.0;
        bottom_box.y = top_h;

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: w,
            height: total_h,
            baseline,
            kind: LayoutKind::Atop {
                top: Box::new(top_box),
                bottom: Box::new(bottom_box),
            },
        }
    }

    fn layout_sqrt(&self, index: &Option<Box<EqNode>>, body: &EqNode, fs: f64) -> LayoutBox {
        let b = self.layout_node(body, fs);
        let pad = fs * SQRT_PAD;
        // legacy 수식 서체의 √ 기호 zone은 기본 크기 1em 고정 — 기호를 키워도
        // zone은 안 넓어진다 (eq-002 실측: 9.53pt·10.2pt 기호 모두 zone 9.0pt).
        let sign_w = if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            self.font_size
        } else {
            fs * 0.6
        };
        let body_w = b.width + pad;
        let body_h = b.height + pad * 2.0;

        let legacy = self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font);
        let idx = index.as_ref().map(|i| {
            // legacy 지수는 2차 첨자 크기(0.5em)다 (eq-002 실측 4.56pt@9.06).
            self.layout_node(i, fs * if legacy { 0.5 } else { SCRIPT_SCALE })
        });
        let idx_w = idx.as_ref().map(|i| i.width).unwrap_or(0.0);
        let total_w = idx_w.max(sign_w * 0.5) + sign_w * 0.5 + body_w;

        let mut body_box = b;
        body_box.x = total_w - body_w + pad * 0.5;
        body_box.y = pad;

        let idx = idx.map(|mut ib| {
            if legacy {
                // 지수는 기호 zone 안쪽 +0.26em 지점에, 기준선은 본문 기준선
                // −0.57em 높이에 놓인다 (eq-002 실측 4@sign+2.4pt, baseline−5.16pt).
                ib.x = body_box.x - sign_w + fs * 0.26;
                let sb = body_box.y + body_box.baseline;
                ib.y = sb - fs * 0.57 - ib.baseline;
            } else {
                ib.x = 0.0;
                ib.y = 0.0;
            }
            ib
        });

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: body_h,
            baseline: body_box.y + body_box.baseline,
            kind: LayoutKind::Sqrt {
                index: idx.map(Box::new),
                body: Box::new(body_box),
            },
        }
    }

    // legacy 서체의 첨자 크기는 본문의 0.68em (eq-002 실측 sup 글립 6.18pt@9.06).
    fn script_font_size(&self, fs: f64) -> f64 {
        if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            fs * 0.68
        } else {
            fs * SCRIPT_SCALE
        }
    }

    fn layout_superscript(&self, base: &EqNode, sup: &EqNode, fs: f64) -> LayoutBox {
        let legacy = self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font);
        let b = self.layout_node(base, fs);
        let s = self.layout_node(sup, self.script_font_size(fs));

        if legacy {
            // legacy 위첨자: sup 상자 *하단*이 base 기준선 위 ~0.30em에 걸린다.
            // (eq-002 실측 재측정: leaf `2`→2.8pt, 분수 sup→3.4pt@9.06)
            // 분수 sup 처럼 하단이 구조적 padding 으로 부풀려진 상자는 실제
            // 자식 배치 하단(content_bottom)을 앵커로 쓴다 — 잎의 em 꼬리
            // (baseline 아래 0.2em)까지만 들어가고 그 아래 pad 는 빠진다.
            let mut sup_y = b.baseline - fs * 0.30 - content_bottom(&s);
            let mut base_y = 0.0;
            if sup_y < 0.0 {
                base_y = -sup_y;
                sup_y = 0.0;
            }
            let total_h = (base_y + b.height).max(sup_y + s.height);
            let mut base_box = b;
            base_box.x = 0.0;
            base_box.y = base_y;
            let mut sup_box = s;
            sup_box.x = base_box.width + fs * THIN_SPACE_EM;
            sup_box.y = sup_y;
            let total_w = sup_box.x + sup_box.width;
            return LayoutBox {
                x: 0.0,
                y: 0.0,
                width: total_w,
                height: total_h,
                baseline: base_box.y + base_box.baseline,
                kind: LayoutKind::Superscript {
                    base: Box::new(base_box),
                    sup: Box::new(sup_box),
                },
            };
        }

        // sup_shift: 기준선으로부터 위첨자 상단까지의 거리 (양수 = base 상단 아래)
        let sup_shift = b.baseline - s.height * 0.7;

        let (base_y, sup_y, total_h);
        if sup_shift >= 0.0 {
            // [Task #1300] 위첨자 상단을 base 상단에 맞춘다 (한컴 정합).
            // 기존엔 base 를 sup_shift(=b.baseline 비례) 만큼 아래로 밀어 위첨자를
            // 박스 최상단에 두었는데, 키 큰 base(괄호 분수 등)에서 위첨자가 base 상단
            // 위로 과하게 치솟아 윗줄을 침범했다(#1300). base 를 밀지 않고(상단 정렬)
            // 위첨자 상단이 base 상단과 같은 높이에 오도록 한다.
            // base 가 sup 보다 낮은 경우만 sup 를 담도록 base 를 내린다.
            sup_y = 0.0;
            base_y = (s.height - b.height).max(0.0);
            total_h = (base_y + b.height).max(s.height);
        } else {
            // 위첨자가 base 상단 위로 확장 — sup를 상단에, base를 |sup_shift|만큼 내림
            sup_y = 0.0;
            base_y = -sup_shift;
            total_h = (base_y + b.height).max(s.height);
        }

        let mut base_box = b;
        base_box.x = 0.0;
        base_box.y = base_y;

        let mut sup_box = s;
        // 한컴 legacy 수식의 위첨자 간격은 base 잉크 끝에서 ~thin
        // (eq-002 실측: `3`→`⅛` 상자 1.62pt@9.06).
        let sup_gap = if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            fs * THIN_SPACE_EM
        } else {
            0.0
        };
        sup_box.x = base_box.width + sup_gap;
        sup_box.y = sup_y;

        let total_w = sup_box.x + sup_box.width;

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: total_h,
            baseline: base_box.y + base_box.baseline,
            kind: LayoutKind::Superscript {
                base: Box::new(base_box),
                sup: Box::new(sup_box),
            },
        }
    }

    fn layout_subscript(&self, base: &EqNode, sub: &EqNode, fs: f64) -> LayoutBox {
        let b = self.layout_node(base, fs);
        let s = self.layout_node(sub, self.script_font_size(fs));

        let sub_shift = b.baseline * 0.4;
        let total_h = (b.height).max(sub_shift + s.height);

        let mut base_box = b;
        base_box.x = 0.0;
        base_box.y = 0.0;

        let mut sub_box = s;
        // 아래첨자는 이탤릭 보정 전 advance에 붙는다 (TeX rule 18).
        // legacy 서체는 첨자 앞 thin space를 둔다 (위첨자와 같은 규칙).
        let sub_gap = if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            fs * THIN_SPACE_EM
        } else {
            0.0
        };
        sub_box.x = base_box.width + sub_gap - self.trailing_italic_correction(base, fs);
        sub_box.y = sub_shift;

        let total_w = base_box.width.max(sub_box.x + sub_box.width);

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: total_h,
            baseline: base_box.baseline,
            kind: LayoutKind::Subscript {
                base: Box::new(base_box),
                sub: Box::new(sub_box),
            },
        }
    }

    fn layout_subsup(&self, base: &EqNode, sub: &EqNode, sup: &EqNode, fs: f64) -> LayoutBox {
        // 적분 기호: 상한은 기호 상단, 하한은 기호 하단에 맞춤
        let is_integral = matches!(base, EqNode::MathSymbol(s) if is_integral_symbol(s));

        let b = self.layout_node(base, fs);
        let sb = self.layout_node(sub, self.script_font_size(fs));
        let sp = self.layout_node(sup, self.script_font_size(fs));

        if is_integral {
            // 적분 전용 배치 (Task #1317): 글리프를 stroke path 로 그리므로 상·하한 attach
            // point 를 path 기하(`integral_geom`)에 맞춰 산출한다. SVG/Canvas/Skia 가 동일
            // geom 을 공유하여 폰트 대체에 무관하게 정합한다(정답 한글 2022 비례).
            //   - 상한(sup): 상단 갈고리 우측, 글리프 최상단 근처
            //   - 하한(sub): 하단 갈고리 우측, 글리프 최하단(=baseline 근처)
            let geom = integral_geom(fs);
            // 상·하한이 적분 줄기에 붙지 않도록 **가로 간격(gap_x)만** 키워 띄운다.
            // 세로로 벌리면 적분 박스 높이가 커져 줄 간격이 위/아래로 넓어지므로
            // 세로 위치는 컴팩트하게 유지한다 (작업지시자 피드백, Task #1317 v4).
            let gap_x = fs * 0.22;

            let mut base_box = b;
            base_box.x = 0.0;
            base_box.width = geom.width; // 글리프 advance = path 폭

            // 글리프 기준 첨자 세로 위치(박스 상단 원점) — 컴팩트(글리프 상·하단 근처).
            let sup_dy = geom.top_y - sp.height * 0.30; // 상한: 최상단 근처
            let sub_dy = geom.bottom_y - sb.height * 0.72; // 하한: 최하단 근처

            // 상한이 박스 위로 넘치지 않도록 글리프를 그만큼 아래로 내린다.
            let head = (-sup_dy).max(0.0);
            base_box.y = head;

            let mut sup_box = sp;
            sup_box.x = base_box.x + geom.top_hook_x + gap_x;
            sup_box.y = base_box.y + sup_dy;

            let mut sub_box = sb;
            sub_box.x = base_box.x + geom.bottom_hook_x + gap_x;
            sub_box.y = base_box.y + sub_dy;

            let right = (sup_box.x + sup_box.width)
                .max(sub_box.x + sub_box.width)
                .max(base_box.x + geom.width);
            let total_w = right + fs * BIG_OP_TRAIL_PAD;
            let total_h = (sub_box.y + sub_box.height)
                .max(base_box.y + base_box.height)
                .max(sup_box.y + sup_box.height);

            return LayoutBox {
                x: 0.0,
                y: 0.0,
                width: total_w,
                height: total_h,
                baseline: base_box.y + base_box.baseline,
                kind: LayoutKind::SubSup {
                    base: Box::new(base_box),
                    sub: Box::new(sub_box),
                    sup: Box::new(sup_box),
                },
            };
        }

        let sup_shift = b.baseline - sp.height * 0.7;
        let sub_shift = b.baseline * 0.4;

        let ascent = if sup_shift < 0.0 {
            sp.height - sup_shift.abs()
        } else {
            sp.height.max(0.0)
        };
        let top = sup_shift.min(0.0).abs();
        let total_h = (top + b.height)
            .max(top + sub_shift + sb.height)
            .max(ascent + b.height);

        let base_y = top.max(
            if sup_shift > 0.0 {
                0.0
            } else {
                sp.height - sup_shift.abs() - b.baseline
            }
            .max(0.0),
        );

        let mut base_box = b;
        base_box.x = 0.0;
        base_box.y = base_y;

        // legacy 서체는 첨자 앞 thin space (layout_superscript/subscript와 같은 규칙).
        let script_gap = if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            fs * THIN_SPACE_EM
        } else {
            0.0
        };
        let mut sup_box = sp;
        sup_box.x = base_box.width + script_gap;
        sup_box.y = 0.0;

        let mut sub_box = sb;
        sub_box.x = base_box.width + script_gap - self.trailing_italic_correction(base, fs);
        sub_box.y = base_y + sub_shift;

        let total_w = (sup_box.x + sup_box.width).max(sub_box.x + sub_box.width);

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: total_h
                .max(base_box.y + base_box.height)
                .max(sub_box.y + sub_box.height),
            baseline: base_box.y + base_box.baseline,
            kind: LayoutKind::SubSup {
                base: Box::new(base_box),
                sub: Box::new(sub_box),
                sup: Box::new(sup_box),
            },
        }
    }

    fn layout_big_op(
        &self,
        symbol: &str,
        sub: &Option<Box<EqNode>>,
        sup: &Option<Box<EqNode>>,
        fs: f64,
    ) -> LayoutBox {
        // 적분 기호: nolimits 스타일 (큰 기호 + 오른쪽 위/아래 첨자)
        if is_integral_symbol(symbol) {
            return self.layout_integral(symbol, sub, sup, fs);
        }
        // ∑, ∏ 등: limits 스타일 (위/아래 중앙)
        let op_fs = fs * BIG_OP_SCALE;
        let op_w = estimate_text_width(symbol, op_fs, false);
        let op_h = op_fs;

        let sub_box = sub
            .as_ref()
            .map(|s| self.layout_node(s, self.script_font_size(fs)));
        let sup_box = sup
            .as_ref()
            .map(|s| self.layout_node(s, self.script_font_size(fs)));

        let sup_h = sup_box
            .as_ref()
            .map(|b| b.height + fs * 0.05)
            .unwrap_or(0.0);
        let sub_h = sub_box
            .as_ref()
            .map(|b| b.height + fs * 0.05)
            .unwrap_or(0.0);

        let total_h = sup_h + op_h + sub_h;
        let max_w = [
            op_w,
            sub_box.as_ref().map(|b| b.width).unwrap_or(0.0),
            sup_box.as_ref().map(|b| b.width).unwrap_or(0.0),
        ]
        .iter()
        .copied()
        .fold(0.0f64, f64::max);

        let baseline = sup_h + op_h * 0.6;

        let sup_laid = sup_box.map(|mut b| {
            b.x = (max_w - b.width) / 2.0;
            b.y = 0.0;
            b
        });
        let sub_laid = sub_box.map(|mut b| {
            b.x = (max_w - b.width) / 2.0;
            b.y = sup_h + op_h;
            b
        });

        LayoutBox {
            x: 0.0,
            y: 0.0,
            // Task #1233: 피연산자가 연산자에 붙지 않도록 trailing 간격 추가.
            // sup/sub 중앙정렬은 max_w 기준 유지 → 연산자는 좌측, 우측에 순수 공백.
            width: max_w + fs * BIG_OP_TRAIL_PAD,
            height: total_h,
            baseline,
            kind: LayoutKind::BigOp {
                symbol: symbol.to_string(),
                sub: sub_laid.map(Box::new),
                sup: sup_laid.map(Box::new),
            },
        }
    }

    /// 적분 기호 레이아웃: 큰 기호 + 오른쪽 위/아래 첨자 (nolimits 스타일)
    fn layout_integral(
        &self,
        symbol: &str,
        sub: &Option<Box<EqNode>>,
        sup: &Option<Box<EqNode>>,
        fs: f64,
    ) -> LayoutBox {
        let op_fs = fs * BIG_OP_SCALE;
        let op_w = estimate_text_width(symbol, op_fs, false);
        let op_h = op_fs;

        let sub_box = sub
            .as_ref()
            .map(|s| self.layout_node(s, self.script_font_size(fs)));
        let sup_box = sup
            .as_ref()
            .map(|s| self.layout_node(s, self.script_font_size(fs)));

        // 기호 기준선: 기호 높이의 60% (중앙보다 약간 위)
        let op_baseline = op_h * 0.6;

        // 위첨자: 기호 오른쪽 위
        let sup_shift = op_h * 0.1; // 기호 상단에서 약간 아래
                                    // 아래첨자: 기호 오른쪽 아래
        let sub_shift = op_h * 0.55; // 기호 중앙 아래

        let script_x = op_w; // 첨자는 기호 오른쪽에 배치

        let mut total_w = op_w;
        let mut total_h = op_h;

        let sup_laid = sup_box.map(|mut b| {
            b.x = script_x;
            b.y = sup_shift;
            total_w = total_w.max(script_x + b.width);
            b
        });

        let sub_laid = sub_box.map(|mut b| {
            b.x = script_x;
            b.y = sub_shift;
            total_w = total_w.max(script_x + b.width);
            total_h = total_h.max(sub_shift + b.height);
            b
        });

        LayoutBox {
            x: 0.0,
            y: 0.0,
            // Task #1233: 적분 뒤 피연산자(예: f(x)dx)가 첨자에 붙지 않도록 trailing 간격.
            width: total_w + fs * BIG_OP_TRAIL_PAD,
            height: total_h,
            baseline: op_baseline,
            kind: LayoutKind::BigOp {
                symbol: symbol.to_string(),
                sub: sub_laid.map(Box::new),
                sup: sup_laid.map(Box::new),
            },
        }
    }

    fn layout_limit(&self, is_upper: bool, sub: &Option<Box<EqNode>>, fs: f64) -> LayoutBox {
        let name = if is_upper { "Lim" } else { "lim" };
        let name_w = self.text_metrics(name, fs, false, false, false).0;
        let name_h = fs;

        let sub_box = sub.as_ref().map(|s| self.layout_node(s, fs * SCRIPT_SCALE));
        let sub_h = sub_box
            .as_ref()
            .map(|b| b.height + fs * 0.05)
            .unwrap_or(0.0);
        let sub_w = sub_box.as_ref().map(|b| b.width).unwrap_or(0.0);

        let w = name_w.max(sub_w);
        let total_h = name_h + sub_h;

        let sub_laid = sub_box.map(|mut b| {
            b.x = (w - b.width) / 2.0;
            b.y = name_h;
            b
        });

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: w,
            height: total_h,
            baseline: fs * 0.8,
            kind: LayoutKind::Limit {
                is_upper,
                sub: sub_laid.map(Box::new),
            },
        }
    }

    fn layout_matrix(&self, rows: &[Vec<EqNode>], style: MatrixStyle, fs: f64) -> LayoutBox {
        if rows.is_empty() {
            return LayoutBox {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: fs,
                baseline: fs * 0.8,
                kind: LayoutKind::Empty,
            };
        }

        let col_gap = fs * MATRIX_COL_GAP;
        let row_gap = fs * MATRIX_ROW_GAP;

        // 모든 셀 레이아웃
        let mut cell_boxes: Vec<Vec<LayoutBox>> = rows
            .iter()
            .map(|row| row.iter().map(|c| self.layout_node(c, fs)).collect())
            .collect();

        let num_cols = cell_boxes.iter().map(|r| r.len()).max().unwrap_or(0);

        // 열 폭 계산
        let mut col_widths = vec![0.0f64; num_cols];
        for row in &cell_boxes {
            for (ci, cell) in row.iter().enumerate() {
                if ci < num_cols {
                    col_widths[ci] = col_widths[ci].max(cell.width);
                }
            }
        }

        // 행 높이 계산
        let mut row_heights: Vec<f64> = cell_boxes
            .iter()
            .map(|row| row.iter().map(|c| c.height).fold(fs, f64::max))
            .collect();

        // 셀 위치 배정
        let mut y = 0.0;
        for (ri, row) in cell_boxes.iter_mut().enumerate() {
            let rh = row_heights[ri];
            let mut x = 0.0;
            for (ci, cell) in row.iter_mut().enumerate() {
                let cw = if ci < num_cols {
                    col_widths[ci]
                } else {
                    cell.width
                };
                cell.x = x + (cw - cell.width) / 2.0;
                cell.y = y + (rh - cell.height) / 2.0;
                x += cw + if ci + 1 < num_cols { col_gap } else { 0.0 };
            }
            y += rh + row_gap;
        }

        let total_w: f64 =
            col_widths.iter().sum::<f64>() + col_gap * (num_cols.saturating_sub(1)) as f64;
        let total_h = y - row_gap;
        let bracket_pad = fs * 0.2;

        // 괄호 포함 폭
        let paren_w = match style {
            MatrixStyle::Plain => 0.0,
            _ => fs * 0.3,
        };
        let full_w = total_w + paren_w * 2.0 + bracket_pad * 2.0;

        // 셀 x 오프셋 (괄호 포함)
        let x_offset = paren_w + bracket_pad;
        for row in &mut cell_boxes {
            for cell in row.iter_mut() {
                cell.x += x_offset;
            }
        }

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: full_w,
            height: total_h,
            baseline: total_h / 2.0,
            kind: LayoutKind::Matrix {
                cells: cell_boxes,
                style,
            },
        }
    }

    fn layout_cases(&self, rows: &[EqNode], fs: f64) -> LayoutBox {
        let row_gap = fs * MATRIX_ROW_GAP;
        let mut row_boxes: Vec<LayoutBox> = rows.iter().map(|r| self.layout_node(r, fs)).collect();

        let max_w = row_boxes.iter().map(|b| b.width).fold(0.0f64, f64::max);
        let mut y = 0.0;
        for b in &mut row_boxes {
            b.x = fs * 0.3; // 왼쪽 중괄호 여백
            b.y = y;
            y += b.height + row_gap;
        }
        let total_h = y - row_gap;
        let full_w = max_w + fs * 0.6;

        // 중괄호 포함 레이아웃 → Paren으로 래핑
        let inner = LayoutBox {
            x: 0.0,
            y: 0.0,
            width: full_w,
            height: total_h,
            baseline: total_h / 2.0,
            kind: LayoutKind::Row(row_boxes),
        };

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: full_w + fs * 0.3,
            height: total_h,
            baseline: total_h / 2.0,
            kind: LayoutKind::Paren {
                left: "{".to_string(),
                right: String::new(),
                body: Box::new(inner),
            },
        }
    }

    fn layout_rel(
        &self,
        arrow: &str,
        over: &EqNode,
        under: &Option<Box<EqNode>>,
        fs: f64,
    ) -> LayoutBox {
        let small_fs = fs * 0.7;
        let gap = fs * 0.1;

        // 화살표 레이아웃
        let mut arrow_box = self.layout_node(&EqNode::MathSymbol(arrow.to_string()), fs);
        // 위 내용
        let mut over_box = self.layout_node(over, small_fs);
        // 아래 내용
        let mut under_box = under.as_ref().map(|u| self.layout_node(u, small_fs));

        // 전체 폭: 가장 넓은 요소 기준
        let max_w = arrow_box
            .width
            .max(over_box.width)
            .max(under_box.as_ref().map(|u| u.width).unwrap_or(0.0));

        // 화살표 폭을 max_w로 확장 (시각적으로 늘림)
        arrow_box.width = max_w;

        // 세로 배치: over → arrow → under
        let mut y = 0.0;
        over_box.x = (max_w - over_box.width) / 2.0;
        over_box.y = y;
        y += over_box.height + gap;

        arrow_box.x = 0.0;
        arrow_box.y = y;
        let arrow_center_y = y + arrow_box.height / 2.0;
        y += arrow_box.height + gap;

        if let Some(ref mut ub) = under_box {
            ub.x = (max_w - ub.width) / 2.0;
            ub.y = y;
            y += ub.height;
        } else {
            y -= gap; // under가 없으면 마지막 gap 제거
        }

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: max_w,
            height: y,
            baseline: arrow_center_y,
            kind: LayoutKind::Rel {
                arrow: Box::new(arrow_box),
                over: Box::new(over_box),
                under: under_box.map(Box::new),
            },
        }
    }

    fn layout_eqalign(&self, rows: &[(EqNode, EqNode)], fs: f64) -> LayoutBox {
        let row_gap = fs * MATRIX_ROW_GAP;
        let align_gap = fs * 0.15; // & 기준 좌우 사이 간격

        // 각 행의 왼쪽/오른쪽 레이아웃 계산
        let mut laid_rows: Vec<(LayoutBox, LayoutBox)> = rows
            .iter()
            .map(|(l, r)| (self.layout_node(l, fs), self.layout_node(r, fs)))
            .collect();

        // 왼쪽 최대 폭 (& 정렬 기준)
        let max_left_w = laid_rows
            .iter()
            .map(|(l, _)| l.width)
            .fold(0.0f64, f64::max);

        let mut y = 0.0;
        let mut total_w = 0.0f64;
        for (left, right) in &mut laid_rows {
            // 왼쪽: 오른쪽 정렬 (& 기준으로 맞춤)
            left.x = max_left_w - left.width;
            // 오른쪽: & 기준 바로 뒤
            right.x = max_left_w + align_gap;

            let row_h = left.height.max(right.height);
            let row_bl = left.baseline.max(right.baseline);
            // 베이스라인 정렬
            left.y = y + (row_bl - left.baseline);
            right.y = y + (row_bl - right.baseline);

            total_w = total_w.max(right.x + right.width);
            y += row_h + row_gap;
        }
        let total_h = (y - row_gap).max(0.0);

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: total_h,
            baseline: total_h / 2.0,
            kind: LayoutKind::EqAlign { rows: laid_rows },
        }
    }

    fn layout_pile(&self, rows: &[EqNode], align: PileAlign, fs: f64) -> LayoutBox {
        let row_gap = fs * MATRIX_ROW_GAP;
        let mut row_boxes: Vec<LayoutBox> = rows.iter().map(|r| self.layout_node(r, fs)).collect();

        let max_w = row_boxes.iter().map(|b| b.width).fold(0.0f64, f64::max);
        let mut y = 0.0;
        for b in &mut row_boxes {
            b.x = match align {
                PileAlign::Left => 0.0,
                PileAlign::Center => (max_w - b.width) / 2.0,
                PileAlign::Right => max_w - b.width,
            };
            b.y = y;
            y += b.height + row_gap;
        }
        let total_h = y - row_gap;

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: max_w,
            height: total_h,
            baseline: total_h / 2.0,
            kind: LayoutKind::Row(row_boxes),
        }
    }

    fn layout_paren(&self, left: &str, right: &str, body: &EqNode, fs: f64) -> LayoutBox {
        let b = self.layout_node(body, fs);
        let use_stretch_round = b.height > fs * 1.2 && matches!((left, right), ("(", ")"));
        let pad = if use_stretch_round {
            fs * 0.03
        } else {
            fs * PAREN_PAD
        };
        // Times New Roman '(' advance (em 기준) = 0.333. 텍스트 높이 glyph는 이 폭을 유지하고,
        // 큰 둥근 괄호 path는 한컴 HyhwpEQ 출력에 가깝게 더 좁게 잡는다. (Task #283, #1139)
        let legacy = self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font);
        let paren_w = if use_stretch_round {
            // legacy는 e044/e045 글립 잉크가 slot(0.39em)까지 늘어난다
            // (eq-002 실측 괄호 잉크 3.55pt@9.06).
            if legacy {
                fs * 0.39
            } else {
                fs * 0.27
            }
        } else {
            fs * 0.333
        };

        let left_w = if left.is_empty() { 0.0 } else { paren_w };
        let right_w = if right.is_empty() { 0.0 } else { paren_w };

        let mut body_box = b;
        body_box.x = left_w + pad;
        body_box.y = 0.0;

        let total_w = left_w + pad + body_box.width + pad + right_w;

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: body_box.height,
            baseline: body_box.baseline,
            kind: LayoutKind::Paren {
                left: left.to_string(),
                right: right.to_string(),
                body: Box::new(body_box),
            },
        }
    }

    fn layout_decoration(
        &self,
        kind: super::symbols::DecoKind,
        body: &EqNode,
        fs: f64,
    ) -> LayoutBox {
        let b = self.layout_node(body, fs);
        let deco_h = fs * 0.25;

        let mut body_box = b;
        body_box.y = deco_h;

        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: body_box.width,
            height: body_box.height + deco_h,
            baseline: body_box.y + body_box.baseline,
            kind: LayoutKind::Decoration {
                kind,
                body: Box::new(body_box),
            },
        }
    }

    fn layout_font_style(
        &self,
        style: super::symbols::FontStyleKind,
        body: &EqNode,
        fs: f64,
    ) -> LayoutBox {
        let styled = self.styled(style);
        let b = styled.layout_node(body, fs);
        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: b.width,
            height: b.height,
            baseline: b.baseline,
            kind: LayoutKind::FontStyle {
                style,
                body: Box::new(b),
            },
        }
    }

    /// FontStyle 적용 후 상태. canvas/svg painter의 전환 규칙과 같아야 측정과 paint가 맞는다.
    fn styled(&self, style: super::symbols::FontStyleKind) -> Self {
        use super::symbols::FontStyleKind;
        let mut styled = self.clone();
        (styled.italic, styled.bold) = match style {
            FontStyleKind::Roman | FontStyleKind::SansSerif | FontStyleKind::Monospace => {
                (false, false)
            }
            FontStyleKind::Italic => (true, self.bold),
            FontStyleKind::Bold => (self.italic, true),
            FontStyleKind::Blackboard => (false, true),
            FontStyleKind::Calligraphy | FontStyleKind::Fraktur => (false, false),
        };
        styled
    }

    fn layout_space(&self, kind: SpaceKind, fs: f64) -> LayoutBox {
        let w = match kind {
            SpaceKind::Normal => fs * 0.33,
            SpaceKind::Thin => fs * 0.17,
            SpaceKind::Tab => fs * 1.0,
        };
        LayoutBox {
            x: 0.0,
            y: 0.0,
            width: w,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::Space(w),
        }
    }
}

/// 적분 기호 여부 판별
pub(crate) fn is_integral_symbol(symbol: &str) -> bool {
    matches!(symbol, "∫" | "∬" | "∭" | "∮" | "∯" | "∰")
}

/// 상자를 구성하는 자식들의 실제 배치 하단 (상자 좌표계). 잎 상자는 em 꼬리를
/// 포함한 자기 높이, 컨테이너는 자식들의 재귀 하단 최댓값이다 — 구조적 padding
/// 으로 부풀려진 `height` 와 달리 시각적으로 보이는 잉크 범위에 가깝다.
fn content_bottom(lb: &LayoutBox) -> f64 {
    match &lb.kind {
        LayoutKind::Row(children) => children
            .iter()
            .map(|child| child.y + content_bottom(child))
            .fold(0.0, f64::max),
        LayoutKind::Fraction { numer, denom, .. } => {
            (numer.y + content_bottom(numer)).max(denom.y + content_bottom(denom))
        }
        LayoutKind::Atop { top, bottom, .. } => {
            (top.y + content_bottom(top)).max(bottom.y + content_bottom(bottom))
        }
        _ => lb.height,
    }
}

/// 텍스트 폭 추정
pub(crate) fn estimate_text_width(text: &str, font_size: f64, italic: bool) -> f64 {
    let mut w = 0.0;
    for ch in text.chars() {
        let ratio = if ch.is_ascii() {
            if ch.is_ascii_uppercase() {
                0.65
            } else if ch.is_ascii_lowercase() {
                0.55
            } else if ch.is_ascii_digit() {
                0.55
            } else {
                0.5
            }
        } else {
            estimate_unicode_char_width(ch)
        };
        w += font_size * ratio;
    }
    if italic {
        w *= 1.05;
    }
    w
}

/// 비-ASCII 문자의 폭 비율 추정 (font_size 대비)
fn estimate_unicode_char_width(ch: char) -> f64 {
    match ch {
        // 프라임/아포스트로피 — 매우 좁음
        '′' | '″' | '‴' | '\'' | '`' => 0.3,
        // 그리스 소문자 — 일반 라틴 소문자와 유사
        'α'..='ω' | 'ϑ' | 'ϖ' => 0.55,
        // 그리스 대문자 — 일반 라틴 대문자와 유사
        'Α'..='Ω' | 'ϒ' => 0.65,
        // 수학 연산자 — 중간 너비
        '±' | '∓' | '×' | '÷' | '·' | '∘' | '†' | '‡' | '•' => 0.6,
        // 관계 기호 — 등호 너비와 유사
        '≠' | '≤' | '≥' | '≈' | '≡' | '≅' | '∼' | '≃' | '≍' | '≐' | '∝' | '≺' | '≻' => {
            0.7
        }
        // 집합/논리 기호
        '∈' | '∉' | '∋' | '⊂' | '⊃' | '⊆' | '⊇' | '∀' | '∃' | '¬' | '∧' | '∨' => {
            0.65
        }
        '⊏' | '⊐' | '⊑' | '⊒' | '⊻' | '⊢' | '⊣' | '⊨' => 0.65,
        // 큰 연산자 기호 (단독 텍스트로 사용될 때)
        '∫' | '∬' | '∭' | '∮' | '∯' | '∰' => 0.5,
        '∑' | '∏' | '∐' => 0.8,
        '∪' | '∩' | '⊔' | '⊓' | '⊎' | '⋀' | '⋁' => 0.7,
        '⊕' | '⊗' | '⊙' | '⊖' | '⊘' => 0.7,
        // 화살표
        '←' | '→' | '↑' | '↓' | '↔' | '↕' => 0.8,
        '⇐' | '⇒' | '⇑' | '⇓' | '⇔' | '⇕' => 0.8,
        '↖' | '↗' | '↙' | '↘' | '↦' | '↩' | '↪' => 0.8,
        // 점 기호
        '⋯' | '…' | '⋮' | '⋱' => 0.8,
        // 기타 수학 기호 — 좁은 것
        '∂' | '∅' | '∇' | '∞' | '∠' | '∡' | '∢' | '⊾' => 0.6,
        '⊥' | '⊤' | '°' | '‰' | '‱' | '♯' => 0.5,
        'ℵ' | 'ℏ' | 'ı' | 'ȷ' | 'ℓ' | '℘' | 'ℑ' | 'ℜ' | 'ℒ' | 'Å' | '℧' => 0.6,
        '℃' | '℉' => 0.9,
        // 기하 도형은 대체 서체(Apple Symbols·맑은 고딕 등)에서 거의 전각이다.
        '△' | '▽' | '○' | '◇' | '□' | '▲' | '▼' | '●' | '◆' | '■' => 0.97,
        '⋄' => 0.7,
        // CJK — 전각
        '\u{3000}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{AC00}'..='\u{D7AF}' => 1.0,
        // 기타 비-ASCII — 중간 너비 기본값
        _ => 0.6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::equation::parser::EqParser;
    use crate::renderer::equation::tokenizer::tokenize;

    fn parse_and_layout(script: &str, font_size: f64) -> LayoutBox {
        let tokens = tokenize(script);
        let ast = EqParser::new(tokens).parse();
        EqLayout::new(font_size).layout(&ast)
    }

    #[test]
    fn test_simple_text() {
        let lb = parse_and_layout("abc", 20.0);
        assert!(lb.width > 0.0);
        assert!(lb.height > 0.0);
    }

    #[test]
    fn 직립과_중첩_이탤릭은_실제_표시_서체로_측정한다() {
        use super::super::symbols::FontStyleKind;
        let text = EqNode::Text("abc".into());
        let roman = EqNode::FontStyle {
            style: FontStyleKind::Roman,
            body: Box::new(text.clone()),
        };
        let nested = EqNode::FontStyle {
            style: FontStyleKind::Roman,
            body: Box::new(EqNode::FontStyle {
                style: FontStyleKind::Italic,
                body: Box::new(text.clone()),
            }),
        };
        let layout = EqLayout::new(20.0);
        assert_eq!(
            layout.layout(&roman).width,
            layout.text_width("abc", 20.0, false, true)
        );
        assert_eq!(layout.layout(&nested).width, layout.layout(&text).width);
    }

    #[test]
    fn 저장_폭에는_글립_크기_대신_연산자_간격을_맞춘다() {
        fn leaves(node: &LayoutBox, out: &mut Vec<(String, f64, f64)>) {
            match &node.kind {
                LayoutKind::Text(s) | LayoutKind::Number(s) => {
                    out.push((s.clone(), node.width, node.height))
                }
                LayoutKind::Row(children) => {
                    for child in children {
                        leaves(child, out);
                    }
                }
                LayoutKind::Fraction { numer, denom, .. } => {
                    leaves(numer, out);
                    leaves(denom, out);
                }
                _ => {}
            }
        }
        for script in ["a+b=c", "{a+b} over c = d over {e+f}"] {
            let ast = EqParser::new(tokenize(script)).parse();
            let engine = EqLayout::new(20.0);
            let natural = engine.layout(&ast);
            let target = natural.width - 2.0;
            let fitted = engine.layout_in_control_width(&ast, target);
            assert!((fitted.width - target).abs() < 0.001);
            assert_eq!(fitted.height, natural.height);
            assert_eq!(fitted.baseline, natural.baseline);
            let (mut before, mut after) = (Vec::new(), Vec::new());
            leaves(&natural, &mut before);
            leaves(&fitted, &mut after);
            assert_eq!(before, after);
            assert_eq!(engine.layout_in_control_width(&ast, 0.01).width, natural.width,
                "a source box narrower than its glyphs must never stretch glyphs or erase all spacing");
        }
    }

    fn row_children(lb: &LayoutBox) -> &[LayoutBox] {
        match &lb.kind {
            LayoutKind::Row(children) => children,
            other => panic!("expected Row, got {other:?}"),
        }
    }

    /// 사용자 보고: `TRIANGLE x = {lambda L} over {d}` 에서 △가 x를 덮었다.
    /// 원자 박스는 겹치지 않고, 관계 기호 양쪽은 같은 thick space다.
    #[test]
    fn 삼각형과_변수는_겹치지_않고_등호_간격은_대칭이다() {
        let fs = 13.0 + 1.0 / 3.0;
        let ast = EqParser::new(tokenize("TRIANGLE  x= {lambda  L} over {d}")).parse();
        let lb = EqLayout::with_font(fs, "HYhwpEQ").layout(&ast);
        let atoms = row_children(&lb);
        assert_eq!(atoms.len(), 4);
        for pair in atoms.windows(2) {
            assert!(
                pair[1].x >= pair[0].x + pair[0].width - 1e-9,
                "atoms overlap: {:?} / {:?}",
                pair[0].kind,
                pair[1].kind
            );
        }
        let gap = |i: usize| atoms[i + 1].x - (atoms[i].x + atoms[i].width);
        assert!(
            (gap(0) - fs * THIN_SPACE_EM).abs() < 1e-9,
            "△ is a prefix operator"
        );
        // 한컴 legacy 간격표는 관계 기호 좌우가 비대칭이다
        // (eq-002 실측: Ord→Rel 0.03em, Rel→복합 원자 thin).
        assert!((gap(1) - fs * 0.03).abs() < 1e-9);
        assert!((gap(2) - fs * THIN_SPACE_EM).abs() < 1e-9);
    }

    #[test]
    fn 원자_간격은_부호와_첨자_및_명시_공백을_구별한다() {
        let fs = 20.0;
        let gaps = |script: &str| -> Vec<f64> {
            let lb = parse_and_layout(script, fs);
            row_children(&lb)
                .windows(2)
                .map(|pair| pair[1].x - (pair[0].x + pair[0].width))
                .collect()
        };
        let medium = fs * MEDIUM_SPACE_EM;
        let thick = fs * THICK_SPACE_EM;
        let close = |a: &[f64], b: &[f64]| {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
        };
        assert!(close(&gaps("a+b"), &[medium, medium]));
        // 관계 기호 뒤·행 첫머리의 -는 부호(Ord)라 피연산자에 붙는다.
        assert!(close(&gaps("a=-b"), &[thick, thick, 0.0]));
        assert!(close(&gaps("-a+b"), &[0.0, medium, medium]));
        // 명시 공백(~)은 원자 간격에 더해진다.
        let spaced = parse_and_layout("a~+b", fs);
        let spaced = row_children(&spaced);
        assert!(
            (spaced[2].x - (spaced[0].x + spaced[0].width) - (fs * 0.33 + medium)).abs() < 1e-9
        );
        // 첨자 크기에서는 이항·관계 간격을 넣지 않는다.
        let lb = parse_and_layout("x^{n+1}", fs);
        let LayoutKind::Superscript { sup, .. } = &lb.kind else {
            panic!("superscript")
        };
        for pair in row_children(sup).windows(2) {
            assert!((pair[1].x - (pair[0].x + pair[0].width)).abs() < 1e-9);
        }
        // 함수 이름(Op) 뒤 피연산자는 thin space, 괄호(Open)는 붙는다.
        assert!(close(&gaps("sin x"), &[fs * THIN_SPACE_EM]));
        assert!(gaps("sin (x)")[0].abs() < 1e-9);
    }

    #[test]
    fn test_fraction_layout() {
        let lb = parse_and_layout("a over b", 20.0);
        assert!(lb.width > 0.0);
        assert!(lb.height > 20.0); // 분수는 기본 높이보다 높아야 함
    }

    #[test]
    fn modern_hy_fraction_left_aligns_children_in_thin_margins() {
        for fs in [11.0, 22.0] {
            let engine = EqLayout::with_font(fs, "HYhwpEQ");
            // 한컴 버전60+HYhwpEQ 분수는 자식을 thin 여백에 좌측 정렬하고 폭은
            // 최장 자식 advance + 양쪽 thin이다 (eq-002 실측: ¼ 막대 폭과
            // `1`·`4`의 동일한 시작점).
            let thin = fs * THIN_SPACE_EM;
            let ast = EqParser::new(tokenize("1 over i")).parse();
            let narrow = engine.layout(&ast);
            let EqNode::Fraction {
                numer: n_node,
                denom: d_node,
            } = &ast
            else {
                panic!("fraction node")
            };
            let LayoutKind::Fraction {
                numer,
                denom,
                bar_inset,
            } = &narrow.kind
            else {
                panic!("fraction")
            };
            let adv = |node: &EqNode, lb: &LayoutBox| {
                engine.node_advance_right(node, fs).unwrap_or(lb.width)
            };
            let want_w = (adv(n_node, numer).max(adv(d_node, denom)) + thin * 2.0).max(fs * 0.628);
            assert!((narrow.width - want_w).abs() < 1e-8);
            assert!((numer.x - thin).abs() < 1e-8);
            assert!((denom.x - thin).abs() < 1e-8);
            assert_eq!(*bar_inset, 0.0);

            let wide_ast = EqParser::new(tokenize("12345 over 6")).parse();
            let wide = engine.layout(&wide_ast);
            let LayoutKind::Fraction { numer, .. } = &wide.kind else {
                panic!("fraction")
            };
            assert!(wide.width > fs);
            assert!((numer.x - thin).abs() < 1e-8);

            let legacy = engine
                .with_version("")
                .layout(&EqParser::new(tokenize("1 over i")).parse());
            let LayoutKind::Fraction { bar_inset, .. } = legacy.kind else {
                panic!("fraction")
            };
            assert!((bar_inset - fs * 0.05).abs() < 1e-8);
        }
    }

    #[test]
    fn legacy_fraction_preserves_native_baseline_clearance_at_different_sizes() {
        for fs in [12.0, 24.0] {
            let ast = EqParser::new(tokenize("1 over p")).parse();
            let lb = EqLayout::with_font(fs, "HYhwpEQ").layout(&ast);
            let LayoutKind::Fraction { numer, denom, .. } = &lb.kind else {
                panic!("fraction")
            };
            let separation = (denom.y + denom.baseline - numer.y - numer.baseline) / fs;
            assert!((1.28..1.34).contains(&separation));
            assert!(numer.y >= 0.0 && denom.y + denom.height <= lb.height);
            let nested = EqParser::new(tokenize("1 over {a over b}")).parse();
            let lb = EqLayout::with_font(fs, "HYhwpEQ").layout(&nested);
            let LayoutKind::Fraction { numer, denom, .. } = &lb.kind else {
                panic!("fraction")
            };
            assert!(numer.y + numer.height < denom.y);
            assert!(denom.y + denom.height <= lb.height);
        }
    }

    #[test]
    fn hft_fraction_uses_its_axis_and_keeps_nested_denominators_clear() {
        for fs in [12.0, 24.0] {
            let ast = EqParser::new(tokenize("x over L")).parse();
            let legacy = EqLayout::with_font(fs, "HYhwpEQ")
                .with_version("")
                .layout(&ast);
            let modern = EqLayout::with_font(fs, "HYhwpEQ")
                .with_version("Equation Version 60")
                .layout(&ast);
            let LayoutKind::Fraction { numer, denom, .. } = &legacy.kind else {
                panic!("fraction")
            };
            assert!((legacy.baseline - fraction_line_y(numer, fs) - fs * 0.375).abs() < 1e-8);
            let separation = denom.y + denom.baseline - numer.y - numer.baseline;
            assert!((1.14 * fs..1.17 * fs).contains(&separation));
            assert!(legacy.baseline > modern.baseline);
            let nested = EqParser::new(tokenize("x over {a over b}")).parse();
            let nested = EqLayout::with_font(fs, "HYhwpEQ")
                .with_version("")
                .layout(&nested);
            let LayoutKind::Fraction { numer, denom, .. } = &nested.kind else {
                panic!("fraction")
            };
            assert!(denom.y > fraction_line_y(numer, fs));
            assert!(denom.y + denom.height <= nested.height);
        }
    }

    /// Task #1233: 큰 연산자(Σ)는 box width 에 trailing 간격(fs×BIG_OP_TRAIL_PAD)을 포함해야
    /// 피연산자가 붙지 않는다.
    #[test]
    fn test_big_op_trailing_pad() {
        // 트리 어디서든 첫 BigOp LayoutBox 를 찾는다 (top-level Row/단독 모두 대응)
        fn find_big_op(b: &LayoutBox) -> Option<&LayoutBox> {
            if matches!(b.kind, LayoutKind::BigOp { .. }) {
                return Some(b);
            }
            if let LayoutKind::Row(children) = &b.kind {
                for c in children {
                    if let Some(f) = find_big_op(c) {
                        return Some(f);
                    }
                }
            }
            None
        }
        let fs = 20.0;
        let lb = parse_and_layout("sum_{n=1}^{N} b", fs);
        let big = find_big_op(&lb).expect("BigOp 노드가 있어야 함");
        // 내부(중앙정렬된 sub/sup)의 우측 끝
        let inner = match &big.kind {
            LayoutKind::BigOp { sub, sup, .. } => {
                let s = sub.as_ref().map(|b| b.x + b.width).unwrap_or(0.0);
                let p = sup.as_ref().map(|b| b.x + b.width).unwrap_or(0.0);
                s.max(p)
            }
            _ => unreachable!(),
        };
        assert!(
            big.width - inner >= fs * BIG_OP_TRAIL_PAD * 0.9,
            "BigOp trailing 간격 부재: width={} inner={}",
            big.width,
            inner
        );
    }

    #[test]
    fn test_superscript_layout() {
        let lb = parse_and_layout("x^2", 20.0);
        assert!(lb.width > 0.0);
        assert!(lb.height > 0.0);
    }

    #[test]
    fn nested_paren_exponent_is_above_its_complete_base() {
        fn find_sup(lb: &LayoutBox) -> Option<(&LayoutBox, &LayoutBox)> {
            match &lb.kind {
                LayoutKind::Superscript { base, sup } => Some((base, sup)),
                LayoutKind::Row(children) => children.iter().find_map(find_sup),
                _ => None,
            }
        }

        let lb = parse_and_layout("(f(x))^{5}", 20.0);
        let (base, sup) = find_sup(&lb).expect("nested parenthesis superscript");
        let base_baseline = base.y + base.baseline;
        let sup_baseline = sup.y + sup.baseline;
        assert!(
            sup_baseline < base_baseline,
            "exponent baseline ({sup_baseline}) must be above the grouped base baseline ({base_baseline})"
        );
    }

    #[test]
    fn test_superscript_tall_base_no_overshoot() {
        // [#1300] 키 큰 base(괄호 분수 등)의 위첨자가 baseline 위로 과하게 치솟아
        // 윗줄을 침범하던 문제. base 밀어내기(base_y)는 sup 높이를 넘지 않아야 한다.
        fn find_sup(lb: &LayoutBox) -> Option<(&LayoutBox, &LayoutBox)> {
            match &lb.kind {
                LayoutKind::Superscript { base, sup } => Some((base, sup)),
                LayoutKind::Row(ch) => ch.iter().rev().find_map(find_sup),
                _ => None,
            }
        }
        // 위첨자 상단이 base 상단보다 위로 치솟지 않아야 한다(상단 정렬). 즉 sup.y >= base.y.
        // (이전 버그: 키 큰 base 를 아래로 밀어 sup.y=0 < base.y 가 되어 위첨자가 base 상단 위로 떠올랐다.)
        const MARGIN: f64 = 0.01;

        // 키 큰 base: 괄호로 감싼 분수 — 상단 정렬(base_y≈0) 확인
        let tall = parse_and_layout("LEFT ( {1} over {6} RIGHT )^4", 12.0);
        let (b_tall, s_tall) = find_sup(&tall).expect("tall superscript");
        assert!(
            s_tall.y >= b_tall.y - MARGIN,
            "tall: sup.y ({}) must not rise above base.y ({})",
            s_tall.y,
            b_tall.y
        );
        // 합성 baseline 이 base 자연 baseline 과 일치(이중 가산 없음)
        assert!(
            (tall.baseline - (b_tall.y + b_tall.baseline)).abs() < MARGIN,
            "tall: box baseline ({}) should equal base baseline ({})",
            tall.baseline,
            b_tall.y + b_tall.baseline
        );

        // 짧은 base: x^4 도 동일 불변(상단 정렬) — 위첨자가 base 상단 위로 안 떠오름
        let short = parse_and_layout("x^4", 12.0);
        let (b_short, s_short) = find_sup(&short).expect("short superscript");
        assert!(
            s_short.y >= b_short.y - MARGIN,
            "short: sup.y ({}) must not rise above base.y ({})",
            s_short.y,
            b_short.y
        );
    }

    #[test]
    fn test_superscript_fraction_baseline() {
        // #532: 분수형 위첨자 (25^{1/3}) 에서 sup의 baseline이
        // base baseline 아래로 내려가면 안 됨
        let lb = parse_and_layout("25^{{1} over {3}}", 14.0);
        let (base_box, sup_box) = match &lb.kind {
            LayoutKind::Superscript { base, sup } => (base, sup),
            LayoutKind::Row(children) => {
                // Row 내 마지막 요소가 Superscript일 수 있음
                let last = children.last().unwrap();
                match &last.kind {
                    LayoutKind::Superscript { base, sup } => (base, sup),
                    _ => panic!("Expected Superscript in Row"),
                }
            }
            _ => panic!("Expected Superscript or Row, got {:?}", lb.kind),
        };
        // sup의 상단(y)이 base의 상단보다 높거나 같아야 함
        assert!(
            sup_box.y <= base_box.y,
            "sup.y ({}) should be <= base.y ({})",
            sup_box.y,
            base_box.y
        );
        // sup의 baseline이 base baseline보다 위에 있어야 함
        let sup_baseline_abs = sup_box.y + sup_box.baseline;
        let base_baseline_abs = base_box.y + base_box.baseline;
        assert!(
            sup_baseline_abs < base_baseline_abs,
            "sup baseline ({}) should be above base baseline ({})",
            sup_baseline_abs,
            base_baseline_abs
        );
    }

    #[test]
    fn test_eq01_script() {
        // 실제 eq-01.hwp 수식
        let lb = parse_and_layout(
            "평점=입찰가격평가~배점한도 TIMES LEFT ( {최저입찰가격} over {해당입찰가격} RIGHT )",
            20.0,
        );
        assert!(lb.width > 100.0);
        assert!(lb.height > 0.0);
    }

    #[test]
    fn test_cases_korean_no_overlap() {
        // exam_math.hwp p177 CASES 수식 — 한글 혼합
        let lb = parse_and_layout(
            "a _{n+1} = {cases{``a _{n} -3&&LEFT ( LEFT |` a _{n} `RIGHT | 이~홀수인~경우 RIGHT )#``{1} over {2} a _{n}&&LEFT ( a _{n} =0~또는~ LEFT |` a _{n} `RIGHT | 이~짝수인~경우 RIGHT )}}",
            14.67,
        );
        assert!(lb.width > 0.0, "CASES width should be positive");
        assert!(lb.height > 0.0, "CASES height should be positive");

        // 전체 수식 a_{n+1} = {cases{...}} 는 Row[subscript, =, Paren{cases}]
        let top_children = match &lb.kind {
            LayoutKind::Row(children) => children,
            other => panic!("Top-level should be Row, got {:?}", other),
        };
        let cases_paren = top_children
            .iter()
            .find(|c| matches!(&c.kind, LayoutKind::Paren { .. }))
            .expect("Should contain a Paren (CASES) element");
        let cases_body = match &cases_paren.kind {
            LayoutKind::Paren { body, .. } => body,
            _ => unreachable!(),
        };
        let rows = match &cases_body.kind {
            LayoutKind::Row(rows) => rows,
            other => panic!("CASES body should be Row, got {:?}", other),
        };
        assert!(rows.len() >= 2, "CASES should have at least 2 rows");
        let row1 = &rows[0];
        let row2 = &rows[1];
        let row1_bottom = row1.y + row1.height;
        let row2_top = row2.y;
        assert!(
            row2_top >= row1_bottom,
            "CASES rows should not overlap: row1 bottom={:.1}, row2 top={:.1}",
            row1_bottom,
            row2_top
        );
    }

    #[test]
    fn test_korean_text_width_not_italic() {
        // 한글 텍스트는 이탤릭 보정 없이 폭 산출
        let korean = parse_and_layout("홀수인~경우", 20.0);
        let latin = parse_and_layout("abcdef", 20.0);
        // 한글 6자(전각 1.0×) > 라틴 6자(~0.55×)
        assert!(
            korean.width > latin.width,
            "Korean text width ({:.1}) should be larger than Latin ({:.1})",
            korean.width,
            latin.width
        );
    }

    #[test]
    fn known_equation_font_uses_its_proportional_advances() {
        let layout = EqLayout::with_font(20.0, "함초롬돋움");
        let narrow = layout.layout(&EqNode::Text("iiii".to_string()));
        let wide = layout.layout(&EqNode::Text("WWWW".to_string()));

        assert!(
            wide.width > narrow.width * 1.5,
            "resolved font advances should distinguish iii ({}) from WWW ({})",
            narrow.width,
            wide.width,
        );
    }
}

fn is_cjk_char(c: char) -> bool {
    matches!(c, '\u{3000}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{AC00}'..='\u{D7AF}')
}

/// TeX 수식 원자 분류 (The TeXbook 17장).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MathClass {
    Ord,
    Op,
    Bin,
    Rel,
    Open,
    Close,
    Punct,
    Inner,
}

/// 행 안의 원자. 괄호 묶음처럼 왼쪽/오른쪽 경계의 분류가 다를 수 있다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Atom {
    left: MathClass,
    right: MathClass,
    /// 큰 연산자처럼 박스 안에 이미 뒤 간격을 가진 원자.
    trailing_space: bool,
}

impl Atom {
    fn of(class: MathClass) -> Self {
        Self {
            left: class,
            right: class,
            trailing_space: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AtomSlot {
    Atom(Atom),
    /// 명시 공백: 간격에 더해지지만 원자 관계는 유지한다.
    Glue,
    /// 줄바꿈: 앞뒤 원자 관계를 끊는다.
    Break,
}

fn atom_of(node: &EqNode) -> AtomSlot {
    let class = match node {
        EqNode::Space(_) | EqNode::Empty => return AtomSlot::Glue,
        EqNode::Newline => return AtomSlot::Break,
        EqNode::Symbol(s) | EqNode::MathSymbol(s) if is_integral_symbol(s) => {
            return AtomSlot::Atom(Atom {
                trailing_space: true,
                ..Atom::of(MathClass::Op)
            })
        }
        EqNode::Symbol(s) | EqNode::MathSymbol(s) => symbol_class(s),
        EqNode::Text(_) | EqNode::Number(_) | EqNode::Quoted(_) => MathClass::Ord,
        EqNode::Function(_) | EqNode::Limit { .. } => MathClass::Op,
        EqNode::BigOp { .. } => {
            return AtomSlot::Atom(Atom {
                trailing_space: true,
                ..Atom::of(MathClass::Op)
            })
        }
        // 분수선은 개체 여백(bar_inset) 안쪽에서 끝난다. TeX의 null delimiter와 같은 역할.
        EqNode::Fraction { .. } | EqNode::Atop { .. } | EqNode::Cases { .. } => MathClass::Inner,
        EqNode::Matrix { style, .. } => {
            if *style == MatrixStyle::Plain {
                MathClass::Ord
            } else {
                MathClass::Inner
            }
        }
        EqNode::Rel { .. } => MathClass::Rel,
        EqNode::Paren { .. } => {
            return AtomSlot::Atom(Atom {
                left: MathClass::Open,
                right: MathClass::Close,
                trailing_space: false,
            })
        }
        EqNode::Superscript { base, .. }
        | EqNode::Subscript { base, .. }
        | EqNode::SubSup { base, .. }
        | EqNode::Color { body: base, .. }
        | EqNode::FontStyle { body: base, .. } => {
            return match atom_of(base) {
                AtomSlot::Atom(atom) => AtomSlot::Atom(atom),
                _ => AtomSlot::Atom(Atom::of(MathClass::Ord)),
            }
        }
        // 괄호로 시작·끝나는 평탄화된 괄호 행은 경계 분류를 유지하고, 그 밖의 묶음은 Ord다.
        EqNode::Row(children) => {
            let edge = |node: Option<&EqNode>| match node {
                Some(EqNode::Symbol(s)) => Some(symbol_class(s)),
                _ => None,
            };
            if edge(children.first()) == Some(MathClass::Open)
                && edge(children.last()) == Some(MathClass::Close)
            {
                return AtomSlot::Atom(Atom {
                    left: MathClass::Open,
                    right: MathClass::Close,
                    trailing_space: false,
                });
            }
            MathClass::Ord
        }
        _ => MathClass::Ord,
    };
    AtomSlot::Atom(Atom::of(class))
}

/// TeX rule 5·6: 앞에 피연산자가 없는 Bin(부호)과 뒤에 피연산자가 없는 Bin은 Ord가 된다.
fn resolve_atoms(mut slots: Vec<AtomSlot>) -> Vec<AtomSlot> {
    let mut previous: Option<usize> = None;
    for i in 0..slots.len() {
        match slots[i] {
            AtomSlot::Atom(atom) => {
                let prev_right = previous.and_then(|p| match slots[p] {
                    AtomSlot::Atom(prev) => Some(prev.right),
                    _ => None,
                });
                if atom.left == MathClass::Bin
                    && prev_right.map_or(true, |right| {
                        matches!(
                            right,
                            MathClass::Bin
                                | MathClass::Op
                                | MathClass::Rel
                                | MathClass::Open
                                | MathClass::Punct
                        )
                    })
                {
                    slots[i] = AtomSlot::Atom(Atom::of(MathClass::Ord));
                } else if matches!(
                    atom.left,
                    MathClass::Rel | MathClass::Close | MathClass::Punct
                ) && prev_right == Some(MathClass::Bin)
                {
                    slots[previous.unwrap()] = AtomSlot::Atom(Atom::of(MathClass::Ord));
                }
                previous = Some(i);
            }
            AtomSlot::Break => {
                demote_trailing_bin(&mut slots, previous);
                previous = None;
            }
            AtomSlot::Glue => {}
        }
    }
    demote_trailing_bin(&mut slots, previous);
    slots
}

fn demote_trailing_bin(slots: &mut [AtomSlot], last: Option<usize>) {
    if let Some(i) = last {
        if matches!(slots[i], AtomSlot::Atom(atom) if atom.right == MathClass::Bin) {
            slots[i] = AtomSlot::Atom(Atom::of(MathClass::Ord));
        }
    }
}

const THIN_SPACE_EM: f64 = 3.0 / 18.0;
const MEDIUM_SPACE_EM: f64 = 4.0 / 18.0;
const THICK_SPACE_EM: f64 = 5.0 / 18.0;

/// 인접 원자 사이 간격 (em). TeX 원자 간격표를 따르며, 괄호 항목(첨자 크기에서 생략)은
/// 음수로 적는다. 0 = 없음, 1 = thin, 2 = medium, 3 = thick.
fn math_space_em(prev: Atom, next: Atom, script: bool) -> f64 {
    use MathClass::*;
    if prev.trailing_space {
        return 0.0;
    }
    #[rustfmt::skip]
    const TABLE: [[i8; 8]; 8] = [
        //  Ord  Op  Bin  Rel Open Close Punct Inner
        [    0,   1,  -2,  -3,   0,   0,    0,   -1], // Ord
        [    1,   1,   0,  -3,   0,   0,    0,   -1], // Op
        [   -2,  -2,   0,   0,  -2,   0,    0,   -2], // Bin
        [   -3,  -3,   0,   0,  -3,   0,    0,   -3], // Rel
        [    0,   0,   0,   0,   0,   0,    0,    0], // Open
        [    0,   1,  -2,  -3,   0,   0,    0,   -1], // Close
        [   -1,  -1,   0,  -1,  -1,  -1,   -1,   -1], // Punct
        [   -1,   1,  -2,  -3,  -1,   0,   -1,   -1], // Inner
    ];
    let index = |class: MathClass| match class {
        Ord => 0,
        Op => 1,
        Bin => 2,
        Rel => 3,
        Open => 4,
        Close => 5,
        Punct => 6,
        Inner => 7,
    };
    let entry = TABLE[index(prev.right)][index(next.left)];
    if entry < 0 && script {
        return 0.0;
    }
    match entry.abs() {
        1 => THIN_SPACE_EM,
        2 => MEDIUM_SPACE_EM,
        3 => THICK_SPACE_EM,
        _ => 0.0,
    }
}

/// 기호의 TeX 원자 분류.
pub(crate) fn symbol_class(text: &str) -> MathClass {
    match text {
        "=" | "<" | ">" | "<=" | ">=" | "!=" | "==" | "->" | "<<" | ">>" | "<<<" | ">>>" | ":"
        | "≤" | "≥" | "≠" | "≈" | "≡" | "∼" | "≃" | "≅" | "∝" | "≪" | "≫" | "→" | "←" | "↔"
        | "⇒" | "⇐" | "⇔" | "∈" | "∉" | "∋" | "⊂" | "⊃" | "⊆" | "⊇" | "≒" | "≐" | "∥" | "↦"
        | "⟶" | "⟵" | "⟹" | "⟸" | "⟺" => MathClass::Rel,
        "+" | "-" | "−" | "*" | "×" | "÷" | "±" | "∓" | "·" | "∙" | "∘" | "⊕" | "⊖" | "⊗" | "⊙"
        | "∪" | "∩" | "∧" | "∨" | "⊔" | "⊓" | "∖" => MathClass::Bin,
        "(" | "[" | "{" | "⟨" | "⌈" | "⌊" => MathClass::Open,
        ")" | "]" | "}" | "⟩" | "⌉" | "⌋" | "!" => MathClass::Close,
        "," | ";" => MathClass::Punct,
        // 도형 접두 기호(△ABC, ∠ABC, △x)는 뒤 피연산자와 thin space로 떨어진다.
        // 대체 서체의 도형 글립은 오른쪽 여백이 거의 없어 Ord로 두면 변수에 붙는다.
        "△" | "▽" | "∠" | "∡" | "∢" | "□" | "◇" | "○" | "⊿" => MathClass::Op,
        _ => MathClass::Ord,
    }
}
