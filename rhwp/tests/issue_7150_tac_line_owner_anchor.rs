#![cfg(not(target_arch = "wasm32"))]

//! [Issue #7150] 한 줄에 글자처럼 취급되는 표가 둘 이상이면, **줄 높이를 정한 표**까지
//! 저장 기준선에 앉아 그 줄 전체가 내려앉는다.
//!
//! 업스트림 `#7049` 는 밴드 분기(`y + om_top`)를 「줄을 독점한 표」로 좁히며
//! `line_tac_table_count <= 1` 을 걸었고, 그 술어는 줄을 **소유한** 표까지 배제한다.
//! Rauhwpx 는 그 술어 자체가 없고 `table_y = (y + baseline + om_bottom - table_h).max(y)`
//! 만 쓴다. 소유 표는 `.max(y)` 로 줄 상단에 붙고, 동반 표는 저장 기준선에 앉아
//! 하단차가 높이차의 0.15배가 되지 않는다.
//!
//! 한/글은 소유자를 `줄상단 + om_top` 에 고정하고, 같은 줄의 다른 표는 그 앵커에서
//! 유도한 공유 기준선 `y + owner_om_top + 0.85×owner_h` 에 앉힌다.
//!
//! 표본 `samples/issue2470/36382471_masked.hwpx` 1쪽 결재란. 첫 칸 valign=Center 는
//! Rauhwpx 에서 줄 y 가 한/글(140.50)과 다르다. 이 시험은 그 칸 정렬을 고치지 않고
//! **호스트 줄 상대** 좌석만 잠근다.

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const SAMPLE: &str = "samples/issue2470/36382471_masked.hwpx";
const OWNER_H: f64 = 150.60;
const COMPANION_H: f64 = 109.00;
const OWNER_OM_TOP: f64 = 140.0 / 75.0;

fn load_page(rel: &str, page: u32) -> RenderNode {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let core = DocumentCore::from_bytes(&std::fs::read(p).expect("표본 읽기")).expect("문서 로드");
    core.build_page_render_tree(page).expect("render tree").root
}

fn page_tables(root: &RenderNode) -> Vec<(f64, f64, f64, f64)> {
    let mut out = Vec::new();
    fn walk(n: &RenderNode, out: &mut Vec<(f64, f64, f64, f64)>) {
        if matches!(n.node_type, RenderNodeType::Table { .. }) {
            out.push((n.bbox.x, n.bbox.y, n.bbox.width, n.bbox.height));
        }
        for c in &n.children {
            walk(c, out);
        }
    }
    walk(root, &mut out);
    out
}

fn page_lines(root: &RenderNode) -> Vec<(f64, f64, f64, f64)> {
    let mut out = Vec::new();
    fn walk(n: &RenderNode, out: &mut Vec<(f64, f64, f64, f64)>) {
        if matches!(n.node_type, RenderNodeType::TextLine(_)) {
            out.push((n.bbox.x, n.bbox.y, n.bbox.width, n.bbox.height));
        }
        for c in &n.children {
            walk(c, out);
        }
    }
    walk(root, &mut out);
    out
}

/// 폭이 `[lo, hi]` 인 표들을 x 순으로.
fn by_width(tables: &[(f64, f64, f64, f64)], lo: f64, hi: f64) -> Vec<(f64, f64, f64, f64)> {
    let mut v: Vec<_> = tables
        .iter()
        .copied()
        .filter(|t| (lo..=hi).contains(&t.2))
        .collect();
    v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    v
}

fn host_line_y(lines: &[(f64, f64, f64, f64)], table: (f64, f64, f64, f64)) -> f64 {
    let (tx, ty, tw, _) = table;
    let mid = tx + tw / 2.0;
    let mut best: Option<(f64, f64)> = None;
    for &(lx, ly, lw, lh) in lines {
        if mid < lx - 0.5 || mid > lx + lw + 0.5 {
            continue;
        }
        if ly > ty + 1.0 {
            continue;
        }
        let dist = (ty - ly).abs();
        let take = match best {
            None => true,
            Some((best_dist, _)) => {
                dist < best_dist - 0.01 || (dist - best_dist).abs() < 0.01 && lh > 80.0
            }
        };
        if take {
            best = Some((dist, ly));
        }
    }
    best.map(|(_, ly)| ly)
        .unwrap_or_else(|| panic!("호스트 TextLine 을 찾지 못했다 table={table:?} lines={lines:?}"))
}

fn approval_tables(rel: &str) -> (RenderNode, (f64, f64, f64, f64), (f64, f64, f64, f64)) {
    let root = load_page(rel, 0);
    let tables = page_tables(&root);
    let companion = by_width(&tables, 240.0, 270.0);
    let owner = by_width(&tables, 340.0, 380.0);
    assert_eq!(
        companion.len(),
        1,
        "좌측 결재표 하나를 기대했다: {companion:?}"
    );
    assert_eq!(owner.len(), 1, "우측 결재표 하나를 기대했다: {owner:?}");
    (root, companion[0], owner[0])
}

/// 줄을 소유한 표(우 7×4, 높이 150.60)는 `줄상단 + om_top` 에 앉는다.
#[test]
fn issue_7150_line_owner_sits_at_its_outer_margin() {
    let (root, _, owner) = approval_tables(SAMPLE);
    let (_, y, _, h) = owner;
    assert!(
        (h - OWNER_H).abs() < 0.2,
        "표본 전제: 소유 표 높이 {OWNER_H:.2} 이어야 판정이 의미를 갖는다 (got {h:.2})"
    );
    let line_y = host_line_y(&page_lines(&root), owner);
    let expected = line_y + OWNER_OM_TOP;
    assert!(
        (y - expected).abs() < 0.3,
        "줄을 소유한 표는 줄상단+om_top({expected:.2})에 앉아야 한다 — got {y:.2} \
         (수정 전 줄 상단 {line_y:.2} 에 클램프)"
    );
}

/// 같은 줄의 다른 표(좌 4×2, 높이 109.00)도 소유자 앵커에서 유도한 기준선에 앉는다.
#[test]
fn issue_7150_line_companion_follows_the_owner_anchor() {
    let (root, companion, owner) = approval_tables(SAMPLE);
    let (_, y, _, h) = companion;
    assert!(
        (h - COMPANION_H).abs() < 0.2,
        "표본 전제: 동반 표 높이 {COMPANION_H:.2} (got {h:.2})"
    );
    let line_y = host_line_y(&page_lines(&root), owner);
    let expected = line_y + OWNER_OM_TOP + 0.85 * (OWNER_H - COMPANION_H);
    assert!(
        (y - expected).abs() < 0.3,
        "동반 표는 소유자 앵커 기준선에 앉아야 한다({expected:.2}) — got {y:.2}"
    );
}

/// #7049 가 세운 하단차 계약 — 높이차의 0.15 배.
///
/// `0.15 × (150.60 − 109.00) = 6.24`, 한/글 실측 `6.23`. 소유자만 올리고 동반 표를
/// 저장 기준선에 두면 깨진다.
#[test]
fn issue_7150_bottom_gap_keeps_the_issue_7049_contract() {
    let (_, left, right) = approval_tables(SAMPLE);
    let gap = (right.1 + right.3) - (left.1 + left.3);
    assert!(
        (gap - 6.24).abs() < 0.3,
        "두 표의 하단차는 높이차의 0.15 배(6.24)여야 한다 — got {gap:.2} \
         (한/글 6.23 · 소유자만 고치면 4.90)"
    );
}

/// 같은 쪽의 본문 칸은 건드리지 않는다 — 바깥 표의 나머지 세 행.
#[test]
fn issue_7150_body_rows_are_untouched() {
    let root = load_page(SAMPLE, 0);
    let outer: Vec<_> = page_tables(&root)
        .into_iter()
        .filter(|t| t.2 > 640.0)
        .collect();
    assert_eq!(outer.len(), 1, "바깥 표 하나를 기대했다: {outer:?}");
    let (_, y, _, h) = outer[0];
    assert!(
        (y - 117.10).abs() < 0.2 && (h - 914.20).abs() < 0.3,
        "바깥 표 기하는 불변이어야 한다 — got y={y:.2} h={h:.2} (기대 117.10 / 914.20)"
    );
}

/// 저장 UTF-16 줄 경계에서 이전 줄 끝 표와 다음 줄 첫 표가 같은 가시 위치로
/// 투영되더라도, 다른 줄의 여백을 현재 줄 기준선에 사용하면 안 된다.
/// fixture는 합성 계약 진단이며 한컴 재저장/PDF 오라클이 아니다.
#[test]
fn previous_line_table_margin_does_not_move_the_next_line_table() {
    let fixtures = "tests/fixtures/issue7150_cross_line_owner";
    let original_root = load_page(&format!("{fixtures}/previous_line_margin_140.hwpx"), 0);
    let changed_root = load_page(&format!("{fixtures}/previous_line_margin_240.hwpx"), 0);
    let original = by_width(&page_tables(&original_root), 240.0, 270.0);
    let changed = by_width(&page_tables(&changed_root), 240.0, 270.0);
    assert_eq!(original.len(), 2, "두 줄의 작은 표가 한 번씩 있어야 한다");
    assert_eq!(changed.len(), 2, "여백 변경으로 표가 누락/중복되면 안 된다");
    let next_line_y = |tables: &[(f64, f64, f64, f64)]| {
        tables.iter().map(|t| t.1).fold(f64::NEG_INFINITY, f64::max)
    };
    let before = next_line_y(&original);
    let after = next_line_y(&changed);
    assert!(
        (before - after).abs() < 0.1,
        "이전 줄의 여백 배분만 바꾸면 다음 줄 표는 불변이어야 한다: {before:.3} → {after:.3}"
    );
}
