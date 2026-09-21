#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::Paragraph;
use rhwp::model::shape::{CommonObjAttr, DrawingObjAttr, RectangleShape, ShapeObject, TextBox};
use rhwp::model::table::{Cell, Table};

const OUTER_CELL_WIDTH: u32 = 30000;
const INNER_LEFT_WIDTH: u32 = 4000;
const INNER_RIGHT_WIDTH: u32 = 6000;

/// 바깥 1×1 표의 칸 안에 2열 표가 든 문서.
///
/// 반환 경로는 studio `hitTest` 의 `cellPath` 와 같은 모양 —
/// `[(바깥 컨트롤, 바깥 셀, 그 셀의 문단), (안쪽 컨트롤, 안쪽 셀, 그 셀의 문단)]`.
fn nested_core() -> (DocumentCore, Vec<(usize, usize, usize)>) {
    let cell = |col: u16, width: u32, text: &str| Cell {
        row: 0,
        col,
        col_span: 1,
        row_span: 1,
        width,
        height: 3000,
        paragraphs: vec![Paragraph {
            text: text.to_string(),
            char_offsets: (0..text.chars().count() as u32).collect(),
            char_count: text.chars().count() as u32,
            has_para_text: true,
            ..Default::default()
        }],
        ..Default::default()
    };

    let inner_table = Table {
        row_count: 1,
        col_count: 2,
        cells: vec![
            cell(
                0,
                INNER_LEFT_WIDTH,
                "안쪽 왼쪽 칸의 글이 길어지면 다시 흐른다",
            ),
            cell(1, INNER_RIGHT_WIDTH, "안쪽 오른쪽"),
        ],
        ..Default::default()
    };

    let mut outer_cell_para = Paragraph::default();
    outer_cell_para
        .controls
        .push(Control::Table(Box::new(inner_table)));

    let outer_table = Table {
        row_count: 1,
        col_count: 1,
        cells: vec![Cell {
            row: 0,
            col: 0,
            col_span: 1,
            row_span: 1,
            width: OUTER_CELL_WIDTH,
            height: 9000,
            paragraphs: vec![outer_cell_para],
            ..Default::default()
        }],
        ..Default::default()
    };

    let mut body_para = Paragraph::default();
    body_para
        .controls
        .push(Control::Table(Box::new(outer_table)));

    let mut document = Document::default();
    document.sections.push(Section {
        paragraphs: vec![body_para],
        ..Default::default()
    });

    let mut core = DocumentCore::new_empty();
    core.set_document(document);
    (core, vec![(0, 0, 0), (0, 0, 0)])
}

fn outer_table(core: &DocumentCore) -> &Table {
    match core.document().sections[0].paragraphs[0].controls.first() {
        Some(Control::Table(table)) => table,
        _ => panic!("바깥 표를 찾지 못했다"),
    }
}

fn inner_table(core: &DocumentCore) -> &Table {
    match outer_table(core).cells[0].paragraphs[0].controls.first() {
        Some(Control::Table(table)) => table,
        _ => panic!("안쪽 표를 찾지 못했다"),
    }
}

fn table_in_textbox_core() -> (DocumentCore, Vec<(usize, usize, usize)>) {
    let cell = |col| Cell {
        row: 0,
        col,
        col_span: 1,
        row_span: 1,
        width: 5_000,
        height: 3_000,
        paragraphs: vec![Paragraph::new_empty()],
        ..Default::default()
    };
    let table = Control::Table(Box::new(Table {
        row_count: 1,
        col_count: 2,
        cells: vec![cell(0), cell(1)],
        ..Default::default()
    }));
    let shape = Control::Shape(Box::new(ShapeObject::Rectangle(RectangleShape {
        common: CommonObjAttr {
            width: 20_000,
            height: 12_000,
            treat_as_char: true,
            ..Default::default()
        },
        drawing: DrawingObjAttr {
            text_box: Some(TextBox {
                max_width: 20_000,
                paragraphs: vec![Paragraph {
                    controls: vec![table],
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    })));
    let mut document = Document::default();
    document.sections.push(Section {
        paragraphs: vec![Paragraph {
            controls: vec![shape],
            ..Default::default()
        }],
        ..Default::default()
    });
    let mut core = DocumentCore::new_empty();
    core.set_document(document);
    (core, vec![(0, 0, 0), (0, 0, 0)])
}

#[test]
fn nested_path_resizes_the_inner_table_only() {
    let (mut core, path) = nested_core();
    let before_outer_width = outer_table(&core).cells[0].width;

    core.resize_table_cells_by_cell_path_native(
        0,
        0,
        &path,
        r#"[{"cellIdx":0,"widthDelta":1200},{"cellIdx":1,"widthDelta":-1200}]"#,
    )
    .expect("중첩 표 셀 크기 조절이 성공해야 한다");

    let inner = inner_table(&core);
    assert_eq!(
        inner.cells[0].width,
        INNER_LEFT_WIDTH + 1200,
        "안쪽 왼쪽 칸이 넓어져야 한다"
    );
    assert_eq!(
        inner.cells[1].width,
        INNER_RIGHT_WIDTH - 1200,
        "안쪽 오른쪽 칸이 그만큼 좁아져야 한다"
    );
    assert_eq!(
        outer_table(&core).cells[0].width,
        before_outer_width,
        "바깥 표의 칸은 손대지 않는다 — 평면 API 로는 이 값이 대신 바뀌었다",
    );
}

#[test]
fn nested_resize_reflows_with_the_inner_cell_width() {
    let (mut core, path) = nested_core();
    let before_lines = inner_table(&core).cells[0].paragraphs[0].line_segs.len();

    core.resize_table_cells_by_cell_path_native(
        0,
        0,
        &path,
        r#"[{"cellIdx":0,"widthDelta":-3000}]"#,
    )
    .expect("중첩 표 셀 크기 조절이 성공해야 한다");

    let after_lines = inner_table(&core).cells[0].paragraphs[0].line_segs.len();
    assert!(
        after_lines > before_lines,
        "안쪽 칸을 좁히면 그 칸 글이 더 많은 줄로 흘러야 한다 (이전 {before_lines}줄 → 이후 {after_lines}줄)",
    );
}

#[test]
fn depth_one_path_targets_the_outer_table() {
    let (mut core, _) = nested_core();
    let before_outer = outer_table(&core).cells[0].height;
    let before_inner = inner_table(&core).cells[0].height;

    core.resize_table_cells_by_cell_path_native(
        0,
        0,
        &[(0, 0, 0)],
        r#"[{"cellIdx":0,"heightDelta":500}]"#,
    )
    .expect("깊이 1 경로가 성공해야 한다");

    assert_eq!(
        outer_table(&core).cells[0].height,
        before_outer + 500,
        "깊이 1 은 바깥 표의 칸을 조절한다"
    );
    assert_eq!(
        inner_table(&core).cells[0].height,
        before_inner,
        "안쪽 표는 건드리지 않는다"
    );
}

#[test]
fn a_path_that_does_not_end_at_a_table_is_refused() {
    let (mut core, _) = nested_core();
    let result = core.resize_table_cells_by_cell_path_native(
        0,
        0,
        &[(0, 0, 0), (1, 0, 0)],
        r#"[{"cellIdx":0,"widthDelta":100}]"#,
    );
    assert!(
        result.is_err(),
        "표가 아닌 경로는 조용히 성공하면 안 된다 — 엉뚱한 표가 바뀐다"
    );
    assert_eq!(
        inner_table(&core).cells[0].width,
        INNER_LEFT_WIDTH,
        "거부된 요청은 아무것도 바꾸지 않는다"
    );
}

#[test]
fn an_empty_path_is_refused() {
    let (mut core, _) = nested_core();
    let result = core.resize_table_cells_by_cell_path_native(
        0,
        0,
        &[],
        r#"[{"cellIdx":0,"widthDelta":100}]"#,
    );
    assert!(result.is_err(), "빈 경로는 거부해야 한다");
}

#[test]
fn resize_limit_properties_belong_to_the_same_nested_table() {
    let (core, path) = nested_core();
    for (idx, width) in [(0, INNER_LEFT_WIDTH), (1, INNER_RIGHT_WIDTH)] {
        let json = core
            .get_cell_properties_by_cell_path_native(0, 0, &path, idx)
            .unwrap();
        let props: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(props["width"], width);
        assert_eq!(props["height"], 3000);
    }
    let outer: serde_json::Value = serde_json::from_str(
        &core
            .get_cell_properties_by_cell_path_native(0, 0, &path[..1], 0)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(outer["width"], OUTER_CELL_WIDTH);
    assert!(core
        .get_cell_properties_by_cell_path_native(0, 0, &path, 2)
        .is_err());
    assert!(core
        .get_cell_properties_by_cell_path_native(0, 0, &[], 0)
        .is_err());
}

#[test]
fn nested_structural_edits_change_only_the_target_table() {
    let (mut core, path) = nested_core();

    core.insert_table_row_by_cell_path_native(0, 0, &path, 0, true)
        .expect("insert inner row");
    assert_eq!(
        (inner_table(&core).row_count, inner_table(&core).col_count),
        (2, 2)
    );
    assert_eq!(
        (outer_table(&core).row_count, outer_table(&core).col_count),
        (1, 1)
    );

    core.delete_table_row_by_cell_path_native(0, 0, &path, 1)
        .expect("delete inner row");
    core.insert_table_column_by_cell_path_native(0, 0, &path, 1, true)
        .expect("insert inner column");
    assert_eq!(
        (inner_table(&core).row_count, inner_table(&core).col_count),
        (1, 3)
    );

    core.delete_table_column_by_cell_path_native(0, 0, &path, 2)
        .expect("delete inner column");
    core.merge_table_cells_by_cell_path_native(0, 0, &path, 0, 0, 0, 1)
        .expect("merge inner cells");
    assert_eq!(inner_table(&core).cells.len(), 1);
    assert_eq!(outer_table(&core).cells.len(), 1);

    core.split_table_cell_by_cell_path_native(0, 0, &path, 0, 0)
        .expect("split inner merged cell");
    assert_eq!(inner_table(&core).cells.len(), 2);
    assert_eq!(
        (outer_table(&core).row_count, outer_table(&core).col_count),
        (1, 1)
    );
}

#[test]
fn nested_advanced_split_paths_preserve_the_outer_table() {
    let (mut core, path) = nested_core();
    core.split_table_cell_into_by_cell_path_native(0, 0, &path, 0, 0, 2, 2, true, false)
        .expect("split inner cell into grid");

    let inner_after_one = inner_table(&core).cells.len();
    assert!(inner_after_one > 2, "the inner table must gain cells");
    assert_eq!(outer_table(&core).cells.len(), 1);

    core.split_table_cells_in_range_by_cell_path_native(0, 0, &path, 0, 0, 0, 0, 1, 2, true)
        .expect("split an inner range");
    assert!(inner_table(&core).cells.len() > inner_after_one);
    assert_eq!(
        (outer_table(&core).row_count, outer_table(&core).col_count),
        (1, 1)
    );
}

#[test]
fn rejected_nested_structural_edit_is_atomic() {
    let (mut core, path) = nested_core();
    let before = (inner_table(&core).row_count, inner_table(&core).cells.len());

    assert!(core
        .delete_table_row_by_cell_path_native(0, 0, &path, 0)
        .is_err());
    assert!(core
        .insert_table_row_by_cell_path_native(0, 0, &[(0, 0, 0), (99, 0, 0)], 0, true)
        .is_err());

    assert_eq!(
        (inner_table(&core).row_count, inner_table(&core).cells.len()),
        before
    );
    assert_eq!(
        (outer_table(&core).row_count, outer_table(&core).col_count),
        (1, 1)
    );
}

#[test]
fn logical_cell_target_tracks_reordered_nested_cells() {
    let (mut core, path) = nested_core();
    core.insert_table_column_by_cell_path_native(0, 0, &path, 0, false)
        .expect("insert before the original cell");

    let path_json = serde_json::json!([
        { "controlIndex": 0, "cellIndex": 0, "cellParaIndex": 0 },
        { "controlIndex": 0, "cellIndex": 0, "cellParaIndex": 0 }
    ])
    .to_string();
    let target: serde_json::Value = serde_json::from_str(
        &core
            .get_table_cell_target_by_path_native(0, 0, &path_json, 0, 1, 0)
            .expect("resolve shifted original cell"),
    )
    .unwrap();

    assert_eq!(target["cellIndex"], 1);
    assert_eq!(target["cellParaIndex"], 0);
    assert!(target["charCount"].as_u64().unwrap() > 0);
}

#[test]
fn structural_path_reaches_a_table_inside_a_textbox() {
    let (mut core, path) = table_in_textbox_core();
    core.merge_table_cells_by_cell_path_native(0, 0, &path, 0, 0, 0, 1)
        .expect("merge table inside textbox");

    let shape = match &core.document().sections[0].paragraphs[0].controls[0] {
        Control::Shape(shape) => shape,
        _ => panic!("textbox shape"),
    };
    let rectangle = match shape.as_ref() {
        ShapeObject::Rectangle(rectangle) => rectangle,
        _ => panic!("rectangle textbox"),
    };
    let table = match &rectangle.drawing.text_box.as_ref().unwrap().paragraphs[0].controls[0] {
        Control::Table(table) => table,
        _ => panic!("table in textbox"),
    };
    assert_eq!(table.cells.len(), 1);
}

#[test]
fn structural_path_reaches_three_table_levels() {
    let (mut core, _) = nested_core();
    let deepest = inner_table(&core).clone();
    let outer = match &mut core.document_mut().sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => table,
        _ => panic!("outer table"),
    };
    let middle = match &mut outer.cells[0].paragraphs[0].controls[0] {
        Control::Table(table) => table,
        _ => panic!("middle table"),
    };
    middle.cells[0].paragraphs[0]
        .controls
        .push(Control::Table(Box::new(deepest)));
    core.set_document(core.document().clone());

    let path = [(0, 0, 0), (0, 0, 0), (0, 0, 0)];
    core.merge_table_cells_by_cell_path_native(0, 0, &path, 0, 0, 0, 1)
        .expect("merge third-level table");

    let outer = outer_table(&core);
    let middle = match &outer.cells[0].paragraphs[0].controls[0] {
        Control::Table(table) => table,
        _ => panic!("middle table"),
    };
    let deepest = match &middle.cells[0].paragraphs[0].controls[0] {
        Control::Table(table) => table,
        _ => panic!("deepest table"),
    };
    assert_eq!(deepest.cells.len(), 1);
    assert_eq!(middle.cells.len(), 2);
    assert_eq!(outer.cells.len(), 1);
}
