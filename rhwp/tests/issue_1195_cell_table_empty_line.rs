//! Issue #1195: 표 셀 안 빈 줄(줄간격 90%, 글자에 따라) + TAC 표 겹침 회귀 가드.
//!
//! `samples/hcar-001.hwp` 1쪽 신청서 12×7 표의 셀[28](전체폭 셀) 안에는
//! "1. 개인정보 수집 및 이용 동의[필수]" 제목 문단 다음에, 공백 textRun("     ")이
//! 선행하고 그 뒤에 TAC 표(4×1 "개인정보 동의" 표)가 오는 문단이 있다.
//!
//! 한컴은 표 앞 공백 textRun 너비 다음에 표를 놓되 잔여 너비가 부족하면 다음 줄
//! (line feed)에 표를 조판한다. 즉 표는 문단 첫 줄(제목 줄)이 아니라 표 앞 빈 줄
//! 다음 line_seg 에 위치한다. 보정 전 rhwp 는 표를 첫 줄 위치에 배치해 제목과 겹쳤다.
//!
//! 가드 (좁은 범위): 4×1 표 top y 가 제목 "[필수]" 글자 y 보다 아래(겹치지 않음)여야 한다.
//! - 보정 ON: 표 top 643.8 > 제목 639.8 → 통과
//! - 보정 OFF(회귀): 표 top 631.8 < 639.8 → 실패 (가드가 결함을 잡음)
//!
//! 좌표를 못 찾으면 명시적으로 실패한다(헐거운 통과 방지).

use std::fs;
use std::path::Path;

fn render_hcar_page1_svg() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/hcar-001.hwp");
    let bytes = fs::read(&path).expect("read samples/hcar-001.hwp");
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse hcar-001.hwp");
    doc.render_page_svg_native(0).expect("render page 1 svg")
}

/// `<rect ... width=W ...>` 의 top y 들을 폭 범위(min,max)로 필터링.
fn rect_top_ys_with_width(svg: &str, min_w: f64, max_w: f64) -> Vec<f64> {
    let mut out = Vec::new();
    for tag in iter_tags(svg, "<rect") {
        if let (Some(y), Some(w)) = (attr_f64(&tag, "y"), attr_f64(&tag, "width")) {
            if w > min_w && w < max_w {
                out.push(y);
            }
        }
    }
    out
}

/// 특정 글자를 본문으로 갖는 `<text>` 노드들의 y (y= 또는 translate(x,y)).
fn text_ys_containing(svg: &str, needle: &str) -> Vec<f64> {
    let mut out = Vec::new();
    let mut rest = svg;
    while let Some(p) = rest.find("<text") {
        rest = &rest[p..];
        let close = rest.find("</text>").map(|e| e + 7).unwrap_or(rest.len());
        let node = &rest[..close];
        let gt = node.find('>').map(|e| e + 1).unwrap_or(node.len());
        let (open_tag, body) = node.split_at(gt);
        let body = body.trim_end_matches("</text>");
        if body.contains(needle) {
            if let Some(y) = attr_f64(open_tag, "y").or_else(|| translate_y(open_tag)) {
                out.push(y);
            }
        }
        rest = &rest[close..];
    }
    out
}

fn iter_tags(svg: &str, open: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let mut rest = svg;
    while let Some(p) = rest.find(open) {
        rest = &rest[p..];
        let end = rest.find('>').map(|e| e + 1).unwrap_or(rest.len());
        tags.push(rest[..end].to_string());
        rest = &rest[end..];
    }
    tags
}

fn attr_f64(tag: &str, name: &str) -> Option<f64> {
    let pat = format!("{}=\"", name);
    let i = tag.find(&pat)? + pat.len();
    let j = tag[i..].find('"')? + i;
    tag[i..j].parse().ok()
}

fn translate_y(tag: &str) -> Option<f64> {
    let i = tag.find("translate(")? + "translate(".len();
    let rest = &tag[i..];
    let j = rest.find(')')?;
    let parts: Vec<&str> = rest[..j]
        .split([',', ' '])
        .filter(|s| !s.is_empty())
        .collect();
    parts.get(1).and_then(|s| s.trim().parse().ok())
}

#[test]
fn issue_1195_cell_tac_table_does_not_overlap_preceding_title() {
    let svg = render_hcar_page1_svg();

    // 4×1 "1.동의" 표 (폭 약 589.6px) top y — 못 찾으면 실패.
    let t4 = rect_top_ys_with_width(&svg, 587.0, 591.0);
    assert!(
        !t4.is_empty(),
        "4×1 개인정보 동의 표(폭 ~589.6px) rect 를 SVG 에서 찾지 못함 — 테스트 전제 깨짐"
    );
    let table_top = t4.iter().cloned().fold(f64::INFINITY, f64::min);

    // 제목 "1. 개인정보 수집 및 이용 동의[필수]" — '필' 글자 중 표 top 근처(40px 위~10px 아래).
    // 표 근처가 아닌 다른 '필'(다른 줄)은 제외해 정확히 이 제목만 비교.
    let title_ys: Vec<f64> = text_ys_containing(&svg, "필")
        .into_iter()
        .filter(|&y| (table_top - 40.0..table_top + 10.0).contains(&y))
        .collect();
    assert!(
        !title_ys.is_empty(),
        "표 top({table_top:.1}) 근처(−40..+10px)에서 제목 '필' 글자를 찾지 못함 — 테스트 전제 깨짐"
    );
    let title_y = title_ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    // 핵심 단언: 표 top 이 제목 글자보다 아래여야 한다(겹치지 않음).
    // 보정 OFF 회귀 시 표 top(631.8) < 제목(639.8) 이 되어 실패한다.
    assert!(
        table_top > title_y,
        "셀 안 TAC 표가 제목과 겹침: 표 top={table_top:.1} ≤ 제목 y={title_y:.1} \
         (표가 표 앞 빈 줄 다음 줄로 내려가지 않음 — Issue #1195 회귀)"
    );
}
