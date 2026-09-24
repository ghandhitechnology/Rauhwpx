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
