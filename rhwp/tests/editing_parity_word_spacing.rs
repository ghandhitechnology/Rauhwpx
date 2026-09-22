//! Imported mixed-format whitespace must not invent visible justification slack.
//! These are layout invariants, not new independently captured Hancom recipes.

use rhwp::document_core::DocumentCore;
use rhwp::model::{
    control::Control,
    paragraph::{CharShapeRef, LineSeg, Paragraph},
    provenance::FontMetricsPolicy,
};
use serde_json::Value;

const FIRST: &str = "그림 앞 문장입니다.";

fn document(in_cell: bool, trailing_font_size: i32) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let mut table_address = None;
    if in_cell {
        let result: Value =
            serde_json::from_str(&core.create_table_native(0, 0, 0, 2, 2).unwrap()).unwrap();
        table_address = Some((
            result["paraIdx"].as_u64().unwrap() as usize,
            result["controlIdx"].as_u64().unwrap() as usize,
        ));
    }
    let mut doc = core.document().clone();
    let mut shape = doc.doc_info.char_shapes[0].clone();
    shape.raw_data = None;
    shape.base_size = trailing_font_size;
    let trailing_style = doc.doc_info.char_shapes.len() as u32;
    doc.doc_info.char_shapes.push(shape);

    let text = format!("{FIRST}    다음 줄입니다.");
    let second_start = FIRST.chars().count() as u32 + 4;
    let line = LineSeg {
        line_height: 3600,
        text_height: 3600,
        baseline_distance: 3000,
        segment_width: 20000,
        tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
        ..Default::default()
    };
    let para = Paragraph {
        char_count: text.encode_utf16().count() as u32 + 1,
        char_offsets: (0..text.chars().count() as u32).collect(),
        text,
        has_para_text: true,
        char_shapes: vec![
            CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            },
            // Only the last of four trailing spaces changes size.
            CharShapeRef {
                start_pos: second_start - 1,
                char_shape_id: trailing_style,
            },
            CharShapeRef {
                start_pos: second_start,
                char_shape_id: 0,
            },
        ],
        line_segs: vec![
            line.clone(),
            LineSeg {
                text_start: second_start,
                vertical_pos: 5000,
                ..line
            },
        ],
        ..Default::default()
    };
    if let Some((parent, control)) = table_address {
        let Control::Table(table) = &mut doc.sections[0].paragraphs[parent].controls[control]
        else {
            panic!("expected table");
        };
        table.cells[0].paragraphs = vec![para];
    } else {
        doc.sections[0].paragraphs.push(para);
    }
    DocumentCore::from_bytes_with_font_metrics(
        &rhwp::serializer::hwpx::serialize_hwpx(&doc).unwrap(),
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap()
}

fn first_line_glyphs(core: &DocumentCore) -> Vec<(char, f64)> {
    let layout: Value =
        serde_json::from_str(&core.get_page_text_layout_native(0).unwrap()).unwrap();
    let runs = layout["runs"].as_array().unwrap();
    let first = runs
        .iter()
        .find(|r| r["text"].as_str().is_some_and(|t| t.starts_with("그림")))
        .unwrap();
    let y = first["y"].as_f64().unwrap();
    let mut glyphs = Vec::new();
    for run in runs.iter().filter(|r| r["y"].as_f64() == Some(y)) {
        let x = run["x"].as_f64().unwrap();
        for (index, ch) in run["text"].as_str().unwrap().chars().enumerate() {
            if !ch.is_whitespace() {
                glyphs.push((ch, x + run["charX"][index].as_f64().unwrap()));
            }
        }
    }
    assert_eq!(
        glyphs.iter().map(|(ch, _)| *ch).collect::<String>(),
        FIRST.replace(' ', "")
    );
    glyphs
}

fn assert_trailing_font_does_not_shift_words(in_cell: bool) {
    let expected = first_line_glyphs(&document(in_cell, 1000));
    for font_size in [600, 3600] {
        let mut core = document(in_cell, font_size);
        for cycle in 0..=3 {
            let actual = first_line_glyphs(&core);
            for ((ch, x), (_, expected_x)) in actual.iter().zip(&expected) {
                assert!((x - expected_x).abs() < 0.001,
                    "cell={in_cell}, size={font_size}, reopen={cycle}, glyph={ch}: {x} vs {expected_x}");
            }
            if cycle < 3 {
                core = DocumentCore::from_bytes_with_font_metrics(
                    &core.export_hwpx_native().unwrap(),
                    FontMetricsPolicy::HcrDeclared,
                )
                .unwrap();
            }
        }
    }
}

#[test]
fn body_mixed_trailing_whitespace_preserves_visible_word_positions() {
    assert_trailing_font_does_not_shift_words(false);
}

#[test]
fn cell_mixed_trailing_whitespace_preserves_visible_word_positions() {
    assert_trailing_font_does_not_shift_words(true);
}

fn assert_short_and_forced_lines_keep_natural_spacing(in_cell: bool) {
    for (forced_break, image) in [(false, false), (true, false), (true, true)] {
        let mut blank = DocumentCore::new_empty();
        blank.create_blank_document_native().unwrap();
        let mut core = DocumentCore::from_bytes_with_font_metrics(
            &blank.export_hwpx_native().unwrap(),
            FontMetricsPolicy::HcrDeclared,
        )
        .unwrap();
        let mut parent = 0;
        let mut path = Vec::new();
        if in_cell {
            let result: Value =
                serde_json::from_str(&core.create_table_native(0, 0, 0, 2, 2).unwrap()).unwrap();
            parent = result["paraIdx"].as_u64().unwrap() as usize;
            path.push((result["controlIdx"].as_u64().unwrap() as usize, 0, 0));
        }
        let text = if forced_break {
            format!("{FIRST}\n다음 줄입니다.")
        } else {
            FIRST.into()
        };
        if in_cell {
            core.insert_text_in_cell_by_path(0, parent, &path, 0, &text)
                .unwrap();
        } else {
            core.insert_text_native(0, parent, 0, &text).unwrap();
        }
        if image {
            core.insert_picture_with_placement_native(
                0,
                parent,
                FIRST.chars().count() + 1,
                &path,
                include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0-xml14/grid.png"),
                18000,
                9000,
                240,
                120,
                "png",
                "Spacing regression",
                None,
                None,
                true,
            )
            .unwrap();
        }
        let format = |core: &mut DocumentCore, props: &str| {
            if in_cell {
                core.apply_para_format_in_cell_by_path(0, parent, &path, props)
                    .unwrap();
            } else {
                core.apply_para_format_native(0, parent, props).unwrap();
            }
        };
        format(&mut core, r#"{"alignment":"left"}"#);
        let natural = first_line_glyphs(&core);
        format(&mut core, r#"{"alignment":"justify"}"#);
        for cycle in 0..=3 {
            assert_eq!(
                first_line_glyphs(&core),
                natural,
                "cell={in_cell}, forced={forced_break}, image={image}, reopen={cycle}"
            );
            if cycle < 3 {
                core = DocumentCore::from_bytes_with_font_metrics(
                    &core.export_hwpx_native().unwrap(),
                    FontMetricsPolicy::HcrDeclared,
                )
                .unwrap();
            }
        }
    }
}

#[test]
fn body_short_and_forced_lines_keep_natural_spacing_with_or_without_a_picture() {
    assert_short_and_forced_lines_keep_natural_spacing(false);
}

#[test]
fn cell_short_and_forced_lines_keep_natural_spacing_with_or_without_a_picture() {
    assert_short_and_forced_lines_keep_natural_spacing(true);
}
