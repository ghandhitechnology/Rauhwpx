use crate::document_core::DocumentCore;
use crate::model::bin_data::BinDataContent;
use crate::model::paragraph::{CharShapeRef, Paragraph};
use crate::model::style::{CharShape, Font};
use serde_json::Value;

const FONT: &[u8] = include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf");

fn document(text: &str) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let mut document = core.document.clone();
    document.doc_info.font_faces = vec![
        vec![Font {
            name: "RHWP Shaping Fixture".into(),
            is_embedded: true,
            resolved_bin_data_id: Some(1),
            ..Default::default()
        }];
        7
    ];
    document.doc_info.char_shapes = vec![CharShape {
        font_ids: [0; 7],
        ratios: [100; 7],
        relative_sizes: [100; 7],
        base_size: 1500,
        ..Default::default()
    }];
    document.bin_data_content = vec![BinDataContent {
        id: 1,
        data: FONT.to_vec().into(),
        extension: "ttf".into(),
    }];
    document.sections[0].paragraphs = vec![Paragraph {
        text: text.into(),
        char_count: text.encode_utf16().count() as u32 + 1,
        char_offsets: (0..text.chars().count() as u32).collect(),
        char_shapes: vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }],
        has_para_text: true,
        ..Default::default()
    }];
    core.set_document(document);
    core
}

fn cursor(core: &DocumentCore, offset: usize) -> Value {
    serde_json::from_str(&core.get_cursor_rect_native(0, 0, offset).unwrap()).unwrap()
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.15,
        "expected {expected}, got {actual}"
    );
}

#[test]
fn embedded_shaping_keeps_caret_selection_and_hit_testing_in_agreement() {
    for (text, width) in [
        ("AV", 24.0),
        ("To", 24.0),
        ("office", 60.0),
        ("e\u{301}", 12.0),
        ("한AV", 44.0),
    ] {
        let core = document(text);
        let start = cursor(&core, 0);
        let end = cursor(&core, text.chars().count());
        let x = start["x"].as_f64().unwrap();
        near(end["x"].as_f64().unwrap() - x, width);
        let rects: Vec<Value> = serde_json::from_str(
            &core
                .get_selection_rects_native(0, 0, 0, 0, text.chars().count(), None, None)
                .unwrap(),
        )
        .unwrap();
        near(rects[0]["width"].as_f64().unwrap(), width);
        let hit: Value = serde_json::from_str(
            &core
                .hit_test_native(
                    0,
                    end["x"].as_f64().unwrap() - 0.01,
                    end["y"].as_f64().unwrap() + end["height"].as_f64().unwrap() * 0.5,
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            hit["charOffset"].as_u64(),
            Some(text.chars().count() as u64),
            "{text}: {hit}"
        );
    }
}

#[test]
fn embedded_ligatures_keep_scalar_caret_boundaries() {
    let core = document("office");
    let positions = (0..=6)
        .map(|offset| cursor(&core, offset)["x"].as_f64().unwrap())
        .collect::<Vec<_>>();
    near(positions[2] - positions[1], 8.0);
    near(positions[3] - positions[2], 8.0);
    near(positions[4] - positions[3], 8.0);
    let accented = document("e\u{301}");
    near(
        cursor(&accented, 1)["x"].as_f64().unwrap(),
        cursor(&accented, 2)["x"].as_f64().unwrap(),
    );
}

#[test]
fn embedded_font_kerning_and_clusters_share_measurement_geometry() {
    use crate::renderer::layout::{compute_char_positions, estimate_text_width_unrounded};
    use crate::renderer::TextStyle;

    let core = document("AV");
    let _scope = core.resolved_shaping_font_scope();
    let style = TextStyle {
        font_family: "RHWP Shaping Fixture".into(),
        font_size: 20.0,
        kerning: true,
        ..Default::default()
    };
    for (text, expected) in [
        ("AV", 20.0),
        ("To", 22.0),
        ("office", 60.0),
        ("e\u{301}", 12.0),
        ("한AV", 40.0),
    ] {
        let positions = compute_char_positions(text, &style);
        assert_eq!(positions.len(), text.chars().count() + 1);
        near(*positions.last().unwrap(), expected);
        near(estimate_text_width_unrounded(text, &style), expected);
        let equation =
            crate::renderer::equation::layout::EqLayout::with_font(20.0, "RHWP Shaping Fixture")
                .layout(&crate::renderer::equation::ast::EqNode::Text(text.into()));
        near(equation.width, expected);
    }
}

#[test]
fn embedded_ligature_advance_controls_line_fitting() {
    let mut core = document("office office");
    let mut source = core.document.clone();
    let page = &mut source.sections[0].section_def.page_def;
    page.width = 4800;
    page.margin_left = 0;
    page.margin_right = 0;
    page.margin_gutter = 0;
    core.set_document(source);

    let first = cursor(&core, 0);
    let first_word_last_character = cursor(&core, 5);
    let second_word_end = cursor(&core, 13);
    near(
        first_word_last_character["y"].as_f64().unwrap(),
        first["y"].as_f64().unwrap(),
    );
    assert!(second_word_end["y"].as_f64().unwrap() > first["y"].as_f64().unwrap());
}
