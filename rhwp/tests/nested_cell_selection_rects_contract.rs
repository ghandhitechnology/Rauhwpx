//! 중첩 셀(depth>=2) 선택 사각형 계약.
//!
//! hit-test 의 평면 셀 필드(controlIndex/cellIndex/cellParaIndex)는 최외곽 셀만
//! 가리키므로, 평면 `getSelectionRectsInCell` 로는 중첩 표 내부 선택을 지정할 수
//! 없다 — 바깥 셀 문단이 하이라이트되거나 아무것도 매칭되지 않는다 (#2651 동형).
//! `getSelectionRectsByPath` 는 셀 경로 전체로 안쪽 셀 축을 정확히 매칭해야 한다.

use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

/// depth>=2 셀 컨텍스트를 가진, 텍스트가 있는 첫 TextRun 을 찾는다.
fn find_nested_text_run(
    node: &RenderNode,
) -> Option<(usize, Vec<(usize, usize, usize)>, String, f64, f64)> {
    if let RenderNodeType::TextRun(ref tr) = node.node_type {
        if let Some(ref ctx) = tr.cell_context {
            if ctx.path.len() >= 2 && tr.text.chars().count() >= 2 {
                let path: Vec<(usize, usize, usize)> = ctx
                    .path
                    .iter()
                    .map(|e| (e.control_index, e.cell_index, e.cell_para_index))
                    .collect();
                return Some((
                    ctx.parent_para_index,
                    path,
                    tr.text.clone(),
                    node.bbox.x,
                    node.bbox.y,
                ));
            }
        }
    }
    for child in &node.children {
        if let Some(found) = find_nested_text_run(child) {
            return Some(found);
        }
    }
    None
}

#[test]
fn nested_cell_selection_rects_match_inner_run_geometry() {
    let data = std::fs::read("samples/inner-table-01.hwp").expect("샘플 로드 실패");
    let doc = HwpDocument::from_bytes(&data).expect("HWP5 파싱 실패");

    let mut nested = None;
    for page in 0..doc.page_count() {
        let tree = doc
            .build_page_render_tree(page)
            .expect("렌더 트리 빌드 실패");
        nested = find_nested_text_run(&tree.root);
        if nested.is_some() {
            break;
        }
    }
    let (ppi, path, text, run_x, run_y) =
        nested.expect("샘플에 depth>=2 텍스트 run 이 있어야 한다");
    let inner_cpi = path.last().unwrap().2;
    let sel_len = text.chars().count().min(2);

    let path_json = serde_json::to_string(
        &path
            .iter()
            .map(|&(ci, cei, cpi)| {
                serde_json::json!({"controlIndex": ci, "cellIndex": cei, "cellParaIndex": cpi})
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();

    let rects_json = doc
        .get_selection_rects_by_path(
            0,
            ppi as u32,
            &path_json,
            inner_cpi as u32,
            0,
            inner_cpi as u32,
            sel_len as u32,
        )
        .expect("경로 기반 선택 사각형 조회 실패");
    let rects: Value = serde_json::from_str(&rects_json).expect("JSON 파싱 실패");
    let rects = rects.as_array().expect("배열이어야 한다");
    assert!(
        !rects.is_empty(),
        "중첩 셀 선택은 최소 1개의 사각형을 반환해야 한다"
    );

    // 반환 rect 는 안쪽 run 의 줄 위(같은 y, run 시작 근처 x)에 있어야 한다 —
    // 바깥 셀 문단을 하이라이트하면 y 또는 x 가 크게 어긋난다.
    let r = &rects[0];
    let rx = r["x"].as_f64().unwrap();
    let ry = r["y"].as_f64().unwrap();
    assert!(
        (ry - run_y).abs() <= 2.0,
        "rect y({ry:.1})는 안쪽 run y({run_y:.1})와 같은 줄이어야 한다"
    );
    assert!(
        (rx - run_x).abs() <= 2.0,
        "rect x({rx:.1})는 안쪽 run 시작 x({run_x:.1}) 근처여야 한다"
    );
}
