#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const SAMPLE: &str = "samples/issue7018/2769535-records-inspection-plan.hwpx";
const TEXT_LINE_BASELINE_PX: f64 = 13.6;
const TABLE_LINE_BASELINE_PX: f64 = 179.0;
const HOST_NEEDLE: &str = "행정박물";

fn sample() -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE))
        .expect("#7018 정식 HWPX fixture 읽기")
}

fn collect_runs<'a>(node: &'a RenderNode, needle: &str, out: &mut Vec<&'a RenderNode>) {
    if let RenderNodeType::TextRun(run) = &node.node_type {
        if run.text.contains(needle) {
            out.push(node);
        }
    }
    for child in &node.children {
        collect_runs(child, needle, out);
    }
}

fn host_run(core: &DocumentCore) -> RenderNode {
    let page = core.build_page_render_tree(1).expect("2쪽 render tree");
    let mut found = Vec::new();
    collect_runs(&page.root, HOST_NEEDLE, &mut found);
    assert_eq!(
        found.len(),
        1,
        "`마. 행정박물류` 런은 2쪽에 하나여야 한다 — 실측 {}개",
        found.len()
    );
    found[0].clone()
}

#[test]
fn tac_host_text_uses_its_own_stored_line_baseline() {
    let core = DocumentCore::from_bytes(&sample()).expect("문서 로드");
    let run = host_run(&core);
    assert!(
        (run.bbox.height - TEXT_LINE_BASELINE_PX).abs() <= 1.0,
        "글자 런 상자 높이는 글자 줄 baseline {TEXT_LINE_BASELINE_PX}px 이어야 한다 — \
         실측 {:.1}px (표 줄 값 {TABLE_LINE_BASELINE_PX}px 을 받으면 #7018 회귀)",
        run.bbox.height,
    );
}

#[test]
fn tac_host_text_baseline_matches_the_hangul_oracle() {
    let core = DocumentCore::from_bytes(&sample()).expect("문서 로드");
    let run = host_run(&core);
    let baseline = run.bbox.y + run.bbox.height;
    assert!(
        (run.bbox.y - 605.8).abs() <= 1.0,
        "줄 상자 상단은 저장 사다리가 말하는 605.8px 이어야 한다 — 실측 {:.1}px",
        run.bbox.y,
    );
    assert!(
        (605.0..=622.0).contains(&baseline),
        "baseline 은 한/글 2020 잉크 구간(605.5..620.5) 안이어야 한다 — 실측 {baseline:.1}px \
         (표 줄 값이면 784.8px, 165.4px 하강)",
    );
}

#[test]
fn every_run_on_the_host_line_uses_that_lines_baseline() {
    let core = DocumentCore::from_bytes(&sample()).expect("문서 로드");
    let page = core.build_page_render_tree(1).expect("2쪽 render tree");
    let host = host_run(&core);
    let mut line_runs = Vec::new();
    fn collect(node: &RenderNode, host_y: f64, out: &mut Vec<(f64, f64, String)>) {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            if (node.bbox.y - host_y).abs() <= 1.0 {
                out.push((node.bbox.height, node.bbox.y, run.text.clone()));
            }
        }
        for child in &node.children {
            collect(child, host_y, out);
        }
    }
    collect(&page.root, host.bbox.y, &mut line_runs);
    assert!(
        line_runs.len() >= 2,
        "호스트 줄에는 제목 런과 후행 공백 런이 함께 있어야 한다 — 실측 {}개: {line_runs:?}",
        line_runs.len(),
    );
    for (h, y, text) in &line_runs {
        assert!(
            (h - TEXT_LINE_BASELINE_PX).abs() <= 1.0,
            "호스트 줄 런 {text:?} (y={y:.1}) 의 상자 높이는 글자 줄 baseline \
             {TEXT_LINE_BASELINE_PX}px 이어야 한다 — 실측 {h:.1}px \
             (표 줄 {TABLE_LINE_BASELINE_PX}px 이면 그 출력 경로에 보정이 빠진 것)",
        );
    }
}

#[test]
fn the_table_placement_is_unchanged() {
    let core = DocumentCore::from_bytes(&sample()).expect("문서 로드");
    let page = core.build_page_render_tree(1).expect("2쪽 render tree");
    let host = host_run(&core);
    let mut tac: Option<(f64, f64)> = None;
    fn walk(node: &RenderNode, host_y: f64, out: &mut Option<(f64, f64)>) {
        if matches!(node.node_type, RenderNodeType::Table(_))
            && (node.bbox.y - host_y).abs() <= 1.0
            && node.bbox.height > 180.0
        {
            *out = Some((node.bbox.y, node.bbox.height));
        }
        for child in &node.children {
            walk(child, host_y, out);
        }
    }
    walk(&page.root, host.bbox.y, &mut tac);
    let (table_y, table_h) = tac.expect("호스트 줄에 앉은 자리차지 표");
    assert!(
        (table_y - 605.8).abs() <= 2.5,
        "표 상단은 수정 전과 같은 605.8px 이어야 한다 — 실측 {table_y:.1}px \
         (이 수정은 글자 런의 baseline 출처만 바꾼다)",
    );
    assert!(
        (table_h - 206.8).abs() <= 2.5,
        "표 높이는 206.8px 이어야 한다 — 실측 {table_h:.1}px",
    );
}

#[test]
fn page_count_matches_the_oracle() {
    let core = DocumentCore::from_bytes(&sample()).expect("문서 로드");
    assert_eq!(core.page_count(), 2, "한/글 2020 과 같은 2쪽이어야 한다");
}

#[test]
fn stored_ladder_axis_matches_char_offsets() {
    let bytes = sample();
    let doc = rhwp::parse_document(&bytes).expect("파싱");
    let para = doc
        .sections
        .iter()
        .flat_map(|s| s.paragraphs.iter())
        .find(|p| p.text.contains(HOST_NEEDLE))
        .expect("호스트 문단");

    assert_eq!(para.line_segs.len(), 2, "글자 줄과 표 줄 두 줄이어야 한다");
    let text_units = para.text.chars().count();
    assert_eq!(text_units, 11, "본문은 11 글자다 (제목 10 + 후행 공백 1)");
    assert_eq!(
        para.char_offsets.len(),
        text_units,
        "char_offsets 는 글자마다 하나다"
    );
    assert_eq!(
        para.line_segs[1].text_start, 11,
        "표 줄은 본문 끝에서 시작한다 — 표가 줄을 통째로 가졌다는 기록"
    );
    assert_eq!(
        *para.char_offsets.last().expect("마지막 글자"),
        10,
        "마지막 글자의 축 위치는 10 — 표 줄 시작 11 과 같은 눈금이다"
    );
    assert_ne!(
        u32::try_from(text_units).unwrap_or(0),
        para.char_count,
        "char_count 는 컨트롤 슬롯을 포함해 본문 길이와 다르다 — 판정 기준으로 쓸 수 없다"
    );
    assert_eq!(para.line_segs[0].baseline_distance, 1020);
    assert_eq!(para.line_segs[1].baseline_distance, 13423);
}
