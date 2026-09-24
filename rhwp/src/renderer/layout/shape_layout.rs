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

/// 글상자에 공백이 아닌 실제 텍스트가 한 글자라도 있는지.
fn textbox_has_visible_text(text_box: &TextBox) -> bool {
    text_box
        .paragraphs
        .iter()
        .any(|para| para.text.chars().any(|ch| !ch.is_whitespace()))
}

fn textbox_contains_non_tac_picture(text_box: &TextBox) -> bool {
    text_box.paragraphs.iter().any(|para| {
        para.controls
            .iter()
            .any(|control| matches!(control, Control::Picture(pic) if !pic.common.treat_as_char))
    })
}

pub(super) fn shape_caption_for_layout(shape: &ShapeObject) -> Option<Caption> {
    match shape {
        ShapeObject::Line(s) => s.drawing.caption.clone(),
        ShapeObject::Rectangle(s) => s.drawing.caption.clone(),
        ShapeObject::Ellipse(s) => s.drawing.caption.clone(),
        ShapeObject::Arc(s) => s.drawing.caption.clone(),
        ShapeObject::Polygon(s) => s.drawing.caption.clone(),
        ShapeObject::Curve(s) => s.drawing.caption.clone(),
        ShapeObject::Group(s) => s.caption.clone(),
        ShapeObject::Picture(s) => s.caption.clone(),
        ShapeObject::Chart(s) => s.caption.clone().or_else(|| s.drawing.caption.clone()),
        ShapeObject::Ole(s) => s.caption.clone().or_else(|| s.drawing.caption.clone()),
    }
}

fn caption_height_hu(caption: &Caption) -> i32 {
    if caption.paragraphs.is_empty() {
        return 0;
    }

    let mut line_seg_height = 0i32;
    let mut composed_height = 0i32;
    for para in &caption.paragraphs {
        if let (Some(first), Some(last)) = (para.line_segs.first(), para.line_segs.last()) {
            let para_top = first.vertical_pos.min(0);
            let para_bottom = last.vertical_pos.saturating_add(last.line_height);
            line_seg_height = line_seg_height.max(para_bottom.saturating_sub(para_top));
        }

        let composed = compose_paragraph(para);
        if composed.lines.is_empty() {
            composed_height = composed_height.saturating_add(400);
        } else {
            for (line_index, line) in composed.lines.iter().enumerate() {
                composed_height = composed_height.saturating_add(line.line_height);
                if line_index + 1 < composed.lines.len() {
                    composed_height = composed_height.saturating_add(line.line_spacing);
                }
            }
        }
    }

    line_seg_height.max(composed_height).max(0)
}

pub(super) fn shape_vertical_visual_extent_hu(shape: &ShapeObject, shape_height_hu: i32) -> i32 {
    let shape_height_hu = shape_height_hu.max(0);
    let Some(caption) = shape_caption_for_layout(shape) else {
        return shape_height_hu;
    };
    let caption_height_hu = caption_height_hu(&caption);
    if caption_height_hu == 0 {
        return shape_height_hu;
    }

    match caption.direction {
        CaptionDirection::Top | CaptionDirection::Bottom => shape_height_hu
            .saturating_add(caption_height_hu)
            .saturating_add(caption.spacing as i32),
        CaptionDirection::Left | CaptionDirection::Right => shape_height_hu.max(caption_height_hu),
    }
}

fn textbox_vpos_origin_hu(common: &CommonObjAttr, matrix_positioned: bool) -> Option<i32> {
    if matrix_positioned || common.treat_as_char {
        return None;
    }
    if !matches!(common.vert_rel_to, VertRelTo::Paper | VertRelTo::Page)
        || !matches!(common.vert_align, VertAlign::Top | VertAlign::Inside)
    {
        return None;
    }

    let origin = crate::renderer::float_placement::signed_hwpunit(common.vertical_offset);
    (origin > 0).then_some(origin)
}

fn normalize_textbox_vpos_hu(vertical_pos: i32, origin_hu: Option<i32>) -> i32 {
    match origin_hu {
        Some(origin) if origin > 0 && vertical_pos >= origin => vertical_pos - origin,
        _ => vertical_pos,
    }
}

fn textbox_vpos_px(vertical_pos: i32, origin_hu: Option<i32>, dpi: f64) -> f64 {
    hwpunit_to_px(normalize_textbox_vpos_hu(vertical_pos, origin_hu), dpi)
}

/// 글상자 인라인 개체 줄바꿈 판정 허용 오차(px).
/// 폭 추정 오차로 딱 맞는 개체가 불필요하게 다음 행으로 접히는 것을 막는다.
const TEXTBOX_INLINE_WRAP_EPS_PX: f64 = 0.5;

/// 평탄화된 HWPX 그룹(matrix group) 자식의 "글상자 보조선"(검정 얇은 SOLID 테두리)은
/// 한컴 실물에서 인쇄되지 않는다(편람 장 표지 "행정업무 운영 개요" 제목/목록 글상자).
/// 오탐 방지를 위해 매우 좁게 한정: 그룹 자식(group_level>0) + 회전/전단 없음 + 검정
/// (color==0) 얇은(0<width<=40 HWPUNIT) SOLID(line_type==1) 테두리 + 캡션 없음 +
/// (a) 채우기 없는 텍스트 전용 글상자 또는 (b) 흰색 단색 마스크 박스.
fn should_suppress_group_child_construction_stroke(drawing: &DrawingObjAttr) -> bool {
    if drawing.caption.is_some() {
        return false;
    }
    let sa = &drawing.shape_attr;
    let has_rotation_or_shear = sa.render_b.abs() > 1e-6 || sa.render_c.abs() > 1e-6;
    if sa.group_level == 0 || has_rotation_or_shear {
        return false;
    }
    let line = &drawing.border_line;
    let line_type = line.attr & 0x3f;
    if line_type != 1 || line.color != 0 || line.width <= 0 || line.width > 40 {
        return false;
    }
    let text_only_box = drawing
        .text_box
        .as_ref()
        .is_some_and(textbox_has_visible_text)
        && drawing.fill.fill_type == FillType::None
        && drawing.fill.gradient.is_none()
        && drawing.fill.image.is_none();
    if text_only_box {
        return true;
    }
    drawing.text_box.is_none()
        && drawing.fill.fill_type == FillType::Solid
        && drawing.fill.gradient.is_none()
        && drawing.fill.image.is_none()
        && drawing
            .fill
            .solid
            .is_some_and(|solid| solid.background_color == 0x00ff_ffff && solid.pattern_type <= 0)
}
