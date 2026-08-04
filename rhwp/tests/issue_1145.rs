//! Issue #1145: RowBreak tables must not split inside a small rowspan block.
//!
//! The donation report sample has a 3x3 RowBreak table at paragraph 22. Its
//! title cell spans rows 0..2. Splitting page 1 as rows 0..1 and page 2 as
//! rows 1..3 paints the title twice, so the whole rowspan block must move to
//! the next page when it does not fit in the remaining area.

use std::fs;
use std::path::Path;

fn page_dump(rel_path: &str, page_idx: u32) -> String {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(repo_root).join(rel_path);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {rel_path}: {e}"));
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("parse {rel_path}: {e:?}"));
    doc.dump_page_items(Some(page_idx))
}

#[test]
fn issue1145_rowbreak_rowspan_title_is_not_split_across_pages() {
    let sample = "samples/2025년 기부·답례품 실적 지자체 보고서_양식.hwpx";

    let page1 = page_dump(sample, 0);
    assert!(
        !page1.contains("PartialTable   pi=22"),
        "page 1 must not keep only the first row of the row-spanned title block:\n{page1}"
    );

    let page2 = page_dump(sample, 1);
    assert!(
        page2.contains("Table          pi=22 ci=0  3x3"),
        "the whole table should start on page 2 as a normal table:\n{page2}"
    );
    assert!(
        !page2.contains("PartialTable   pi=22"),
        "page 2 should not continue from the middle of the row-spanned title block:\n{page2}"
    );
}
