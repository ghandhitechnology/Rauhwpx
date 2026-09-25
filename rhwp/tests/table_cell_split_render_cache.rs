//! 셀 문단 구조 편집 뒤 분할 표 렌더가 새 pagination 컷과 맞아야 한다.
//!
//! 렌더 쪽 `cell_units` 캐시는 셀 포인터가 키다. 셀 문단 분할/병합·범위 삭제·서식
//! 적용은 셀 구조체를 그대로 둔 채 문단만 바꾸므로, 캐시를 비우지 않으면 새로 계산한
//! 셀 컷(유닛 수)을 옛 유닛 목록에 적용한다. 그러면 여러 쪽에 걸친 큰 셀이 옛 지점에서
//! 끊기고 쪽 아래가 비어 보였다(다른 곳을 클릭해 재조판하면 풀림).

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;

const CELL_PARAS: usize = 150;

/// 1×1 표 하나의 셀에 여러 쪽을 채우는 문단을 넣은 문서.
fn doc_with_multi_page_cell() -> (DocumentCore, usize, usize) {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().expect("blank document");
    core.create_table_ex_native(0, 0, 0, 1, 1, false, None, None)
        .expect("1x1 table");
    let para_idx = core.document().sections[0]
        .paragraphs
        .iter()
        .position(|p| p.controls.iter().any(|c| matches!(c, Control::Table(_))))
        .expect("표가 놓인 문단");
    let ctrl_idx = core.document().sections[0].paragraphs[para_idx]
        .controls
        .iter()
        .position(|c| matches!(c, Control::Table(_)))
        .expect("표 컨트롤");
    for i in 0..CELL_PARAS {
        let text = format!("{i}번째 줄 셀 안의 문단");
        core.insert_text_in_cell_native(0, para_idx, ctrl_idx, 0, i, 0, &text)
            .expect("셀 텍스트");
        if i + 1 < CELL_PARAS {
            let len = text.chars().count();
            core.split_paragraph_in_cell_native(0, para_idx, ctrl_idx, 0, i, len, None)
                .expect("셀 문단 분할");
        }
    }
    (core, para_idx, ctrl_idx)
}

fn render_all(core: &DocumentCore) -> Vec<String> {
    (0..core.page_count())
        .map(|page| core.render_page_svg_native(page).expect("svg"))
        .collect()
}

/// 편집본 렌더와 권위 재조판(refresh_layout_native) 렌더가 모든 쪽에서 같아야 한다.
fn assert_render_matches_full_relayout(core: &mut DocumentCore, label: &str) {
    let incremental_cuts = core.dump_page_items(None);
    let incremental = render_all(core);
    core.refresh_layout_native();
    let full = render_all(core);
    assert_eq!(
        incremental_cuts,
        core.dump_page_items(None),
        "{label}: 셀 분할점 불일치"
    );
    assert_eq!(incremental.len(), full.len(), "{label}: 쪽수 불일치");
    let stale: Vec<usize> = (0..full.len())
        .filter(|&page| incremental[page] != full[page])
        .collect();
    assert!(
        stale.is_empty(),
        "{label}: 옛 셀 유닛으로 그려진 쪽 {stale:?}"
    );
}

#[test]
fn 셀_문단_병합과_분할_뒤_모든_쪽을_다시_그린다() {
    let (mut core, para_idx, ctrl_idx) = doc_with_multi_page_cell();
    assert!(core.page_count() >= 3, "셀이 여러 쪽에 걸쳐야 한다");
    let _ = render_all(&core);

    // 앞쪽 문단 병합: 뒤 쪽의 분할점이 위로 당겨진다.
    for _ in 0..4 {
        core.merge_paragraph_in_cell_native(0, para_idx, ctrl_idx, 0, 3)
            .expect("셀 문단 병합");
    }
    assert_render_matches_full_relayout(&mut core, "병합");

    let _ = render_all(&core);
    // 앞쪽 Enter 반복: 분할점이 아래로 밀린다.
    for _ in 0..6 {
        core.split_paragraph_in_cell_native(0, para_idx, ctrl_idx, 0, 1, 0, None)
            .expect("셀 문단 분할");
    }
    assert_render_matches_full_relayout(&mut core, "분할");

    let _ = render_all(&core);
    core.delete_range_in_cell_by_path(0, para_idx, &[(ctrl_idx, 0, 1)], 1, 0, 8, 0)
        .expect("여러 셀 문단 범위 삭제");
    assert_render_matches_full_relayout(&mut core, "범위 삭제");
}

#[test]
fn 셀_문단_서식_변경_뒤_모든_쪽을_다시_그린다() {
    let (mut core, para_idx, ctrl_idx) = doc_with_multi_page_cell();
    let _ = render_all(&core);
    // 줄 간격 확대: 셀 줄 높이가 바뀌어 뒤 쪽 분할점이 이동한다.
    for cell_para in 2..12 {
        core.apply_para_format_in_cell_native(
            0,
            para_idx,
            ctrl_idx,
            0,
            cell_para,
            r#"{"lineSpacing":300}"#,
        )
        .expect("셀 문단 서식");
    }
    assert_render_matches_full_relayout(&mut core, "문단 서식");
}
