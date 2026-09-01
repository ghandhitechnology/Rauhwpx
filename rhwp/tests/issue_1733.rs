//! Issue #1733: 국제고속선기준 tail/vpos-reset 잔여 over-pagination 회귀 방지.
//!
//! [#2559 트레이드] 한컴 2024/PDF 기준은 242쪽. 빈 꼬리말 밴드를 각주에 회수한
//! 뒤 한때 241쪽으로 남았던 잔여는 현재 본선에서 해소되어 두 포맷 모두 한컴
//! 정답 242쪽과 맞는다. 이 핀은 그 정합을 유지하고, 다시 241/243 쪽으로
//! 흔들리면 #2559 밴드 회수 또는 과다분할 회귀다.

use rhwp::wasm_api::HwpDocument;
use std::fs;
use std::path::Path;

const HANCOM_PDF_PAGE_COUNT: u32 = 242;
const CURRENT_PAGE_COUNT_PIN: u32 = 242;

fn load_doc(sample: &str) -> HwpDocument {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(repo_root).join(sample);
    let bytes = fs::read(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|err| panic!("parse {}: {err:?}", path.display()))
}

fn assert_current_page_count_pin(sample: &str) {
    let doc = load_doc(sample);
    assert_eq!(
        doc.page_count(),
        CURRENT_PAGE_COUNT_PIN,
        "{sample} should retain the documented #2559 page-count pin; HWP 2024/PDF oracle is {HANCOM_PDF_PAGE_COUNT}"
    );
}

#[test]
fn issue_1733_hwpx_retains_documented_page_count_pin() {
    assert_current_page_count_pin("samples/task1725/text_footnote_tail_overpagination.hwpx");
}

#[test]
fn issue_1733_hwp_retains_documented_page_count_pin() {
    assert_current_page_count_pin("samples/task1725/text_footnote_tail_overpagination.hwp");
}
