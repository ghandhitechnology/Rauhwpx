//! Hancom parity guard for a single RowBreak cell that contains saved page-local line
//! coordinates and a second-level CellBreak table with repeating header rows.
//!
//! The official Hancom 2024 PDF paired with the corpus HWPX has 48 pages. Losing the saved
//! 71822->0 page reset removes one page; flattening the inner table into anonymous mixed fragments
//! and omitting its repeated two-row header removes another. The separately converted native-HWP
//! fixture has a different saved-line boundary (the reset is already the first unit of its next
//! fragment), so its evidence-backed non-regression count is 47; there is no native-specific
//! Hancom oracle that would justify manufacturing an empty sliver page.

use std::fs;
use std::path::Path;

use rhwp::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType};

const HEADER_TEXT: &str = "가능한 고장배제";
const PDF_POINT_TO_LAYOUT_PX: f64 = 96.0 / 72.0;
// Hancom 2024 PDF, pages 42-45: xMin=179.28, yMin=67.824,
// xMax=265.44, yMax=79.812 points on every page.
const OFFICIAL_HEADER_BBOX_PX: BoundingBox = BoundingBox {
    x: 179.28 * PDF_POINT_TO_LAYOUT_PX,
    y: 67.824 * PDF_POINT_TO_LAYOUT_PX,
    width: (265.44 - 179.28) * PDF_POINT_TO_LAYOUT_PX,
    height: (79.812 - 67.824) * PDF_POINT_TO_LAYOUT_PX,
};
const OFFICIAL_BBOX_EDGE_TOLERANCE_PX: f64 = 6.0;
const REPEATED_BBOX_EDGE_TOLERANCE_PX: f64 = 0.25;

fn load_doc(rel: &str) -> rhwp::wasm_api::HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {rel}: {error}"));
    rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|error| panic!("parse {rel}: {error}"))
}

fn intersect(a: BoundingBox, b: BoundingBox) -> Option<BoundingBox> {
    let left = a.x.max(b.x);
    let top = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    (right > left && bottom > top).then(|| BoundingBox::new(left, top, right - left, bottom - top))
}

/// Collect only header runs that the SVG/canvas replay can actually paint.
///
/// `extract_page_text_native` intentionally walks all text nodes, including content outside a
/// clipped table cell. The giant nested table keeps its original header in that hidden body, so
/// a plain text count cannot distinguish a real repeated header from negative-y clipped content.
fn visible_header_runs(tree: &rhwp::renderer::render_tree::PageRenderTree) -> Vec<BoundingBox> {
    fn walk(node: &RenderNode, inherited_clip: Option<BoundingBox>, out: &mut Vec<BoundingBox>) {
        if !node.visible {
            return;
        }

        let node_clip = match &node.node_type {
            RenderNodeType::Body {
                clip_rect: Some(rect),
            } => Some(*rect),
            RenderNodeType::TableCell(cell) if cell.clip => Some(node.bbox),
            _ => None,
        };
        let active_clip = match (inherited_clip, node_clip) {
            (Some(parent), Some(current)) => {
                let Some(clipped) = intersect(parent, current) else {
                    return;
                };
                Some(clipped)
            }
            (Some(parent), None) => Some(parent),
            (None, Some(current)) => Some(current),
            (None, None) => None,
        };

        if let RenderNodeType::TextRun(run) = &node.node_type {
            let inside_clip = active_clip.is_none_or(|clip| node.bbox.intersects(&clip));
            if inside_clip && run.display_or_text() == HEADER_TEXT {
                out.push(node.bbox);
            }
        }
        for child in &node.children {
            walk(child, active_clip, out);
        }
    }

    let mut runs = Vec::new();
    walk(&tree.root, None, &mut runs);
    runs
}

fn find_table(node: &RenderNode, row_count: u16, col_count: u16) -> Option<&RenderNode> {
    if matches!(
        &node.node_type,
        RenderNodeType::Table(table)
            if table.row_count == row_count && table.col_count == col_count
    ) {
        return Some(node);
    }
    node.children
        .iter()
        .find_map(|child| find_table(child, row_count, col_count))
}

fn assert_bbox_edges_close(
    actual: BoundingBox,
    expected: BoundingBox,
    tolerance: f64,
    context: &str,
) {
    let actual_edges = [
        actual.x,
        actual.y,
        actual.x + actual.width,
        actual.y + actual.height,
    ];
    let expected_edges = [
        expected.x,
        expected.y,
        expected.x + expected.width,
        expected.y + expected.height,
    ];
    for (label, (actual, expected)) in ["left", "top", "right", "bottom"]
        .into_iter()
        .zip(actual_edges.into_iter().zip(expected_edges))
    {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{context}: {label} edge {actual:.3}px differs from {expected:.3}px by more than {tolerance:.3}px",
        );
    }
}

#[test]
fn giant_cell_overfill_matches_hancom_48_page_pagination() {
    let source = "samples/table_giant_cell_overfill.hwpx";
    let doc = load_doc(source);
    assert_eq!(
        doc.page_count(),
        48,
        "{source}: saved page reset and nested repeating-header costs must both survive"
    );
}

#[test]
fn giant_cell_overfill_keeps_saved_bands_on_their_hancom_pages() {
    let doc = load_doc("samples/table_giant_cell_overfill.hwpx");
    let expected = [
        (5, 125, 161),
        (6, 161, 195),
        (7, 195, 230),
        (36, 1092, 1110),
        (37, 1110, 1149),
        (38, 1149, 1184),
        (39, 1184, 1207),
        (40, 1207, 1264),
    ];

    for (page, start, end) in expected {
        let dump = doc.dump_page_items(Some(page));
        let cut = format!("start_cut=[{start}] end_cut=[{end}]");
        assert!(
            dump.contains(&cut),
            "human page {} must keep {cut}; dump:\n{dump}",
            page + 1,
        );
    }
}

#[test]
fn giant_cell_page_40_renders_only_the_terminal_note_row() {
    let doc = load_doc("samples/table_giant_cell_overfill.hwpx");
    let tree = doc
        .build_page_render_tree(39)
        .expect("render human page 40");
    let nested = find_table(&tree.root, 70, 5).expect("70x5 verification table on page 40");
    let rows = nested
        .children
        .iter()
        .filter_map(|node| match &node.node_type {
            RenderNodeType::TableCell(cell) => Some(cell.row),
            _ => None,
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        rows,
        std::collections::BTreeSet::from([69]),
        "page 40 must render the terminal note row instead of repainting rows 0..39",
    );
    assert!(
        nested.bbox.height > 100.0 && nested.bbox.height < 200.0,
        "terminal note box must retain its authored one-row geometry: {:?}",
        nested.bbox,
    );
}

#[test]
fn giant_cell_native_conversion_preserves_its_saved_reset_boundary() {
    let source = "samples/task1718/table_giant_cell_overfill.hwp";
    let doc = load_doc(source);
    assert_eq!(
        doc.page_count(),
        47,
        "{source}: native saved-line reset lands directly on the next fragment boundary"
    );
}

#[test]
fn giant_cell_inner_table_header_repeats_only_inside_its_atom() {
    let doc = load_doc("samples/table_giant_cell_overfill.hwpx");
    let visible = (40..=45)
        .map(|page| {
            let tree = doc
                .build_page_render_tree(page)
                .unwrap_or_else(|error| panic!("render page {}: {error}", page + 1));
            visible_header_runs(&tree)
        })
        .collect::<Vec<_>>();
    let counts = visible.iter().map(Vec::len).collect::<Vec<_>>();
    assert_eq!(
        counts,
        [0usize, 1, 1, 1, 1, 0],
        "pages 41-46 must visibly paint wrapper / four inner-table headers / wrapper"
    );

    let original = visible[1][0];
    assert_bbox_edges_close(
        original,
        OFFICIAL_HEADER_BBOX_PX,
        OFFICIAL_BBOX_EDGE_TOLERANCE_PX,
        "page 42 original header vs Hancom 2024 PDF",
    );
    for (page_index, page_runs) in visible.iter().enumerate().take(5).skip(2) {
        assert_bbox_edges_close(
            page_runs[0],
            original,
            REPEATED_BBOX_EDGE_TOLERANCE_PX,
            &format!(
                "page {} repeated header vs page 42 original",
                page_index + 41
            ),
        );
    }
}
