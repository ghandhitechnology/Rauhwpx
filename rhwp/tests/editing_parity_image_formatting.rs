//! Behavioral formatting/history checks around inline pictures.
//! These verify editing invariants, not an independently captured Hancom edit.

use rhwp::document_core::DocumentCore;
use rhwp::model::{control::Control, paragraph::Paragraph, provenance::FontMetricsPolicy};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
struct Target {
    parent: usize,
    path: Vec<(usize, usize, usize)>,
}

impl Target {
    fn paragraph<'a>(&self, core: &'a DocumentCore) -> &'a Paragraph {
        let mut para = &core.document().sections[0].paragraphs[self.parent];
        for &(control, cell, inner_para) in &self.path {
            let Control::Table(table) = &para.controls[control] else {
                panic!("expected table");
            };
            para = &table.cells[cell].paragraphs[inner_para];
        }
        para
    }

    fn apply(&self, core: &mut DocumentCore, from: usize, to: usize, props: &str) {
        if self.path.is_empty() {
            core.apply_char_format_native(0, self.parent, from, to, props)
                .unwrap();
        } else {
            core.apply_char_format_in_cell_by_path(0, self.parent, &self.path, from, to, props)
                .unwrap();
        }
    }

    // The Studio command restores each original/derived run, not a document
    // snapshot. Exercise those exact core operations in both history directions.
    fn restore(&self, core: &mut DocumentCore, spans: &[(usize, usize, u32)]) {
        for &(from, to, id) in spans {
            if self.path.is_empty() {
                core.set_char_shape_id_native(0, self.parent, from, to, id)
                    .unwrap();
            } else {
                core.set_char_shape_id_in_cell_by_path(0, self.parent, &self.path, from, to, id)
                    .unwrap();
            }
        }
    }

    fn properties(&self, core: &DocumentCore) -> Vec<Value> {
        (0..self.paragraph(core).text.chars().count())
            .map(|offset| {
                let result = if self.path.is_empty() {
                    core.get_char_properties_at_native(0, self.parent, offset)
                        .unwrap()
                } else {
                    let (control, cell, para) = self.path[0];
                    core.get_cell_char_properties_at_native(
                        0,
                        self.parent,
                        control,
                        cell,
                        para,
                        offset,
                    )
                    .unwrap()
                };
                let mut value: Value = serde_json::from_str(&result).unwrap();
                // Serialized styles may be renumbered; formatting must not change.
                value.as_object_mut().unwrap().remove("charShapeId");
                value
            })
            .collect()
    }
}

fn layout(core: &DocumentCore) -> Value {
    json!((0..core.page_count()).map(|page| json!({
        "text": serde_json::from_str::<Value>(&core.get_page_text_layout_native(page).unwrap()).unwrap(),
        "controls": serde_json::from_str::<Value>(&core.get_page_control_layout_native(page).unwrap()).unwrap(),
    })).collect::<Vec<_>>())
}

fn assert_layout_eq(actual: &Value, expected: &Value, context: &str) {
    match (actual, expected) {
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{context}: length");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_layout_eq(a, b, &format!("{context}/{i}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{context}: keys"
            );
            for (key, a) in a {
                assert_layout_eq(a, &b[key], &format!("{context}/{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{context}"),
    }
}

fn assert_visible_text(layout: &Value, text: &str) {
    let rendered: String = layout
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|page| page["text"]["runs"].as_array().unwrap().iter())
        .map(|run| run["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        rendered,
        text.replace('\u{fffc}', ""),
        "all visible characters must render, including the final punctuation"
    );
}

fn target(core: &DocumentCore, in_cell: bool) -> Target {
    for (parent, para) in core.document().sections[0].paragraphs.iter().enumerate() {
        if !in_cell
            && para
                .controls
                .iter()
                .any(|control| matches!(control, Control::Picture(_)))
        {
            return Target {
                parent,
                path: vec![],
            };
        }
        for (control, item) in para.controls.iter().enumerate() {
            if in_cell && matches!(item, Control::Table(_)) {
                return Target {
                    parent,
                    path: vec![(control, 0, 0)],
                };
            }
        }
    }
    panic!("missing image paragraph");
}

fn assert_format_history(bytes: &[u8], in_cell: bool, props: &str) {
    assert_format_history_with_mixed_runs(bytes, in_cell, props, false);
}

fn assert_format_history_with_mixed_runs(
    bytes: &[u8],
    in_cell: bool,
    props: &str,
    seed_runs: bool,
) {
    let mut core =
        DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    let target = target(&core, in_cell);
    if seed_runs {
        // Two surrogate pairs before the picture make UTF-16/control offsets
        // differ from Unicode selection offsets. Existing runs must survive
        // formatting across the picture and per-run undo/redo.
        if in_cell {
            core.insert_text_in_cell_by_path(0, target.parent, &target.path, 5, "😀𠀀")
                .unwrap();
        } else {
            core.insert_text_native(0, target.parent, 5, "😀𠀀")
                .unwrap();
        }
        target.apply(&mut core, 4, 9, r##"{"bold":true,"textColor":"#d02030"}"##);
        target.apply(&mut core, 14, 19, r#"{"italic":true,"fontSize":1300}"#);
    }
    let from = 7;
    let to = 24;
    let text = target.paragraph(&core).text.clone();
    let controls = format!("{:?}", target.paragraph(&core).controls);
    let before_properties = target.properties(&core);
    let before_layout = layout(&core);
    assert_visible_text(&before_layout, &text);
    let before_spans = target.paragraph(&core).char_shape_runs_in_range(from, to);
    target.apply(&mut core, from, to, props);
    let after_spans = target.paragraph(&core).char_shape_runs_in_range(from, to);
    let after_properties = target.properties(&core);
    assert_ne!(
        before_properties[from], after_properties[from],
        "format command must take effect"
    );
    let requested: Value = serde_json::from_str(props).unwrap();
    for offset in from..to {
        for (key, value) in requested.as_object().unwrap() {
            assert_eq!(
                &after_properties[offset][key], value,
                "selected character {offset}: {key}"
            );
        }
        for key in ["bold", "italic", "textColor"] {
            if requested.get(key).is_none() {
                assert_eq!(
                    after_properties[offset][key], before_properties[offset][key],
                    "selected character {offset}: preserve existing {key}"
                );
            }
        }
    }
    for offset in (0..from).chain(to..before_properties.len()) {
        assert_eq!(
            before_properties[offset], after_properties[offset],
            "unselected character {offset}"
        );
    }
    assert_eq!(target.paragraph(&core).text, text);
    assert_eq!(
        format!("{:?}", target.paragraph(&core).controls),
        controls,
        "formatting must retain image data and anchor"
    );
    let after_layout = layout(&core);
    assert_visible_text(&after_layout, &text);
    for cycle in 1..=3 {
        target.restore(&mut core, &before_spans);
        assert_eq!(
            target.properties(&core),
            before_properties,
            "undo {cycle}: formatting"
        );
        assert_eq!(layout(&core), before_layout, "undo {cycle}: layout");
        target.restore(&mut core, &after_spans);
        assert_eq!(
            target.properties(&core),
            after_properties,
            "redo {cycle}: formatting"
        );
        assert_eq!(layout(&core), after_layout, "redo {cycle}: layout");
        assert_eq!(target.paragraph(&core).text, text);
        assert_eq!(format!("{:?}", target.paragraph(&core).controls), controls);
    }
    for cycle in 1..=3 {
        core = DocumentCore::from_bytes_with_font_metrics(
            &core.export_hwpx_native().unwrap(),
            FontMetricsPolicy::HcrDeclared,
        )
        .unwrap();
        assert_eq!(
            target.properties(&core),
            after_properties,
            "reopen {cycle}: formatting"
        );
        assert_eq!(target.paragraph(&core).text, text, "reopen {cycle}: text");
        let reopened = layout(&core);
        assert_visible_text(&reopened, &text);
        assert_layout_eq(&reopened, &after_layout, &format!("reopen {cycle}: layout"));
    }
}

const BODY: &[u8] = include_bytes!(
    "fixtures/editing_parity/mac-hancom-12.30.0-independent/body-mixed-text/edited.hwpx"
);
const CELL: &[u8] = include_bytes!(
    "fixtures/editing_parity/mac-hancom-12.30.0-independent/cell-mixed-text/edited.hwpx"
);

#[test]
fn body_underline_across_picture_history_and_reopens() {
    assert_format_history(BODY, false, r#"{"underline":true}"#);
}

#[test]
fn cell_underline_across_picture_history_and_reopens() {
    assert_format_history(CELL, true, r#"{"underline":true}"#);
}

#[test]
fn body_font_size_across_picture_history_and_reopens() {
    assert_format_history(BODY, false, r#"{"fontSize":1600}"#);
}

#[test]
fn cell_font_size_across_picture_history_and_reopens() {
    assert_format_history(CELL, true, r#"{"fontSize":1600}"#);
}

#[test]
fn mixed_body_runs_and_non_bmp_text_survive_picture_formatting_history() {
    for props in [r#"{"underline":true}"#, r#"{"fontSize":1600}"#] {
        assert_format_history_with_mixed_runs(BODY, false, props, true);
    }
}

#[test]
fn mixed_cell_runs_and_non_bmp_text_survive_picture_formatting_history() {
    for props in [r#"{"underline":true}"#, r#"{"fontSize":1600}"#] {
        assert_format_history_with_mixed_runs(CELL, true, props, true);
    }
}

fn assert_font_change_reflows(bytes: &[u8], in_cell: bool) {
    let mut scalar =
        DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    let target = target(&scalar, in_cell);
    let end = target.paragraph(&scalar).text.chars().count();
    let narrow_text = " iii iiiii iiiiiii".repeat(12);
    if in_cell {
        scalar
            .insert_text_in_cell_by_path(0, target.parent, &target.path, end, &narrow_text)
            .unwrap();
    } else {
        scalar
            .insert_text_native(0, target.parent, end, &narrow_text)
            .unwrap();
        scalar
            .insert_paragraph_native(0, target.parent + 1)
            .unwrap();
        scalar
            .insert_text_native(
                0,
                target.parent + 1,
                0,
                "다음 문단은 앞 문단의 높이를 따라야 합니다.",
            )
            .unwrap();
    }
    let source = scalar.export_hwpx_native().unwrap();
    scalar = DocumentCore::from_bytes_with_font_metrics(&source, FontMetricsPolicy::HcrDeclared)
        .unwrap();
    let mut per_language =
        DocumentCore::from_bytes_with_font_metrics(&source, FontMetricsPolicy::HcrDeclared)
            .unwrap();
    let scalar_id = scalar.find_or_create_font_id_native("굴림체");
    let array_id = per_language.find_or_create_font_id_native("굴림체");
    assert_eq!(scalar_id, array_id);
    let end = target.paragraph(&scalar).text.chars().count();
    let before_layout = layout(&scalar);
    let before_properties = target.properties(&scalar);
    let before_spans = target.paragraph(&scalar).char_shape_runs_in_range(0, end);
    target.apply(
        &mut scalar,
        0,
        end,
        &json!({"fontId": scalar_id}).to_string(),
    );
    let font_ids = [array_id; 7];
    target.apply(
        &mut per_language,
        0,
        end,
        &json!({"fontIds": font_ids}).to_string(),
    );
    assert_eq!(
        target.properties(&scalar),
        target.properties(&per_language),
        "both font APIs apply identical formatting"
    );
    assert_eq!(
        layout(&scalar),
        layout(&per_language),
        "font APIs must produce identical live layout"
    );
    assert_eq!(
        format!("{:?}", target.paragraph(&scalar).line_segs),
        format!("{:?}", target.paragraph(&per_language).line_segs),
        "a font-family change must recompute the same stored wrapping via either API"
    );
    let after_layout = layout(&scalar);
    let after_properties = target.properties(&scalar);
    let after_spans = target.paragraph(&scalar).char_shape_runs_in_range(0, end);
    for cycle in 1..=3 {
        target.restore(&mut scalar, &before_spans);
        assert_eq!(
            target.properties(&scalar),
            before_properties,
            "font undo {cycle}: properties"
        );
        assert_eq!(
            layout(&scalar),
            before_layout,
            "font undo {cycle}: layout including following paragraphs"
        );
        target.restore(&mut scalar, &after_spans);
        assert_eq!(
            target.properties(&scalar),
            after_properties,
            "font redo {cycle}: properties"
        );
        assert_eq!(
            layout(&scalar),
            after_layout,
            "font redo {cycle}: layout including following paragraphs"
        );
    }
    for cycle in 1..=3 {
        scalar = DocumentCore::from_bytes_with_font_metrics(
            &scalar.export_hwpx_native().unwrap(),
            FontMetricsPolicy::HcrDeclared,
        )
        .unwrap();
        assert_eq!(
            target.properties(&scalar),
            after_properties,
            "font reopen {cycle}: properties"
        );
        assert_eq!(layout(&scalar), after_layout, "font reopen {cycle}: layout");
    }
}

#[test]
fn body_font_family_change_across_picture_reflows() {
    assert_font_change_reflows(BODY, false);
}

#[test]
fn cell_font_family_change_across_picture_reflows() {
    assert_font_change_reflows(CELL, true);
}
