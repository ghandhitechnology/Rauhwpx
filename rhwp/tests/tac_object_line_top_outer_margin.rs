//! TAC 표/도형의 세로 위치 — 줄 상단 + 바깥 여백.
//!
//! `samples/hwpx/hy-001.hwpx` (한컴 macOS PDF 기준)
//! - p1: 문단 0·1·2 가 각각 TAC 표 1개(outMargin 283HU)만 가진다. 저장 줄
//!   vpos 0 / 3458 / 5465. 한컴은 앞 문단이 TAC 표여도 각 표를 자기 줄 상단 +
//!   283HU 에 놓는다 — 표 사이 간격은 vpos 차와 같다. 수정 전에는 2·3번째 표가
//!   바깥 여백 없이 줄 상단에 붙어 283HU 위로 올라갔다.
//! - p2: 문단 27 은 비-TAC TopAndBottom 표(아래 여백 283HU) 뒤에 TAC 글상자
//!   (정책브리핑/OPEN 로고)를 둔다. 글상자 줄은 표 하단 + 283HU 에서 시작한다.

use std::fs;
use std::path::Path;

use rhwp::document_core::DocumentCore;
use serde_json::Value;

const HU_PER_PX: f64 = 7200.0 / 96.0;

fn load(sample: &str) -> DocumentCore {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples")
        .join(sample);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {sample}: {e}"))
}

/// (type, paraIdx, controlIdx) 인 최상위 컨트롤의 (y, h).
fn control_box(core: &DocumentCore, page: u32, kind: &str, para: u64, ctrl: u64) -> (f64, f64) {
    let layout: Value = serde_json::from_str(
        &core
            .get_page_control_layout_native(page)
            .expect("control layout"),
    )
    .expect("control layout JSON");
    let c = layout["controls"]
        .as_array()
        .expect("controls")
        .iter()
        .find(|c| {
            c["type"] == kind
                && c["paraIdx"].as_u64() == Some(para)
                && c["controlIdx"].as_u64() == Some(ctrl)
                && c["outerTableControlIdx"].is_null()
        })
        .unwrap_or_else(|| panic!("page {page}: {kind} pi={para} ci={ctrl} not found"));
    (c["y"].as_f64().unwrap(), c["h"].as_f64().unwrap())
}

#[test]
fn stacked_tac_table_paragraphs_keep_outer_margin_top() {
    let core = load("hwpx/hy-001.hwpx");
    let (y0, _) = control_box(&core, 0, "table", 0, 3);
    let (y1, _) = control_box(&core, 0, "table", 1, 0);
    let (y2, _) = control_box(&core, 0, "table", 2, 0);
    // 세 표 모두 줄 상단 + om_top 이므로 표 간격 = 저장 vpos 차.
    let gap01 = (y1 - y0) * HU_PER_PX;
    let gap12 = (y2 - y1) * HU_PER_PX;
    assert!(
        (gap01 - 3458.0).abs() < 20.0,
        "pi0→pi1 표 간격 {gap01:.0}HU, 기대 3458HU"
    );
    assert!(
        (gap12 - 2007.0).abs() < 20.0,
        "pi1→pi2 표 간격 {gap12:.0}HU, 기대 2007HU"
    );
}

#[test]
fn tac_shape_after_topbottom_table_starts_below_outer_margin_bottom() {
    let core = load("hwpx/hy-001.hwpx");
    let (ty, th) = control_box(&core, 1, "table", 27, 0);
    let (sy, _) = control_box(&core, 1, "shape", 27, 1);
    let gap = (sy - (ty + th)) * HU_PER_PX;
    assert!(
        (gap - 283.0).abs() < 20.0,
        "표 하단→글상자 간격 {gap:.0}HU, 기대 283HU"
    );
}
