//! 에이전트 셀 수식 API 계약: getFontList / insertEquationInCell / deleteEquationControlInCell.
//!
//! - `get_font_list` 는 등록 원본 이름(대체 해소 없음)을 `{lang,id,name}` 배열로 돌려준다.
//! - `insert_equation_in_cell_native` 는 본문 `insert_equation_native` 와 동일한 컨트롤을
//!   셀 문단에 조립하고, 셀 텍스트 편집과 같은 재조판 경로를 탄다.
//! - `delete_equation_control_in_cell_native` 는 그 역연산으로 char_count 8 감소·오프셋
//!   되돌림까지 수행한다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use serde_json::Value;

/// 2×2 표 하나를 가진 빈 문서. 반환: (core, 표 문단 인덱스, 표 컨트롤 인덱스).
fn doc_with_table() -> (DocumentCore, usize, usize) {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().expect("blank document");
    core.create_table_ex_native(0, 0, 0, 2, 2, false, None, None)
        .expect("2x2 table");

    let para_idx = core.document().sections[0]
        .paragraphs
        .iter()
        .position(|p| p.controls.iter().any(|c| matches!(c, Control::Table(_))))
        .expect("표가 놓인 문단");
    let ctrl_idx = core.document().sections[0].paragraphs[para_idx]
        .controls
        .iter()
        .position(|c| matches!(c, Control::Table(_)))
        .expect("표 컨트롤");
    (core, para_idx, ctrl_idx)
}

fn cell_paragraph<'a>(
    core: &'a DocumentCore,
    para_idx: usize,
    ctrl_idx: usize,
    cell_idx: usize,
    cell_para_idx: usize,
) -> &'a rhwp::model::paragraph::Paragraph {
    match &core.document().sections[0].paragraphs[para_idx].controls[ctrl_idx] {
        Control::Table(table) => &table.cells[cell_idx].paragraphs[cell_para_idx],
        other => panic!("표가 아님: {other:?}"),
    }
}

/// getFontList: 로드된 문서에서 유효한 JSON 배열과 최소 1개의 글꼴을 돌려준다.
#[test]
fn font_list_returns_registered_fonts() {
    let (core, _, _) = doc_with_table();
    let json = core.get_font_list();
    let value: Value =
        serde_json::from_str(&json).unwrap_or_else(|e| panic!("JSON 파싱 ({e}): {json}"));
    let entries = value.as_array().expect("배열이어야 한다");
    assert!(
        !entries.is_empty(),
        "등록 글꼴이 최소 1개 있어야 한다: {json}"
    );
    for entry in entries {
        let lang = entry["lang"].as_u64().expect("lang 숫자");
        assert!(lang <= 6, "lang 슬롯은 0~6: {entry}");
        entry["id"].as_u64().expect("id 숫자");
        let name = entry["name"].as_str().expect("name 문자열");
        assert!(!name.is_empty(), "글꼴 이름이 비어있지 않아야 한다");
    }
}

/// insertEquationInCell → getEquationProperties(셀 경로)로 스크립트를 읽고,
/// deleteEquationControlInCell 로 제거한다. 두 번째 삭제는 오류.
#[test]
fn insert_read_delete_equation_in_cell() {
    let (mut core, para_idx, ctrl_idx) = doc_with_table();
    let char_count_before = cell_paragraph(&core, para_idx, ctrl_idx, 0, 0).char_count;

    let result = core
        .insert_equation_in_cell_native(0, para_idx, ctrl_idx, 0, 0, 0, "1 over 2", 1000, 0)
        .expect("셀 수식 삽입");
    let v: Value = serde_json::from_str(&result).expect("삽입 결과 JSON");
    assert_eq!(v["ok"], Value::Bool(true));
    assert_eq!(v["cellParaIdx"].as_u64(), Some(0));
    let eq_idx = v["controlIdx"].as_u64().expect("controlIdx") as usize;

    // 모델: 셀 문단에 수식 컨트롤이 생겼고 char_count 가 8 증가했다.
    let cell_para = cell_paragraph(&core, para_idx, ctrl_idx, 0, 0);
    assert!(
        matches!(cell_para.controls.get(eq_idx), Some(Control::Equation(_))),
        "controlIdx 위치에 수식 컨트롤이 있어야 한다"
    );
    assert_eq!(cell_para.char_count, char_count_before + 8, "수식은 8칸");

    // 조회: 셀 경로 getEquationProperties 가 스크립트를 되돌려준다.
    let props = core
        .get_equation_properties_native(0, para_idx, ctrl_idx, Some(0), Some(0))
        .expect("셀 수식 속성 조회");
    let pv: Value = serde_json::from_str(&props).expect("속성 JSON");
    assert_eq!(pv["script"].as_str(), Some("1 over 2"));

    // 삭제: 컨트롤 제거 + char_count 원복.
    let deleted = core
        .delete_equation_control_in_cell_native(0, para_idx, ctrl_idx, 0, 0, eq_idx)
        .expect("셀 수식 삭제");
    let dv: Value = serde_json::from_str(&deleted).expect("삭제 결과 JSON");
    assert_eq!(dv["ok"], Value::Bool(true));

    let cell_para = cell_paragraph(&core, para_idx, ctrl_idx, 0, 0);
    assert!(
        !cell_para
            .controls
            .iter()
            .any(|c| matches!(c, Control::Equation(_))),
        "삭제 후 셀 문단에 수식 컨트롤이 남으면 안 된다"
    );
    assert_eq!(cell_para.char_count, char_count_before, "char_count 원복");

    // 같은 인덱스 재삭제는 오류 (컨트롤이 이미 없다).
    assert!(
        core.delete_equation_control_in_cell_native(0, para_idx, ctrl_idx, 0, 0, eq_idx)
            .is_err(),
        "두 번째 삭제는 오류여야 한다"
    );
}

/// 범위 밖 셀/문단 좌표 삽입은 오류다.
#[test]
fn insert_into_out_of_range_cell_errors() {
    let (mut core, para_idx, ctrl_idx) = doc_with_table();

    // 2×2 표: 셀 인덱스 99 는 범위 밖.
    assert!(
        core.insert_equation_in_cell_native(0, para_idx, ctrl_idx, 99, 0, 0, "x", 1000, 0)
            .is_err(),
        "범위 밖 셀 인덱스는 오류여야 한다"
    );
    // 셀 문단 인덱스 범위 밖.
    assert!(
        core.insert_equation_in_cell_native(0, para_idx, ctrl_idx, 0, 99, 0, "x", 1000, 0)
            .is_err(),
        "범위 밖 셀 문단 인덱스는 오류여야 한다"
    );
    // 표가 아닌 컨트롤 인덱스.
    assert!(
        core.insert_equation_in_cell_native(0, para_idx, ctrl_idx + 100, 0, 0, 0, "x", 1000, 0)
            .is_err(),
        "범위 밖 컨트롤 인덱스는 오류여야 한다"
    );
}

/// 수식이 아닌 컨트롤을 셀 삭제 API 로 지우려 하면 타입 오류다.
#[test]
fn delete_non_equation_control_in_cell_errors() {
    let (mut core, para_idx, ctrl_idx) = doc_with_table();

    // 셀에 텍스트만 있는 상태에서 존재하지 않는 컨트롤 삭제 → 범위 오류.
    core.insert_text_in_cell_native(0, para_idx, ctrl_idx, 0, 0, 0, "본문")
        .expect("셀 텍스트 삽입");
    assert!(
        core.delete_equation_control_in_cell_native(0, para_idx, ctrl_idx, 0, 0, 0)
            .is_err(),
        "수식 컨트롤이 없으면 오류여야 한다"
    );
}

/// 삽입 시프트(shift_for_inline_control_insert)와 삭제 시프트
/// (remove_equation_control_and_shift)가 대칭이어야 char_shapes/range_tags 경계가
/// 삽입+삭제 사이클 뒤 원래 위치로 돌아온다.
#[test]
fn char_shapes_and_range_tags_survive_insert_delete_cycle() {
    let (mut core, para_idx, ctrl_idx) = doc_with_table();

    // 셀 문단에 텍스트 6자 + 글자모양 run 2개(0.., 3..) + range_tag 하나를 만든다.
    core.insert_text_in_cell_native(0, para_idx, ctrl_idx, 0, 0, 0, "가나다라마바")
        .expect("셀 텍스트 삽입");
    core.apply_char_format_in_cell_native(0, para_idx, ctrl_idx, 0, 0, 3, 6, r#"{"bold":true}"#)
        .expect("셀 글자 서식 적용");
    match &mut core.document_mut().sections[0].paragraphs[para_idx].controls[ctrl_idx] {
        Control::Table(table) => {
            table.cells[0].paragraphs[0]
                .range_tags
                .push(rhwp::model::paragraph::RangeTag {
                    start: 1,
                    end: 5,
                    tag: 0x0100_0000,
                });
        }
        other => panic!("표가 아님: {other:?}"),
    }

    let snapshot = |core: &DocumentCore| {
        let para = cell_paragraph(core, para_idx, ctrl_idx, 0, 0);
        let shapes: Vec<(u32, u32)> = para
            .char_shapes
            .iter()
            .map(|cs| (cs.start_pos, cs.char_shape_id))
            .collect();
        let tags: Vec<(u32, u32, u32)> = para
            .range_tags
            .iter()
            .map(|rt| (rt.start, rt.end, rt.tag))
            .collect();
        (shapes, tags)
    };
    let (shapes_before, tags_before) = snapshot(&core);
    assert!(
        shapes_before.len() >= 2,
        "run 이 최소 2개여야 시프트 대칭을 검증할 수 있다: {shapes_before:?}"
    );

    // 텍스트 중간(offset 3)에 수식 삽입 후 다시 삭제.
    let result = core
        .insert_equation_in_cell_native(0, para_idx, ctrl_idx, 0, 0, 3, "1 over 2", 1000, 0)
        .expect("셀 수식 삽입");
    let v: Value = serde_json::from_str(&result).expect("삽입 결과 JSON");
    let eq_idx = v["controlIdx"].as_u64().expect("controlIdx") as usize;
    core.delete_equation_control_in_cell_native(0, para_idx, ctrl_idx, 0, 0, eq_idx)
        .expect("셀 수식 삭제");

    let (shapes_after, tags_after) = snapshot(&core);
    assert_eq!(
        shapes_after, shapes_before,
        "삽입+삭제 사이클 뒤 char_shapes.start_pos 가 원복되어야 한다"
    );
    assert_eq!(
        tags_after, tags_before,
        "삽입+삭제 사이클 뒤 range_tags.start/end 가 원복되어야 한다"
    );
}

/// 한 셀 문단에 수식이 두 개일 때 getEquationScriptInCellAt 이 인덱스별 스크립트를
/// 정확히 돌려준다 (find_equation_ref 는 첫 번째 수식만 찾는다).
#[test]
fn get_equation_script_in_cell_at_returns_indexed_script() {
    let (mut core, para_idx, ctrl_idx) = doc_with_table();

    core.insert_text_in_cell_native(0, para_idx, ctrl_idx, 0, 0, 0, "xy")
        .expect("셀 텍스트 삽입");
    core.insert_equation_in_cell_native(0, para_idx, ctrl_idx, 0, 0, 0, "1 over 2", 1000, 0)
        .expect("첫 번째 수식 삽입");
    core.insert_equation_in_cell_native(0, para_idx, ctrl_idx, 0, 0, 2, "a over b", 1000, 0)
        .expect("두 번째 수식 삽입");

    let first = core
        .get_equation_script_in_cell_at(0, para_idx, ctrl_idx, 0, 0, 0)
        .expect("인덱스 0 조회");
    let fv: Value = serde_json::from_str(&first).expect("인덱스 0 JSON");
    assert_eq!(fv["ok"], Value::Bool(true));
    assert_eq!(fv["script"].as_str(), Some("1 over 2"));

    let second = core
        .get_equation_script_in_cell_at(0, para_idx, ctrl_idx, 0, 0, 1)
        .expect("인덱스 1 조회");
    let sv: Value = serde_json::from_str(&second).expect("인덱스 1 JSON");
    assert_eq!(sv["ok"], Value::Bool(true));
    assert_eq!(sv["script"].as_str(), Some("a over b"));
}

/// getEquationScriptInCellAt: 범위 밖 좌표·타입 불일치는 모두 오류다.
#[test]
fn get_equation_script_in_cell_at_errors() {
    let (mut core, para_idx, ctrl_idx) = doc_with_table();
    core.insert_equation_in_cell_native(0, para_idx, ctrl_idx, 0, 0, 0, "1 over 2", 1000, 0)
        .expect("셀 수식 삽입");

    // 범위 밖 좌표들.
    assert!(
        core.get_equation_script_in_cell_at(99, para_idx, ctrl_idx, 0, 0, 0)
            .is_err(),
        "범위 밖 구역 인덱스는 오류여야 한다"
    );
    assert!(
        core.get_equation_script_in_cell_at(0, 999, ctrl_idx, 0, 0, 0)
            .is_err(),
        "범위 밖 문단 인덱스는 오류여야 한다"
    );
    assert!(
        core.get_equation_script_in_cell_at(0, para_idx, ctrl_idx + 100, 0, 0, 0)
            .is_err(),
        "표가 아닌(범위 밖) 컨트롤 인덱스는 오류여야 한다"
    );
    assert!(
        core.get_equation_script_in_cell_at(0, para_idx, ctrl_idx, 99, 0, 0)
            .is_err(),
        "범위 밖 셀 인덱스는 오류여야 한다"
    );
    assert!(
        core.get_equation_script_in_cell_at(0, para_idx, ctrl_idx, 0, 99, 0)
            .is_err(),
        "범위 밖 셀 문단 인덱스는 오류여야 한다"
    );
    assert!(
        core.get_equation_script_in_cell_at(0, para_idx, ctrl_idx, 0, 0, 99)
            .is_err(),
        "범위 밖 수식 컨트롤 인덱스는 오류여야 한다"
    );

    // 수식이 아닌 컨트롤을 가리키면 타입 오류다.
    match &mut core.document_mut().sections[0].paragraphs[para_idx].controls[ctrl_idx] {
        Control::Table(table) => {
            let cell_para = &mut table.cells[0].paragraphs[0];
            cell_para
                .controls
                .push(Control::Bookmark(rhwp::model::control::Bookmark::default()));
            cell_para.ctrl_data_records.push(None);
        }
        other => panic!("표가 아님: {other:?}"),
    }
    let err = core
        .get_equation_script_in_cell_at(0, para_idx, ctrl_idx, 0, 0, 1)
        .expect_err("수식이 아닌 컨트롤은 오류여야 한다");
    assert!(
        format!("{err}").contains("수식이 아닙니다"),
        "타입 오류 메시지가 나와야 한다: {err}"
    );
}
