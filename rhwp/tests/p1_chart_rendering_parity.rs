use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;

use rhwp::model::shape::{ChartShape, ChartType, DataSeries};
use rhwp::ole_chart::{
    chart_shape_to_ir, render_ole_chart_svg_body, render_ole_chart_svg_fragment, OleChart,
    OleChartSeries, OleChartType,
};
use rhwp::ooxml_chart::{BarGrouping, OoxmlChart, OoxmlChartType, OoxmlSeries, RadarStyle};
use rhwp::serializer::hwpx::serialize_hwpx;

const NATIVE_FAMILY_STEMS: &[&str] = &[
    "세로막대형/묶은세로막대형",
    "가로막대형/묶은가로막대형",
    "라인/표식이있는꺽은선형",
    "원형/2차원원형",
    "분산형/직선및표식이있는분산형",
    "기타/시가고가저가종가",
];

fn sample_bytes(relative: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn render_page0(bytes: &[u8]) -> String {
    let mut document = rhwp::wasm_api::HwpDocument::from_bytes(bytes).expect("parse chart fixture");
    document.render_page_svg(0).expect("render chart fixture")
}

fn zip_entry(bytes: &[u8], name: &str) -> Vec<u8> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("open HWPX archive");
    let mut file = archive.by_name(name).expect("find HWPX chart part");
    let mut output = Vec::new();
    file.read_to_end(&mut output).expect("read HWPX chart part");
    output
}

#[test]
fn native_hwp_and_hwpx_families_render_real_clipped_chart_svg() {
    for stem in NATIVE_FAMILY_STEMS {
        for extension in ["hwp", "hwpx"] {
            let relative = format!("samples/chart/{stem}.{extension}");
            let svg = render_page0(&sample_bytes(&relative));
            assert!(
                svg.contains("class=\"hwp-ooxml-chart\""),
                "{relative}: missing real chart SVG"
            );
            assert!(
                svg.contains("class=\"hwp-ooxml-chart-viewport\"")
                    && svg.contains("overflow=\"hidden\""),
                "{relative}: chart bbox clip/viewport missing"
            );
            assert!(
                !svg.contains("hwp-ooxml-chart-fallback")
                    && !svg.contains("차트 (미지원)")
                    && !svg.contains("차트 (Chart)"),
                "{relative}: unsupported chart placeholder remained"
            );
        }
    }
}

#[test]
fn native_hwpx_chart_passthrough_save_is_render_stable() {
    let source = sample_bytes("samples/chart/세로막대형/묶은세로막대형.hwpx");
    let before_svg = render_page0(&source);
    let document = rhwp::parse_document(&source).expect("parse source HWPX");
    let saved = serialize_hwpx(&document).expect("P0 HWPX passthrough save");
    let after_svg = render_page0(&saved);

    assert_eq!(
        zip_entry(&source, "Chart/chart1.xml"),
        zip_entry(&saved, "Chart/chart1.xml"),
        "editable native chart XML must pass through byte-for-byte"
    );
    assert_eq!(
        before_svg, after_svg,
        "chart render changed after HWPX save"
    );
    assert!(!after_svg.contains("hwp-ooxml-chart-fallback"));
}

#[test]
fn added_ooxml_family_fixtures_render_without_fallbacks() {
    let fixtures: &[(&str, OoxmlChartType, &str)] = &[
        (
            include_str!("fixtures/p1_charts/area.xml"),
            OoxmlChartType::Area,
            "hwp-chart-area-series",
        ),
        (
            include_str!("fixtures/p1_charts/doughnut.xml"),
            OoxmlChartType::Doughnut,
            "hwp-chart-doughnut-hole",
        ),
        (
            include_str!("fixtures/p1_charts/radar.xml"),
            OoxmlChartType::Radar,
            "hwp-chart-radar-series",
        ),
    ];

    for (xml, expected_type, render_class) in fixtures {
        let chart = OoxmlChart::parse(xml.as_bytes()).expect("parse OOXML chart fixture");
        assert_eq!(chart.chart_type, *expected_type);
        let svg = chart.render_svg(11.0, 17.0, 320.0, 210.0);
        assert!(
            svg.contains(render_class),
            "{expected_type:?} did not render"
        );
        assert!(svg.contains("viewBox=\"11.00 17.00 320.00 210.00\""));
        assert!(!svg.contains("hwp-ooxml-chart-fallback"));
        if *expected_type == OoxmlChartType::Area {
            assert_eq!(chart.title.as_deref(), Some("Area sales"));
            assert_eq!(chart.category_axis_title.as_deref(), Some("Quarter"));
            assert_eq!(chart.primary_value_axis_title.as_deref(), Some("Revenue"));
            assert_eq!(chart.series[0].color, Some(0x3366CC));
            assert!(chart.data_labels.show_value);
            assert!(svg.contains("hwp-chart-axis-title"));
            assert!(svg.contains("hwp-chart-data-label"));
        } else if *expected_type == OoxmlChartType::Doughnut {
            assert_eq!(chart.doughnut_hole_size, Some(62.0));
            assert!(svg.contains(">A 3</text>"));
        } else if *expected_type == OoxmlChartType::Radar {
            assert_eq!(chart.radar_style, RadarStyle::Marker);
            assert!(svg.contains("hwp-chart-marker"));
        }
    }
}

#[test]
fn area_grouping_is_preserved_and_percent_stacks_render_as_bands() {
    let xml = include_str!("fixtures/p1_charts/area.xml")
        .replace("val=\"standard\"", "val=\"percentStacked\"")
        .replace("</c:areaChart>", "<c:ser><c:tx><c:v>South</c:v></c:tx><c:val><c:numLit><c:pt idx=\"0\"><c:v>3</c:v></c:pt><c:pt idx=\"1\"><c:v>5</c:v></c:pt><c:pt idx=\"2\"><c:v>6</c:v></c:pt></c:numLit></c:val></c:ser></c:areaChart>");
    let chart = OoxmlChart::parse(xml.as_bytes()).expect("parse stacked area chart");

    assert_eq!(chart.area_grouping, BarGrouping::PercentStacked);
    let svg = chart.render_svg(0.0, 0.0, 360.0, 240.0);
    assert_eq!(svg.matches("class=\"hwp-chart-area-series\"").count(), 2);
    assert!(svg.contains(">100%</text>"));
    assert!(!svg.contains("NaN") && !svg.contains("inf"));
}

#[test]
fn point_data_label_overrides_are_not_promoted_to_the_whole_plot() {
    let xml = include_str!("fixtures/p1_charts/area.xml").replace(
        "<c:showVal val=\"1\"/>",
        "<c:dLbl><c:idx val=\"0\"/><c:showVal val=\"1\"/></c:dLbl>",
    );
    let chart = OoxmlChart::parse(xml.as_bytes()).expect("parse point label override");

    assert!(!chart.data_labels.show_value);
    assert!(!chart
        .render_svg(0.0, 0.0, 320.0, 210.0)
        .contains("hwp-chart-data-label"));
}

#[test]
fn single_slice_pie_and_opaque_values_produce_valid_svg() {
    let ooxml = OoxmlChart {
        chart_type: OoxmlChartType::Pie,
        categories: vec!["Only".to_string(), "Ignored".to_string()],
        series: vec![OoxmlSeries {
            name: "Share".to_string(),
            values: vec![7.0, f64::NAN],
            series_type: OoxmlChartType::Pie,
            ..Default::default()
        }],
        ..Default::default()
    };
    let ooxml_svg = ooxml.render_svg(0.0, 0.0, 200.0, 160.0);
    assert!(ooxml_svg.contains("<circle class=\"hwp-chart-pie-slice\""));
    assert!(!ooxml_svg.contains("NaN"));

    let legacy = OleChart {
        chart_type: OleChartType::Pie,
        title: None,
        categories: vec!["Only".to_string()],
        series: vec![OleChartSeries {
            name: Some("Share".to_string()),
            values: vec![7.0],
            color: Some(0x123456),
        }],
    };
    let legacy_svg = render_ole_chart_svg_body(&legacy, 200.0, 160.0);
    assert!(legacy_svg.contains("<circle class=\"hwp-ole-chart-pie-slice\""));
    assert!(legacy_svg.contains("#123456"));
    assert!(legacy_svg.contains(">Only</text>"));
    assert!(!legacy_svg.contains("stroke=\"#e5e7eb\""));
}

#[test]
fn decoded_chart_data_uses_legacy_chart_ir_and_preserves_order_and_colors() {
    let shape = ChartShape {
        chart_type: ChartType::Column,
        title: Some("Quarterly".to_string()),
        series: vec![
            DataSeries {
                name: "First".to_string(),
                values: vec![1.0, 2.0],
                categories: vec!["Q1".to_string(), "Q2".to_string()],
                color: Some(0x112233),
            },
            DataSeries {
                name: "Second".to_string(),
                values: vec![3.0, 4.0],
                categories: vec!["Q1".to_string(), "Q2".to_string()],
                color: Some(0xAABBCC),
            },
            DataSeries {
                name: "Empty".to_string(),
                values: Vec::new(),
                categories: Vec::new(),
                color: Some(0xFFFFFF),
            },
        ],
        ..Default::default()
    };
    let chart = chart_shape_to_ir(&shape).expect("decoded CHART_DATA should become chart IR");
    assert_eq!(chart.series[0].name.as_deref(), Some("First"));
    assert_eq!(chart.series[1].name.as_deref(), Some("Second"));
    assert_eq!(
        chart.series.len(),
        2,
        "empty model series should not render"
    );
    let svg = render_ole_chart_svg_fragment(&chart, 5.0, 7.0, 240.0, 160.0, 0);
    assert!(svg.contains("hwp-ole-chart-rust-svg"));
    assert!(svg.contains("#112233"));
    assert!(svg.contains("#aabbcc"));
    assert!(!svg.contains("OLE chart"));
}

#[test]
fn opaque_chart_data_is_not_assigned_invented_values() {
    let shape = ChartShape {
        raw_chart_data: vec![0xde, 0xad, 0xbe, 0xef],
        ..Default::default()
    };
    assert!(chart_shape_to_ir(&shape).is_none());
    assert!(OoxmlChart::parse(&shape.raw_chart_data).is_none());
}
