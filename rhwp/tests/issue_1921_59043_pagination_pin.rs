//! Issue #1921 — 59043 규제영향분석서 페이지네이션 드리프트 핀.
//!
//! `samples/issue1921/59043_regulatory_analysis.hwp` — 부동(자리차지) 표·rowspan
//! 블록이 밀집한 규제영향분석서. PR #2092(RowBreak 블록컷 sliver 흡수)로
//! 48쪽 → 42쪽 (수정 전 pi=160 3×3 rowspan 블록에서 컷 진동 `+46,+1` 교대).
//!
//! 권위 정답지는 한글 2022 편집기 37쪽
//! (`pdf/issue1921/59043_regulatory_analysis-2022.pdf`, 편집기 PageCount=37 정합).
//! shared cell-cut normalization, wrapper ownership, saved rewind, column-tail packing을
//! 정합한 뒤 37쪽과 핵심 표 fragment 경계를 함께 고정한다.

use std::fs;
use std::path::Path;

fn load(rel: &str) -> rhwp::wasm_api::HwpDocument {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(repo_root).join(rel);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("parse {}: {:?}", rel, e))
}

#[test]
fn regulatory_59043_page_count_pin() {
    let doc = load("samples/issue1921/59043_regulatory_analysis.hwp");
    assert_eq!(doc.page_count(), 37, "한글 2022 오라클은 37쪽");

    let p11 = doc.dump_page_items(Some(10));
    let p12 = doc.dump_page_items(Some(11));
    let p13 = doc.dump_page_items(Some(12));
    assert!(p11.contains("pi=98") && p11.contains("end_cut=[81]"));
    assert!(p12.contains("pi=98") && p12.contains("start_cut=[81]") && p12.contains("end_cut=[]"));
    assert!(
        !p13.contains("pi=98"),
        "6x1 그림 표는 두 쪽에서 끝나야 한다"
    );

    let p17 = doc.dump_page_items(Some(16));
    let p18 = doc.dump_page_items(Some(17));
    let p19 = doc.dump_page_items(Some(18));
    assert!(p17.contains("pi=153") && p17.contains("rows=0..9"));
    assert!(p18.contains("pi=153") && p18.contains("rows=9..50"));
    assert!(p19.contains("pi=153") && p19.contains("rows=50..56"));
    assert!(
        p19.contains("pi=160"),
        "후속 Canada 표는 같은 쪽 tail에 pack되어야 한다"
    );
}
