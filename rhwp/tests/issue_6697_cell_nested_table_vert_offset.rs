//! Issue #6697 — cell-nested TopAndBottom+Para table honors `vertical_offset`.
//!
//! Synthetic DocumentCore fixture only. Nested tables are collected as
//! descendants of `RenderNodeType::TableCell(_)` (Rauhwpx `TableNode` has no
//! `cell_context`).
#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::page::PageDef;
use rhwp::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
use rhwp::model::shape::{TextWrap, VertRelTo};
use rhwp::model::style::{CharShape, ParaShape};
use rhwp::model::table::{Cell, Table};
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const POSITIVE_OFFSET_HU: u32 = 3062;
const NEGATIVE_OFFSET: u32 = (-22613i32) as u32;
const EXPECTED_LEAD_PX: f64 = 3062.0 / 75.0;

fn nested_table(vertical_offset: u32) -> Table {
    let mut table = Table {
        row_count: 1,
        col_count: 1,
        cells: vec![Cell {
            col: 0,
            row: 0,
            col_span: 1,
            row_span: 1,
            width: 12_000,
            height: 4_000,
            apply_inner_margin: true,
            paragraphs: vec![Paragraph::new_empty()],
            ..Default::default()
        }],
        ..Default::default()
    };
    table.common.treat_as_char = false;
    table.common.text_wrap = TextWrap::TopAndBottom;
    table.common.vert_rel_to = VertRelTo::Para;
    table.common.flow_with_text = true;
    table.common.vertical_offset = vertical_offset;
    table.common.width = 12_000;
    table.common.height = 4_000;
    table.rebuild_grid();
    table
}

fn host_para(vertical_offset: u32) -> Paragraph {
    Paragraph {
        text: "캡션".to_string(),
        char_count: 2,
        char_shapes: vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }],
        line_segs: vec![LineSeg {
            text_start: 0,
            line_height: 1000,
            text_height: 1000,
            baseline_distance: 850,
            line_spacing: 600,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }],
        controls: vec![Control::Table(Box::new(nested_table(vertical_offset)))],
        ..Default::default()
    }
}

fn outer_table(vertical_offset: u32) -> Table {
    let mut table = Table {
        row_count: 1,
        col_count: 1,
        cells: vec![Cell {
            col: 0,
            row: 0,
            col_span: 1,
            row_span: 1,
            width: 20_000,
            height: 16_000,
            apply_inner_margin: true,
            paragraphs: vec![host_para(vertical_offset)],
            ..Default::default()
        }],
        ..Default::default()
    };
    table.common.treat_as_char = true;
    table.common.flow_with_text = true;
    table.common.text_wrap = TextWrap::TopAndBottom;
    table.common.width = 20_000;
    table.common.height = 16_000;
    table.rebuild_grid();
    table
}

fn document(vertical_offset: u32) -> Document {
    let host = Paragraph {
        char_count: 1,
        line_segs: vec![LineSeg {
            line_height: 1000,
            line_spacing: 600,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }],
        controls: vec![Control::Table(Box::new(outer_table(vertical_offset)))],
        ..Default::default()
    };
    let mut section = Section::default();
    section.section_def.page_def = PageDef::a4_default();
    section.paragraphs.push(host);

    let mut doc = Document::default();
    doc.doc_info.para_shapes = vec![ParaShape::default()];
    doc.doc_info.char_shapes.push(CharShape {
        font_ids: [0; 7],
        ratios: [100; 7],
        relative_sizes: [100; 7],
        base_size: 1000,
        ..Default::default()
    });
    doc.sections.push(section);
    doc
}

fn render(vertical_offset: u32) -> rhwp::renderer::render_tree::PageRenderTree {
    let mut core = DocumentCore::new_empty();
    core.set_document(document(vertical_offset));
    core.build_page_render_tree(0).expect("page 1 render tree")
}

fn collect_nested_tables<'a>(node: &'a RenderNode, in_cell: bool, out: &mut Vec<&'a RenderNode>) {
    let in_cell = in_cell || matches!(node.node_type, RenderNodeType::TableCell(_));
    if in_cell && matches!(node.node_type, RenderNodeType::Table(_)) {
        out.push(node);
    }
    for child in &node.children {
        collect_nested_tables(child, in_cell, out);
    }
}

fn nested_table_y(vertical_offset: u32) -> f64 {
    let tree = render(vertical_offset);
    let mut nested = Vec::new();
    collect_nested_tables(&tree.root, false, &mut nested);
    assert_eq!(
        nested.len(),
        1,
        "expected exactly one cell-nested table, found {}",
        nested.len()
    );
    nested[0].bbox.y
}

#[test]
fn cell_nested_float_table_honors_vert_offset() {
    let y0 = nested_table_y(0);
    let y_off = nested_table_y(POSITIVE_OFFSET_HU);
    let delta = y_off - y0;
    assert!(
        (delta - EXPECTED_LEAD_PX).abs() <= 1.0,
        "nested table y must move by {EXPECTED_LEAD_PX:.3}px (3062 HU / 75); \
         got {delta:.3} (y0={y0:.3}, y_off={y_off:.3})"
    );
}

#[test]
fn negative_vert_offset_does_not_lift_the_nested_table() {
    let y0 = nested_table_y(0);
    let y_neg = nested_table_y(NEGATIVE_OFFSET);
    assert!(
        (y_neg - y0).abs() <= 1.0,
        "negative vert offset must stay within 1px of offset 0; \
         y0={y0:.3}, y_neg={y_neg:.3}"
    );
}
