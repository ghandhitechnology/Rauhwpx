//! Issue #1067: HWPX 도형 IR 화 + HWP/HWPX 회전 부호 정정 회귀 가드.
//!
//! 정정 영역 3 가지:
//!
//! 1. **HWPX `<hc:pt>` 점 파싱** (`src/parser/hwpx/section.rs::parse_shape_object`):
//!    polygon 의 가변 꼭짓점 (rect 의 pt0/pt1/pt2/pt3 와 별개) — 누락 시 PolygonShape::points
//!    빈 Vec → HWPX 의 도형 path 가 빈 상태로 렌더링되어 도형 미표시.
//!
//! 2. **flip + 회전 동시 적용 시 회전 부호 반전** (`src/renderer/svg.rs::open_shape_transform`,
//!    `src/renderer/web_canvas.rs::open_shape_transform`): 한컴 정답지 시각 표준 정합.
//!    누락 시 첫 도형이 180도 반시계 방향으로 잘못 회전 (작업지시자 보고).
//!
//! 3. **U+FFFC OBJECT REPLACEMENT CHARACTER skip** (`src/renderer/svg.rs::draw_text`,
//!    `src/renderer/web_canvas.rs::draw_text`): inline 컨트롤 (treat_as_char) placeholder 가
//!    paragraph text 의 U+FFFC 로 표현됨 — 시각적으로 invisible 해야 함.
//!
//! 작업지시자 시각 판정 통과 (Stage 1+2+3): "정답지 이미지 정합".

use rhwp::model::control::Control;
use rhwp::model::shape::ShapeObject;
use rhwp::parser::parse_document;
use std::fs;
use std::path::Path;

fn read_sample(rel: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", rel, e))
}

fn control_kind(ctrl: &Control) -> &'static str {
    match ctrl {
        Control::SectionDef(_) => "SectionDef",
        Control::ColumnDef(_) => "ColumnDef",
        Control::Shape(_) => "Shape",
        _ => "Other",
    }
}

fn extract_rotate_center_x(svg: &str, marker: &str) -> f64 {
    let start = svg
        .find(marker)
        .unwrap_or_else(|| panic!("SVG transform marker 없음: {}", marker))
        + marker.len();
    let end = svg[start..]
        .find(',')
        .unwrap_or_else(|| panic!("SVG rotate center x 구분자 없음: {}", marker));
    svg[start..start + end]
        .parse::<f64>()
        .unwrap_or_else(|e| panic!("SVG rotate center x parse 실패: {}: {}", marker, e))
}

/// HWPX polygon 의 `<hc:pt>` 점들이 IR PolygonShape::points 에 4 개로 매핑.
#[test]
fn issue_1067_hwpx_polygon_points_mapped() {
    let bytes = read_sample("samples/hwpx/shape-001.hwpx");
    let doc = parse_document(&bytes).expect("parse hwpx");
    let mut polygon_count = 0;
    for section in &doc.sections {
        for para in &section.paragraphs {
            for ctrl in &para.controls {
                if let Control::Shape(shape) = ctrl {
                    if let ShapeObject::Polygon(poly) = shape.as_ref() {
                        polygon_count += 1;
                        assert_eq!(
                            poly.points.len(),
                            4,
                            "HWPX polygon points: 4 점 매핑 필요 (parse_shape_object b\"pt\")"
                        );
                    }
                }
            }
        }
    }
    assert!(polygon_count >= 2, "shape-001.hwpx 는 최소 2 polygon 보유");
}

/// HWP 정답지의 polygon points 와 HWPX 의 points 완전 동일 (정답지 정합).
#[test]
fn issue_1067_hwpx_polygon_points_match_oracle() {
    let hwp_bytes = read_sample("samples/shape-001.hwp");
    let hwpx_bytes = read_sample("samples/hwpx/shape-001.hwpx");
    let hwp_doc = parse_document(&hwp_bytes).expect("parse hwp");
    let hwpx_doc = parse_document(&hwpx_bytes).expect("parse hwpx");

    let collect_polygon_points = |doc: &rhwp::model::document::Document| -> Vec<Vec<(i32, i32)>> {
        let mut out = Vec::new();
        for section in &doc.sections {
            for para in &section.paragraphs {
                for ctrl in &para.controls {
                    if let Control::Shape(shape) = ctrl {
                        if let ShapeObject::Polygon(poly) = shape.as_ref() {
                            out.push(poly.points.iter().map(|p| (p.x, p.y)).collect());
                        }
                    }
                }
            }
        }
        out
    };

    let hwp_polys = collect_polygon_points(&hwp_doc);
    let hwpx_polys = collect_polygon_points(&hwpx_doc);
    assert_eq!(hwp_polys, hwpx_polys, "HWP/HWPX polygon points 정합");
}

/// HWPX polygon 의 flip + rotation 정보가 IR 에 정확 보존.
#[test]
fn issue_1067_hwpx_polygon_flip_rotation_preserved() {
    let bytes = read_sample("samples/hwpx/shape-001.hwpx");
    let doc = parse_document(&bytes).expect("parse hwpx");
    let polygons: Vec<&rhwp::model::shape::PolygonShape> = doc
        .sections
        .iter()
        .flat_map(|s| &s.paragraphs)
        .flat_map(|p| &p.controls)
        .filter_map(|c| {
            if let Control::Shape(shape) = c {
                if let ShapeObject::Polygon(poly) = shape.as_ref() {
                    return Some(poly);
                }
            }
            None
        })
        .collect();
    assert!(polygons.len() >= 2, "polygon 개수 ≥ 2");
    // 도형 1: horz_flip=true, rotation=270
    assert!(
        polygons[0].drawing.shape_attr.horz_flip,
        "도형 1: horz_flip"
    );
    assert_eq!(
        polygons[0].drawing.shape_attr.rotation_angle, 270,
        "도형 1: rotation_angle = 270"
    );
    // 도형 2: horz_flip=false, rotation=90
    assert!(
        !polygons[1].drawing.shape_attr.horz_flip,
        "도형 2: horz_flip 없음"
    );
    assert_eq!(
        polygons[1].drawing.shape_attr.rotation_angle, 90,
        "도형 2: rotation_angle = 90"
    );
}

/// SVG export 결과의 첫 polygon transform 가 flip + rotate(-rotation) 형식 정합.
/// (한컴 시각 표준 — flip 동시 적용 시 회전 부호 반전).
#[test]
fn issue_1067_svg_rotation_sign_negated_with_flip() {
    let bytes = read_sample("samples/shape-001.hwp");
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse");
    let svg = doc.render_page_svg_native(0).expect("svg");

    // 도형 1 (horz_flip=true, rotation=270): SVG transform 에 rotate(-270, ...) 표시
    assert!(
        svg.contains("scale(-1,1) rotate(-270"),
        "첫 도형: flip + rotate(-rotation) 정합 (한컴 표준). svg snippet:\n{}",
        &svg[..svg.len().min(2000)]
    );
    // 도형 2 (flip 없음, rotation=90): 일반 rotate(90, ...)
    assert!(
        svg.contains("rotate(90,"),
        "두 번째 도형: flip 없는 rotate(90) 정합"
    );
}

/// SVG export 결과에 U+FFFC OBJECT REPLACEMENT CHARACTER 가 emit 되지 않음.
#[test]
fn issue_1067_svg_no_object_replacement_character() {
    let bytes = read_sample("samples/shape-001.hwp");
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse");
    let svg = doc.render_page_svg_native(0).expect("svg");
    assert!(
        !svg.contains('\u{FFFC}'),
        "SVG 에 U+FFFC (OBJ placeholder) 표시되지 않음 (inline 컨트롤 placeholder 는 invisible)"
    );
}

/// Issue #1071: HWPX secPr 도 HWP 와 같은 문단 control stream 슬롯을 가져야 한다.
///
/// secPr 를 `Section.section_def` 로만 보존하고 `Control::SectionDef` 를 만들지 않으면,
/// HWPX paragraph text 의 inline marker 수와 `para.controls` 순서가 어긋난다. 이 경우
/// treat-as-character 도형의 문단 내 가로 위치가 HWP 정답지보다 왼쪽으로 밀린다.
#[test]
fn issue_1071_hwpx_secpr_materialized_in_control_stream() {
    let hwp_bytes = read_sample("samples/shape-001.hwp");
    let hwpx_bytes = read_sample("samples/hwpx/shape-001.hwpx");
    let hwp_doc = parse_document(&hwp_bytes).expect("parse hwp");
    let hwpx_doc = parse_document(&hwpx_bytes).expect("parse hwpx");

    let hwp_para = &hwp_doc.sections[0].paragraphs[0];
    let hwpx_para = &hwpx_doc.sections[0].paragraphs[0];

    let hwp_kinds: Vec<_> = hwp_para.controls.iter().map(control_kind).collect();
    let hwpx_kinds: Vec<_> = hwpx_para.controls.iter().map(control_kind).collect();
    assert_eq!(
        hwpx_kinds, hwp_kinds,
        "HWPX secPr/colPr/shape control stream 은 HWP 정답지와 같은 순서여야 함"
    );
    assert_eq!(
        hwpx_para.char_offsets, hwp_para.char_offsets,
        "HWPX char_offsets 도 HWP 정답지와 같아야 TAC control 위치가 안정됨"
    );
    assert_eq!(
        hwpx_para.control_text_positions(),
        hwp_para.control_text_positions(),
        "HWPX control_text_positions 는 HWP 정답지와 같아야 함"
    );
}

/// Issue #1071: HWPX TAC 도형의 SVG 가로 위치가 HWP 정답지와 같아야 한다.
#[test]
fn issue_1071_hwpx_tac_shape_svg_centers_match_hwp() {
    let hwp_bytes = read_sample("samples/shape-001.hwp");
    let hwpx_bytes = read_sample("samples/hwpx/shape-001.hwpx");
    let hwp_doc = rhwp::wasm_api::HwpDocument::from_bytes(&hwp_bytes).expect("parse hwp");
    let hwpx_doc = rhwp::wasm_api::HwpDocument::from_bytes(&hwpx_bytes).expect("parse hwpx");
    let hwp_svg = hwp_doc.render_page_svg_native(0).expect("hwp svg");
    let hwpx_svg = hwpx_doc.render_page_svg_native(0).expect("hwpx svg");

    for marker in ["rotate(-270,", "rotate(90,"] {
        let hwp_x = extract_rotate_center_x(&hwp_svg, marker);
        let hwpx_x = extract_rotate_center_x(&hwpx_svg, marker);
        assert!(
            (hwp_x - hwpx_x).abs() < 0.01,
            "HWP/HWPX TAC shape center mismatch: marker={marker}, hwp={hwp_x}, hwpx={hwpx_x}"
        );
    }
}
