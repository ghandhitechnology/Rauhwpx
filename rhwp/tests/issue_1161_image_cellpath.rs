//! Issue #1161 Stage 3: ImageNode 가 전체 다단계 cellPath 를 방출하는지 검증.
//!
//! `samples/pic-in-table-01.hwp` 의 셀 picture 는 2단계 중첩 표(외부표→셀→내부표→셀→그림)
//! 안에 있다. 렌더 컨트롤 레이아웃(`get_page_control_layout_native`)에서 image 컨트롤이
//! **2-엔트리 이상 cellPath** 로 노출되어야 프런트가 전체 경로로 복사할 수 있다.

use rhwp::document_core::DocumentCore;

fn load_sample() -> DocumentCore {
    let bytes = std::fs::read("samples/pic-in-table-01.hwp").expect("read pic-in-table-01.hwp");
    DocumentCore::from_bytes(&bytes).expect("parse pic-in-table-01.hwp")
}

#[test]
fn image_control_layout_emits_multilevel_cellpath() {
    let doc = load_sample();
    let pages = doc.page_count();
    let mut max_depth = 0usize;
    let mut found_multilevel = false;

    'pages: for p in 0..pages {
        let json = match doc.get_page_control_layout_native(p) {
            Ok(j) => j,
            Err(_) => continue,
        };
        let v: serde_json::Value = serde_json::from_str(&json).expect("layout JSON 파싱");
        let Some(controls) = v["controls"].as_array() else {
            continue;
        };
        for c in controls {
            if c["type"] != "image" {
                continue;
            }
            if let Some(path) = c["cellPath"].as_array() {
                max_depth = max_depth.max(path.len());
                if path.len() >= 2 {
                    found_multilevel = true;
                    // 각 엔트리 구조 검증 (parse_cell_path 가 읽는 키와 동일).
                    for e in path {
                        assert!(e["controlIndex"].is_number(), "controlIndex 부재: {e}");
                        assert!(e["cellIndex"].is_number(), "cellIndex 부재: {e}");
                        assert!(e["cellParaIndex"].is_number(), "cellParaIndex 부재: {e}");
                    }
                    // parentParaIdx 도 함께 방출되어야 복사 native 의 parent_para 인자가 됨.
                    assert!(
                        c["parentParaIdx"].is_number(),
                        "셀 image 에 parentParaIdx 부재: {c}"
                    );
                    break 'pages;
                }
            }
        }
    }

    assert!(
        found_multilevel,
        "셀 picture 가 2-엔트리 이상 cellPath 로 노출되지 않음 (관측 최대 depth={max_depth})"
    );
}
