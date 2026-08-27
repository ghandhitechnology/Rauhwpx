//! Issue #2211: 중첩 표 행 성장 판정의 pad 이중 계상 — 주보 p1 좌측 단 하단 클리핑.
//!
//! `samples/basic/issue1994_behindtext_table_20200830.hwp` p1 좌측 단의 표 pi=5
//! (내부 18×9 중첩)에서, 저장 LINE_SEG 콘텐츠가 선언 h에 꽉 맞는 행마다
//! `content + pad_top + pad_bottom > h` 판정으로 +282HU(3.76px)씩 성장해
//! 누적 +30px → 마지막 문단("모세가…")이 페이지 하단에서 절단됐다.
//!
//! 정정: 저장 LINE_SEG 보유 셀은 성장 판정에서 pad 를 가산하지 않는다
//! (resolve_row_heights 1-b/2-b, cell_has_stored_line_segs — #2112 계보).

use std::fs;
use std::path::Path;

/// p1 SVG 좌측 단(x<545)에서 지정 텍스트를 포함하는 줄의 y (baseline) 최댓값.
fn find_text_y(svg: &str, probe: &str) -> Option<f64> {
    // 본문은 글자 단위 <text> — probe 첫 글자의 y 후보 중 probe 두 번째
    // 글자가 같은 y 에 존재하는 것을 채택한다.
    let chars: Vec<char> = probe.chars().collect();
    let mut candidates: Vec<(f64, f64)> = Vec::new(); // (y, x)
    let mut seconds: Vec<(f64, f64)> = Vec::new();
    for frag in svg.split("<text ").skip(1) {
        let head = &frag[..frag.find('>').unwrap_or(frag.len())];
        let body_start = frag.find('>').map(|i| i + 1).unwrap_or(0);
        let body = &frag[body_start..frag.find("</text>").unwrap_or(frag.len())];
        let (x, y) = if let Some(i) = head.find("translate(") {
            let r = &head[i + "translate(".len()..];
            let Some(e) = r.find(')') else { continue };
            let mut it = r[..e].split(',');
            let (Some(xs), Some(ys)) = (it.next(), it.next()) else {
                continue;
            };
            match (xs.trim().parse::<f64>(), ys.trim().parse::<f64>()) {
                (Ok(x), Ok(y)) => (x, y),
                _ => continue,
            }
        } else {
            let attr = |k: &str| -> Option<f64> {
                let pat = format!("{k}=\"");
                let s = head.find(&pat)? + pat.len();
                head[s..].split('"').next()?.parse().ok()
            };
            match (attr("x"), attr("y")) {
                (Some(x), Some(y)) => (x, y),
                _ => continue,
            }
        };
        if x >= 545.0 {
            continue;
        }
        if body.contains(chars[0]) {
            candidates.push((y, x));
        }
        if body.contains(chars[1]) {
            seconds.push((y, x));
        }
    }
    candidates
        .iter()
        .filter(|(y, _)| seconds.iter().any(|(y2, _)| (y - y2).abs() < 1.0))
        .map(|(y, _)| *y)
        .fold(None, |acc: Option<f64>, y| {
            Some(acc.map_or(y, |a: f64| a.max(y)))
        })
}

#[test]
fn issue_2211_left_column_last_paragraph_fits_in_page() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwp_path =
        Path::new(repo_root).join("samples/basic/issue1994_behindtext_table_20200830.hwp");
    let bytes =
        fs::read(&hwp_path).unwrap_or_else(|e| panic!("read {}: {}", hwp_path.display(), e));
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .expect("parse issue1994_behindtext_table_20200830.hwp");
    let svg = doc.render_page_svg_native(0).expect("render page 1 SVG");

    // 좌측 단 마지막 문단의 둘째 줄 "모세야!" — 한컴 baseline ≈ 733px.
    // 회귀(행별 +3.76px 누적) 시 ≈ 763px 로 페이지 본문 하한(748.4px)을 넘어 절단.
    let y = find_text_y(&svg, "모세야").expect("좌측 단 마지막 문단(모세야) 텍스트를 찾지 못함");
    assert!(
        y < 748.0,
        "좌측 단 마지막 줄이 페이지 본문 하한을 넘음: baseline y={y:.1} (한컴 ≈733, 회귀 시 ≈763) — #2211 행 성장 pad 이중 계상 회귀"
    );

    // 성서읽기 표기의 y 도 한컴 정합대(±8px)에 있어야 중간 누적이 없다.
    let y2 = find_text_y(&svg, "성서").expect("성서읽기 줄을 찾지 못함");
    assert!(
        (655.0..672.0).contains(&y2),
        "성서읽기 줄 y={y2:.1} — 한컴 ≈661 대비 이탈 (#2211 중간 누적 회귀)"
    );
}

fn find_table<'a>(
    node: &'a serde_json::Value,
    rows: u64,
    cols: u64,
) -> Option<&'a serde_json::Value> {
    if node.get("type").and_then(|v| v.as_str()) == Some("Table")
        && node.get("rows").and_then(|v| v.as_u64()) == Some(rows)
        && node.get("cols").and_then(|v| v.as_u64()) == Some(cols)
    {
        return Some(node);
    }
    node.get("children")?
        .as_array()?
        .iter()
        .find_map(|child| find_table(child, rows, cols))
}

fn row_single_span_height(table: &serde_json::Value, row: u64) -> f64 {
    table["children"]
        .as_array()
        .expect("table children")
        .iter()
        .filter(|cell| {
            cell.get("type").and_then(|v| v.as_str()) == Some("Cell")
                && cell.get("row").and_then(|v| v.as_u64()) == Some(row)
        })
        .filter_map(|cell| cell["bbox"]["h"].as_f64())
        .fold(0.0, f64::max)
}

#[test]
fn table_in_textbox_multiline_row_consumes_saved_common_height_residual() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwp_path = Path::new(repo_root).join("samples/table-in-tbox.hwp");
    let bytes = fs::read(&hwp_path).unwrap_or_else(|e| panic!("read {}: {e}", hwp_path.display()));
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse table-in-tbox fixture");
    let json = doc
        .get_page_render_tree(0)
        .expect("render table-in-tbox page 1");
    let tree: serde_json::Value = serde_json::from_str(&json).expect("parse render tree JSON");
    let main = find_table(&tree, 34, 8).expect("34x8 main table inside textbox");

    let total_h = main["bbox"]["h"].as_f64().expect("main table height");
    let multiline_h = row_single_span_height(main, 1);
    let final_h = row_single_span_height(main, 33);

    assert!(
        (32.0..33.0).contains(&multiline_h),
        "two-line institution row must include 141+141HU vertical padding (Hancom 32.44px), \
         got {multiline_h:.2}px"
    );
    assert!(
        (19.0..20.0).contains(&final_h),
        "common-height residual belongs to the overflowing multiline row, not the final row \
         (Hancom final row 19.50px), got {final_h:.2}px"
    );
    assert!(
        (677.0..678.5).contains(&total_h),
        "row redistribution must preserve the authored total table height (~677.8px), \
         got {total_h:.2}px"
    );
}
