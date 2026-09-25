//! 한컴 수식 스크립트 파싱 및 렌더링
//!
//! 수식 스크립트(버전 6.0)를 토큰화하고 AST로 변환한 뒤 SVG로 렌더링한다.
//! 참조: openhwp/docs/hwpx/appendix-i-formula.md

pub mod ast;
pub mod canonical;
#[cfg(target_arch = "wasm32")]
pub mod canvas_render;
pub(crate) mod font;
pub mod layout;
pub(crate) mod legacy_hwpeq;
pub(crate) mod measure;
pub mod parser;
pub mod svg_render;
pub mod symbols;
pub mod tokenizer;

/// 개체 공통 너비는 바깥 여백을 제외한 값이다. 인라인 슬롯에 양쪽 여백을 예약한다.
pub(crate) fn occupied_width_hwp(eq: &crate::model::control::Equation) -> i32 {
    (i64::from(eq.common.width)
        + i64::from(eq.common.margin.left)
        + i64::from(eq.common.margin.right))
    .clamp(0, i64::from(i32::MAX)) as i32
}

/// EQEDIT baseLine은 저장된 개체 높이의 백분율이다. 없는 값만 자연 기준선으로 보완한다.
pub(crate) fn control_baseline_hwp(eq: &crate::model::control::Equation, natural: f64) -> f64 {
    if eq.common.height > 0 && (1..=100).contains(&eq.baseline) {
        f64::from(eq.common.height) * f64::from(eq.baseline) / 100.0
    } else {
        natural
    }
}

/// Natural equation box metrics in the renderer's pixel coordinate system.
///
/// Inline layout must use the same ascent/descent as the painter.  Deriving a
/// baseline from an arbitrary fraction of object height moves tall operators.
/// An authored EQEDIT baseline remains a separate placement contract.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IntrinsicMetrics {
    pub width: f64,
    pub height: f64,
    pub baseline: f64,
}

/// Measure an EqEdit script with the exact parser/layout path used for paint.
pub fn intrinsic_metrics_px(script: &str, font_size: u32, dpi: f64) -> IntrinsicMetrics {
    intrinsic_metrics_px_with_font(script, font_size, dpi, "")
}

pub fn intrinsic_metrics_px_with_font(
    script: &str,
    font_size: u32,
    dpi: f64,
    font_name: &str,
) -> IntrinsicMetrics {
    intrinsic_metrics_px_with_version(script, font_size, dpi, font_name, "Equation Version 60")
}

pub fn intrinsic_metrics_px_with_version(
    script: &str,
    font_size: u32,
    dpi: f64,
    font_name: &str,
    version_info: &str,
) -> IntrinsicMetrics {
    let font_size_px = super::hwpunit_to_px(font_size.max(1) as i32, dpi);
    let tokens = tokenizer::tokenize(script);
    let ast = parser::EqParser::new(tokens).parse();
    let layout = layout::EqLayout::with_font(font_size_px, font_name)
        .with_version(version_info)
        .layout(&ast);
    IntrinsicMetrics {
        width: layout.width,
        height: layout.height,
        baseline: layout.baseline,
    }
}

/// 저장 개체 폭 안에 배치한 수식의 실제 paint 폭(HWPUNIT).
///
/// painter는 `layout_in_control_width`로 원자 간격을 줄여 저장 폭에 맞춘다. 최소 간격으로도
/// 넘칠 때만 자연 폭이 저장 폭보다 커지며, 줄 advance는 그 초과분만 더해야 한다.
pub fn fitted_width_hwp(eq: &crate::model::control::Equation) -> u32 {
    let font_size_px = super::hwpunit_to_px(eq.font_size.max(1) as i32, super::DEFAULT_DPI);
    let ast = parser::EqParser::new(tokenizer::tokenize(&eq.script)).parse();
    let stored = super::hwpunit_to_px(eq.common.width as i32, super::DEFAULT_DPI);
    let layout = layout::EqLayout::with_font(font_size_px, &eq.font_name)
        .with_version(&eq.version_info)
        .layout_in_control_width(&ast, stored);
    super::px_to_hwpunit(layout.width, super::DEFAULT_DPI).max(1) as u32
}

/// Natural equation box metrics in HWPUNIT, used by line composition.
pub fn intrinsic_metrics_hwp(script: &str, font_size: u32) -> (u32, u32, u32) {
    intrinsic_metrics_hwp_with_font(script, font_size, "")
}

pub fn intrinsic_metrics_hwp_with_font(
    script: &str,
    font_size: u32,
    font_name: &str,
) -> (u32, u32, u32) {
    intrinsic_metrics_hwp_with_version(script, font_size, font_name, "Equation Version 60")
}

pub fn intrinsic_metrics_hwp_with_version(
    script: &str,
    font_size: u32,
    font_name: &str,
    version_info: &str,
) -> (u32, u32, u32) {
    let metrics = intrinsic_metrics_px_with_version(
        script,
        font_size,
        super::DEFAULT_DPI,
        font_name,
        version_info,
    );
    let height = super::px_to_hwpunit(metrics.height, super::DEFAULT_DPI).max(1) as u32;
    let baseline =
        super::px_to_hwpunit(metrics.baseline, super::DEFAULT_DPI).clamp(0, height as i32) as u32;
    (
        super::px_to_hwpunit(metrics.width, super::DEFAULT_DPI).max(1) as u32,
        height,
        baseline,
    )
}

/// 수식 스크립트와 BaseUnit에서 레이아웃이 소비할 intrinsic HWPUNIT 크기를 계산한다.
pub fn intrinsic_size_hwp(script: &str, font_size: u32) -> (u32, u32) {
    let (width, height, _) = intrinsic_metrics_hwp(script, font_size);
    (width, height)
}

pub fn intrinsic_size_hwp_with_font(script: &str, font_size: u32, font_name: &str) -> (u32, u32) {
    let (width, height, _) = intrinsic_metrics_hwp_with_font(script, font_size, font_name);
    (width, height)
}

#[cfg(test)]
mod metric_tests {
    use super::*;

    #[test]
    fn source_control_metrics_keep_margins_baseline_and_natural_glyph_size_separate() {
        use crate::model::{control::Equation, Padding};
        let mut eq = Equation::default();
        eq.common.width = 3000;
        eq.common.height = 2400;
        eq.common.margin = Padding {
            left: 75,
            right: 150,
            top: 100,
            bottom: 200,
        };
        eq.baseline = 65;
        assert_eq!(occupied_width_hwp(&eq), 3225);
        assert_eq!(control_baseline_hwp(&eq, 1700.0), 1560.0);
        eq.baseline = 0;
        assert_eq!(control_baseline_hwp(&eq, 1700.0), 1700.0);
        eq.baseline = 101;
        assert_eq!(control_baseline_hwp(&eq, 1700.0), 1700.0);
        let ast = parser::EqParser::new(tokenizer::tokenize("x over L")).parse();
        for version in ["", "Equation Version 60"] {
            let engine = layout::EqLayout::with_font(16.0, "HYhwpEQ").with_version(version);
            let natural = engine.layout(&ast);
            let placed = engine.layout_in_control_width(&ast, natural.width + 12.0);
            assert_eq!(placed.x, 6.0);
            assert_eq!(placed.width, natural.width);
            assert_eq!(placed.height, natural.height);
            assert_eq!(placed.baseline, natural.baseline);
            assert_eq!(
                engine.layout_in_control_width(&ast, natural.width - 2.0).x,
                0.0
            );
        }
    }

    #[test]
    fn big_operator_exposes_its_real_baseline() {
        let (_, height, baseline) = intrinsic_metrics_hwp("W = sum_{i=1}^{n} u_i", 1000);

        assert!(baseline > 0 && baseline < height);
        assert!(
            baseline < (height as f64 * 0.85).round() as u32,
            "a summation baseline must not be synthesized from 85% of its total height"
        );
    }
}
