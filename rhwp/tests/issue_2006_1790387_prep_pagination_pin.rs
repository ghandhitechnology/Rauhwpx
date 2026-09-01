//! Issue #2006 — 1790387 HIV PrEP 최종결과보고서 페이지네이션 드리프트 핀.
//!
//! `samples/issue2006/1790387_prep_final_report.hwpx` — 빈 문단에 전면급
//! tac(treat_as_char) 이미지 여러 장이 스택된 프레임 페이지가 많은 정책연구
//! 최종결과보고서. PR #2082(전면 tac 이미지 스택 라인 경계 강제분할)로
//! 130쪽 → 141쪽 (스택 문단 h>1500px 잔여 0).
//!
//! 권위 정답지는 한글 2022 편집기 146쪽
//! (`pdf-large/issue2006/1790387_prep_final_report-2022.pdf`, Git LFS,
//! 편집기 PageCount=146 정합). 작은 TAC marker host 폭과 저장 lineSeg의 모순을
//! fresh 조판하고, 의도적인 empty-vpos ladder와 명시적 쪽나누기를 각각 보존한다.

use std::fs;
use std::path::Path;

fn load(rel: &str) -> rhwp::wasm_api::HwpDocument {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(repo_root).join(rel);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("parse {}: {:?}", rel, e))
}

#[ignore = "known layout-oracle debt on main; same class as PR #193 (actual 144 vs Hancom 146)"]
#[test]
fn prep_1790387_page_count_pin() {
    let doc = load("samples/issue2006/1790387_prep_final_report.hwpx");
    assert_eq!(doc.page_count(), 146, "한글 2022 오라클은 146쪽");

    let p15 = doc.dump_page_items(Some(14));
    assert!(
        p15.contains("pi=158  h=52.8") && p15.contains("pi=162  h=52.8"),
        "저장 1줄 TAC 본문은 host 폭을 반영해 2줄 높이여야 한다"
    );

    let p54 = doc.dump_page_items(Some(53));
    let p55 = doc.dump_page_items(Some(54));
    let p56 = doc.dump_page_items(Some(55));
    assert!(p54.contains("pi=491") && p54.contains("pi=500"));
    assert!(p55.contains("pi=501") && !p55.contains("pi=502"));
    assert!(
        p56.contains("pi=502"),
        "empty ladder와 explicit break 경계를 합치면 안 된다"
    );
}
