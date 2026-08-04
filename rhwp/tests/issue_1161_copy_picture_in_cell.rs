//! Issue #1161: rhwp-studio 표 셀 안 inline picture 복사(Ctrl+C) 미지원.
//!
//! `copy_control_native` 등 클립보드 native 가 본문(outer paragraph) 컨트롤만
//! 접근하던 결함을 `cell_path` 인자로 해소한다(#1151/PR #1177 의 cell_path 패턴 정합).
//! `samples/pic-in-table-01.hwp` 의 셀 안 그림을 셀 경로로 복사하면 클립보드에
//! Picture 컨트롤이 담겨야 한다(공개 반환 JSON 의 "[그림]" 으로 판정).

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::table::Table;

fn load_sample() -> DocumentCore {
    let bytes = std::fs::read("samples/pic-in-table-01.hwp").expect("read pic-in-table-01.hwp");
    DocumentCore::from_bytes(&bytes).expect("parse pic-in-table-01.hwp")
}

/// 셀 안 inline picture 의 위치를 셀 경로로 반환:
/// `(sec, parent_para, cell_path, inner_ctrl_idx)`.
/// `cell_path` 의 각 항목은 `(control_idx, cell_idx, cell_para_idx)` 이며
/// `resolve_paragraph_by_path` 의미와 동일하게 picture 가 담긴 문단까지 도달한다.
/// `samples/pic-in-table-01.hwp` 의 셀 picture 는 중첩 표(2단계) 안에 있으므로
/// 재귀 탐색으로 다단계 경로를 만든다.
fn find_inline_cell_picture(
    doc: &DocumentCore,
) -> Option<(usize, usize, Vec<(usize, usize, usize)>, usize)> {
    let document = doc.document();
    for (sec_idx, section) in document.sections.iter().enumerate() {
        for (para_idx, para) in section.paragraphs.iter().enumerate() {
            for (ctrl_idx, ctrl) in para.controls.iter().enumerate() {
                if let Control::Table(table) = ctrl {
                    if let Some((path, inner)) = find_in_table(table, &[], ctrl_idx) {
                        return Some((sec_idx, para_idx, path, inner));
                    }
                }
            }
        }
    }
    None
}

/// `prefix` 로 도달한 문단의 controls[`tbl_ctrl_idx`] 가 `table` 일 때,
/// 그 표(및 중첩 표) 안에서 첫 picture 를 찾아 `(cell_path, inner_ctrl)` 반환.
fn find_in_table(
    table: &Table,
    prefix: &[(usize, usize, usize)],
    tbl_ctrl_idx: usize,
) -> Option<(Vec<(usize, usize, usize)>, usize)> {
    for (cell_idx, cell) in table.cells.iter().enumerate() {
        for (cp_idx, cpara) in cell.paragraphs.iter().enumerate() {
            // 이 cell 문단(cpara)까지 도달하는 경로.
            let mut path = prefix.to_vec();
            path.push((tbl_ctrl_idx, cell_idx, cp_idx));
            for (ctrl_idx, ctrl) in cpara.controls.iter().enumerate() {
                match ctrl {
                    Control::Picture(_) => return Some((path, ctrl_idx)),
                    Control::Table(inner) => {
                        if let Some(r) = find_in_table(inner, &path, ctrl_idx) {
                            return Some(r);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    None
}

/// 본문 첫 표 컨트롤 위치 `(sec, para, ctrl_idx)` 탐색(회귀 테스트용).
fn find_body_table(doc: &DocumentCore) -> Option<(usize, usize, usize)> {
    let document = doc.document();
    for (sec_idx, section) in document.sections.iter().enumerate() {
        for (para_idx, para) in section.paragraphs.iter().enumerate() {
            for (ctrl_idx, ctrl) in para.controls.iter().enumerate() {
                if matches!(ctrl, Control::Table(_)) {
                    return Some((sec_idx, para_idx, ctrl_idx));
                }
            }
        }
    }
    None
}

#[test]
fn copy_inline_cell_picture_yields_picture() {
    let mut doc = load_sample();
    let (sec, parent_para, cell_path, inner_ctrl) =
        find_inline_cell_picture(&doc).expect("샘플에 셀 안 inline picture 가 있어야 함");

    let json = doc
        .copy_control_native(sec, parent_para, &cell_path, inner_ctrl)
        .expect("셀 picture 복사 실패");

    assert!(
        json.contains("[그림]"),
        "셀 경로 복사 결과가 그림이 아님: {json} (cell_path={cell_path:?}, inner={inner_ctrl})"
    );
}

#[test]
fn copy_empty_path_does_not_yield_cell_picture() {
    // [결함 박제] cell_path 없이 본문 인덱스로 inner_ctrl 을 접근하면
    // 셀 안 picture 를 얻을 수 없다(표를 얻거나 범위 초과). 그림이 복사되면 결함 미해소.
    let mut doc = load_sample();
    let (sec, parent_para, _cell_path, inner_ctrl) =
        find_inline_cell_picture(&doc).expect("샘플에 셀 안 inline picture 가 있어야 함");

    let got_picture = doc
        .copy_control_native(sec, parent_para, &[], inner_ctrl)
        .map(|j| j.contains("[그림]"))
        .unwrap_or(false);

    assert!(
        !got_picture,
        "본문 경로(빈 cell_path)로 셀 picture 가 잘못 복사됨 — cell_path 미반영"
    );
}

#[test]
fn get_cell_picture_image_data_via_path() {
    // 시스템 클립보드 image/png 경로(get_control_image_*_native)도 셀 경로 지원.
    let doc = load_sample();
    let (sec, parent_para, cell_path, inner_ctrl) =
        find_inline_cell_picture(&doc).expect("샘플에 셀 안 inline picture 가 있어야 함");

    let data = doc
        .get_control_image_data_native(sec, parent_para, &cell_path, inner_ctrl)
        .expect("셀 picture 이미지 데이터 조회 실패");
    assert!(!data.is_empty(), "셀 picture 이미지 데이터가 비어있음");

    // MIME 값 자체는 임베드 포맷에 의존(미인식 시 application/octet-stream).
    // 핵심은 셀 경로로 picture 에 도달해 MIME 로직이 실행된다는 점.
    let mime = doc
        .get_control_image_mime_native(sec, parent_para, &cell_path, inner_ctrl)
        .expect("셀 picture MIME 조회 실패");
    assert!(!mime.is_empty(), "MIME 비어있음");
}

#[test]
fn body_control_copy_still_works() {
    // 회귀: 빈 cell_path 본문 복사가 기존대로 동작(표 컨트롤 복사 → "[표]").
    let mut doc = load_sample();
    let (sec, para, ctrl) = find_body_table(&doc).expect("샘플에 본문 표가 있어야 함");
    let json = doc
        .copy_control_native(sec, para, &[], ctrl)
        .expect("본문 표 복사 실패");
    assert!(json.contains("[표]"), "본문 표 복사 결과 비정상: {json}");
}
