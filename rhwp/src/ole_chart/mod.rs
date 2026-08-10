//! HWP OLE `Contents` 기반 차트 파싱 골격.
//!
//! 구버전/Neo 계열 HWP 차트 OLE는 `OOXMLChartContents`나 `OlePres000`
//! 미리보기 없이 `Contents` 스트림만 담는 경우가 있다. 이 모듈은 해당
//! 스트림을 차트 IR로 해석하기 위한 전용 진입점이다.

pub mod ir;
pub mod parser;
pub mod svg_renderer;

pub use ir::{
    ole_chart_ir_base64, ole_chart_ir_json, OleChartIrPayload, OLE_CHART_IR_SCHEMA,
    OLE_CHART_IR_VERSION,
};
pub use parser::{
    parse_ole_chart_contents, probe_ole_chart_contents, OleChart, OleChartContentsProbe,
    OleChartParseError, OleChartSeries, OleChartType,
};
pub use svg_renderer::{
    render_ole_chart_standalone_svg, render_ole_chart_svg_body, render_ole_chart_svg_fragment,
};

/// Convert an already-decoded legacy `CHART_DATA` model into the renderer-neutral
/// chart IR. Raw bytes are deliberately not guessed here: callers get `None`
/// until the parser has produced actual series values.
pub fn chart_shape_to_ir(shape: &crate::model::shape::ChartShape) -> Option<OleChart> {
    use crate::model::shape::ChartType;

    if shape.series.is_empty() || shape.series.iter().all(|series| series.values.is_empty()) {
        return None;
    }
    let chart_type = match shape.chart_type {
        ChartType::Column => OleChartType::Column,
        ChartType::Bar => OleChartType::Bar,
        ChartType::Line => OleChartType::Line,
        ChartType::Pie => OleChartType::Pie,
        ChartType::Area => OleChartType::Area,
        ChartType::Scatter => OleChartType::Scatter,
        ChartType::Unknown => OleChartType::Unknown,
    };
    let categories = shape
        .x_axis
        .as_ref()
        .map(|axis| axis.labels.clone())
        .filter(|labels| !labels.is_empty())
        .or_else(|| {
            shape
                .series
                .iter()
                .find(|series| !series.categories.is_empty())
                .map(|series| series.categories.clone())
        })
        .unwrap_or_else(|| {
            let len = shape
                .series
                .iter()
                .map(|series| series.values.len())
                .max()
                .unwrap_or(0);
            (1..=len).map(|index| index.to_string()).collect()
        });
    Some(OleChart {
        chart_type,
        title: shape.title.clone(),
        categories,
        series: shape
            .series
            .iter()
            .filter(|series| !series.values.is_empty())
            .map(|series| OleChartSeries {
                name: (!series.name.is_empty()).then(|| series.name.clone()),
                values: series.values.clone(),
                color: series.color,
            })
            .collect(),
    })
}
