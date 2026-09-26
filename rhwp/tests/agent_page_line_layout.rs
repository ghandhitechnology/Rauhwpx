//! 에이전트 get_page_geometry 가 기대는 `getPageLineLayout` 줄 계약을 검사한다.
//! 본문 문단의 줄 문자 범위는 0 에서 시작해 빈틈 없이 이어져 문단 끝에서 닫히고,
//! 베이스라인은 줄 상자 안에 있으며, 셀 안 줄은 셀 경로를 싣는다.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use rhwp::document_core::DocumentCore;
use serde_json::Value;

fn load(sample: &str) -> DocumentCore {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples")
        .join(sample);
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    DocumentCore::from_bytes(&bytes).unwrap_or_else(|error| panic!("parse {sample}: {error}"))
}

fn lines(core: &DocumentCore, page: u32) -> Vec<Value> {
    let layout: Value =
        serde_json::from_str(&core.get_page_line_layout_native(page).expect("line layout"))
            .expect("line layout JSON");
    layout["lines"].as_array().expect("lines array").clone()
}

fn num(v: &Value, key: &str) -> f64 {
    v[key]
        .as_f64()
        .unwrap_or_else(|| panic!("{key} missing in {v}"))
}

fn check_body_paragraph_ranges(sample: &str) -> usize {
    let core = load(sample);
    let mut checked = 0;
    for page in 0..core.page_count() {
        // (sec, para) → 줄 범위들. 쪽 경계에 걸친 문단은 시작/끝 검사를 건너뛴다.
        let mut paras: BTreeMap<(u64, u64), Vec<(u64, u64)>> = BTreeMap::new();
        for line in lines(&core, page) {
            let (y, h, bl) = (num(&line, "y"), num(&line, "h"), num(&line, "bl"));
            assert!(
                bl >= y - 0.5 && bl <= y + h + 0.5,
                "{sample} p{page}: baseline outside {line}"
            );
            if line.get("area").is_some() || line.get("cell").is_some() {
                continue;
            }
            let (Some(sec), Some(para), Some(cs), Some(ce)) = (
                line["sec"].as_u64(),
                line["para"].as_u64(),
                line["cs"].as_u64(),
                line["ce"].as_u64(),
            ) else {
                continue;
            };
            paras.entry((sec, para)).or_default().push((cs, ce));
        }
        for ((sec, para), mut ranges) in paras {
            ranges.sort();
            for pair in ranges.windows(2) {
                assert_eq!(
                    pair[0].1, pair[1].0,
                    "{sample} p{page} s{sec}p{para}: gap/overlap {ranges:?}"
                );
            }
            let text_len = core.document().sections[sec as usize].paragraphs[para as usize]
                .text
                .chars()
                .count() as u64;
            let starts_here = ranges[0].0 == 0;
            let ends_here = ranges.last().unwrap().1 == text_len;
            if starts_here && ends_here {
                checked += 1;
            }
        }
    }
    checked
}

#[test]
fn body_line_ranges_are_contiguous() {
    assert!(check_body_paragraph_ranges("hwp_table_test.hwp") >= 5);
    assert!(check_body_paragraph_ranges("2010-01-06.hwp") >= 5);
}

#[test]
fn cell_lines_carry_cell_path() {
    let core = load("hwp_table_test.hwp");
    let cell_lines: Vec<Value> = lines(&core, 0)
        .into_iter()
        .filter(|line| line.get("cell").is_some())
        .collect();
    assert!(!cell_lines.is_empty(), "table cell lines");
    let first = &cell_lines[0];
    assert_eq!(first["cell"]["pp"], 3, "outer table paragraph");
    assert_eq!(first["cell"]["path"][0], serde_json::json!([0, 0, 0]));
    let runs = first["runs"].as_array().expect("runs");
    assert_eq!(runs.len(), 1);
    // 런 x 범위는 줄 상자 안에 있다.
    let (x, w) = (num(first, "x"), num(first, "w"));
    let (rx, rw) = (runs[0][0].as_f64().unwrap(), runs[0][1].as_f64().unwrap());
    assert!(
        rx >= x - 0.5 && rx + rw <= x + w + 0.5,
        "run outside line box: {first}"
    );
}
