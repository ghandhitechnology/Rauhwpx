//! 한컴 수식 스크립트 파싱 및 렌더링
//!
//! 수식 스크립트(버전 6.0)를 토큰화하고 AST로 변환한 뒤 SVG로 렌더링한다.
//! 참조: openhwp/docs/hwpx/appendix-i-formula.md

pub mod ast;
#[cfg(target_arch = "wasm32")]
pub mod canvas_render;
pub mod layout;
pub mod parser;
pub mod svg_render;
pub mod symbols;
pub mod tokenizer;

/// Natural equation box metrics in the renderer's pixel coordinate system.
///
/// Inline layout must use the same ascent/descent as the painter.  Deriving a
/// baseline from the stored object height (for example `height * 0.85`) moves
/// tall operators and fractions below the surrounding text baseline.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IntrinsicMetrics {
    pub width: f64,
    pub height: f64,
    pub baseline: f64,
}

/// Measure an EqEdit script with the exact parser/layout path used for paint.
pub fn intrinsic_metrics_px(script: &str, font_size: u32, dpi: f64) -> IntrinsicMetrics {
    let font_size_px = super::hwpunit_to_px(font_size.max(1) as i32, dpi);
    let tokens = tokenizer::tokenize(script);
    let ast = parser::EqParser::new(tokens).parse();
    let layout = layout::EqLayout::new(font_size_px).layout(&ast);
    IntrinsicMetrics {
        width: layout.width,
        height: layout.height,
        baseline: layout.baseline,
    }
}

/// Natural equation box metrics in HWPUNIT, used by line composition.
pub fn intrinsic_metrics_hwp(script: &str, font_size: u32) -> (u32, u32, u32) {
    let metrics = intrinsic_metrics_px(script, font_size, super::DEFAULT_DPI);
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

#[cfg(test)]
mod metric_tests {
    use super::*;

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
