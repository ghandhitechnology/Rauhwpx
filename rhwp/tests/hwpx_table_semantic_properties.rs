use std::fs;
use std::path::Path;

use rhwp::model::control::Control;
use rhwp::model::table::Table;
use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

const SAMPLE: &str = "samples/task1772/table_outer_margin_common_sync.hwpx";
type TablePos = (usize, usize, usize);

fn load() -> HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {SAMPLE}: {e}"));
    HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {SAMPLE}: {e:?}"))
}

fn table_positions(doc: &HwpDocument) -> Vec<TablePos> {
    let mut positions = Vec::new();
    for (si, section) in doc.document().sections.iter().enumerate() {
        for (pi, para) in section.paragraphs.iter().enumerate() {
            for (ci, control) in para.controls.iter().enumerate() {
                if matches!(control, Control::Table(_)) {
                    positions.push((si, pi, ci));
                }
            }
        }
    }
    positions
}

fn table_at(doc: &HwpDocument, pos: TablePos) -> &Table {
    match &doc.document().sections[pos.0].paragraphs[pos.1].controls[pos.2] {
        Control::Table(table) => table.as_ref(),
        _ => panic!("expected table at {pos:?}"),
    }
}

fn table_at_mut(doc: &mut HwpDocument, pos: TablePos) -> &mut Table {
    match &mut doc.document_mut().sections[pos.0].paragraphs[pos.1].controls[pos.2] {
        Control::Table(table) => table.as_mut(),
        _ => panic!("expected table at {pos:?}"),
    }
}

fn properties(doc: &HwpDocument, pos: TablePos) -> Value {
    let json = doc
        .get_table_properties(pos.0 as u32, pos.1 as u32, pos.2 as u32)
        .expect("get table properties");
    serde_json::from_str(&json).expect("parse table properties JSON")
}

#[derive(Debug, PartialEq)]
struct TableState {
    attr: u32,
    common_attr: u32,
    raw_ctrl_data: Vec<u8>,
    width: u32,
    height: u32,
    vertical_offset: u32,
    horizontal_offset: u32,
    common_margin: (i16, i16, i16, i16),
    outer_margin: (i16, i16, i16, i16),
    placement: String,
    border_fill_id: u16,
    cell_border_fill_ids: Vec<u16>,
    border_fill_count: usize,
}

fn state(doc: &HwpDocument, pos: TablePos) -> TableState {
    let table = table_at(doc, pos);
    TableState {
        attr: table.attr,
        common_attr: table.common.attr,
        raw_ctrl_data: table.raw_ctrl_data.clone(),
        width: table.common.width,
        height: table.common.height,
        vertical_offset: table.common.vertical_offset,
        horizontal_offset: table.common.horizontal_offset,
        common_margin: (
            table.common.margin.left,
            table.common.margin.right,
            table.common.margin.top,
            table.common.margin.bottom,
        ),
        outer_margin: (
            table.outer_margin_left,
            table.outer_margin_right,
            table.outer_margin_top,
            table.outer_margin_bottom,
        ),
        placement: format!(
            "{:?}/{:?}/{:?}/{:?}/{:?}/{}/{}/{}",
            table.common.text_wrap,
            table.common.vert_rel_to,
            table.common.vert_align,
            table.common.horz_rel_to,
            table.common.horz_align,
            table.common.flow_with_text,
            table.common.allow_overlap,
            table.common.prevent_page_break
        ),
        border_fill_id: table.border_fill_id,
        cell_border_fill_ids: table.cells.iter().map(|cell| cell.border_fill_id).collect(),
        border_fill_count: doc.document().doc_info.border_fills.len(),
    }
}

#[test]
fn hwpx_get_table_properties_uses_semantic_common_object_fields() {
    let mut doc = load();
    let positions = table_positions(&doc);
    assert!(positions.len() >= 2, "fixture must contain two tables");

    let first = properties(&doc, positions[0]);
    assert_eq!(first["tableWidth"], 49_240);
    assert_eq!(first["tableHeight"], 16_486);
    assert_eq!(first["outerLeft"], 140);
    assert_eq!(first["outerRight"], 140);
    assert_eq!(first["outerTop"], 140);
    assert_eq!(first["outerBottom"], 852);
    assert_eq!(first["treatAsChar"], false);
    assert_eq!(first["textWrap"], "TopAndBottom");
    assert_eq!(first["vertRelTo"], "Page");
    assert_eq!(first["vertAlign"], "Top");
    assert_eq!(first["horzRelTo"], "Page");
    assert_eq!(first["horzAlign"], "Center");
    assert_eq!(first["restrictInPage"], true);
    assert_eq!(first["allowOverlap"], false);
    assert_eq!(first["keepWithAnchor"], false);
    assert!(table_at(&doc, positions[0]).raw_ctrl_data.is_empty());

    let second = properties(&doc, positions[1]);
    assert_eq!(second["tableWidth"], 49_537);
    assert_eq!(second["tableHeight"], 18_270);
    assert_eq!(second["vertAlign"], "Bottom");
    assert_eq!(second["horzAlign"], "Left");
    assert_eq!(second["restrictInPage"], true);
    assert_eq!(second["keepWithAnchor"], true);

    let table = table_at_mut(&mut doc, positions[0]);
    table.common.vertical_offset = (-720_i32) as u32;
    table.common.horizontal_offset = (-1_440_i32) as u32;
    let signed = properties(&doc, positions[0]);
    assert_eq!(signed["vertOffset"], -720);
    assert_eq!(signed["horzOffset"], -1_440);
}

#[test]
fn hwpx_full_getter_payload_is_a_semantic_noop_across_export() {
    let mut doc = load();
    let pos = table_positions(&doc)[0];
    let before_properties = properties(&doc, pos);
    let before_state = state(&doc, pos);

    doc.set_table_properties(
        pos.0 as u32,
        pos.1 as u32,
        pos.2 as u32,
        &before_properties.to_string(),
    )
    .expect("set unchanged table properties");

    assert_eq!(state(&doc, pos), before_state);
    assert_eq!(properties(&doc, pos), before_properties);

    let exported = doc.export_hwpx_native().expect("export HWPX");
    let reparsed = HwpDocument::from_bytes(&exported).expect("reparse exported HWPX");
    let reparsed_pos = table_positions(&reparsed)[0];
    assert_eq!(properties(&reparsed, reparsed_pos), before_properties);
    assert_eq!(state(&reparsed, reparsed_pos), before_state);
}

#[test]
fn outer_margin_update_synchronizes_common_and_hwpx_export_fields() {
    let mut doc = load();
    let pos = table_positions(&doc)[0];
    let expected = (12, 234, 345, 456);

    doc.set_table_properties(
        pos.0 as u32,
        pos.1 as u32,
        pos.2 as u32,
        r#"{"outerLeft":12,"outerRight":234,"outerTop":345,"outerBottom":456}"#,
    )
    .expect("update table outer margins");

    let updated = state(&doc, pos);
    assert_eq!(updated.common_margin, expected);
    assert_eq!(updated.outer_margin, expected);
    let updated_properties = properties(&doc, pos);
    assert_eq!(updated_properties["outerLeft"], expected.0);
    assert_eq!(updated_properties["outerRight"], expected.1);
    assert_eq!(updated_properties["outerTop"], expected.2);
    assert_eq!(updated_properties["outerBottom"], expected.3);

    let exported = doc.export_hwpx_native().expect("export HWPX");
    let reparsed = HwpDocument::from_bytes(&exported).expect("reparse exported HWPX");
    let reparsed_pos = table_positions(&reparsed)[0];
    let reparsed_state = state(&reparsed, reparsed_pos);
    assert_eq!(reparsed_state.common_margin, expected);
    assert_eq!(reparsed_state.outer_margin, expected);
    assert_eq!(properties(&reparsed, reparsed_pos), updated_properties);
}
