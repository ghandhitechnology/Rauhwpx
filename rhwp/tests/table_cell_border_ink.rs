//! 저장 행 높이가 줄은 담지만 안 여백까지 담지 못할 때 글자가 괘선을 넘지 않아야 한다.

use rhwp::diagnostics::cell_text_overflow::scan_page;
use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

#[test]
fn 저장된_좁은_머리행에서_글자가_테두리를_넘지_않는다() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples/issue1937_rowbreak_footnote_overpagination.hwp");
    let core =
        DocumentCore::from_bytes(&std::fs::read(path).expect("샘플 읽기")).expect("문서 읽기");
    // 20쪽 머리행의 저장 높이는 1282 HU, 줄 높이는 1000 HU다.
    // 저장 여백 566 HU를 그대로 더하면 글자가 아래 괘선을 약 3 px 넘는다.
    let tree = core.build_page_render_tree(19).expect("20쪽 렌더");
    let overflow = scan_page(&tree.root, 19);
    assert!(overflow.is_empty(), "셀 글자 넘침: {overflow:?}");
}

#[test]
fn 이어진_셀의_중첩표_뒤에_원래_쪽_좌표를_더하지_않는다() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples/issue1891_external_bindata_link.hwpx");
    let core =
        DocumentCore::from_bytes(&std::fs::read(path).expect("샘플 읽기")).expect("문서 읽기");
    // 중첩 표 뒤의 저장 vpos를 새 조각 시작에 더하면 이전 쪽 높이까지
    // 중복 예약하여 뒤 문단이 셀 아래 괘선에 잘린다.
    let tree = core.build_page_render_tree(47).expect("48쪽 렌더");
    let overflow = scan_page(&tree.root, 47);
    assert!(overflow.is_empty(), "셀 글자 넘침: {overflow:?}");
    fn 마지막_문단이_셀_안에_보인다(node: &RenderNode, cell_bottom: f64) -> bool {
        let bottom = if matches!(node.node_type, RenderNodeType::TableCell(_)) {
            node.bbox.y + node.bbox.height
        } else {
            cell_bottom
        };
        if let RenderNodeType::TextRun(run) = &node.node_type {
            if run.text.contains("운영기준") {
                assert!(
                    node.bbox.y + node.bbox.height <= bottom,
                    "마지막 문단이 셀 밖에 있음"
                );
                return true;
            }
        }
        node.children
            .iter()
            .any(|child| 마지막_문단이_셀_안에_보인다(child, bottom))
    }
    assert!(
        마지막_문단이_셀_안에_보인다(&tree.root, f64::INFINITY),
        "마지막 문단이 사라짐"
    );
}
