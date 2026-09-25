//! 셀 블록의 구조·내용·실행 취소 계약.
use rhwp::document_core::DocumentCore;
use rhwp::model::{
    control::Control,
    document::{Document, Section},
    paragraph::Paragraph,
    table::{Cell, Table},
};

fn nested_core() -> DocumentCore {
    let mut inner = Table {
        row_count: 2,
        col_count: 3,
        ..Default::default()
    };
    for row in 0..2 {
        for col in 0..3 {
            let text = format!("칸{row}{col}");
            inner.cells.push(Cell {
                row,
                col,
                row_span: 1,
                col_span: 1,
                width: 5000 + u32::from(col) * 1000,
                height: 3000,
                paragraphs: vec![Paragraph {
                    char_count: text.chars().count() as u32 + 1,
                    char_offsets: (0..text.chars().count() as u32).collect(),
                    text,
                    has_para_text: true,
                    ..Default::default()
                }],
                ..Default::default()
            });
        }
    }
    inner.rebuild_grid();
    let mut host = Paragraph::new_empty();
    host.controls.push(Control::Table(Box::new(inner)));
    let outer = Table {
        row_count: 1,
        col_count: 1,
        cells: vec![Cell {
            row_span: 1,
            col_span: 1,
            width: 30000,
            height: 9000,
            paragraphs: vec![host],
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut body = Paragraph::new_empty();
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
fn table(core: &DocumentCore) -> &Table {
    let Control::Table(outer) = &core.document().sections[0].paragraphs[0].controls[0] else {
        panic!("바깥 표")
    };
    let Control::Table(inner) = &outer.cells[0].paragraphs[0].controls[0] else {
        panic!("안쪽 표")
    };
    inner
}
const PATH: &[(usize, usize, usize)] = &[(0, 0, 0), (0, 0, 0)];

#[test]
fn 중첩_셀_복사와_붙여넣기는_일반_방향과_대상_폭을_보존한다() {
    let mut core = nested_core();
    let copied: serde_json::Value = serde_json::from_str(
        &core
            .copy_table_cell_range_native(0, 0, PATH, 0, 0, 0, 1)
            .unwrap(),
    )
    .unwrap();
    assert!(copied["text"].as_str().unwrap().contains("칸00\t칸01"));
    assert!(copied["html"].as_str().unwrap().contains("<table"));
    let before = core.save_snapshot_native();
    core.paste_table_cell_range_native(0, 0, PATH, 1, 1)
        .unwrap();
    let after = core.save_snapshot_native();
    let cells = &table(&core).cells;
    assert_eq!(cells[4].paragraphs[0].text, "칸00");
    assert_eq!(cells[5].paragraphs[0].text, "칸01");
    assert_eq!(cells[4].width, 6000);
    assert_eq!(cells[5].width, 7000);
    core.restore_snapshot_native(before).unwrap();
    assert_eq!(table(&core).cells[4].paragraphs[0].text, "칸11");
    core.restore_snapshot_native(after).unwrap();
    assert_eq!(table(&core).cells[4].paragraphs[0].text, "칸00");
}

#[test]
fn 병합_셀을_복사하고_내용을_지워도_구조가_유지된다() {
    let mut core = nested_core();
    core.merge_table_cells_by_cell_path_native(0, 0, PATH, 0, 0, 0, 1)
        .unwrap();
    core.copy_table_cell_range_native(0, 0, PATH, 0, 0, 0, 1)
        .unwrap();
    core.paste_table_cell_range_native(0, 0, PATH, 1, 0)
        .unwrap();
    assert_eq!(table(&core).cells.len(), 4);
    let merged = table(&core)
        .cells
        .iter()
        .find(|cell| cell.row == 1 && cell.col == 0)
        .unwrap();
    assert_eq!(merged.col_span, 2);
    assert!(merged
        .paragraphs
        .iter()
        .any(|paragraph| paragraph.text.contains("칸00")));
    let before = core.save_snapshot_native();
    core.clear_table_cell_range_native(0, 0, PATH, 1, 0, 1, 1)
        .unwrap();
    assert_eq!(table(&core).cells[2].col_span, 2);
    assert!(table(&core).cells[2].paragraphs[0].text.is_empty());
    let after = core.save_snapshot_native();
    core.restore_snapshot_native(before).unwrap();
    assert!(table(&core).cells[2]
        .paragraphs
        .iter()
        .any(|paragraph| paragraph.text.contains("칸00")));
    core.restore_snapshot_native(after).unwrap();
    assert!(table(&core).cells[2].paragraphs[0].text.is_empty());
}

#[test]
fn 범위_초과_붙여넣기는_원자적이고_병합_선택은_셀_전체로_확장된다() {
    let mut core = nested_core();
    core.copy_table_cell_range_native(0, 0, PATH, 0, 0, 0, 1)
        .unwrap();
    let before = table(&core).clone();
    assert!(core
        .paste_table_cell_range_native(0, 0, PATH, 1, 2)
        .is_err());
    assert_eq!(format!("{:?}", table(&core)), format!("{before:?}"));
    core.merge_table_cells_by_cell_path_native(0, 0, PATH, 0, 0, 0, 1)
        .unwrap();
    let copied = core
        .copy_table_cell_range_native(0, 0, PATH, 0, 0, 0, 0)
        .unwrap();
    assert!(copied.contains("colspan=\\\"2"));
    assert!(core
        .paste_table_cell_range_native(0, 0, PATH, 0, 1)
        .is_err());
    core.clear_table_cell_range_native(0, 0, PATH, 0, 0, 0, 0)
        .unwrap();
    assert_eq!(table(&core).cells[0].col_span, 2);
    assert!(table(&core).cells[0].paragraphs[0].text.is_empty());
}

#[test]
fn 셀_안의_중첩_표도_본문에_붙여넣고_html로_내보낸다() {
    let mut core = nested_core();
    let copied: serde_json::Value = serde_json::from_str(
        &core
            .copy_table_cell_range_native(0, 0, &[(0, 0, 0)], 0, 0, 0, 0)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        copied["html"].as_str().unwrap().matches("<table").count(),
        2
    );
    assert!(copied["text"].as_str().unwrap().contains("칸12"));
    core.paste_control_native(0, 0, 0).unwrap();
    let tables: Vec<_> = core.document().sections[0]
        .paragraphs
        .iter()
        .flat_map(|paragraph| &paragraph.controls)
        .filter_map(|control| match control {
            Control::Table(table) => Some(table),
            _ => None,
        })
        .collect();
    assert_eq!(tables.len(), 2);
    for table in tables {
        let Control::Table(inner) = &table.cells[0].paragraphs[0].controls[0] else {
            panic!("중첩 표 누락")
        };
        assert_eq!(inner.cells[5].paragraphs[0].text, "칸12");
    }
}

#[test]
fn 보호된_셀은_복사할_수_있지만_지우거나_덮어쓰지_않는다() {
    let mut core = nested_core();
    let mut document = core.document().clone();
    let Control::Table(outer) = &mut document.sections[0].paragraphs[0].controls[0] else {
        unreachable!()
    };
    let Control::Table(inner) = &mut outer.cells[0].paragraphs[0].controls[0] else {
        unreachable!()
    };
    inner.cells[0].set_cell_protect(true);
    core.set_document(document);
    core.copy_table_cell_range_native(0, 0, PATH, 0, 0, 0, 0)
        .unwrap();
    assert!(core
        .clear_table_cell_range_native(0, 0, PATH, 0, 0, 0, 0)
        .is_err());
    assert!(core
        .paste_table_cell_range_native(0, 0, PATH, 0, 0)
        .is_err());
    assert_eq!(table(&core).cells[0].paragraphs[0].text, "칸00");
}

#[test]
fn 병합_셀을_중첩_표로_붙여넣으면_두_문단이_겹치지_않는다() {
    use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let created: serde_json::Value = serde_json::from_str(
        &core
            .create_table_ex_native(0, 0, 0, 2, 3, false, None, None)
            .unwrap(),
    )
    .unwrap();
    let parent = created["paraIdx"].as_u64().unwrap() as usize;
    let control = created["controlIdx"].as_u64().unwrap() as usize;
    for cell in 0..6 {
        core.insert_text_in_cell_native(0, parent, control, cell, 0, 0, &format!("칸{cell}"))
            .unwrap();
    }
    core.merge_table_cells_native(0, parent, control, 0, 0, 0, 1)
        .unwrap();
    core.copy_table_cell_range_native(0, parent, &[(control, 0, 0)], 0, 0, 0, 0)
        .unwrap();
    core.paste_internal_in_cell_by_path_native(0, parent, &[(control, 4, 0)], 0)
        .unwrap();
    fn walk(
        node: &RenderNode,
        tables: usize,
        cells: &mut Vec<(f64, f64, f64, f64)>,
        runs: &mut Vec<(String, f64, f64)>,
    ) {
        let tables = tables + usize::from(matches!(node.node_type, RenderNodeType::Table(_)));
        if tables >= 2 && matches!(node.node_type, RenderNodeType::Table(_)) {
            if let Some(&(x, _, width, _)) = cells.last() {
                assert!(
                    node.bbox.x + node.bbox.width <= x + width + 0.5,
                    "중첩 표가 부모 셀 폭을 넘침"
                );
            }
        }
        let is_cell = matches!(node.node_type, RenderNodeType::TableCell(_));
        if is_cell {
            cells.push((node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height));
        }
        if tables == 1 && matches!(node.node_type, RenderNodeType::TextLine(_)) {
            let text: String = node
                .children
                .iter()
                .filter_map(|child| match &child.node_type {
                    RenderNodeType::TextRun(run) => Some(run.text.as_str()),
                    _ => None,
                })
                .collect();
            if text == "칸5" {
                let glyph = node
                    .children
                    .iter()
                    .find(|child| matches!(child.node_type, RenderNodeType::TextRun(_)))
                    .unwrap();
                for &(_, y, _, height) in cells.iter() {
                    assert!(
                        glyph.bbox.y + glyph.bbox.height <= y + height + 0.5,
                        "기존 글이 부모 셀 아래로 넘침"
                    );
                }
                let RenderNodeType::TextRun(run) = &glyph.node_type else {
                    unreachable!()
                };
                runs.push((
                    "바깥문단".into(),
                    glyph.bbox.y + run.baseline - run.style.font_size * 0.85,
                    run.style.font_size,
                ));
            }
        }
        if tables >= 2 {
            if let RenderNodeType::TextRun(run) = &node.node_type {
                for &(x, y, width, height) in cells.iter() {
                    assert!(
                        node.bbox.y + node.bbox.height <= y + height + 0.5,
                        "중첩 글이 부모 셀 아래로 넘침: {:?}, {cells:?}",
                        node.bbox
                    );
                    assert!(
                        node.bbox.x + node.bbox.width <= x + width + 0.5,
                        "중첩 글이 부모 셀 오른쪽으로 넘침"
                    );
                }
                if run.text.starts_with('칸') {
                    runs.push((
                        run.text.clone(),
                        node.bbox.y + run.baseline - run.style.font_size * 0.85,
                        run.style.font_size,
                    ));
                }
            }
        }
        for child in &node.children {
            walk(child, tables, cells, runs);
        }
        if is_cell {
            cells.pop();
        }
    }
    let mut runs = Vec::new();
    walk(
        &core.build_page_render_tree(0).unwrap().root,
        0,
        &mut Vec::new(),
        &mut runs,
    );
    let outer = runs
        .iter()
        .find(|run| run.0 == "바깥문단")
        .expect("기존 셀 문단")
        .clone();
    runs.retain(|run| run.0 != "바깥문단");
    for run in &runs {
        assert!(
            outer.1 + outer.2 <= run.1 + 0.1 || run.1 + run.2 <= outer.1 + 0.1,
            "기존 셀 글과 중첩 글이 겹침: {outer:?}, {run:?}"
        );
    }
    assert_eq!(runs.len(), 2, "중첩 셀의 두 문단");
    assert!(
        runs[1].1 >= runs[0].1 + runs[0].2 - 0.1,
        "문단 겹침: {runs:?}"
    );
}
