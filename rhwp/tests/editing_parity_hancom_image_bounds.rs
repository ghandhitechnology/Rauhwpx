//! Image, table and cell-wrap regressions against observed Mac Hancom exports.
//!
//! These assertions cover selected geometry and wrapping, not complete typography.
//! Capture provenance and immutable input/PDF hashes live beside the fixtures.

use rhwp::document_core::DocumentCore;
use rhwp::model::provenance::FontMetricsPolicy;
use serde_json::Value;

#[test]
fn independent_cell_spacing_preserves_glyphs_image_and_cells_through_reopens() {
    for bytes in [
        include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0-independent/cell-paragraph-spacing/edited.hwpx").as_slice(),
        include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0-independent/cell-paragraph-spacing/rau-edited.hwpx").as_slice(),
    ] {
        let mut core = DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
        let text = core.get_page_text_layout_native(0).unwrap();
        let controls = core.get_page_control_layout_native(0).unwrap();
        // Measured from the independently edited Hancom PDF, in points.
        let xs = [87.95999908447266, 297.7200012207031, 507.47998046875];
        let ys = [102.1199951171875, 248.87998962402344, 261.7200012207031];
        for cycle in 0..=3 {
            assert_eq!(core.page_count(), 1);
            assert_eq!(core.get_page_text_layout_native(0).unwrap(), text);
            assert_eq!(core.get_page_control_layout_native(0).unwrap(), controls);
            let layout: Value = serde_json::from_str(&text).unwrap();
            let run = layout["runs"].as_array().unwrap().iter().find(|r| r["text"] == "그림 ").unwrap();
            for (index, official) in [273.0, 282.8404846191406].into_iter().enumerate() {
                let x = (run["x"].as_f64().unwrap() + run["charX"][index].as_f64().unwrap()) * 0.75;
                assert!((x - official).abs() <= 0.5,
                    "cycle {cycle}, glyph {index}: {x} vs {official}");
            }
            let objects: Value = serde_json::from_str(&controls).unwrap();
            let items = objects["controls"].as_array().unwrap();
            let image = items.iter().find(|c| c["type"] == "image").unwrap();
            assert_eq!(image["cellIdx"], 0);
            assert_eq!(image["cellParaIdx"], 0);
            for (key, official) in ["x", "y", "w", "h"].into_iter().zip([
                92.99622344970703, 109.435546875, 179.9926986694336, 89.996337890625,
            ]) {
                assert!((image[key].as_f64().unwrap() * 0.75 - official).abs() <= 0.5);
            }
            let table = items.iter().find(|c| c["type"] == "table").unwrap();
            let cells = table["cells"].as_array().unwrap();
            assert_eq!(cells.len(), 4);
            for cell in cells {
                let row = cell["row"].as_u64().unwrap() as usize;
                let col = cell["col"].as_u64().unwrap() as usize;
                for (key, official) in ["x", "y", "w", "h"].into_iter().zip([
                    xs[col], ys[row], xs[col+1]-xs[col], ys[row+1]-ys[row],
                ]) {
                    assert!((cell[key].as_f64().unwrap() * 0.75 - official).abs() <= 0.5);
                }
            }
            if cycle < 3 {
                core = DocumentCore::from_bytes_with_font_metrics(
                    &core.export_hwpx_native().unwrap(), FontMetricsPolicy::HcrDeclared,
                ).unwrap();
            }
        }
    }
}

#[test]
fn independent_mixed_cell_justification_and_geometry_match_pdf_through_reopens() {
    for bytes in [
        include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0-independent/cell-mixed-text/edited.hwpx").as_slice(),
        include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0-independent/cell-mixed-text/rau-edited.hwpx").as_slice(),
    ] {
        let mut core = DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
        let text = core.get_page_text_layout_native(0).unwrap();
        let controls = core.get_page_control_layout_native(0).unwrap();
        // Native PDF glyph origins in the word "paragraph.", whose placement
        // previously drifted past tolerance despite matching line starts.
        let glyphs = [(28, 238.800003052), (29, 244.799911499), (30, 250.441253662),
                      (31, 255.235992432), (32, 260.877349854), (33, 266.518676758),
                      (34, 271.313415527), (35, 276.954772949), (36, 282.954681396),
                      (37, 289.313140869)];
        let xs = [87.95999908447266, 297.7200012207031, 507.47998046875];
        let ys = [102.1199951171875, 242.87998962402344, 255.72000122070312];
        for cycle in 0..=3 {
            assert_eq!(core.page_count(), 1);
            assert_eq!(core.get_page_text_layout_native(0).unwrap(), text);
            assert_eq!(core.get_page_control_layout_native(0).unwrap(), controls);
            let layout: Value = serde_json::from_str(&text).unwrap();
            let run = layout["runs"].as_array().unwrap().iter().find(|r|
                r["text"] == "Picture and text share this paragraph. "
            ).unwrap();
            for (index, official) in glyphs {
                let x = (run["x"].as_f64().unwrap() + run["charX"][index].as_f64().unwrap()) * 0.75;
                assert!((x - official).abs() <= 0.5,
                        "cycle {cycle}, glyph {index}: {x} vs {official}");
            }
            let objects: Value = serde_json::from_str(&controls).unwrap();
            let items = objects["controls"].as_array().unwrap();
            let image = items.iter().find(|c| c["type"] == "image").unwrap();
            assert_eq!(image["cellIdx"], 0);
            assert_eq!(image["cellParaIdx"], 0);
            for (key, official) in ["x", "y", "w", "h"].into_iter().zip([
                92.99622344970703, 119.51513671875, 179.9926986694336, 89.996337890625,
            ]) {
                assert!((image[key].as_f64().unwrap() * 0.75 - official).abs() <= 0.5);
            }
            let table = items.iter().find(|c| c["type"] == "table").unwrap();
            let cells = table["cells"].as_array().unwrap();
            assert_eq!(cells.len(), 4);
            for cell in cells {
                let row = cell["row"].as_u64().unwrap() as usize;
                let col = cell["col"].as_u64().unwrap() as usize;
                for (key, official) in ["x", "y", "w", "h"].into_iter().zip([
                    xs[col], ys[row], xs[col+1]-xs[col], ys[row+1]-ys[row],
                ]) {
                    assert!((cell[key].as_f64().unwrap() * 0.75 - official).abs() <= 0.5);
                }
            }
            if cycle < 3 {
                core = DocumentCore::from_bytes_with_font_metrics(
                    &core.export_hwpx_native().unwrap(), FontMetricsPolicy::HcrDeclared,
                ).unwrap();
            }
        }
    }
}

#[test]
fn independent_mixed_body_hangul_origins_match_pdf_through_reopens() {
    for bytes in [
        include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0-independent/body-mixed-text/edited.hwpx").as_slice(),
        include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0-independent/body-mixed-text/rau-edited.hwpx").as_slice(),
    ] {
        let mut core = DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
        let text = core.get_page_text_layout_native(0).unwrap();
        let controls = core.get_page_control_layout_native(0).unwrap();
        // Visible glyph origins from the independent Hancom PDF, in points.
        // Spaces are intentionally excluded. The Python comparator also gates
        // the other line, Latin glyphs and baselines using unrounded SVG data.
        let expected = [
            (0, 143.880004883), (1, 153.599975586),
            (3, 168.240005493), (4, 177.959976196), (5, 187.679931641),
            (7, 202.440002441), (8, 212.159973145),
            (10, 226.919998169), (11, 236.639968872), (12, 246.359924316),
            (13, 256.079895020), (14, 265.799865723), (15, 275.519989014),
        ];
        for cycle in 0..=3 {
            assert_eq!(core.page_count(), 1);
            assert_eq!(core.get_page_text_layout_native(0).unwrap(), text);
            assert_eq!(core.get_page_control_layout_native(0).unwrap(), controls);
            let layout: Value = serde_json::from_str(&text).unwrap();
            let runs = layout["runs"].as_array().unwrap();
            let tail = runs.iter().find(|run| run["text"] == "그림 뒤에도 글이 이어집니다.").unwrap();
            for (index, official) in expected {
                let x = (tail["x"].as_f64().unwrap() + tail["charX"][index].as_f64().unwrap()) * 0.75;
                assert!((x - official).abs() <= 0.5,
                    "cycle {cycle}, glyph {index}: {x} vs {official}");
            }
            if cycle < 3 {
                core = DocumentCore::from_bytes_with_font_metrics(
                    &core.export_hwpx_native().unwrap(), FontMetricsPolicy::HcrDeclared,
                ).unwrap();
            }
        }
    }
}

#[test]
fn independently_authored_hancom_body_image_matches_pdf_through_reopens() {
    let bytes = include_bytes!(
        "fixtures/editing_parity/mac-hancom-12.30.0-independent/body-paragraph-spacing/edited.hwpx"
    );
    let mut core =
        DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    let controls = core.get_page_control_layout_native(0).unwrap();
    let text = core.get_page_text_layout_native(0).unwrap();
    // Bounds in PDF points from the independently authored Hancom capture,
    // not from Rau's rendering. The Python gate also checks text baselines.
    let expected = [
        85.0765380859375,
        121.195068359375,
        179.99270629882812,
        89.996337890625,
    ];
    for cycle in 0..=3 {
        assert_eq!(core.page_count(), 1);
        assert_eq!(core.get_page_control_layout_native(0).unwrap(), controls);
        assert_eq!(core.get_page_text_layout_native(0).unwrap(), text);
        let layout: Value = serde_json::from_str(&controls).unwrap();
        let pictures: Vec<_> = layout["controls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["type"] == "image")
            .collect();
        assert_eq!(pictures.len(), 1);
        for (key, official) in ["x", "y", "w", "h"].into_iter().zip(expected) {
            let actual = pictures[0][key].as_f64().unwrap() * 0.75;
            assert!(
                (actual - official).abs() <= 0.5,
                "cycle {cycle}, {key}: {actual} vs {official}"
            );
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

#[test]
fn independently_authored_hancom_empty_cell_matches_pdf_through_reopens() {
    let bytes = include_bytes!(
        "fixtures/editing_parity/mac-hancom-12.30.0-independent/cell-empty/edited.hwpx"
    );
    let mut core =
        DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    let controls = core.get_page_control_layout_native(0).unwrap();
    // Independent Hancom PDF border centerlines and picture bounds, in points.
    let xs = [87.95999908447266, 297.7200012207031, 507.47998046875];
    let ys = [102.1199951171875, 194.87998962402344, 207.72000122070312];
    for cycle in 0..=3 {
        assert_eq!(core.page_count(), 1);
        assert_eq!(core.get_page_control_layout_native(0).unwrap(), controls);
        let layout: Value = serde_json::from_str(&controls).unwrap();
        let items = layout["controls"].as_array().unwrap();
        let picture = items.iter().find(|c| c["type"] == "image").unwrap();
        assert_eq!(picture["cellIdx"], 0);
        assert_eq!(picture["cellParaIdx"], 0);
        let expected = [
            92.99622344970703,
            103.435791015625,
            179.99270629882812,
            89.996337890625,
        ];
        for (key, official) in ["x", "y", "w", "h"].into_iter().zip(expected) {
            assert!((picture[key].as_f64().unwrap() * 0.75 - official).abs() <= 0.5);
        }
        let table = items.iter().find(|c| c["type"] == "table").unwrap();
        let cells = table["cells"].as_array().unwrap();
        assert_eq!(cells.len(), 4);
        for cell in cells {
            let row = cell["row"].as_u64().unwrap() as usize;
            let col = cell["col"].as_u64().unwrap() as usize;
            let expected = [
                xs[col],
                ys[row],
                xs[col + 1] - xs[col],
                ys[row + 1] - ys[row],
            ];
            for (key, official) in ["x", "y", "w", "h"].into_iter().zip(expected) {
                assert!((cell[key].as_f64().unwrap() * 0.75 - official).abs() <= 0.5);
            }
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

#[test]
fn legacy_body_spacing_matches_hancom_without_rewriting_source_positions() {
    let bytes = include_bytes!(
        "fixtures/editing_parity/mac-hancom-12.30.0/body-paragraph-spacing/edited.hwpx"
    );
    let parsed = rhwp::parser::parse_document(bytes).unwrap();
    let original_export = rhwp::serializer::hwpx::serialize_hwpx(&parsed).unwrap();
    let mut core =
        DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    let original_layout = core.get_page_control_layout_native(0).unwrap();
    let original_text = core.get_page_text_layout_native(0).unwrap();
    for _ in 0..=3 {
        assert_eq!(core.page_count(), 1);
        assert_eq!(
            core.get_page_control_layout_native(0).unwrap(),
            original_layout
        );
        assert_eq!(core.get_page_text_layout_native(0).unwrap(), original_text);
        assert_eq!(core.export_hwpx_native().unwrap(), original_export);
        let layout: Value = serde_json::from_str(&original_layout).unwrap();
        let picture = layout["controls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["type"] == "image")
            .unwrap();
        assert!((picture["y"].as_f64().unwrap() * 0.75 - 118.2201904296875).abs() <= 0.5);
        core = DocumentCore::from_bytes_with_font_metrics(
            &core.export_hwpx_native().unwrap(),
            FontMetricsPolicy::HcrDeclared,
        )
        .unwrap();
    }
}

#[test]
fn legacy_body_spacing_stays_stable_during_neighbor_edits_and_undo() {
    let bytes = include_bytes!(
        "fixtures/editing_parity/mac-hancom-12.30.0/body-paragraph-spacing/edited.hwpx"
    );
    for edit in 0..4 {
        let para = if edit == 1 { 0 } else { 2 };
        let mut core =
            DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared)
                .unwrap();
        let image_y = |core: &DocumentCore| {
            let layout: Value =
                serde_json::from_str(&core.get_page_control_layout_native(0).unwrap()).unwrap();
            layout["controls"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["type"] == "image")
                .unwrap()["y"]
                .as_f64()
                .unwrap()
        };
        let before_y = image_y(&core);
        let before = core.save_snapshot_native();
        match edit {
            2 => {
                core.split_paragraph_native(0, 2, 4, None).unwrap();
            }
            3 => {
                core.insert_text_native(0, 2, 4, "\n").unwrap();
            }
            _ => {
                core.insert_text_native(0, para, 0, "A").unwrap();
            }
        }
        assert!(
            (image_y(&core) - before_y).abs() < 0.1,
            "edit {edit} in paragraph {para} moved the picture"
        );
        let edited_text = core.get_page_text_layout_native(0).unwrap();
        let after = core.save_snapshot_native();
        core.restore_snapshot_native(before).unwrap();
        assert_eq!(image_y(&core), before_y);
        core.restore_snapshot_native(after).unwrap();
        assert_eq!(core.get_page_text_layout_native(0).unwrap(), edited_text);
        for _ in 0..3 {
            core = DocumentCore::from_bytes_with_font_metrics(
                &core.export_hwpx_native().unwrap(),
                FontMetricsPolicy::HcrDeclared,
            )
            .unwrap();
            assert!((image_y(&core) - before_y).abs() < 0.1);
            assert_eq!(core.get_page_text_layout_native(0).unwrap(), edited_text);
        }
    }
}

#[test]
fn legacy_body_spacing_format_change_undo_and_reopen_agree() {
    let bytes = include_bytes!(
        "fixtures/editing_parity/mac-hancom-12.30.0/body-paragraph-spacing/edited.hwpx"
    );
    let mut core =
        DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    let picture_y = |core: &DocumentCore| {
        let layout: Value =
            serde_json::from_str(&core.get_page_control_layout_native(0).unwrap()).unwrap();
        layout["controls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["type"] == "image")
            .unwrap()["y"]
            .as_f64()
            .unwrap()
    };
    let original_y = picture_y(&core);
    let before = core.save_snapshot_native();
    // Before: 3 pt/1.5 pt. After: 6 pt/3 pt. IR paragraph margins are doubled HU.
    core.apply_para_format_native(0, 1, r#"{"spacingBefore":1200,"spacingAfter":600}"#)
        .unwrap();
    let edited_y = picture_y(&core);
    assert!((edited_y - original_y - 4.0).abs() < 0.1);
    let edited_text = core.get_page_text_layout_native(0).unwrap();
    let after = core.save_snapshot_native();
    core.restore_snapshot_native(before).unwrap();
    assert_eq!(picture_y(&core), original_y);
    core.restore_snapshot_native(after).unwrap();
    assert_eq!(picture_y(&core), edited_y);
    for _ in 0..3 {
        core = DocumentCore::from_bytes_with_font_metrics(
            &core.export_hwpx_native().unwrap(),
            FontMetricsPolicy::HcrDeclared,
        )
        .unwrap();
        assert_eq!(picture_y(&core), edited_y);
        assert_eq!(core.get_page_text_layout_native(0).unwrap(), edited_text);
    }
}

#[test]
fn old_cell_wraps_use_current_metrics_without_rewriting_source_lines() {
    for id in [
        "cell-mixed-text",
        "cell-fit-width",
        "cell-paragraph-spacing",
    ] {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/editing_parity");
        let bytes =
            std::fs::read(root.join("mac-hancom-12.30.0").join(id).join("edited.hwpx")).unwrap();
        let windows = DocumentCore::from_bytes(&bytes).unwrap();
        let mut mac =
            DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HcrDeclared)
                .unwrap();
        let modern = DocumentCore::from_bytes_with_font_metrics(
            &std::fs::read(
                root.join("mac-hancom-12.30.0-xml14")
                    .join(id)
                    .join("edited.hwpx"),
            )
            .unwrap(),
            FontMetricsPolicy::HcrDeclared,
        )
        .unwrap();
        let expected_text = modern.extract_page_text_native(0).unwrap();
        let original_export = windows.export_hwpx_native().unwrap();
        for cycle in 0..=3 {
            assert_eq!(
                mac.extract_page_text_native(0).unwrap(),
                expected_text,
                "{id} cycle {cycle}"
            );
            assert_eq!(
                mac.export_hwpx_native().unwrap(),
                original_export,
                "{id}: render-only correction changed source"
            );
            mac = DocumentCore::from_bytes_with_font_metrics(
                &mac.export_hwpx_native().unwrap(),
                FontMetricsPolicy::HcrDeclared,
            )
            .unwrap();
        }
    }
}

#[test]
fn first_cell_spacing_edit_updates_picture_and_row_and_supports_snapshot_undo() {
    let bytes = include_bytes!(
        "fixtures/editing_parity/mac-hancom-12.30.0-xml14/cell-paragraph-spacing/edited.hwpx"
    );
    let mut core =
        DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    let geometry = |core: &DocumentCore| {
        let layout: Value =
            serde_json::from_str(&core.get_page_control_layout_native(0).unwrap()).unwrap();
        let controls = layout["controls"].as_array().unwrap();
        let image = controls.iter().find(|c| c["type"] == "image").unwrap();
        let table = controls.iter().find(|c| c["type"] == "table").unwrap();
        [
            image["y"].as_f64().unwrap(),
            table["cells"][0]["h"].as_f64().unwrap(),
        ]
    };
    let original = geometry(&core);
    let before = core.save_snapshot_native();
    core.apply_para_format_in_cell_native(0, 0, 2, 0, 0, r#"{"spacingBefore":2400}"#)
        .unwrap();
    let edited = geometry(&core);
    for (new, old) in edited.into_iter().zip(original) {
        assert!(
            (new - old - 8.0).abs() < 0.15,
            "12 pt versus 6 pt: {new} vs {old}"
        );
    }
    let after = core.save_snapshot_native();
    core.restore_snapshot_native(before).unwrap();
    assert_eq!(geometry(&core), original);
    core.restore_snapshot_native(after).unwrap();
    assert_eq!(geometry(&core), edited);
    for _ in 0..3 {
        core = DocumentCore::from_bytes_with_font_metrics(
            &core.export_hwpx_native().unwrap(),
            FontMetricsPolicy::HcrDeclared,
        )
        .unwrap();
        assert_eq!(geometry(&core), edited);
    }
}

#[test]
fn first_hwpx_cell_paragraph_spacing_matches_mac_hancom_through_reopening() {
    let bytes = include_bytes!(
        "fixtures/editing_parity/mac-hancom-12.30.0-xml14/cell-paragraph-spacing/edited.hwpx"
    );
    let mut core =
        DocumentCore::from_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    let mut first = None;
    for cycle in 0..=3 {
        let layout: Value =
            serde_json::from_str(&core.get_page_control_layout_native(0).unwrap()).unwrap();
        let controls = layout["controls"].as_array().unwrap();
        let image = controls.iter().find(|c| c["type"] == "image").unwrap();
        for (field, expected) in [
            ("x", 92.99622344970703),
            ("y", 109.435546875),
            ("w", 179.9926986694336),
            ("h", 89.996337890625),
        ] {
            let actual = image[field].as_f64().unwrap() * 0.75;
            assert!(
                (actual - expected).abs() <= 0.5,
                "cycle {cycle}: {field} = {actual}; Hancom = {expected}"
            );
        }
        assert_eq!(core.page_count(), 1);
        assert_eq!(image["cellIdx"], 0);
        // Table borders in the same pinned PDF: top=102.12, row break=248.88,
        // bottom=261.72 pt. Moving the picture alone must not pass this test.
        let table = controls.iter().find(|c| c["type"] == "table").unwrap();
        let table_y = table["y"].as_f64().unwrap() * 0.75;
        let table_bottom = table_y + table["h"].as_f64().unwrap() * 0.75;
        let first_row_bottom = table_y + table["cells"][0]["h"].as_f64().unwrap() * 0.75;
        assert!((table_y - 102.12).abs() <= 0.5);
        assert!((first_row_bottom - 248.88).abs() <= 0.5);
        assert!((table_bottom - 261.72).abs() <= 0.5);
        if let Some(first) = &first {
            assert_eq!(&layout, first);
        } else {
            first = Some(layout);
        }
        core = DocumentCore::from_bytes_with_font_metrics(
            &core.export_hwpx_native().unwrap(),
            FontMetricsPolicy::HcrDeclared,
        )
        .unwrap();
    }
}

#[test]
fn mac_hcr_metrics_fix_body_image_anchor_without_changing_saved_input() {
    let bytes =
        include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0/body-mixed-text/edited.hwpx");
    let mut core = DocumentCore::from_bytes(bytes).unwrap();
    let original_export = core.export_hwpx_native().unwrap();
    let windows_snapshot = core.save_snapshot_native();
    core.set_font_metrics_policy_native(FontMetricsPolicy::HcrDeclared);
    assert_eq!(
        core.export_hwpx_native().unwrap(),
        original_export,
        "font measurement policy must not rewrite stored document content"
    );
    let layout = |core: &DocumentCore| -> Value {
        serde_json::from_str(&core.get_page_control_layout_native(0).unwrap()).unwrap()
    };
    let expected_layout = layout(&core);
    let image = expected_layout["controls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|control| control["type"] == "image")
        .unwrap();
    // Coordinates read from the hash-pinned Mac Hancom body-mixed-text PDF.
    for (field, expected) in [
        ("x", 176.7528076171875),
        ("y", 99.2359619140625),
        ("w", 179.99270629882812),
        ("h", 89.996337890625),
    ] {
        let actual = image[field].as_f64().unwrap() * 0.75;
        assert!(
            (actual - expected).abs() <= 0.5,
            "{field}: {actual} vs {expected}"
        );
    }
    // Environment choices are not undoable edits, even for an older snapshot.
    core.restore_snapshot_native(windows_snapshot).unwrap();
    assert_eq!(layout(&core), expected_layout);
    core.replace_content_from_bytes_native(&original_export)
        .unwrap();
    assert_eq!(layout(&core), expected_layout);
    for _ in 0..3 {
        core = DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap();
        core.set_font_metrics_policy_native(FontMetricsPolicy::HcrDeclared);
        assert_eq!(layout(&core), expected_layout);
    }
}

fn assert_image_bounds_through_reopening(bytes: &[u8], expected_pt: [f64; 4]) {
    let mut core = DocumentCore::from_bytes(bytes).expect("open captured Hancom input");
    let mut original_layout = None;
    for cycle in 0..=3 {
        assert_eq!(core.page_count(), 1, "cycle {cycle}: page count");
        let layout: Value = serde_json::from_str(
            &core
                .get_page_control_layout_native(0)
                .expect("control layout"),
        )
        .expect("layout JSON");
        let images: Vec<_> = layout["controls"]
            .as_array()
            .expect("controls")
            .iter()
            .filter(|control| control["type"] == "image")
            .collect();
        assert_eq!(images.len(), 1, "cycle {cycle}: image count");
        let image = images[0];
        assert_eq!(image["cellIdx"], 0, "image must remain inside first cell");
        assert_eq!(image["cellPath"].as_array().unwrap().len(), 1);
        for (field, expected) in ["x", "y", "w", "h"].into_iter().zip(expected_pt) {
            // Core layout defaults to 96 DPI; PDF coordinates are in points.
            let actual = image[field].as_f64().expect("numeric bound") * 72.0 / 96.0;
            assert!(
                (actual - expected).abs() <= 0.5,
                "cycle {cycle}: {field} = {actual} pt; Hancom = {expected} pt"
            );
        }
        if let Some(original) = &original_layout {
            assert_eq!(&layout, original, "cycle {cycle}: local layout drift");
        } else {
            original_layout = Some(layout);
        }
        if cycle < 3 {
            core = DocumentCore::from_bytes(&core.export_hwpx_native().expect("save HWPX"))
                .expect("reopen HWPX");
        }
    }
}

#[test]
fn empty_cell_image_bounds_match_mac_hancom() {
    assert_image_bounds_through_reopening(
        include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0/cell-empty/edited.hwpx"),
        [
            92.99622344970703,
            103.435791015625,
            179.9926986694336,
            89.996337890625,
        ],
    );
}

#[test]
fn mixed_cell_image_bounds_match_mac_hancom() {
    assert_image_bounds_through_reopening(
        include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0/cell-mixed-text/edited.hwpx"),
        [
            92.99622344970703,
            119.51513671875,
            179.9926986694336,
            89.996337890625,
        ],
    );
}

#[test]
fn full_width_cell_image_bounds_match_mac_hancom() {
    assert_image_bounds_through_reopening(
        include_bytes!("fixtures/editing_parity/mac-hancom-12.30.0/cell-fit-width/edited.hwpx"),
        [
            92.99622344970703,
            103.435791015625,
            199.5519027709961,
            99.8359375,
        ],
    );
}
