//! `PageAreas::from_page_def_for_page` 가 손상된(비정상) 여백 값에도 패닉하지 않고
//! 항상 뒤집히지 않은(non-inverted) 영역을 반환하는지 확인하는 회귀 테스트.
//!
//! [PR #17] 다음 두 결함을 방지한다:
//! 1. margin_footer가 (landscape 교환 후) 용지 높이보다 크면 footer_area.bottom을
//!    구하는 `page_height - margin_footer` 뺄셈이 u32 언더플로우로 패닉했다.
//! 2. margin_header + margin_top, margin_left + margin_gutter 같은 여백 덧셈이
//!    체크 없는 `+` 라서 큰 값(예: HWPX가 음수 HWPUNIT를 unsigned로 저장한 경우)에서
//!    u32 오버플로우로 패닉했다.
//!
//! `cargo test`는 기본적으로 overflow-checks가 켜져 있으므로, 고쳐지지 않았다면
//! 이 테스트들은 패닉으로 실패한다.

use rhwp::model::page::{BindingMethod, PageAreas, PageDef};

/// footer 여백이 용지 높이를 초과 — 패닉 없이, footer_area가 뒤집히지 않아야 한다.
#[test]
fn footer_margin_larger_than_page_height_does_not_panic() {
    let page = PageDef {
        width: 59528,
        height: 84188,
        margin_footer: 200_000, // 용지 높이(84188)보다 훨씬 큼
        ..Default::default()
    };

    let areas = PageAreas::from_page_def_for_page(&page, 1);

    assert!(
        areas.footer_area.bottom >= areas.footer_area.top,
        "footer_area가 뒤집히면 안 된다: {:?}",
        areas.footer_area
    );
    assert!(
        areas.body_area.bottom > areas.body_area.top,
        "본문 영역은 항상 양수여야 한다: {:?}",
        areas.body_area
    );
}

/// margin_header + margin_top 덧셈이 u32 오버플로우를 일으키는 경우 — 패닉 없이
/// 폴백(용지의 5% 기본 여백)으로 정상적인 본문 영역을 반환해야 한다.
#[test]
fn header_plus_top_overflow_does_not_panic() {
    let page = PageDef {
        width: 59528,
        height: 84188,
        margin_header: u32::MAX - 100,
        margin_top: 5669,
        ..Default::default()
    };

    let areas = PageAreas::from_page_def_for_page(&page, 1);

    assert!(
        areas.body_area.bottom > areas.body_area.top,
        "본문 영역은 항상 양수여야 한다: {:?}",
        areas.body_area
    );
    assert!(
        areas.header_area.right >= areas.header_area.left,
        "머리말 영역이 뒤집히면 안 된다: {:?}",
        areas.header_area
    );
}

/// margin_left + margin_gutter 덧셈이 u32 오버플로우를 일으키는 경우(SingleSided) —
/// 패닉 없이 좌우 영역이 뒤집히지 않아야 한다.
#[test]
fn left_plus_gutter_overflow_does_not_panic_single_sided() {
    let page = PageDef {
        width: 59528,
        height: 84188,
        margin_left: u32::MAX - 50,
        margin_gutter: 1000,
        binding: BindingMethod::SingleSided,
        ..Default::default()
    };

    let areas = PageAreas::from_page_def_for_page(&page, 1);

    assert!(
        areas.body_area.right > areas.body_area.left,
        "본문 영역 좌우가 뒤집히면 안 된다: {:?}",
        areas.body_area
    );
}

/// margin_left + margin_gutter 오버플로우가 DuplexSided 짝수쪽 경로(마진 교대)에서도
/// 동일하게 방어되는지 확인.
#[test]
fn left_plus_gutter_overflow_does_not_panic_duplex_even_page() {
    let page = PageDef {
        width: 59528,
        height: 84188,
        margin_left: u32::MAX - 50,
        margin_gutter: 1000,
        margin_right: 8504,
        binding: BindingMethod::DuplexSided,
        ..Default::default()
    };

    // 짝수쪽에서는 (margin_left + margin_gutter)가 effective_right로 쓰인다.
    let areas = PageAreas::from_page_def_for_page(&page, 2);

    assert!(
        areas.body_area.right > areas.body_area.left,
        "DuplexSided 짝수쪽에서도 본문 영역 좌우가 뒤집히면 안 된다: {:?}",
        areas.body_area
    );
}

/// 세 가지 결함이 모두 동시에 발생하는 최악의 경우(복합 손상 문서)에도 패닉 없이
/// 모든 영역이 non-inverted 상태로 반환되어야 한다.
#[test]
fn combined_pathological_margins_do_not_panic() {
    let page = PageDef {
        width: 59528,
        height: 84188,
        margin_footer: 500_000,
        margin_header: u32::MAX - 200,
        margin_top: 100_000,
        margin_left: u32::MAX - 300,
        margin_gutter: 50_000,
        margin_right: 8504,
        margin_bottom: 4252,
        binding: BindingMethod::DuplexSided,
        ..Default::default()
    };

    for page_number in [0, 1, 2, 3] {
        let areas = PageAreas::from_page_def_for_page(&page, page_number);

        assert!(
            areas.body_area.bottom > areas.body_area.top,
            "page {page_number}: 본문 영역 상하가 뒤집히면 안 된다: {:?}",
            areas.body_area
        );
        assert!(
            areas.body_area.right > areas.body_area.left,
            "page {page_number}: 본문 영역 좌우가 뒤집히면 안 된다: {:?}",
            areas.body_area
        );
        assert!(
            areas.footer_area.bottom >= areas.footer_area.top,
            "page {page_number}: footer_area가 뒤집히면 안 된다: {:?}",
            areas.footer_area
        );
    }
}
