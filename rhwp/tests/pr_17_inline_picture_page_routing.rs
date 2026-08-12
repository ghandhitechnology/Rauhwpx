//! PR #17 — 인라인(treat_as_char) 그림의 페이지 라우팅 회귀 방지.
//!
//! [Issue #476] 라우팅은 인라인 객체를 "박스가 속한 줄이 놓인 페이지" 에 등록하지만,
//! 두 조판 엔진 모두 `Control::Shape` 에만 적용하고 `Control::Picture` 는 무조건
//! 현재(= 문단의 마지막) 페이지에 push 했다. 그래서 페이지 분할된 문단의 인라인
//! 그림은
//!   1) 줄 안에서 paragraph_layout 이 한 번 (올바른 페이지),
//!   2) 다른 페이지에서 `layout_shape_item` fallback 이 한 번 (잘못된 페이지)
//! 총 두 번 그려졌다. fallback 억제 조건이 `PageItem::FullParagraph` 만 확인해
//! 분할 문단(= PartialParagraph 조각만 남음)에서는 항상 거짓이 된 것이 두 번째 구멍.
//!
//! 픽스처: `samples/issue2006/1790387_prep_final_report.hwpx` (Issue #2006 핀 문서).
//! sec2/pi16 등 인라인 그림 문단이 페이지 경계에 걸쳐 있고, sec3/pi367.. 계열은
//! 한 문단에 인라인 그림 2장(ci=0, ci=1)이 들어 있어 라우팅 구멍과 layout 억제
//! 구멍을 동시에 덮는다.

use rhwp::model::control::Control;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::wasm_api::HwpDocument;
use std::collections::BTreeMap;

/// 그림 키 = (section, para, control).
type PicKey = (usize, usize, usize);

/// 렌더 트리의 ImageNode 를 키 + y 좌표로 수집한다.
fn collect_images(node: &RenderNode, out: &mut Vec<(PicKey, f64)>) {
    if let RenderNodeType::Image(img) = &node.node_type {
        if let (Some(sec), Some(para), Some(ctrl)) =
            (img.section_index, img.para_index, img.control_index)
        {
            out.push(((sec, para, ctrl), node.bbox.y));
        }
    }
    for child in &node.children {
        collect_images(child, out);
    }
}

/// 문서 전체 페이지를 조판해 그림 키별 (페이지, y) 목록을 만든다.
fn image_placements(doc: &HwpDocument) -> BTreeMap<PicKey, Vec<(u32, f64)>> {
    let mut map: BTreeMap<PicKey, Vec<(u32, f64)>> = BTreeMap::new();
    for page in 0..doc.page_count() {
        let tree = doc
            .build_page_render_tree(page)
            .unwrap_or_else(|e| panic!("page {page} render tree: {e:?}"));
        let mut found = Vec::new();
        collect_images(&tree.root, &mut found);
        for (key, y) in found {
            map.entry(key).or_default().push((page, y));
        }
    }
    map
}

fn load_prep() -> HwpDocument {
    let bytes = std::fs::read("samples/issue2006/1790387_prep_final_report.hwpx")
        .expect("samples/issue2006/1790387_prep_final_report.hwpx");
    HwpDocument::from_bytes(&bytes).expect("parse")
}

/// 인라인 그림은 문서 전체에서 정확히 한 페이지에만 그려져야 한다.
#[test]
fn inline_tac_picture_is_rendered_exactly_once() {
    let doc = load_prep();
    let placements = image_placements(&doc);
    let sections = &doc.document().sections;

    let mut checked = 0usize;
    let mut duplicated: Vec<String> = Vec::new();
    for (&(sec, para, ctrl), placed) in &placements {
        // 인라인(treat_as_char) 그림만 검사 대상 — 앵커 그림은 대상 아님.
        let is_inline_pic = sections
            .get(sec)
            .and_then(|s| s.paragraphs.get(para))
            .and_then(|p| p.controls.get(ctrl))
            .is_some_and(|c| matches!(c, Control::Picture(pic) if pic.common.treat_as_char));
        if !is_inline_pic {
            continue;
        }
        checked += 1;
        if placed.len() > 1 {
            duplicated.push(format!("sec{sec}/pi{para}/ci{ctrl} -> {placed:?}"));
        }
    }

    assert!(checked >= 200, "인라인 그림 표본이 너무 적다: {checked}장");
    assert!(
        duplicated.is_empty(),
        "인라인 그림이 두 페이지에 중복 렌더됨 ({}건):\n{}",
        duplicated.len(),
        duplicated.join("\n")
    );
}

/// 회귀의 핵심 좌표 핀 — 분할 문단의 인라인 그림은 자기 줄이 있는 페이지에만 존재한다.
///
/// 픽스 전: sec2/pi16/ci0 이 69·70쪽, sec3/pi367/ci0 이 116·117쪽에 함께 나타났다.
/// 라우팅(typeset/engine)만 고치면 같은 문단의 둘째 그림(ci=1)이 116·117쪽에 남는다 —
/// layout 쪽 억제 조건까지 넓혀야 1장으로 수렴한다.
#[test]
fn split_host_paragraph_pins_inline_pictures_to_their_own_page() {
    let doc = load_prep();
    let placements = image_placements(&doc);

    let pin = |sec: usize, para: usize, ctrl: usize| -> (u32, f64) {
        let placed = placements
            .get(&(sec, para, ctrl))
            .unwrap_or_else(|| panic!("sec{sec}/pi{para}/ci{ctrl} 그림이 렌더되지 않았다"));
        assert_eq!(
            placed.len(),
            1,
            "sec{sec}/pi{para}/ci{ctrl} 는 1장이어야 하는데 {placed:?}"
        );
        placed[0]
    };

    assert_eq!(pin(2, 16, 0).0, 69, "sec2/pi16 인라인 그림은 70쪽에만");
    assert_eq!(pin(2, 25, 0).0, 70, "sec2/pi25 인라인 그림은 71쪽에만");
    assert_eq!(pin(3, 188, 0).0, 91, "sec3/pi188 인라인 그림은 92쪽에만");

    // 인라인 그림 2장이 든 분할 문단 — 각 그림이 자기 줄이 놓인 페이지에 1장씩.
    let (p367_a, y367_a) = pin(3, 367, 0);
    let (p367_b, y367_b) = pin(3, 367, 1);
    assert_eq!((p367_a, p367_b), (116, 117));
    let (p379_a, _) = pin(3, 379, 0);
    let (p379_b, _) = pin(3, 379, 1);
    assert_eq!((p379_a, p379_b), (140, 141));

    // 잘못 라우팅된 사본은 본문 하단 밖(y≈1000px, col_bottom=1020.5)에서 시작했다.
    // 정상 인라인 배치는 본문 상단이다.
    for (label, y) in [("sec3/pi367/ci0", y367_a), ("sec3/pi367/ci1", y367_b)] {
        assert!(
            y < 200.0,
            "{label} 인라인 그림이 본문 하단 잔상 위치에 있다: y={y:.1}"
        );
    }
}

/// 라우팅 헬퍼는 Shape/Picture/Equation 의 treat_as_char 만 인라인으로 본다.
#[test]
fn is_inline_tac_control_covers_shape_picture_equation() {
    use rhwp::model::control::Equation;
    use rhwp::model::image::Picture;
    use rhwp::model::shape::{RectangleShape, ShapeObject};
    use rhwp::renderer::pagination::is_inline_tac_control;

    let mut pic = Picture::default();
    pic.common.treat_as_char = true;
    assert!(is_inline_tac_control(&Control::Picture(Box::new(
        pic.clone()
    ))));
    pic.common.treat_as_char = false;
    assert!(!is_inline_tac_control(&Control::Picture(Box::new(pic))));

    let mut eq = Equation::default();
    eq.common.treat_as_char = true;
    assert!(is_inline_tac_control(&Control::Equation(Box::new(
        eq.clone()
    ))));
    eq.common.treat_as_char = false;
    assert!(!is_inline_tac_control(&Control::Equation(Box::new(eq))));

    let mut rect = RectangleShape::default();
    rect.common.treat_as_char = true;
    assert!(is_inline_tac_control(&Control::Shape(Box::new(
        ShapeObject::Rectangle(rect.clone())
    ))));
    rect.common.treat_as_char = false;
    assert!(!is_inline_tac_control(&Control::Shape(Box::new(
        ShapeObject::Rectangle(rect)
    ))));

    // 표 등은 인라인 라우팅 대상이 아니다.
    assert!(!is_inline_tac_control(&Control::Table(Box::new(
        rhwp::model::table::Table::default()
    ))));
}
