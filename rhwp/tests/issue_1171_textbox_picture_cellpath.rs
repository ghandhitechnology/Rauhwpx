//! Issue #1171 Stage 1: 사각형 글상자(Shape text_box) 안 picture 가 cellPath
//! (cell_index=0 sentinel) 로 렌더 컨트롤 레이아웃에 노출되는지 검증.
//!
//! `samples/tac-img-02.hwp` 의 섹션0 문단 25 (사각형→글상자→picture 2개) / 문단 44
//! (picture 1개) 는 "사각형(Shape, InFrontOfText) → 글상자 → p[0] → picture" 이중 중첩
//! 구조다. 이전에는 collect_controls 가 사각형(Rectangle) 노드에서 return 하여 글상자
//! 내부 picture 를 수집하지 않았고, layout_picture 호출도 cell_ctx=None 이라 식별자가
//! 없었다. Stage 1 이후 해당 image 컨트롤이 글상자 sentinel cellPath 로 노출되어야
//! 프런트가 by_path API 로 속성을 조회/변경할 수 있다.

use rhwp::document_core::DocumentCore;

fn load_sample() -> DocumentCore {
    let bytes = std::fs::read("samples/tac-img-02.hwp").expect("read tac-img-02.hwp");
    DocumentCore::from_bytes(&bytes).expect("parse tac-img-02.hwp")
}

/// 섹션0 문단 25/44 의 글상자 안 picture 가 cellPath(cellIndex=0 sentinel) 로
/// 노출되는지 — paraIdx + cellPath 마지막 엔트리 구조를 검증한다.
#[test]
fn textbox_picture_emits_cellpath_sentinel() {
    let doc = load_sample();
    let pages = doc.page_count();

    // (paraIdx, controlIdx) → cellPath 마지막 엔트리 (controlIndex, cellIndex, cellParaIndex)
    let mut found: std::collections::HashMap<(u64, u64), (u64, u64, u64)> =
        std::collections::HashMap::new();

    for p in 0..pages {
        let Ok(json) = doc.get_page_control_layout_native(p) else {
            continue;
        };
        let v: serde_json::Value = serde_json::from_str(&json).expect("layout JSON 파싱");
        let Some(controls) = v["controls"].as_array() else {
            continue;
        };
        for c in controls {
            if c["type"] != "image" {
                continue;
            }
            let (Some(para), Some(ctrl)) = (c["paraIdx"].as_u64(), c["controlIdx"].as_u64()) else {
                continue;
            };
            if para != 25 && para != 44 {
                continue;
            }
            let path = c["cellPath"]
                .as_array()
                .unwrap_or_else(|| panic!("문단 {para} image 에 cellPath 부재: {c}"));
            let last = path.last().expect("cellPath 비어 있음");
            // parentParaIdx 도 함께 방출되어야 by_path native 의 parent_para 인자가 됨.
            assert_eq!(
                c["parentParaIdx"].as_u64(),
                Some(para),
                "문단 {para} image parentParaIdx 불일치: {c}"
            );
            found.insert(
                (para, ctrl),
                (
                    last["controlIndex"].as_u64().expect("controlIndex"),
                    last["cellIndex"].as_u64().expect("cellIndex"),
                    last["cellParaIndex"].as_u64().expect("cellParaIndex"),
                ),
            );
        }
    }

    // 문단 25: picture 2개(inner ctrl 0,1), 문단 44: picture 1개(inner ctrl 0).
    // 모두 글상자 sentinel = (Shape control_index 0, cell_index 0, cell_para_index 0).
    assert_eq!(
        found.get(&(25, 0)),
        Some(&(0, 0, 0)),
        "문단25 picture0 의 sentinel cellPath 불일치 (관측: {found:?})"
    );
    assert_eq!(
        found.get(&(25, 1)),
        Some(&(0, 0, 0)),
        "문단25 picture1 의 sentinel cellPath 불일치 (관측: {found:?})"
    );
    assert_eq!(
        found.get(&(44, 0)),
        Some(&(0, 0, 0)),
        "문단44 picture0 의 sentinel cellPath 불일치 (관측: {found:?})"
    );
}

/// Stage 2: 글상자 안 picture 속성을 by_path API 로 조회/변경(round-trip)할 수 있는지.
/// getter `resolve_paragraph_by_path` + setter `resolve_cell_paragraph_mut`(Shape arm)
/// 가 글상자 path(마지막 세그먼트=Shape)를 해석하는지 검증.
#[test]
fn picture_in_textbox_get_set_by_path() {
    let mut doc = load_sample();
    // 섹션0 문단25 글상자(사각형 control 0, 글상자 문단 0) 안 picture.
    // cell_path_json 키는 parse_cell_path_json 규약(controlIdx/cellIdx/cellParaIdx).
    let cell_path = r#"[{"controlIdx":0,"cellIdx":0,"cellParaIdx":0}]"#;
    // 프런트 layout/cursor ref 에서 오는 키는 controlIndex/cellIndex/cellParaIndex.
    // native parser 는 둘 다 받아야 resize/delete 경로가 본문 API로 후퇴하지 않는다.
    let layout_cell_path = r#"[{"controlIndex":0,"cellIndex":0,"cellParaIndex":0}]"#;

    // 첫 picture (inner ctrl 0) 조회
    let before = doc
        .get_cell_picture_properties_by_path_native(0, 25, cell_path, 0)
        .expect("글상자 picture 속성 조회 실패");
    let bv: serde_json::Value = serde_json::from_str(&before).unwrap();
    let w0 = bv["width"].as_u64().expect("width 부재");
    let h0 = bv["height"].as_u64().expect("height 부재");
    assert!(w0 > 0 && h0 > 0, "조회된 크기가 0: {before}");

    // width 변경 → set
    let new_w = w0 + 12345;
    let props = format!(r#"{{"width":{new_w}}}"#);
    let ok = doc
        .set_cell_picture_properties_by_path_native(0, 25, cell_path, 0, &props)
        .expect("글상자 picture 속성 변경 실패");
    assert!(ok.contains("\"ok\":true"), "set 응답 비정상: {ok}");

    // 재조회 — 변경 반영 확인
    let after = doc
        .get_cell_picture_properties_by_path_native(0, 25, cell_path, 0)
        .expect("변경 후 재조회 실패");
    let av: serde_json::Value = serde_json::from_str(&after).unwrap();
    assert_eq!(
        av["width"].as_u64(),
        Some(new_w),
        "width 변경 미반영: {after}"
    );

    // 두 번째 picture(inner ctrl 1)도 분리 조회되는지 (inner_control_idx 정합 회귀)
    let p1 = doc
        .get_cell_picture_properties_by_path_native(0, 25, cell_path, 1)
        .expect("글상자 두번째 picture 조회 실패");
    let p1v: serde_json::Value = serde_json::from_str(&p1).unwrap();
    assert!(
        p1v["width"].as_u64().unwrap_or(0) > 0,
        "두번째 picture 크기 0: {p1}"
    );

    // layout key 형식으로도 동일하게 조회되어야 한다.
    let by_layout_key = doc
        .get_cell_picture_properties_by_path_native(0, 25, layout_cell_path, 0)
        .expect("layout key 형식 cellPath 조회 실패");
    let lv: serde_json::Value = serde_json::from_str(&by_layout_key).unwrap();
    assert_eq!(
        lv["width"].as_u64(),
        Some(new_w),
        "layout key 형식 조회가 변경값을 보존하지 못함: {by_layout_key}"
    );
}

#[test]
fn picture_in_textbox_delete_by_path() {
    let mut doc = load_sample();
    let layout_cell_path = r#"[{"controlIndex":0,"cellIndex":0,"cellParaIndex":0}]"#;

    // 문단25 글상자에는 picture 2개(inner ctrl 0,1)가 있고, 두 번째를 by_path로 삭제한다.
    let ok = doc
        .delete_cell_picture_control_by_path_native(0, 25, layout_cell_path, 1)
        .expect("글상자 두번째 picture 삭제 실패");
    assert!(ok.contains("\"ok\":true"), "delete 응답 비정상: {ok}");

    let remaining = doc
        .get_cell_picture_properties_by_path_native(0, 25, layout_cell_path, 0)
        .expect("삭제 후 첫 picture 조회 실패");
    let rv: serde_json::Value = serde_json::from_str(&remaining).unwrap();
    assert!(
        rv["width"].as_u64().unwrap_or(0) > 0,
        "삭제 후 첫 picture 크기 0: {remaining}"
    );
    let deleted = doc.get_cell_picture_properties_by_path_native(0, 25, layout_cell_path, 1);
    assert!(
        deleted.is_err(),
        "삭제된 두번째 picture 가 여전히 조회됨: {deleted:?}"
    );
}
