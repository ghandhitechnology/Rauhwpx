#![cfg(not(target_arch = "wasm32"))]
//! 표 칸 폭을 줄였을 때의 계약.
//!
//! - 새 폭으로 다시 흐른 문단의 줄이 다음 문단 첫 줄과 겹치지 않는다 (셀 안 vpos 재연결).
//! - 크기 조절 뒤 저장한 스냅샷이 조절 결과를 담는다 (redo 가 조절 전으로 돌아가지 않음).

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::Paragraph;
use rhwp::model::table::{Cell, Table};

const LONG: &str = "이중 슬릿을 이용하여 빛의 간섭 무늬를 관찰하고 빛의 파동성을 확인한다.";

fn para(text: &str) -> Paragraph {
    Paragraph {
        text: text.to_string(),
        char_offsets: (0..text.chars().count() as u32).collect(),
        char_count: text.chars().count() as u32,
        has_para_text: true,
        ..Default::default()
    }
}

fn cell(col: u16, width: u32, paragraphs: Vec<Paragraph>) -> Cell {
    Cell {
        row: 0,
        col,
        col_span: 1,
        row_span: 1,
        width,
        height: 2000,
        paragraphs,
        ..Default::default()
    }
}

fn two_column_table() -> Table {
    Table {
        row_count: 1,
        col_count: 2,
        cells: vec![
            cell(0, 4000, vec![para("목표")]),
            cell(1, 36000, vec![para(LONG), para(LONG), para("마지막 문단")]),
        ],
        ..Default::default()
    }
}

/// 본문 문단 0 에 2열 표. 두 번째 칸에 세 문단.
fn flat_core() -> DocumentCore {
    let mut body = Paragraph::default();
    body.controls
        .push(Control::Table(Box::new(two_column_table())));
    let mut document = Document::default();
    document.sections.push(Section {
        paragraphs: vec![body],
        ..Default::default()
    });
    let mut core = DocumentCore::new_empty();
    core.set_document(document);
    core
}

/// 바깥 1×1 표 칸 안에 같은 2열 표.
fn nested_core() -> DocumentCore {
    let mut host = Paragraph::default();
    host.controls
        .push(Control::Table(Box::new(two_column_table())));
    let outer = Table {
        row_count: 1,
        col_count: 1,
        cells: vec![cell(0, 42000, vec![host])],
        ..Default::default()
    };
    let mut body = Paragraph::default();
    body.controls.push(Control::Table(Box::new(outer)));
    let mut document = Document::default();
    document.sections.push(Section {
        paragraphs: vec![body],
        ..Default::default()
    });
    let mut core = DocumentCore::new_empty();
    core.set_document(document);
    core
}

fn table<'a>(core: &'a DocumentCore, nested: bool) -> &'a Table {
    let Some(Control::Table(outer)) = core.document().sections[0].paragraphs[0].controls.first()
    else {
        panic!("표가 없다");
    };
    if !nested {
        return outer;
    }
    match outer.cells[0].paragraphs[0].controls.first() {
        Some(Control::Table(inner)) => inner,
        _ => panic!("안쪽 표가 없다"),
    }
}

/// 칸 안 문단의 줄이 위에서 아래로 겹치지 않고 이어지는지.
fn assert_lines_stacked(cell: &Cell) {
    let mut previous_bottom: Option<i32> = None;
    for (idx, paragraph) in cell.paragraphs.iter().enumerate() {
        for seg in &paragraph.line_segs {
            if let Some(bottom) = previous_bottom {
                assert!(
                    seg.vertical_pos >= bottom,
                    "문단 {idx} 의 줄(vpos {}) 이 앞 줄 아래(vpos {bottom}) 보다 위에 있다 — 줄이 겹친다",
                    seg.vertical_pos
                );
            }
            previous_bottom = Some(seg.vertical_pos + seg.line_height);
        }
    }
}

fn shrink(core: &mut DocumentCore, nested: bool) {
    let json = r#"[{"cellIdx":1,"widthDelta":-24000}]"#;
    if nested {
        core.resize_table_cells_by_cell_path_native(0, 0, &[(0, 0, 0), (0, 1, 0)], json)
            .expect("중첩 표 크기 조절");
    } else {
        core.resize_table_cells_by_cell_path_native(0, 0, &[(0, 1, 0)], json)
            .expect("표 크기 조절");
    }
}

#[test]
fn 열을_좁히면_줄바꿈된_문단들이_겹치지_않는다() {
    for nested in [false, true] {
        let mut core = if nested { nested_core() } else { flat_core() };
        let before = table(&core, nested).cells[1].paragraphs[0].line_segs.len();
        shrink(&mut core, nested);
        let cell = &table(&core, nested).cells[1];
        assert!(
            cell.paragraphs[0].line_segs.len() > before,
            "좁아진 칸에서 첫 문단이 더 많은 줄로 흘러야 한다 (nested={nested})"
        );
        assert_lines_stacked(cell);
    }
}

#[test]
fn 크기_변경_뒤의_스냅샷은_변경된_표를_보존한다() {
    for nested in [false, true] {
        let mut core = if nested { nested_core() } else { flat_core() };
        let original = table(&core, nested).cells[1].width;
        let before = core.save_snapshot_native();
        shrink(&mut core, nested);
        let resized = table(&core, nested).cells[1].width;
        assert_ne!(resized, original);
        let after = core.save_snapshot_native();

        core.restore_snapshot_native(before).expect("undo");
        assert_eq!(table(&core, nested).cells[1].width, original);
        core.restore_snapshot_native(after).expect("redo");
        assert_eq!(
            table(&core, nested).cells[1].width,
            resized,
            "redo 스냅샷이 크기 조절 전 문단을 공유하면 안 된다 (nested={nested})"
        );
    }
}
