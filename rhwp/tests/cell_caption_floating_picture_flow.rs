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

fn caption_stack_geometry(core: &DocumentCore) -> (BoundingBox, BoundingBox, BoundingBox) {
    let tree = core.build_page_render_tree(0).expect("render page 1");
    let cell = find_caption_cell(&tree.root).expect("caption table cell");
    let image = find_target_image(cell).expect("caption-cell picture");
    let caption = find_caption_bbox(cell).expect("caption text run");
    (cell.bbox.clone(), caption, image.bbox.clone())
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

#[test]
fn shared_positive_vpos_origin_does_not_create_uneditable_top_spacing() {
    let bytes = std::fs::read(SAMPLE).unwrap_or_else(|e| panic!("read {SAMPLE}: {e}"));
    let mut core =
        DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {SAMPLE}: {e}"));
    let baseline = caption_stack_geometry(&core);

    // A producer may translate every saved line coordinate in this cell by a
    // common positive origin.  That translation is layout metadata: it must
    // not become an additional top margin that users cannot remove.
    const STALE_ORIGIN: i32 = 2_400;
    let mut shifted_document = core.document().clone();
    let table = match &mut shifted_document.sections[0].paragraphs[0].controls[2] {
        Control::Table(table) => table,
        other => panic!("target control is not a table: {other:?}"),
    };
    let cell = &mut table.cells[2];
    for para in &mut cell.paragraphs {
        for seg in &mut para.line_segs {
            seg.vertical_pos += STALE_ORIGIN;
        }
    }
    assert_eq!(cell.paragraphs[0].line_segs[0].vertical_pos, STALE_ORIGIN);
    core.set_document(shifted_document);

    let shifted = caption_stack_geometry(&core);
    assert!(
        (shifted.1.y - baseline.1.y).abs() <= 0.5,
        "shared saved origin must not push caption text down: baseline={:?}, shifted={:?}",
        baseline.1,
        shifted.1,
    );
    assert!(
        (shifted.2.y - baseline.2.y).abs() <= 0.5,
        "normalizing the stack origin must preserve picture placement relative to the caption: baseline={:?}, shifted={:?}",
        baseline.2,
        shifted.2,
    );
    assert!(
        (shifted.0.height - baseline.0.height).abs() <= 0.5,
        "saved coordinate translation must not grow the table cell: baseline={:?}, shifted={:?}",
        baseline.0,
        shifted.0,
    );
}
