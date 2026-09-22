//! 페이지 안에 온전히 들어간 중첩 칸은 선언된 Center/Bottom valign을 유지한다.

#![cfg(not(target_arch = "wasm32"))]

use std::path::PathBuf;

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::Section;
use rhwp::model::page::PageDef;
use rhwp::model::paragraph::{LineSeg, Paragraph};
use rhwp::model::shape::{TextWrap, VertRelTo};
use rhwp::model::style::ParaShape;
use rhwp::model::table::{Cell, Table, VerticalAlign};
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const NESTED_SAMPLE: &str = "samples/hwpx_sample2.hwp";
const NESTED_DEPTH_SAMPLE2: usize = 2;

fn sample(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn parent_clip_fixture(align: VerticalAlign) -> RenderNode {
    let line = LineSeg {
        line_height: 800,
        text_height: 800,
        baseline_distance: 680,
        segment_width: 18000,
        ..Default::default()
    };
    let mut nested = Table {
        row_count: 1,
        col_count: 1,
        cells: vec![Cell {
            col_span: 1,
            row_span: 1,
            width: 18000,
            height: 10000,
            vertical_align: align,
            paragraphs: vec![Paragraph {
                text: "VISIBLE".to_owned(),
                char_count: 7,
                char_offsets: (0..=7).collect(),
                line_segs: vec![line.clone()],
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    };
    nested.common.width = 18000;
    nested.common.height = 10000;
    nested.common.text_wrap = TextWrap::TopAndBottom;
    nested.common.vert_rel_to = VertRelTo::Para;
    nested.rebuild_grid();
    let mut outer = Table {
        row_count: 1,
        col_count: 1,
        cells: vec![Cell {
            col_span: 1,
            row_span: 1,
            width: 30000,
            height: 12000,
            paragraphs: vec![
                Paragraph {
                    text: "ANCHOR".to_owned(),
                    char_count: 6,
                    char_offsets: (0..=6).collect(),
                    line_segs: vec![line],
                    controls: vec![Control::Table(Box::new(nested))],
                    ..Default::default()
                },
                Paragraph {
                    text: "TAIL".to_owned(),
                    char_count: 4,
                    char_offsets: (0..=4).collect(),
                    line_segs: vec![LineSeg {
                        vertical_pos: 10800,
                        line_height: 800,
                        text_height: 800,
                        baseline_distance: 680,
                        segment_width: 30000,
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            ],
            ..Default::default()
        }],
        ..Default::default()
    };
    outer.common.width = 30000;
    outer.common.height = 12000;
    outer.common.treat_as_char = true;
    outer.rebuild_grid();
    let mut section = Section::default();
    section.section_def.page_def = PageDef {
        width: 59529,
        height: 84189,
        margin_left: 8504,
        margin_right: 8504,
        margin_top: 5668,
        margin_bottom: 4252,
        ..Default::default()
    };
    section.paragraphs.push(Paragraph {
        controls: vec![Control::Table(Box::new(outer))],
        ..Default::default()
    });
    let mut core = DocumentCore::new_empty();
    let mut doc = core.document().clone();
    doc.doc_info.para_shapes = vec![ParaShape::default()];
    doc.sections = vec![section];
    core.set_document(doc);
    core.build_page_render_tree(0)
        .expect("부모 clip 반례 렌더")
        .root
}

fn outer_clip(node: &RenderNode) -> Option<(f64, f64)> {
    if let RenderNodeType::TableCell(cell) = &node.node_type {
        assert!(cell.clip, "paint가 실제 적용하는 부모 clip이어야 한다");
        return Some((node.bbox.y, node.bbox.y + node.bbox.height));
    }
    node.children.iter().find_map(outer_clip)
}

#[test]
fn a_fully_parent_contained_cell_keeps_center_and_bottom_alignment() {
    let top_root = parent_clip_fixture(VerticalAlign::Top);
    let top = nested_cell_contents(&top_root, NESTED_DEPTH_SAMPLE2);
    assert_eq!(top.len(), 1);
    let mut offsets = Vec::new();
    for align in [VerticalAlign::Center, VerticalAlign::Bottom] {
        let root = parent_clip_fixture(align);
        let (parent_top, parent_bottom) = outer_clip(&root).expect("부모 셀");
        let cells = nested_cell_contents(&root, NESTED_DEPTH_SAMPLE2);
        assert_eq!(cells.len(), 1);
        let cell = cells[0];
        assert!(cell.cell_y >= parent_top && cell.cell_y + cell.cell_h <= parent_bottom);
        offsets.push(cell.offset() - top[0].offset());
    }
    assert!(
        offsets[0] > 1.0,
        "Center 정렬 여유가 있어야 한다: {offsets:?}"
    );
    assert!(
        (offsets[1] - 2.0 * offsets[0]).abs() < 0.01,
        "Bottom은 Center의 두 배 여유: {offsets:?}"
    );
}

#[derive(Debug, Clone, Copy)]
struct CellContent {
    cell_x: f64,
    cell_y: f64,
    cell_h: f64,
    first_line_y: f64,
}

impl CellContent {
    fn offset(&self) -> f64 {
        self.first_line_y - self.cell_y
    }
}

fn nested_cell_contents(node: &RenderNode, min_depth: usize) -> Vec<CellContent> {
    fn first_line_y(node: &RenderNode) -> Option<f64> {
        let mut best: Option<f64> = None;
        if matches!(node.node_type, RenderNodeType::TextLine(_)) {
            best = Some(node.bbox.y);
        }
        for child in &node.children {
            if let Some(y) = first_line_y(child) {
                best = Some(best.map_or(y, |b: f64| b.min(y)));
            }
        }
        best
    }

    fn walk(node: &RenderNode, depth: usize, min_depth: usize, out: &mut Vec<CellContent>) {
        let is_cell = matches!(node.node_type, RenderNodeType::TableCell(_));
        let depth = depth + usize::from(is_cell);
        if is_cell && depth >= min_depth {
            if let Some(y) = first_line_y(node) {
                out.push(CellContent {
                    cell_x: node.bbox.x,
                    cell_y: node.bbox.y,
                    cell_h: node.bbox.height,
                    first_line_y: y,
                });
            }
        }
        for child in &node.children {
            walk(child, depth, min_depth, out);
        }
    }

    let mut out = Vec::new();
    walk(node, 0, min_depth, &mut out);
    out.sort_by(|a, b| {
        (a.cell_y, a.cell_x)
            .partial_cmp(&(b.cell_y, b.cell_x))
            .unwrap()
    });
    out.dedup_by(|a, b| (a.cell_y, a.cell_x) == (b.cell_y, b.cell_x));
    out
}

fn page_tree(rel: &str, page_num: u32) -> (RenderNode, f64) {
    let bytes = std::fs::read(sample(rel)).expect("정식 회귀 sample 읽기");
    let core = DocumentCore::from_bytes(&bytes).expect("문서 로드");
    let tree = core
        .build_page_render_tree(page_num)
        .expect("페이지 render tree");
    let page_bottom = tree.root.bbox.y + tree.root.bbox.height;
    (tree.root, page_bottom)
}

fn nested_row() -> (CellContent, CellContent, f64) {
    let (root, page_bottom) = page_tree(NESTED_SAMPLE, 18);
    let cells: Vec<CellContent> = nested_cell_contents(&root, NESTED_DEPTH_SAMPLE2)
        .into_iter()
        .filter(|c| (955.0..975.0).contains(&c.cell_y))
        .collect();
    assert_eq!(
        cells.len(),
        2,
        "이 시험의 전제는 중첩 표 한 행의 두 칸이다. 형상이 바뀌면 전제가 깨진다: {cells:?}"
    );
    (cells[0], cells[1], page_bottom)
}

#[test]
fn an_unclipped_nested_cell_keeps_its_declared_center_alignment() {
    let (picture_cell, text_cell, page_bottom) = nested_row();

    for cell in [picture_cell, text_cell] {
        assert!(
            cell.cell_y >= -0.5 && cell.cell_y + cell.cell_h <= page_bottom + 0.5,
            "전제 붕괴: 칸이 페이지 밖으로 나갔다 {cell:?} (page_bottom={page_bottom})"
        );
    }

    let slack = text_cell.offset() - picture_cell.offset();
    assert!(
        (1.0..=6.0).contains(&slack),
        "여유 있는 Center 칸이 정렬 몫을 받아야 한다. Top 강제면 0.00 이다. \
         실측 {slack:.2}px (그림칸 {:.2} · 글자칸 {:.2})",
        picture_cell.offset(),
        text_cell.offset()
    );
}

#[test]
fn the_cell_without_alignment_slack_stays_put() {
    let (picture_cell, _text_cell, _) = nested_row();
    assert!(
        picture_cell.offset() < 2.5,
        "여유 없는 칸은 여백만큼만 내려가야 한다. 실측 {:.2}px",
        picture_cell.offset()
    );
}
