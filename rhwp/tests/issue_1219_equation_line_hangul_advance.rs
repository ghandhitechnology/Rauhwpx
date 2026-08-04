//! Task #1219: 수식 포함 줄의 본문 한글 압축·겹침 회귀 가드.
//!
//! 재현 문서: `samples/3-09월_교육_통합_2023.hwp` 6쪽(0-indexed page=5) 문26
//! 「공차가 양수인 등차수열 {aₙ}과 등비수열 {bₙ}에 대하여」.
//!
//! 본질: 인라인 수식(treat-as-char)이 포함된 줄의 폭을 측정할 때
//!   1) 줄 끝 위치(= 다음 줄 선두) 수식이 현재 줄 폭에 오포함되고
//!      (`est_x`/`total_tac_width_in_line` 가 전역 tac_offsets_px 를 run 경계로 재필터),
//!   2) 선두 미주 마커("문26)")가 inline_offset 과 fn_text 위첨자로 이중 계상되어
//!      `total_text_width > available_width` 거짓 오버플로우가 발생, 비정렬(Left) 줄에도
//!      음수 자간 압축이 걸려 본문 한글이 8.96px(0.746em)로 겹쳤다.
//!
//! 수정: 측정 TAC 소스를 줄-경계 정규 집합 `line_tac_offsets`(렌더 경로와 동일)로
//! 통일 + 선두 미주(start_line==0 Endnote)를 fn_text 측정에서 제외.
//! 결과 한글 advance 11.93px(≈ font_size 12px, PDF 한글 2022 정합).
//!
//! 좌표 측정: `render_page_svg_native` SVG 의 한글 `<text>` x (96 DPI).

use std::fs;
use std::path::Path;

/// SVG 의 단일-글자 `<text>` 요소를 (x, y, font_size, ch) 로 추출.
fn single_char_glyphs(svg: &str) -> Vec<(f64, f64, f64, char)> {
    let mut out = Vec::new();
    let mut search_from = 0;
    while let Some(rel) = svg[search_from..].find("<text ") {
        let tag_start = search_from + rel;
        search_from = tag_start + 6;

        let after = &svg[tag_start + 6..];
        let Some(close) = after.find('>') else { break };
        let attrs = &after[..close];
        let content_start = tag_start + 6 + close + 1;
        let Some(end_rel) = svg[content_start..].find("</text>") else {
            break;
        };
        let content = &svg[content_start..content_start + end_rel];

        let parse_attr = |name: &str| -> Option<f64> {
            let p = attrs.find(name)?;
            let s = p + name.len();
            let e_rel = attrs[s..].find('"')?;
            attrs[s..s + e_rel].parse::<f64>().ok()
        };

        if content.chars().count() == 1 {
            if let (Some(x), Some(y), Some(fs)) = (
                parse_attr("x=\""),
                parse_attr("y=\""),
                parse_attr("font-size=\""),
            ) {
                out.push((x, y, fs, content.chars().next().unwrap()));
            }
        }
    }
    out
}

fn is_hangul(c: char) -> bool {
    ('가'..='힣').contains(&c)
}

#[test]
fn equation_line_hangul_not_compressed() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwp_path = Path::new(repo_root).join("samples/3-09월_교육_통합_2023.hwp");
    let bytes =
        fs::read(&hwp_path).unwrap_or_else(|e| panic!("read {}: {}", hwp_path.display(), e));
    let doc =
        rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse 3-09월_교육_통합_2023.hwp");

    // 6쪽 (0-indexed page=5) — 문26 이 있는 페이지.
    let svg = doc.render_page_svg_native(5).expect("render page 6");

    let glyphs = single_char_glyphs(&svg);

    // 문26 줄 찾기: "공" 다음에 같은 y 줄에서 "차","가" 가 이어지는 줄의 y 를 식별.
    // (이 페이지에서 "공차가" 시퀀스는 문26 첫 줄에만 등장.)
    let mut target_y: Option<f64> = None;
    for (x, y, _, c) in &glyphs {
        if *c == '공' {
            // 같은 y(±0.5px) 에서 x 가 더 큰 '차' 가 있는지 확인
            let has_cha = glyphs
                .iter()
                .any(|(x2, y2, _, c2)| *c2 == '차' && (y2 - y).abs() < 0.5 && *x2 > *x);
            if has_cha {
                target_y = Some(*y);
                break;
            }
        }
    }
    let target_y = target_y.expect("문26 '공차가' 줄을 찾지 못함");

    // 해당 줄의 본문 한글(font_size ≈ 12) glyph 를 x 순으로 수집.
    let mut line: Vec<(f64, char)> = glyphs
        .iter()
        .filter(|(_, y, fs, c)| {
            (y - target_y).abs() < 0.5 && (fs - 12.0).abs() < 0.1 && is_hangul(*c)
        })
        .map(|(x, _, _, c)| (*x, *c))
        .collect();
    line.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    assert!(
        line.len() >= 10,
        "문26 줄 한글 glyph 가 10개 이상이어야 함 (찾음: {} — {:?})",
        line.len(),
        line.iter().map(|(_, c)| c).collect::<String>()
    );

    // 인접 한글 간 advance 중 "글자 내부"(< 14px, 단어 사이 공백/수식 점프 제외) 만 검사.
    // 수정 전 0.746em(8.96px) 압축이면 이 값들이 ~9px 로 떨어진다.
    // 수정 후 ≈ 11.93px (PDF 한글 2022 의 1.0em=12px 정합).
    let tight_advances: Vec<f64> = line
        .windows(2)
        .map(|w| w[1].0 - w[0].0)
        .filter(|d| *d < 14.0)
        .collect();

    assert!(
        tight_advances.len() >= 5,
        "글자 내부 advance 표본이 5개 이상이어야 함 (찾음: {:?})",
        tight_advances
    );

    let min_adv = tight_advances.iter().cloned().fold(f64::INFINITY, f64::min);
    assert!(
        min_adv >= 11.0,
        "수식 포함 줄 본문 한글이 압축되어 겹침 (최소 advance {:.2}px < 11.0px). \
         font_size 12px 대비 정상 전각 advance 여야 함. advances={:?}",
        min_adv,
        tight_advances
    );
}
