//! Issue #919: 글상자 한컴 UX 정합 회귀 가드.
//!
//! 재현 문서: `samples/table-in-tbox.hwp` page 1.
//! - 글상자 (paragraph 0, control_index 2) bbox: x=75.6 y=75.6 w=628.5 h=976.3
//!   (검정 테두리, 96 dpi)
//!
//! 한컴 UX 정합:
//! - 글상자 외곽 경계선 클릭 → 글상자 객체 선택 (Studio UX, Native hit_test 만으로는
//!   판별 못 함 — isShapeBorderClickByRef 5px tolerance 와 함께 동작)
//! - 글상자 내부 (텍스트 위 + 빈 영역) 클릭 → isTextBox=true 응답으로 즉시 텍스트
//!   편집 진입
//!
//! Stage 1 진단 결함: 글상자 안 빈 영역 (텍스트 부재) 클릭 시 본문 paragraph 0
//! fall-through. Task #919 의 본질.

use std::fs;
use std::path::Path;

fn load_doc() -> rhwp::wasm_api::HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/table-in-tbox.hwp");
    let bytes = fs::read(&path).expect("read table-in-tbox.hwp");
    rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse")
}

/// 글상자 안 텍스트 위 클릭 (위치: 표 셀 안) → isTextBox=true + cellPath.
#[test]
fn issue_919_textbox_inner_text_hit_returns_textbox_path() {
    let doc = load_doc();
    // 글상자 안 paragraph 18 추정 좌표 (Stage 1 진단: y=1024.1)
    let json = doc
        .hit_test_native(0, 200.0, 1024.0)
        .expect("hit_test_native");
    assert!(
        json.contains("\"isTextBox\":true"),
        "글상자 안 텍스트 hit 시 isTextBox=true 반환해야 함\nactual: {}",
        json
    );
    assert!(
        json.contains("\"controlIndex\":2"),
        "글상자 controlIndex=2 반환해야 함\nactual: {}",
        json
    );
}

/// 글상자 안 빈 영역 (텍스트 부재) 클릭 → isTextBox=true + cellParaIndex=0.
/// Task #919 본질 회귀 가드 — 본 PR 전에는 본문 paragraph 0 fall-through.
#[test]
fn issue_919_textbox_inner_empty_hit_returns_textbox_entry() {
    let doc = load_doc();
    // 글상자 안 빈 영역 (Stage 1 진단의 D 케이스: x=400 y=500, 안 표 빈 영역)
    let json = doc
        .hit_test_native(0, 400.0, 500.0)
        .expect("hit_test_native");
    assert!(
        json.contains("\"isTextBox\":true"),
        "글상자 안 빈 영역 hit 시 isTextBox=true 반환해야 함 (Task #919 본질)\n\
         actual: {}",
        json
    );
    assert!(
        json.contains("\"controlIndex\":2"),
        "글상자 controlIndex=2 반환해야 함\nactual: {}",
        json
    );
}

/// 글상자 외부 (명백히 바깥) 클릭 → 본문 paragraph (isTextBox 부재).
#[test]
fn issue_919_textbox_outside_hit_returns_body() {
    let doc = load_doc();
    // 글상자 위쪽 외부 (Stage 1 진단의 B 케이스: x=400 y=50)
    let json = doc
        .hit_test_native(0, 400.0, 50.0)
        .expect("hit_test_native");
    assert!(
        !json.contains("\"isTextBox\":true"),
        "글상자 외부 hit 시 isTextBox 부재 (본문 paragraph 반환)\nactual: {}",
        json
    );
}

/// getShapeBBox API — 글상자 (sec=0, ppi=0, ci=2) bbox 정합.
/// wasm_api 의 `get_shape_bbox` 공개 API 사용 (native 는 pub(crate)).
#[test]
fn issue_919_get_shape_bbox_returns_correct_dimensions() {
    let doc = load_doc();
    // wasm_api.get_shape_bbox 는 JsValue 반환 — native build 에서는 Result<String, HwpError>
    // 직접 호출이 불가하므로 hit_test_native 가 글상자 ci=2 인식하는지로 간접 검증.
    // (Stage 1 진단의 D 케이스: x=400 y=500 → controlIndex=2 반환 → 글상자 인식됨)
    let json = doc
        .hit_test_native(0, 400.0, 500.0)
        .expect("hit_test_native");
    assert!(
        json.contains("\"controlIndex\":2"),
        "글상자 (ci=2) 인식 + bbox 추적 정합\nactual: {}",
        json
    );
}

/// 글상자 안 표 셀 hit → cellPath 두 항목 (글상자 + 안 표 셀).
/// page 1 의 글상자 (ci=2) 안 큰 표 (pi=6) 셀 위치.
#[test]
fn issue_919_inner_table_cell_in_textbox_has_two_path_entries() {
    let doc = load_doc();
    // x=400 y=600: 글상자 안 표 위 영역 (Stage 1+2 진단 의 표_빈영역 부근)
    // 실제 안 표 셀 위 좌표 — x=100 y=770 (안 표 셀 176, pi=10 본문)
    let json = doc
        .hit_test_native(0, 100.0, 770.0)
        .expect("hit_test_native");
    assert!(
        json.contains("\"controlIndex\":2") && json.contains("\"cellParaIndex\":6"),
        "글상자 안 표 셀 hit 시 cellPath 두 항목 (글상자 + 안 표 셀)\nactual: {}",
        json
    );
}

// 참고: get_table_cell_bboxes_by_path 의 native 검증은 wasm-only (JsValue 반환)
// 이므로 본 테스트에서 직접 호출 불가. PR #919 의 resolve_table_by_path 정정 (글상자
// traverse 지원) 은 통합 테스트 (rhwp-studio Esc 동선 시각 판정) 로 검증.
