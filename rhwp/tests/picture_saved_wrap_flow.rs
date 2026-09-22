//! 한컴 저장 그림 어울림의 빈 구간과 위아래 배제 공간을 한 번만 소비한다.
use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

fn collect_lines<'a>(node: &'a RenderNode, para: usize, out: &mut Vec<&'a RenderNode>) {
    if matches!(&node.node_type, RenderNodeType::TextLine(line) if line.para_index == Some(para)) {
        out.push(node);
    }
    for child in &node.children {
        collect_lines(child, para, out);
    }
}

fn load() -> DocumentCore {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/samples/pic2.hwp")).unwrap();
    DocumentCore::from_bytes(&bytes).unwrap()
}

#[test]
fn square_picture_empty_segments_preserve_four_title_lines() {
    let core = load();
    let tree = core.build_page_render_tree(0).unwrap();
    let mut lines = Vec::new();
    collect_lines(&tree.root, 0, &mut lines);
    let visible: Vec<_> = lines
        .into_iter()
        .filter(|line| {
            line.children.iter().any(|child| {
        matches!(&child.node_type, RenderNodeType::TextRun(run) if !run.text.trim().is_empty())
    })
        })
        .collect();
    assert_eq!(
        visible.len(),
        4,
        "그림 사이의 빈 구간 때문에 제목이 재조판되면 안 됨"
    );
    for (i, line) in visible.iter().enumerate() {
        assert!(
            (line.bbox.x - (8504.0 + 39123.0) / 75.0).abs() < 1.0,
            "title x={}",
            line.bbox.x
        );
        assert!(
            (line.bbox.y - (9920.0 + 4480.0 * i as f64) / 75.0).abs() < 1.0,
            "title y={}",
            line.bbox.y
        );
    }
    let mut body = Vec::new();
    collect_lines(&tree.root, 7, &mut body);
    assert!((body[0].bbox.y - (9920.0 + 30400.0) / 75.0).abs() < 1.0);
}

#[test]
fn paper_picture_stored_gap_is_not_reserved_twice() {
    let core = load();
    let tree = core.build_page_render_tree(1).unwrap();
    let mut before = Vec::new();
    collect_lines(&tree.root, 19, &mut before);
    let mut after = Vec::new();
    collect_lines(&tree.root, 22, &mut after);
    assert!(!before.is_empty() && !after.is_empty());
    let expected_delta = 28551.0 / 75.0;
    let delta = after[0].bbox.y - before[0].bbox.y;
    assert!(
        (delta - expected_delta).abs() < 1.0,
        "그림 아래 문단 간격: {delta}, 저장 간격: {expected_delta}"
    );
}

#[test]
fn square_picture_wrap_begins_after_full_width_host_paragraph() {
    let core = load();
    let tree = core.build_page_render_tree(0).unwrap();
    for para in [9, 11] {
        let mut lines = Vec::new();
        collect_lines(&tree.root, para, &mut lines);
        assert!(!lines.is_empty());
        for line in lines {
            assert!(
                (line.bbox.width - 26140.0 / 75.0).abs() < 1.0,
                "그림 옆 문단 {para}의 저장 폭 누락: {}",
                line.bbox.width
            );
        }
    }
}
