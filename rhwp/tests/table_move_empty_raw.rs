//! 표 위치 편집이 빈 `raw_ctrl_data` 를 0으로 채워 저장 기하를 파괴하지 않는지 가드.
//!
//! HWPX 파스본 표는 `raw_ctrl_data` 가 비어 있고, HWP5 `serialize_table` 과
//! HWPX→HWP 어댑터는 비어 있을 때만 `common` 으로 CTRL_HEADER 를 합성한다.
//! `move_table_offset` 이 빈 raw 를 12바이트까지 `push(0)` 하면 그 합성이 끊기고
//! width/height/바깥여백이 저장에서 사라진다.

use std::fs;
use std::path::Path;

use rhwp::model::control::Control;
use rhwp::model::table::Table;
use rhwp::wasm_api::HwpDocument;

const EMPTY_RAW_HWP: &str = "samples/hwp5-tbl-attr-1916.hwp";
const HWPX_SAMPLE: &str = "samples/task1772/table_outer_margin_common_sync.hwpx";
const POPULATED_RAW_HWP: &str = "samples/calc-cell.hwp";

type TablePos = (usize, usize, usize);

fn load(sample: &str) -> HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(sample);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {sample}: {e}"));
    HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {sample}: {e:?}"))
}

fn first_table_pos(doc: &HwpDocument) -> TablePos {
    for (si, section) in doc.document().sections.iter().enumerate() {
        for (pi, para) in section.paragraphs.iter().enumerate() {
            for (ci, control) in para.controls.iter().enumerate() {
                if matches!(control, Control::Table(_)) {
                    return (si, pi, ci);
                }
            }
        }
    }
    panic!("표가 없다");
}

fn table_at(doc: &HwpDocument, pos: TablePos) -> &Table {
    match &doc.document().sections[pos.0].paragraphs[pos.1].controls[pos.2] {
        Control::Table(table) => table.as_ref(),
        _ => panic!("expected table at {pos:?}"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Geometry {
    width: u32,
    height: u32,
    margin: (i16, i16, i16, i16),
    outer: (i16, i16, i16, i16),
}

fn geometry(table: &Table) -> Geometry {
    Geometry {
        width: table.common.width,
        height: table.common.height,
        margin: (
            table.common.margin.left,
            table.common.margin.right,
            table.common.margin.top,
            table.common.margin.bottom,
        ),
        outer: (
            table.outer_margin_left,
            table.outer_margin_right,
            table.outer_margin_top,
            table.outer_margin_bottom,
        ),
    }
}

fn move_table(doc: &mut HwpDocument, pos: TablePos, delta_h: i32, delta_v: i32) -> TablePos {
    doc.move_table_offset(pos.0 as u32, pos.1 as u32, pos.2 as u32, delta_h, delta_v)
        .expect("move_table_offset");
    first_table_pos(doc)
}

#[test]
fn moving_empty_raw_hwp_table_does_not_grow_raw() {
    let mut doc = load(EMPTY_RAW_HWP);
    let pos = first_table_pos(&doc);
    assert!(
        table_at(&doc, pos).raw_ctrl_data.is_empty(),
        "전제: {EMPTY_RAW_HWP} 표 raw 가 비어 있다"
    );

    // 이 표본은 treat_as_char 라 세로 이동이 문단 교환을 탈 수 있다. 가로는 raw 만 본다.
    let pos = move_table(&mut doc, pos, 1000, 0);
    assert!(
        table_at(&doc, pos).raw_ctrl_data.is_empty(),
        "빈 raw 를 0 확장하면 serialize_table 이 12바이트 CTRL_HEADER 를 방출한다"
    );
}

#[test]
fn moving_empty_raw_hwp_table_preserves_geometry_through_hwp_save() {
    let mut doc = load(EMPTY_RAW_HWP);
    let pos = first_table_pos(&doc);
    let before = geometry(table_at(&doc, pos));
    assert!(
        before.width > 0 && before.height > 0,
        "전제: 표에 크기가 있다"
    );

    let _pos = move_table(&mut doc, pos, 1000, 0);
    let saved = doc.export_hwp_native().expect("export HWP");
    let reparsed = HwpDocument::from_bytes(&saved).expect("reparse HWP");
    let after = geometry(table_at(&reparsed, first_table_pos(&reparsed)));
    assert_eq!(
        after, before,
        "이동 후 HWP 저장·재파스에서 표 기하가 사라졌다"
    );
}

#[test]
fn move_still_applies_offsets_on_empty_raw() {
    let mut doc = load(EMPTY_RAW_HWP);
    let pos = first_table_pos(&doc);
    let (v0, h0) = {
        let t = table_at(&doc, pos);
        (
            t.common.vertical_offset as i32,
            t.common.horizontal_offset as i32,
        )
    };

    let pos = move_table(&mut doc, pos, 700, 0);
    let t = table_at(&doc, pos);
    assert_eq!(t.common.horizontal_offset as i32, h0 + 700);
    assert_eq!(t.common.vertical_offset as i32, v0);
}

#[test]
fn hwpx_tables_survive_move_and_hwpx_save() {
    let mut doc = load(HWPX_SAMPLE);
    let pos = first_table_pos(&doc);
    let t = table_at(&doc, pos);
    assert!(
        t.raw_ctrl_data.is_empty(),
        "전제: HWPX 파스본 표는 raw 가 비어 있다"
    );
    let before = geometry(t);
    let (v0, h0) = (
        t.common.vertical_offset as i32,
        t.common.horizontal_offset as i32,
    );
    assert!(
        before.width > 0 && before.height > 0,
        "전제: 표에 크기가 있다"
    );

    let pos = move_table(&mut doc, pos, 1000, 1000);
    assert!(
        table_at(&doc, pos).raw_ctrl_data.is_empty(),
        "HWPX 표 이동이 빈 raw 를 키우면 안 된다"
    );
    let t = table_at(&doc, pos);
    assert_eq!(t.common.horizontal_offset as i32, h0 + 1000);
    assert_eq!(t.common.vertical_offset as i32, v0 + 1000);

    let saved = doc.export_hwpx_native().expect("export HWPX");
    let reparsed = HwpDocument::from_bytes(&saved).expect("reparse HWPX");
    let after_pos = first_table_pos(&reparsed);
    let after = table_at(&reparsed, after_pos);
    assert_eq!(geometry(after), before);
    assert_eq!(after.common.horizontal_offset as i32, h0 + 1000);
    assert_eq!(after.common.vertical_offset as i32, v0 + 1000);
}

#[test]
fn hwpx_tables_survive_move_and_hwp_save() {
    let mut doc = load(HWPX_SAMPLE);
    let pos = first_table_pos(&doc);
    let before = geometry(table_at(&doc, pos));

    let _pos = move_table(&mut doc, pos, 1000, 1000);
    let saved = doc
        .export_hwp_with_adapter()
        .expect("export HWP via adapter");
    let reparsed = HwpDocument::from_bytes(&saved).expect("reparse HWP");
    assert_eq!(
        geometry(table_at(&reparsed, first_table_pos(&reparsed))),
        before,
        "HWPX 표를 옮긴 뒤 HWP 저장하면 어댑터가 12바이트 raw 를 정본으로 쓴다"
    );
}

#[test]
fn position_props_do_not_grow_empty_raw() {
    let mut doc = load(HWPX_SAMPLE);
    let pos = first_table_pos(&doc);
    let before = geometry(table_at(&doc, pos));

    doc.set_table_properties(
        pos.0 as u32,
        pos.1 as u32,
        pos.2 as u32,
        r#"{"vertOffset":2000,"horzOffset":1500,"keepWithAnchor":true}"#,
    )
    .expect("set_table_properties");

    {
        let t = table_at(&doc, pos);
        assert!(
            t.raw_ctrl_data.is_empty(),
            "위치 속성 setter 가 빈 raw 를 키우면 안 된다"
        );
        assert_eq!(t.common.vertical_offset, 2000);
        assert_eq!(t.common.horizontal_offset, 1500);
        assert_eq!(t.common.prevent_page_break, 1);
    }

    let saved = doc.export_hwpx_native().expect("export HWPX");
    let reparsed = HwpDocument::from_bytes(&saved).expect("reparse HWPX");
    let t = table_at(&reparsed, first_table_pos(&reparsed));
    assert_eq!(geometry(t), before);
    assert_eq!(t.common.vertical_offset, 2000);
    assert_eq!(t.common.horizontal_offset, 1500);
    assert_eq!(t.common.prevent_page_break, 1);
}

#[test]
fn populated_raw_still_dual_written() {
    let mut doc = load(POPULATED_RAW_HWP);
    let pos = first_table_pos(&doc);
    let raw_len = {
        let t = table_at(&doc, pos);
        assert!(
            t.raw_ctrl_data.len() >= 12,
            "전제: 한컴 파스본 표는 raw 를 가진다 (len={})",
            t.raw_ctrl_data.len()
        );
        t.raw_ctrl_data.len()
    };

    let pos = move_table(&mut doc, pos, 500, 300);
    let t = table_at(&doc, pos);
    assert_eq!(t.raw_ctrl_data.len(), raw_len, "raw 길이는 변하지 않는다");
    let raw_h = i32::from_le_bytes(t.raw_ctrl_data[8..12].try_into().unwrap());
    assert_eq!(
        raw_h, t.common.horizontal_offset as i32,
        "raw 와 common 이 함께 갱신돼야 한다"
    );
}
