//! 도형/글상자/그룹 개체 레이아웃

use super::super::composer::{compose_paragraph, reflow_line_segs, ComposedParagraph};
use super::super::float_placement::{float_exclusion, horizontal_range, FloatPlacementContext};
use super::super::page_layout::LayoutRect;
use super::super::pagination::PageItem;
use super::super::render_tree::*;
use super::super::style_resolver::ResolvedStyleSet;
use super::super::{hwpunit_to_px, px_to_hwpunit, PathCommand, ShapeStyle, TextStyle};
use super::text_measurement::{
    estimate_text_width, is_cjk_char, is_vertical_rotate_char, resolved_to_text_style,
    vertical_substitute_char,
};
use super::utils::{
    drawing_to_line_style, drawing_to_shape_style, extract_shape_transform, find_bin_data,
};
use super::LayoutEngine;
use super::{CellContext, CellPathEntry};
use crate::model::bin_data::BinDataContent;
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;
use crate::model::shape::{
    Caption, CaptionDirection, CommonObjAttr, DrawingObjAttr, ShapeObject, TextBox,
};
use crate::model::shape::{HorzAlign, HorzRelTo, VertAlign, VertRelTo};
use crate::model::style::{Alignment, FillType};

fn rectangle_corner_radius_px(round_rate: u8, width: f64, height: f64) -> f64 {
    let short_side = width.min(height).max(0.0);
    (short_side * f64::from(round_rate) / 100.0).min(short_side / 2.0)
}

fn stored_lines_clear_fixed_picture(
    paragraphs: &[Paragraph],
    items: &[PageItem],
    anchor_index: usize,
    column_y: f64,
    picture_top: f64,
    picture_bottom: f64,
    dpi: f64,
) -> bool {
    use crate::model::paragraph::LineSeg;
    let Some(PageItem::FullParagraph { para_index: first }) = items.first() else {
        return false;
    };
    let Some(base) = paragraphs.get(*first).and_then(|p| p.line_segs.first()) else {
        return false;
    };
    if base.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0 {
        return false;
    }
    let mut saw_above = false;
    for item in items {
        let PageItem::FullParagraph { para_index } = item else {
            continue;
        };
        if *para_index < anchor_index {
            continue;
        }
        let Some(para) = paragraphs.get(*para_index) else {
            return false;
        };
        if para.line_segs.is_empty() {
            return false;
        }
        for seg in &para.line_segs {
            if seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0
                || seg.vertical_pos < base.vertical_pos
                || seg.line_height <= 0
            {
                return false;
            }
            let top = column_y + hwpunit_to_px(seg.vertical_pos - base.vertical_pos, dpi);
            let bottom = top + hwpunit_to_px(seg.line_height, dpi);
            if bottom <= picture_top + 0.5 {
                saw_above = true;
            } else if top >= picture_bottom - 0.5 {
                return saw_above && *para_index > anchor_index;
            } else {
                return false;
            }
        }
    }
    false
}
