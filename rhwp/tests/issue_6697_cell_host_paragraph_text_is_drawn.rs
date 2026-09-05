//! Issue #6702 / #6697 — host cell paragraph text is drawn when a block table
//! shares the paragraph.
//!
//! Same synthetic shape as `issue_6697_cell_nested_table_vert_offset`: caption
//! text plus a nested TopAndBottom+Para table. Flattened TextRun text must
//! contain `캡션`.
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

fn nested_table() -> Table {
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
    table.common.vertical_offset = 3062;
    table.common.width = 12_000;
    table.common.height = 4_000;
    table.rebuild_grid();
    table
}

fn host_para() -> Paragraph {
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
        controls: vec![Control::Table(Box::new(nested_table()))],
        ..Default::default()
    }
}

fn outer_table() -> Table {
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
            paragraphs: vec![host_para()],
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

fn document() -> Document {
    let host = Paragraph {
        char_count: 1,
        line_segs: vec![LineSeg {
            line_height: 1000,
            line_spacing: 600,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }],
        controls: vec![Control::Table(Box::new(outer_table()))],
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

fn flatten_text_runs(node: &RenderNode, out: &mut String) {
    if let RenderNodeType::TextRun(run) = &node.node_type {
        out.push_str(&run.text);
    }
    for child in &node.children {
        flatten_text_runs(child, out);
    }
}

#[test]
fn cell_host_paragraph_text_is_drawn() {
    let mut core = DocumentCore::new_empty();
    core.set_document(document());
    let tree = core.build_page_render_tree(0).expect("page 1 render tree");

    let mut text = String::new();
    flatten_text_runs(&tree.root, &mut text);
    let flattened: String = text.chars().filter(|ch| !ch.is_whitespace()).collect();
    assert!(
        flattened.contains("캡션"),
        "host cell paragraph text must be drawn; flattened={flattened:?}"
    );
}
