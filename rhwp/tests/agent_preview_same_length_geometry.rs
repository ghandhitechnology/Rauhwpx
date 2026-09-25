//! 실제 서식 문서의 셀 텍스트 치환이 다른 표의 위치와 행 높이를 바꾸지 않는지 검사한다.

use std::fs;
use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use serde_json::{json, Value};

fn load(sample: &str) -> DocumentCore {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples")
        .join(sample);
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    DocumentCore::from_bytes(&bytes).unwrap_or_else(|error| panic!("parse {sample}: {error}"))
}

fn table_geometry(core: &DocumentCore) -> Vec<Value> {
    let mut tables = Vec::new();
    for page in 0..core.page_count() {
        let layout: Value = serde_json::from_str(
            &core
                .get_page_control_layout_native(page)
                .expect("control layout"),
        )
        .expect("control layout JSON");
        for control in layout["controls"].as_array().expect("controls array") {
            if control["type"] != "table" || !control["outerTableControlIdx"].is_null() {
                continue;
            }
            tables.push(json!({
                "page": page,
                "secIdx": control["secIdx"],
                "paraIdx": control["paraIdx"],
                "controlIdx": control["controlIdx"],
                "x": control["x"], "y": control["y"],
                "w": control["w"], "h": control["h"],
            }));
        }
    }
    tables
}

fn check_same_length_edit(
    sample: &str,
    table_para: usize,
    table_control: usize,
    original: &str,
    replacement: &str,
    expected_pages: u32,
) {
    assert_eq!(original.chars().count(), replacement.chars().count());
    let mut core = load(sample);
    assert_eq!(
        core.page_count(),
        expected_pages,
        "{sample}: loaded page count"
    );
    let baseline = table_geometry(&core);
    assert!(!baseline.is_empty(), "{sample}: visible tables");

    let Control::Table(table) =
        &core.document().sections[0].paragraphs[table_para].controls[table_control]
    else {
        panic!("{sample}: target table");
    };
    assert_eq!(
        table.cells[0].paragraphs[0].text, original,
        "{sample}: target text"
    );

    core.delete_text_in_cell_native(
        0,
        table_para,
        table_control,
        0,
        0,
        0,
        original.chars().count(),
    )
    .expect("delete target text");
    core.insert_text_in_cell_native(0, table_para, table_control, 0, 0, 0, replacement)
        .expect("insert same-length replacement");

    assert_eq!(
        core.page_count(),
        expected_pages,
        "{sample}: edited page count"
    );
    let edited = table_geometry(&core);
    assert_eq!(
        baseline.len(),
        edited.len(),
        "{sample}: table fragment count"
    );
    for (index, (before, after)) in baseline.iter().zip(&edited).enumerate() {
        assert_eq!(
            before, after,
            "{sample}: table fragment {index} moved after same-length cell edit"
        );
    }

    for refresh in 1..=2 {
        core.refresh_layout_native();
        assert_eq!(
            core.page_count(),
            expected_pages,
            "{sample}: page count after refresh {refresh}"
        );
        assert_eq!(
            table_geometry(&core),
            baseline,
            "{sample}: table geometry changed after refresh {refresh}"
        );
    }
}

#[test]
fn jinan_form_preserves_table_row_geometry() {
    check_same_length_edit(
        "task2319/20544835_jinan_apt_form.hwp",
        0,
        2,
        "공동주택 지원 신청서",
        "공동주택 지원 신청가",
        2,
    );
}

#[test]
fn repeated_tables_keep_their_page_positions() {
    check_same_length_edit(
        "issue2439/issue2439_repeat_table_overlap.hwp",
        1,
        0,
        "의료기기코드",
        "의료기기코가",
        10,
    );
}

#[test]
fn hwp_table_test_preserves_unrelated_tables() {
    check_same_length_edit("hwp_table_test.hwp", 3, 0, "제목", "제가", 3);
}

#[test]
fn public_health_table_preserves_split_origin() {
    check_same_length_edit(
        "21868765_별표2_보건소_분장사무.hwp",
        4,
        0,
        "부 서 명",
        "부 서 가",
        4,
    );
}

#[test]
fn jinan_title_growth_preserves_other_row_heights_and_restores() {
    let mut core = load("task2319/20544835_jinan_apt_form.hwp");
    let table_cells = |core: &DocumentCore| -> Vec<Value> {
        (0..core.page_count())
            .flat_map(|page_index| {
                let page: Value =
                    serde_json::from_str(&core.get_page_control_layout_native(page_index).unwrap())
                        .unwrap();
                page["controls"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|control| {
                        control["type"] == "table"
                            && control["paraIdx"] == 0
                            && control["controlIdx"] == 2
                    })
                    .flat_map(|control| control["cells"].as_array().unwrap().clone())
                    .collect::<Vec<_>>()
            })
            .collect()
    };
    let before_cells = table_cells(&core);
    let before_tables = table_geometry(&core);
    let title = "공동주택 지원 신청서";
    let expanded = "공동주택 지원 신청서 ".repeat(40);
    core.delete_text_in_cell_native(0, 0, 2, 0, 0, 0, title.chars().count())
        .unwrap();
    core.insert_text_in_cell_native(0, 0, 2, 0, 0, 0, &expanded)
        .unwrap();
    let expanded_cells = table_cells(&core);
    assert_eq!(before_cells.len(), expanded_cells.len());
    assert!(
        expanded_cells[0]["h"].as_f64().unwrap() > before_cells[0]["h"].as_f64().unwrap() + 5.0
    );
    for (before, after) in before_cells.iter().zip(&expanded_cells).skip(1) {
        assert_eq!(
            before["h"], after["h"],
            "an unedited Jinan row changed height"
        );
    }
    core.delete_text_in_cell_native(0, 0, 2, 0, 0, 0, expanded.chars().count())
        .unwrap();
    core.insert_text_in_cell_native(0, 0, 2, 0, 0, 0, title)
        .unwrap();
    core.refresh_layout_native();
    assert_eq!(table_cells(&core), before_cells);
    assert_eq!(table_geometry(&core), before_tables);
}

#[test]
fn paper_anchored_adjacent_tables_keep_gap_after_z_order_change() {
    let mut core = load("table-ipc.hwp");
    let adjacent = |core: &DocumentCore| {
        let tables = table_geometry(core);
        let get = |ci| {
            tables
                .iter()
                .find(|table| {
                    table["secIdx"] == 0
                        && table["paraIdx"] == 0
                        && table["controlIdx"] == ci
                        && table["page"] == 0
                })
                .unwrap()
        };
        let first = get(3);
        let second = get(4);
        (
            first["y"].as_f64().unwrap() + first["h"].as_f64().unwrap(),
            second["y"].as_f64().unwrap(),
        )
    };
    let (before_bottom, before_next_top) = adjacent(&core);
    assert!((before_bottom - before_next_top).abs() <= 0.1);

    core.change_object_z_order_native(0, 0, 3, "front").unwrap();
    let original = "공문제출번호 :";
    let Control::Table(table) = &core.document().sections[0].paragraphs[0].controls[3] else {
        panic!("expected the first paper-anchored table");
    };
    assert_eq!(table.cells[0].paragraphs[0].text, original);
    core.insert_text_in_cell_native(0, 0, 3, 0, 0, original.chars().count(), " 추가 내용 ")
        .unwrap();

    let (grown_bottom, next_top) = adjacent(&core);
    assert!(grown_bottom > before_bottom + 5.0, "the first table grows");
    assert!((grown_bottom - next_top).abs() <= 0.2,
        "adjacent tables overlap after z-order change: first bottom {grown_bottom}, second top {next_top}");
}
