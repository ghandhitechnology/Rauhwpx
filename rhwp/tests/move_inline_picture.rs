//! 인라인(글자처럼 취급) 그림 컨트롤 이동 — move_picture_control_native.
//!
//! 삭제(갭 시프트) → 재삽입(insert_equation_native 인라인 패턴) 두 단계가
//! 문단 메타데이터(char_offsets / char_count / ctrl_data_records)를 정합적으로
//! 유지하는지, 이동 왕복이 원본 상태로 수렴하는지 검증한다.
//!
//! 그림 삽입은 studio 그림 속성 다이얼로그 경로와 동일하게 floating 삽입 후
//! `{"treatAsChar":true}` 토글로 인라인화한다 — 이 상태의 그림은 char_offsets
//! 갭이 없고(마이그레이션이 스트림을 건드리지 않음) 스트림 끝에 배치된다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::paragraph::Paragraph;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const SAMPLE: &str = "samples/basic/english.hwp";

/// 1x1 투명 PNG (67 bytes).
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

const PIC_WIDTH_HU: u32 = 9000; // 3.17cm
const PIC_HEIGHT_HU: u32 = 6000; // 2.12cm

fn load_core() -> DocumentCore {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(repo_root).join(SAMPLE);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("load {SAMPLE}: {e}"))
}

/// 첫 텍스트 문단 인덱스.
fn first_text_para(core: &DocumentCore) -> usize {
    core.document().sections[0]
        .paragraphs
        .iter()
        .position(|p| !p.text.is_empty())
        .expect("샘플에 텍스트 문단이 없음")
}

/// exclude 를 제외한 다른 텍스트 문단 인덱스.
fn other_text_para(core: &DocumentCore, exclude: usize) -> usize {
    core.document().sections[0]
        .paragraphs
        .iter()
        .position(|p| !p.text.is_empty())
        .filter(|&i| i != exclude)
        .or_else(|| {
            core.document().sections[0]
                .paragraphs
                .iter()
                .rposition(|p| !p.text.is_empty())
                .filter(|&i| i != exclude)
        })
        .expect("이동 대상 텍스트 문단이 없음")
}

/// floating 그림 삽입 후 글자처럼 취급 on — control 인덱스 반환.
fn insert_inline_picture(core: &mut DocumentCore, para_idx: usize) -> usize {
    let result = core
        .insert_picture_native(
            0,
            para_idx,
            0,
            &[],
            TINY_PNG,
            PIC_WIDTH_HU,
            PIC_HEIGHT_HU,
            1,
            1,
            "png",
            "move test picture",
            Some(20000),
            Some(20000),
        )
        .expect("insert_picture_native");
    let json: serde_json::Value = serde_json::from_str(&result)
        .unwrap_or_else(|e| panic!("insert 결과 JSON 파싱 실패 `{result}`: {e}"));
    let ci = json["controlIdx"].as_u64().expect("controlIdx 없음") as usize;
    core.set_picture_properties_native(0, para_idx, ci, r#"{"treatAsChar":true}"#)
        .expect("treatAsChar on");
    ci
}

fn move_pic(
    core: &mut DocumentCore,
    from_para: usize,
    from_ci: usize,
    to_para: usize,
    to_char_offset: usize,
) -> serde_json::Value {
    let result = core
        .move_picture_control_native(0, from_para, from_ci, to_para, to_char_offset)
        .unwrap_or_else(|e| panic!("move_picture_control_native: {e:?}"));
    serde_json::from_str(&result)
        .unwrap_or_else(|e| panic!("move 결과 JSON 파싱 실패 `{result}`: {e}"))
}

/// 컨트롤의 논리(캐럿) 위치. document_core::helpers::find_logical_control_positions
/// 와 동일 알고리즘의 테스트 로컬 복제 (pub(crate) 이라 통합 테스트에서 직접 호출 불가).
fn logical_positions(para: &Paragraph) -> Vec<usize> {
    let text_positions = para.control_text_positions();
    let text_len = para.text.chars().count();
    let mut inline_seen = 0usize;
    para.controls
        .iter()
        .enumerate()
        .map(|(ci, ctrl)| {
            let text_pos = text_positions.get(ci).copied().unwrap_or(text_len);
            let pos = text_pos + inline_seen;
            if matches!(
                ctrl,
                Control::Shape(_)
                    | Control::Table(_)
                    | Control::Picture(_)
                    | Control::Equation(_)
                    | Control::Footnote(_)
                    | Control::Endnote(_)
                    | Control::AutoNumber(_)
            ) {
                inline_seen += 1;
            }
            pos
        })
        .collect()
}

fn has_picture(para: &Paragraph) -> bool {
    para.controls
        .iter()
        .any(|c| matches!(c, Control::Picture(_)))
}

/// 문단 상태 스냅샷 (이동 전후 비교용).
type ParaSnapshot = (Vec<u32>, u32, usize, usize, String);

fn snapshot(para: &Paragraph) -> ParaSnapshot {
    (
        para.char_offsets.clone(),
        para.char_count,
        para.controls.len(),
        para.ctrl_data_records.len(),
        para.text.clone(),
    )
}

fn collect_images(node: &RenderNode, out: &mut Vec<Option<usize>>) {
    if let RenderNodeType::Image(img) = &node.node_type {
        out.push(img.control_index);
    }
    for child in &node.children {
        collect_images(child, out);
    }
}

/// 그림이 어느 페이지 렌더 트리에든 ImageNode 로 존재하는지.
fn assert_picture_renders(core: &mut DocumentCore, ci: usize, step: &str) {
    for page in 0..core.page_count() {
        let tree = core
            .build_page_render_tree(page)
            .unwrap_or_else(|e| panic!("[{step}] render tree page {page}: {e}"));
        let mut images = Vec::new();
        collect_images(&tree.root, &mut images);
        if images.contains(&Some(ci)) {
            return;
        }
    }
    panic!("[{step}] 그림 ImageNode 가 어느 페이지에도 없음 (controlIdx={ci})");
}

/// 같은 문단 내 이동: 맨 앞 → 이후 위치. 텍스트/char_count 가 유지되고,
/// 그림 논리 위치가 보정된 대상 오프셋을 따라가며, 렌더가 유지된다.
#[test]
fn move_inline_picture_same_para_later_position() {
    let mut core = load_core();
    let para_idx = first_text_para(&core);
    let ci = insert_inline_picture(&mut core, para_idx);
    let (text_before, len_before, char_count_before) = {
        let para = &core.document().sections[0].paragraphs[para_idx];
        (
            para.text.clone(),
            para.text.chars().count(),
            para.char_count,
        )
    };

    // 그림을 문단 맨 앞(논리 0)으로 이동 — 기존 Field 컨트롤 뒤 슬롯으로 들어가고
    // 그림 갭이 스트림 앞으로 옮겨진다.
    let r1 = move_pic(&mut core, para_idx, ci, para_idx, 0);
    assert_eq!(r1["ok"], serde_json::Value::Bool(true));
    assert_eq!(r1["moved"], serde_json::Value::Bool(true));
    assert_eq!(r1["paraIdx"], serde_json::json!(para_idx));
    let ci1 = r1["controlIdx"].as_u64().unwrap() as usize;
    {
        let para = &core.document().sections[0].paragraphs[para_idx];
        assert_eq!(para.text, text_before, "텍스트 불변");
        assert_eq!(para.text.chars().count(), len_before);
        assert_eq!(
            para.char_count, char_count_before,
            "그림 갭 위치 이동 → char_count 불변"
        );
        assert_eq!(
            logical_positions(para)[ci1],
            0,
            "그림 논리 위치 = 문단 맨 앞"
        );
    }
    assert_picture_renders(&mut core, ci1, "맨 앞 이동 후");

    // 맨 앞 그림을 이후 캐럿 위치(논리 2)로 이동 — 1글자 제거 보정으로 그림 논리
    // 위치는 2-1=1 이 된다.
    let r2 = move_pic(&mut core, para_idx, ci1, para_idx, 2);
    assert_eq!(r2["moved"], serde_json::Value::Bool(true));
    let ci2 = r2["controlIdx"].as_u64().unwrap() as usize;
    {
        let para = &core.document().sections[0].paragraphs[para_idx];
        assert_eq!(para.text, text_before, "재이동 후에도 텍스트 불변");
        assert_eq!(
            para.char_count, char_count_before,
            "갭 유지 → char_count 불변"
        );
        assert_eq!(logical_positions(para)[ci2], 1);
        assert_eq!(
            para.ctrl_data_records.len(),
            para.controls.len(),
            "ctrl_data_records 정합"
        );
    }
    assert_picture_renders(&mut core, ci2, "이후 위치 이동 후");
}

/// 다른 문단으로 이동: 원본 문단은 컨트롤과 갭을 잃고, 대상 문단은 8 유닛과
/// 컨트롤을 얻는다. 대상 논리 위치 ≈ to_char_offset.
#[test]
fn move_inline_picture_across_paragraphs() {
    let mut core = load_core();
    let src = first_text_para(&core);
    let tgt = other_text_para(&core, src);
    let ci = insert_inline_picture(&mut core, src);
    let tgt_len = core.document().sections[0].paragraphs[tgt]
        .text
        .chars()
        .count();
    let src_controls_before = core.document().sections[0].paragraphs[src].controls.len();
    let tgt_snapshot = {
        let para = &core.document().sections[0].paragraphs[tgt];
        (
            para.char_offsets.clone(),
            para.char_count,
            para.controls.len(),
        )
    };

    // 대상 문단 끝 오프셋은 샘플의 잔존 갭 위치에 흡수될 수 있어, 결정적 검증을
    // 위해 문단 맨 앞(논리 0)으로 이동한다.
    let r = move_pic(&mut core, src, ci, tgt, 0);
    assert_eq!(r["ok"], serde_json::Value::Bool(true));
    assert_eq!(r["moved"], serde_json::Value::Bool(true));
    assert_eq!(r["paraIdx"], serde_json::json!(tgt));

    {
        let src_para = &core.document().sections[0].paragraphs[src];
        assert!(!has_picture(src_para), "원본 문단에서 그림 제거");
        assert_eq!(
            src_para.controls.len(),
            src_controls_before - 1,
            "원본 문단에서 컨트롤 1 감소"
        );
        assert_eq!(
            src_para.ctrl_data_records.len(),
            src_para.controls.len(),
            "원본 ctrl_data_records 정합"
        );
    }
    {
        let tgt_para = &core.document().sections[0].paragraphs[tgt];
        assert_eq!(tgt_para.controls.len(), tgt_snapshot.2 + 1);
        assert_eq!(
            tgt_para.ctrl_data_records.len(),
            tgt_para.controls.len(),
            "대상 ctrl_data_records 패딩 정합"
        );
        assert_eq!(
            tgt_para.char_count,
            tgt_snapshot.1 + 8,
            "대상 char_count +8"
        );
        let lp = logical_positions(tgt_para);
        assert_eq!(
            lp[r["controlIdx"].as_u64().unwrap() as usize],
            0,
            "대상 논리 위치 = 문단 맨 앞"
        );
    }
    assert_picture_renders(
        &mut core,
        r["controlIdx"].as_u64().unwrap() as usize,
        "타문단 이동 후",
    );
}

/// 이동 왕복: 다른 문단으로 이동 후 원래 논리 위치로 되돌리면 원본 문단 상태
/// (char_offsets / char_count / 컨트롤 배치)로 수렴한다.
#[test]
fn move_inline_picture_round_trip_restores_state() {
    let mut core = load_core();
    let src = first_text_para(&core);
    let tgt = other_text_para(&core, src);
    let ci = insert_inline_picture(&mut core, src);
    let before = {
        let para = &core.document().sections[0].paragraphs[src];
        (snapshot(para), ci)
    };
    let src_logical = {
        let para = &core.document().sections[0].paragraphs[src];
        logical_positions(para)[ci]
    };

    let r1 = move_pic(&mut core, src, ci, tgt, 0);
    let r2 = move_pic(
        &mut core,
        tgt,
        r1["controlIdx"].as_u64().unwrap() as usize,
        src,
        src_logical,
    );
    assert_eq!(r2["moved"], serde_json::Value::Bool(true));
    assert_eq!(r2["paraIdx"], serde_json::json!(src));

    let para = &core.document().sections[0].paragraphs[src];
    assert_eq!(snapshot(para), before.0, "왕복 후 원본 문단 상태 수렴");
    assert_eq!(
        r2["controlIdx"],
        serde_json::json!(before.1),
        "원본 컨트롤 인덱스 복원"
    );
    assert!(
        matches!(
            &para.controls[before.1],
            Control::Picture(p) if p.common.treat_as_char
        ),
        "그림 컨트롤 + tac=true 복원"
    );
    assert_picture_renders(
        &mut core,
        r2["controlIdx"].as_u64().unwrap() as usize,
        "왕복 후",
    );
}

/// 어울림(tac=false) 그림은 이동 명령이 거부된다 — 위치 이동은 개체 오프셋
/// 변경이며 JS 드래그 경로의 관할이다.
#[test]
fn move_rejects_floating_picture() {
    let mut core = load_core();
    let para_idx = first_text_para(&core);
    let result = core
        .insert_picture_native(
            0,
            para_idx,
            0,
            &[],
            TINY_PNG,
            PIC_WIDTH_HU,
            PIC_HEIGHT_HU,
            1,
            1,
            "png",
            "floating picture",
            Some(20000),
            Some(20000),
        )
        .expect("insert_picture_native");
    let json: serde_json::Value = serde_json::from_str(&result).unwrap();
    let ci = json["controlIdx"].as_u64().unwrap() as usize;

    let err = core.move_picture_control_native(0, para_idx, ci, para_idx, 0);
    assert!(err.is_err(), "tac=false 그림 이동이 거부되어야 함");
}

/// 같은 위치로의 이동은 상태를 변경하지 않는다 (moved=false).
#[test]
fn move_same_position_is_noop() {
    let mut core = load_core();
    let para_idx = first_text_para(&core);
    let ci = insert_inline_picture(&mut core, para_idx);
    let before = {
        let para = &core.document().sections[0].paragraphs[para_idx];
        snapshot(para)
    };
    let logical = {
        let para = &core.document().sections[0].paragraphs[para_idx];
        logical_positions(para)[ci]
    };

    let r = move_pic(&mut core, para_idx, ci, para_idx, logical);
    assert_eq!(r["ok"], serde_json::Value::Bool(true));
    assert_eq!(r["moved"], serde_json::Value::Bool(false));
    assert_eq!(r["controlIdx"], serde_json::json!(ci));

    let para = &core.document().sections[0].paragraphs[para_idx];
    assert_eq!(snapshot(para), before, "no-move 시 문단 상태 불변");
}

fn table_fixture() -> DocumentCore {
    use rhwp::model::table::{Cell, Table};
    fn text() -> Paragraph {
        let mut para = Paragraph::new_empty();
        para.insert_text_at(0, "a😀bc");
        para
    }
    let mut table = Table::default();
    table.row_count = 1;
    table.col_count = 2;
    table.common.width = 24000;
    table.common.height = 6000;
    table.common.treat_as_char = true;
    table.cells = (0..2)
        .map(|col| Cell {
            col,
            row: 0,
            col_span: 1,
            row_span: 1,
            width: 12000,
            height: 6000,
            paragraphs: vec![text()],
            ..Default::default()
        })
        .collect();
    table.rebuild_grid();
    let mut core = load_core();
    core.document_mut().sections[0].paragraphs = vec![Paragraph::new_empty()];
    let body = &mut core.document_mut().sections[0].paragraphs[0];
    body.controls.push(Control::Table(Box::new(table)));
    body.ctrl_data_records.push(None);
    body.char_count += 8;
    core
}

fn path_para<'a>(core: &'a DocumentCore, path: &[(usize, usize, usize)]) -> &'a Paragraph {
    let mut para = &core.document().sections[0].paragraphs[0];
    for &(ctrl, cell, child) in path {
        let Control::Table(table) = &para.controls[ctrl] else {
            panic!("table")
        };
        para = &table.cells[cell].paragraphs[child];
    }
    para
}

fn path_para_mut<'a>(
    core: &'a mut DocumentCore,
    path: &[(usize, usize, usize)],
) -> &'a mut Paragraph {
    let mut para = &mut core.document_mut().sections[0].paragraphs[0];
    for &(ctrl, cell, child) in path {
        let Control::Table(table) = &mut para.controls[ctrl] else {
            panic!("table")
        };
        para = &mut table.cells[cell].paragraphs[child];
    }
    para
}

fn insert_in_path(core: &mut DocumentCore, path: &[(usize, usize, usize)], offset: usize) -> usize {
    let raw = core
        .insert_picture_with_placement_native(
            0,
            0,
            offset,
            path,
            TINY_PNG,
            1000,
            1000,
            1,
            1,
            "png",
            "cell picture",
            None,
            None,
            true,
        )
        .unwrap();
    serde_json::from_str::<serde_json::Value>(&raw).unwrap()["controlIdx"]
        .as_u64()
        .unwrap() as usize
}

fn move_in_path(
    core: &mut DocumentCore,
    from: &[(usize, usize, usize)],
    ctrl: usize,
    to: &[(usize, usize, usize)],
    offset: usize,
) -> serde_json::Value {
    let raw = core
        .move_picture_control_by_path_native(0, 0, from, ctrl, 0, to, offset)
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn move_between_cells_preserves_picture_bytes_and_text_metadata() {
    use rhwp::model::paragraph::{CharShapeRef, RangeTag};
    let mut core = table_fixture();
    let from = [(0, 0, 0)];
    let to = [(0, 1, 0)];
    let source = path_para_mut(&mut core, &from);
    source.char_shapes = vec![
        CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        },
        CharShapeRef {
            start_pos: 3,
            char_shape_id: 0,
        },
    ];
    source.range_tags = vec![RangeTag {
        start: 3,
        end: 5,
        tag: 0,
    }];
    let ctrl = insert_in_path(&mut core, &from, 1);
    let source = path_para_mut(&mut core, &from);
    source.ctrl_data_records[ctrl] = Some(vec![1, 9, 8, 4]);
    let picture = format!("{:?}", source.controls[ctrl]);
    let bin = core.document().bin_data_content[0].data.load();
    let moved = move_in_path(&mut core, &from, ctrl, &to, 2);
    assert_eq!(moved["charOffset"], 2);
    assert_eq!(moved["cellPath"][0]["cellIndex"], 1);
    let source = path_para(&core, &from);
    assert!(!has_picture(source));
    assert_eq!(source.text, "a😀bc");
    assert_eq!(source.char_offsets, vec![0, 1, 3, 4]);
    assert_eq!(source.char_shapes[1].start_pos, 3);
    assert_eq!(
        (source.range_tags[0].start, source.range_tags[0].end),
        (3, 5)
    );
    let target = path_para(&core, &to);
    assert_eq!(target.text, "a😀bc");
    assert_eq!(target.char_offsets, vec![0, 1, 11, 12]);
    assert_eq!(format!("{:?}", target.controls[0]), picture);
    assert_eq!(target.ctrl_data_records[0], Some(vec![1, 9, 8, 4]));
    assert_eq!(core.document().bin_data_content.len(), 1);
    assert_eq!(core.document().bin_data_content[0].data.load(), bin);
    assert_picture_renders(&mut core, 0, "셀 이동");
}

#[test]
fn move_in_same_cell_uses_logical_offsets_between_adjacent_pictures() {
    let mut core = table_fixture();
    let path = [(0, 0, 0)];
    let first = insert_in_path(&mut core, &path, 1);
    let second = insert_in_path(&mut core, &path, 2);
    let original = snapshot(path_para(&core, &path));
    let moved = move_in_path(&mut core, &path, second, &path, 1);
    assert_eq!(moved["controlIdx"], first);
    assert_eq!(moved["charOffset"], 1);
    assert_eq!(snapshot(path_para(&core, &path)), original);
    let moved = move_in_path(&mut core, &path, 0, &path, 5);
    assert_eq!(moved["charOffset"], 4);
    assert_eq!(path_para(&core, &path).char_offsets, vec![0, 9, 11, 20]);
    let before = format!("{:?}", path_para(&core, &path));
    let noop = move_in_path(&mut core, &path, 1, &path, 5);
    assert_eq!(noop["moved"], false);
    assert_eq!(format!("{:?}", path_para(&core, &path)), before);
}

#[test]
fn move_nested_picture_to_parent_cell_updates_ancestor_indices() {
    let mut core = table_fixture();
    let nested = path_para(&core, &[]).controls[0].clone();
    let parent = [(0, 0, 0)];
    let cell = path_para_mut(&mut core, &parent);
    cell.controls.push(nested);
    cell.ctrl_data_records.push(None);
    cell.char_count += 8;
    let from = [(0, 0, 0), (0, 1, 0)];
    let ctrl = insert_in_path(&mut core, &from, 1);
    let result = move_in_path(&mut core, &from, ctrl, &parent, 0);
    assert_eq!(result["charOffset"], 0);
    assert!(has_picture(path_para(&core, &parent)));
    assert!(!has_picture(path_para(&core, &[(0, 0, 0), (1, 1, 0)])));
    // 그림 앞에 있던 중첩 표 인덱스가 삭제에 의해 다시 0으로 돌아간다.
    let back = move_in_path(&mut core, &parent, 0, &[(0, 0, 0), (1, 1, 0)], 1);
    assert_eq!(back["cellPath"][1]["controlIndex"], 0);
    assert!(has_picture(path_para(&core, &from)));
}

#[test]
fn move_cell_picture_to_body_and_back_adjusts_table_path() {
    let mut core = table_fixture();
    let from = [(0, 0, 0)];
    let ctrl = insert_in_path(&mut core, &from, 1);
    let body = move_in_path(&mut core, &from, ctrl, &[], 0);
    assert_eq!(body["cellPath"], serde_json::json!([]));
    assert_eq!(body["controlIdx"], 0);
    assert!(!has_picture(path_para(&core, &[(1, 0, 0)])));
    let back = move_in_path(&mut core, &[], 0, &[(1, 1, 0)], 2);
    assert_eq!(back["cellPath"][0]["controlIndex"], 0);
    assert!(has_picture(path_para(&core, &[(0, 1, 0)])));
}

#[test]
fn invalid_cell_move_does_not_remove_source_picture() {
    let mut core = table_fixture();
    let from = [(0, 0, 0)];
    let ctrl = insert_in_path(&mut core, &from, 1);
    let before = format!("{:?}", core.document().sections[0]);
    assert!(core
        .move_picture_control_by_path_native(0, 0, &from, ctrl, 0, &[(0, 9, 0)], 0)
        .is_err());
    assert_eq!(format!("{:?}", core.document().sections[0]), before);
}
