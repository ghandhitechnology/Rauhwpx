#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::renderer::font_metrics_data::find_metric;
use rhwp::renderer::style_resolver::primary_font_name;

// 기준은 한컴 macOS PDF 의 `2 Tr` 선 굵기(글자 크기의 1/40)다.
// 이 표본의 Windows 한/글 2022 PDF 는 1/50(83 → 1.66)이지만 macOS 동작을 따른다.
const STROKE_EM: f64 = 0.025;
const HANCOM_36382471_PAGE0_TR2_GLYPHS: usize = 55;

fn page_svg(rel: &str, page: u32) -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let core = DocumentCore::from_bytes(&std::fs::read(p).expect("표본 읽기")).expect("문서 로드");
    core.render_page_svg_native(page).expect("SVG 렌더")
}

fn text_elements(svg: &str) -> Vec<(f64, Option<f64>, Option<String>)> {
    let attr = |el: &str, name: &str| -> Option<String> {
        let key = format!("{name}=\"");
        let i = el.find(&key)? + key.len();
        let rest = &el[i..];
        Some(rest[..rest.find('"')?].to_string())
    };
    svg.split("<text ")
        .skip(1)
        .filter_map(|rest| {
            let el = &rest[..rest.find('>')?];
            Some((
                attr(el, "font-size")?.parse().ok()?,
                attr(el, "stroke-width").and_then(|v| v.parse().ok()),
                attr(el, "font-weight"),
            ))
        })
        .collect()
}

#[test]
fn issue_7151_faux_bold_becomes_a_fortieth_em_stroke() {
    let svg = page_svg("samples/issue2470/36382471_masked.hwpx", 0);
    let stroked: Vec<_> = text_elements(&svg)
        .into_iter()
        .filter(|(_, sw, _)| sw.is_some())
        .collect();

    assert_eq!(
        stroked.len(),
        HANCOM_36382471_PAGE0_TR2_GLYPHS,
        "합성 볼드 글자 수가 정본 `Tr 2` 와 같아야 한다 — {} 개",
        stroked.len()
    );
    for (size, sw, weight) in &stroked {
        let want = size * STROKE_EM;
        assert!(
            (sw.unwrap() - want).abs() <= 0.001,
            "획은 글자 크기의 {STROKE_EM} 배여야 한다 — 크기 {size:.3}px, \
             기대 {want:.3}px, 실측 {:.3}px",
            sw.unwrap()
        );
        assert!(
            weight.is_none(),
            "획으로 굵히는 글자에는 font-weight 를 함께 주지 않는다 — {weight:?}"
        );
    }
    assert!(
        !svg.contains("font-weight=\"bold\""),
        "이 쪽의 볼드 face 는 모두 Bold 항목이 없다 — font-weight=\"bold\" 가 남으면 안 된다"
    );
}

#[test]
fn issue_7151_faces_with_a_real_bold_keep_font_weight() {
    let svg = page_svg("samples/hwpx/form-002.hwpx", 0);
    assert!(
        svg.contains("font-weight=\"bold\""),
        "Bold 메트릭이 있는 face 는 font-weight=\"bold\" 를 유지해야 한다"
    );
    for (size, sw, weight) in text_elements(&svg) {
        if weight.as_deref() == Some("bold") {
            assert!(
                sw.is_none(),
                "Bold face 요청에 합성 획을 겹쳐 주면 두 번 굵어진다 — \
                 크기 {size:.3}px, 획 {sw:?}"
            );
        }
    }
}

#[test]
fn issue_7151_bold_fallback_faces_keep_regular_advance() {
    for family in ["굴림체", "HY헤드라인M", "HY견명조"] {
        let primary = primary_font_name(family);
        let bold = find_metric(primary, true, false)
            .unwrap_or_else(|| panic!("{family}: bold 메트릭 조회 실패"));
        let regular = find_metric(primary, false, false)
            .unwrap_or_else(|| panic!("{family}: regular 메트릭 조회 실패"));
        assert!(
            bold.bold_fallback,
            "{family}: bold 요청은 bold_fallback 이어야 한다"
        );
        assert!(
            std::ptr::eq(bold.metric, regular.metric),
            "{family}: bold_fallback 은 Regular 메트릭과 같은 identity 여야 한다"
        );
        match (bold.metric.hangul, regular.metric.hangul) {
            (Some(bh), Some(rh)) => {
                assert!(
                    std::ptr::eq(bh.widths.as_ptr(), rh.widths.as_ptr())
                        && bh.widths.len() == rh.widths.len(),
                    "{family}: hangul 폭 테이블이 Regular 와 같아야 한다"
                );
            }
            (None, None) => {
                assert_eq!(
                    bold.metric.get_width('A'),
                    regular.metric.get_width('A'),
                    "{family}: 기본 Latin 폭이 Regular 와 같아야 한다"
                );
            }
            _ => panic!("{family}: hangul 테이블 유무가 bold/regular 에서 달라지면 안 된다"),
        }
    }
}
