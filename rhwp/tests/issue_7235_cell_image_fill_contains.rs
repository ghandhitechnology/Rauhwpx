//! 칸 배경 그림 채우기 `None`(이진 유형 15)은 칸에 맞춰 축소·가운데 놓는다 (#7235).
//!
//! 종전 `render_image_node`는 None을 배치 모드로 그려 1628×563 로고가
//! 253×57 칸 왼쪽 위에 놓이고 clip되어 사라졌다.

#![cfg(not(target_arch = "wasm32"))]

use std::path::PathBuf;

use rhwp::document_core::DocumentCore;

/// 칸 상자 — 수정 전후 불변이며 render tree Image bbox와 같다.
const CELL_X: f64 = 466.613;
const CELL_Y: f64 = 100.267;
const CELL_W: f64 = 253.373;
const CELL_H: f64 = 57.107;

/// 원본 로고 픽셀 크기.
const IMG_W: f64 = 1628.0;
const IMG_H: f64 = 563.0;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("samples/issue7235/156467175_press_release_header_logo_p1.hwp")
}

fn page_svg() -> String {
    let bytes = std::fs::read(fixture_path()).expect("fixture 읽기 실패");
    let doc = DocumentCore::from_bytes(&bytes).expect("문서 로드 실패");
    doc.render_page_svg_native(0).expect("1쪽 SVG 렌더 실패")
}

/// `<image ...>` 태그에서 x·y·width·height·preserveAspectRatio를 뽑는다.
fn image_tags(svg: &str) -> Vec<(f64, f64, f64, f64, String)> {
    let mut out = Vec::new();
    for tag in svg.split("<image ").skip(1) {
        let head = &tag[..tag.find('>').unwrap_or(tag.len())];
        let attr = |name: &str| -> Option<f64> {
            let key = format!("{name}=\"");
            let rest = head.split(&key).nth(1)?;
            rest[..rest.find('"')?].parse::<f64>().ok()
        };
        let par = head
            .split("preserveAspectRatio=\"")
            .nth(1)
            .and_then(|r| r.find('"').map(|e| r[..e].to_string()))
            .unwrap_or_default();
        if let (Some(x), Some(y), Some(w), Some(h)) =
            (attr("x"), attr("y"), attr("width"), attr("height"))
        {
            out.push((x, y, w, h, par));
        }
    }
    out
}

fn cell_fill_image(svg: &str) -> (f64, f64, f64, f64, String) {
    let found: Vec<_> = image_tags(svg)
        .into_iter()
        .filter(|(x, y, _, _, _)| (x - CELL_X).abs() < 1.0 && (y - CELL_Y).abs() < 1.0)
        .collect();
    assert_eq!(
        found.len(),
        1,
        "칸 원점({CELL_X}, {CELL_Y})에서 시작하는 <image>가 1개여야 한다: {found:?}"
    );
    found.into_iter().next().unwrap()
}

#[test]
fn issue_7235_cell_image_fill_none_is_not_drawn_at_original_size() {
    let svg = page_svg();
    let (_, _, w, h, _) = cell_fill_image(&svg);
    assert!(
        (w - IMG_W).abs() > 1.0 && (h - IMG_H).abs() > 1.0,
        "칸 채우기 그림이 원본 픽셀 크기로 그려졌다: {w} x {h}"
    );
    assert!(
        !svg.contains("fill-clip"),
        "칸 채우기가 여전히 배치 모드(fill-clip)로 그려진다"
    );
}

#[test]
fn issue_7235_cell_image_fill_none_contains_and_centers() {
    let svg = page_svg();
    let (x, y, w, h, par) = cell_fill_image(&svg);
    assert_eq!(
        par, "xMidYMid meet",
        "칸 채우기는 종횡비를 지키며 영역에 맞춰야 한다"
    );
    assert!((x - CELL_X).abs() < 0.01, "x={x}");
    assert!((y - CELL_Y).abs() < 0.01, "y={y}");
    assert!((w - CELL_W).abs() < 0.01, "width={w}");
    assert!((h - CELL_H).abs() < 0.01, "height={h}");
}

#[test]
fn issue_7235_drawn_logo_matches_hancom_geometry() {
    let svg = page_svg();
    let (x, _y, w, h, par) = cell_fill_image(&svg);
    assert_eq!(par, "xMidYMid meet");
    let scale = (w / IMG_W).min(h / IMG_H);
    let drawn_w = IMG_W * scale;
    let drawn_h = IMG_H * scale;
    let left = x + (w - drawn_w) / 2.0;
    let right = left + drawn_w;
    assert!((drawn_w - 165.16).abs() < 0.05, "그려지는 폭={drawn_w}");
    assert!((left - 510.72).abs() < 0.05, "왼쪽={left}");
    assert!((right - 675.88).abs() < 0.05, "오른쪽={right}");
    assert!((drawn_h - CELL_H).abs() < 0.01, "그려지는 높이={drawn_h}");
    assert!(left > 510.0 && right < 677.0, "{left}..{right}");
}

#[test]
fn issue_7235_other_images_on_the_page_are_untouched() {
    let svg = page_svg();
    let others: Vec<_> = image_tags(&svg)
        .into_iter()
        .filter(|(x, y, _, _, _)| (x - CELL_X).abs() >= 1.0 || (y - CELL_Y).abs() >= 1.0)
        .collect();
    assert!(
        !others.is_empty(),
        "대조군 그림이 사라졌다 — 이 수정은 칸 채우기만 바꾼다"
    );
    for (x, y, w, h, par) in others {
        assert_eq!(
            par, "none",
            "대조군 그림의 채우기 방식이 바뀌었다: ({x}, {y}) {w}x{h} par={par}"
        );
    }
}
