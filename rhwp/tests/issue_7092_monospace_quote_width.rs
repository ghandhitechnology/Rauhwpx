#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use rhwp::wasm_api::HwpDocument;

const SAMPLE_ISSUE_157: &str = "samples/hwpx/issue_157.hwpx";
const SAMPLE_1730000: &str = "samples/task2097/1730000_selection_report.hwp";

fn primary_font(family: &str) -> &str {
    family.split(',').next().unwrap_or(family).trim()
}

fn quote_advances(sample: &str, max_pages: u32) -> Vec<(String, f64)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(sample);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc = HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {sample}: {e}"));
    let mut out = Vec::new();
    for page in 0..max_pages {
        let Ok(raw) = doc.get_page_text_layout_native(page) else {
            continue;
        };
        let layout: serde_json::Value = serde_json::from_str(&raw).expect("text-layout JSON");
        for run in layout["runs"].as_array().into_iter().flatten() {
            let text: Vec<char> = run["text"].as_str().unwrap_or_default().chars().collect();
            let font_size = run["fontSize"].as_f64().unwrap_or(0.0);
            let family = primary_font(run["fontFamily"].as_str().unwrap_or_default()).to_string();
            let char_x: Vec<f64> = run["charX"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_f64)
                .collect();
            if font_size <= 0.0 || char_x.len() < text.len() + 1 {
                continue;
            }
            for (i, &c) in text.iter().enumerate() {
                if c != '\u{2018}' && c != '\u{2019}' {
                    continue;
                }
                out.push((family.clone(), (char_x[i + 1] - char_x[i]) / font_size));
            }
        }
    }
    out
}

fn advances_for(font: &str, samples: &[(&str, u32)]) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for (sample, pages) in samples {
        out.extend(
            quote_advances(sample, *pages)
                .into_iter()
                .filter(|(f, _)| f == font)
                .map(|(_, adv)| adv),
        );
    }
    out.sort_by(|a, b| a.partial_cmp(b).expect("유한값"));
    out
}

#[test]
fn monospace_quotes_advance_full_width() {
    for (font, samples) in [
        ("굴림체", &[(SAMPLE_ISSUE_157, 2u32)][..]),
        ("돋움체", &[(SAMPLE_1730000, 4u32)][..]),
    ] {
        let advances = advances_for(font, samples);
        assert!(
            !advances.is_empty(),
            "{font} 따옴표가 하나도 없다 — 검사 대상이 0건이면 통과 증거가 아니다"
        );
        let narrow: Vec<_> = advances.iter().filter(|adv| **adv < 0.9).collect();
        assert!(
            narrow.is_empty(),
            "{font} 따옴표는 정본대로 전각이어야 한다(수정 전 0.300). \
             좁은 것: {narrow:?} · 전체 {advances:?}"
        );
    }
}
