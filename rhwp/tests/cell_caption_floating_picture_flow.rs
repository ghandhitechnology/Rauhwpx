//! Table-cell captions followed by a paragraph-anchored picture must keep the
//! saved paragraph offset.  Treating the picture as the cell's only content
//! independently applies cell vertical alignment and moves it through the
//! caption.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::renderer::hwpunit_to_px;
use rhwp::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType};

const SAMPLE: &str = "samples/issues/2809/jubo_20260104.hwp";
const DPI: f64 = 96.0;

fn find_caption_cell(node: &RenderNode) -> Option<&RenderNode> {
    if matches!(&node.node_type, RenderNodeType::TableCell(cell) if cell.row == 2 && cell.col == 0)
        && node
            .children
            .iter()
            .any(|child| contains_text(child, "예배와 친교"))
    {
        return Some(node);
    }
    node.children.iter().find_map(find_caption_cell)
}

fn contains_text(node: &RenderNode, probe: &str) -> bool {
    matches!(&node.node_type, RenderNodeType::TextRun(run) if run.text.contains(probe))
        || node
            .children
            .iter()
            .any(|child| contains_text(child, probe))
}

fn find_target_image(node: &RenderNode) -> Option<&RenderNode> {
    if matches!(&node.node_type, RenderNodeType::Image(image) if image.bin_data_id == 5) {
        return Some(node);
    }
    node.children.iter().find_map(find_target_image)
}

fn find_caption_bbox(node: &RenderNode) -> Option<BoundingBox> {
    if matches!(&node.node_type, RenderNodeType::TextRun(run) if run.text.contains("예배와 친교"))
    {
        return Some(node.bbox.clone());
    }
    node.children.iter().find_map(find_caption_bbox)
}

#[test]
fn preceding_caption_keeps_saved_picture_paragraph_offset() {
    let bytes = std::fs::read(SAMPLE).unwrap_or_else(|e| panic!("read {SAMPLE}: {e}"));
    let core = DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {SAMPLE}: {e}"));

    let table = match &core.document().sections[0].paragraphs[0].controls[2] {
        Control::Table(table) => table,
        other => panic!("target control is not a table: {other:?}"),
    };
    let cell = &table.cells[2];
    let picture_para = &cell.paragraphs[1];
    let picture = match &picture_para.controls[0] {
        Control::Picture(picture) => picture,
        other => panic!("target control is not a picture: {other:?}"),
    };
    let saved_para_offset = picture_para.line_segs[0].vertical_pos;
    assert!(
        saved_para_offset > 0,
        "fixture needs a caption-to-picture offset"
    );
    assert!(
        cell.paragraphs[0].text.contains("예배와 친교"),
        "fixture needs visible text before the picture paragraph"
    );

    let tree = core.build_page_render_tree(0).expect("render page 1");
    let rendered_cell = find_caption_cell(&tree.root).expect("caption table cell");
    let image = find_target_image(rendered_cell).expect("caption-cell picture");
    let caption = find_caption_bbox(rendered_cell).expect("caption text run");

    let expected_top = rendered_cell.bbox.y
        + hwpunit_to_px(cell.padding.top as i32, DPI)
        + hwpunit_to_px(saved_para_offset, DPI)
        + hwpunit_to_px(picture.common.vertical_offset as i32, DPI);
    assert!(
        (image.bbox.y - expected_top).abs() <= 1.0,
        "picture must retain its saved paragraph offset below the caption: actual={:.1}, expected={expected_top:.1}",
        image.bbox.y,
    );
    assert!(
        caption.y + caption.height <= image.bbox.y + 0.5,
        "caption and picture must not overlap: caption={caption:?}, picture={:?}",
        image.bbox,
    );
}
