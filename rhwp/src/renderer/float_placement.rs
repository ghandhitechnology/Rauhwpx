//! Flow reservation helpers for non-inline floating objects.

use crate::model::control::Control;
use crate::model::paragraph::{LineSeg, Paragraph};
use crate::model::shape::{
    CommonObjAttr, HorzAlign, HorzRelTo, TextFlow, TextWrap, VertAlign, VertRelTo,
};
use crate::model::table::{Table, TablePageBreak};
use crate::model::HwpUnit;

use super::hwpunit_to_px;
use super::page_layout::LayoutRect;

/// Interpret an HWPUNIT value that may have been stored through a signed field.
pub(crate) fn signed_hwpunit(value: HwpUnit) -> i32 {
    value as i32
}

/// A non-TAC `TopAndBottom` object positioned from its host paragraph.
pub(crate) fn is_para_topbottom_float(common: &CommonObjAttr) -> bool {
    !common.treat_as_char
        && matches!(common.text_wrap, TextWrap::TopAndBottom)
        && matches!(common.vert_rel_to, VertRelTo::Para)
}

/// First-fragment top inset for a paragraph-relative wrap-around RowBreak table.
///
/// Hancom positions the visible table box after the object's positive paragraph offset and its
/// outer top margin. Full-table placement has other float paths, but split tables bypass them and
/// need this value in both pagination and paint layout so their page cut stays in sync.
pub(crate) fn para_square_rowbreak_first_fragment_top_offset_px(table: &Table, dpi: f64) -> f64 {
    let vertical_offset = signed_hwpunit(table.common.vertical_offset);
    if table.common.treat_as_char
        || !matches!(table.page_break, TablePageBreak::RowBreak)
        || !matches!(table.common.text_wrap, TextWrap::Square)
        || !matches!(table.common.vert_rel_to, VertRelTo::Para)
        || !matches!(table.common.vert_align, VertAlign::Top | VertAlign::Inside)
        || vertical_offset <= 0
    {
        return 0.0;
    }

    hwpunit_to_px(
        vertical_offset.saturating_add(i32::from(table.outer_margin_top)),
        dpi,
    )
    .max(0.0)
}

/// Stored host-line evidence for the narrow native-HWP RowBreak flow contract (#2439).
///
/// The returned value is the non-synthetic stored line advance in HWPUNIT.  Callers may combine
/// it with the positive object offset for pagination, or with the painted lane bottom and outer
/// bottom for layout.  Keeping the structural predicate here prevents typeset/full/partial layout
/// from drifting apart.  A broad empty-host outer-margin rule is disproven by #2097.
pub(crate) fn native_empty_host_rowbreak_line_advance_hu(
    native_hwp5_layout: bool,
    para: &Paragraph,
    table: &Table,
    next_para: Option<&Paragraph>,
) -> Option<i32> {
    let has_non_whitespace_text = |paragraph: &Paragraph| {
        paragraph
            .text
            .chars()
            .any(|ch| ch > '\u{001F}' && ch != '\u{FFFC}' && !ch.is_whitespace())
    };
    if !native_hwp5_layout
        || table.common.treat_as_char
        || !is_para_topbottom_float(&table.common)
        || has_non_whitespace_text(para)
        || !matches!(table.common.vert_rel_to, VertRelTo::Para)
        || !matches!(table.page_break, TablePageBreak::RowBreak)
        || signed_hwpunit(table.common.vertical_offset) <= 0
        || para
            .controls
            .iter()
            .filter(|control| matches!(control, Control::Table(_)))
            .count()
            != 1
        || para
            .controls
            .iter()
            .filter(|control| {
                matches!(control, Control::Table(candidate)
                    if is_para_topbottom_float(&candidate.common))
            })
            .count()
            != 1
        || !next_para.is_some_and(|next| has_non_whitespace_text(next) && next.controls.is_empty())
    {
        return None;
    }

    let host_seg = para
        .line_segs
        .iter()
        .find(|seg| seg.tag & 0x80000000 == 0 && seg.line_height > 0)?;
    let advance = host_seg.line_height + host_seg.line_spacing.max(0);
    if advance <= 0 {
        return None;
    }
    // [#2808] 저장 vpos ladder 로 한컴이 host 줄 advance 를 실제 흐름에 계상했는지
    // 검증한다. #2439 재현 문서(기계 반복 양식)는 ladder 가 표 높이를 접고
    // `next.vpos - host.vpos == advance` 로 저장되는 반면(= advance 가 실 흐름 증거),
    // 일반 물리 ladder 문서는 델타가 표 높이+offset 을 이미 포함하므로 advance 를
    // 다시 더하면 이중 계상되어 쪽 경계 한 줄이 +1 로 밀린다 (10k r19 회귀 4건).
    let next_vpos = next_para
        .and_then(|next| {
            next.line_segs
                .iter()
                .find(|seg| seg.tag & 0x80000000 == 0 && seg.line_height > 0)
        })
        .map(|seg| seg.vertical_pos)?;
    if (next_vpos - host_seg.vertical_pos - advance).abs() > 1 {
        return None;
    }
    Some(advance)
}

/// Stored page-reset evidence for the native-HWP single-cell RowBreak blank-band contract.
///
/// Some Hancom documents serialize a one-row table with a cell taller than the table object's
/// declared height. When the following paragraph restarts at exactly
/// `cell_height - object_height + outer_top + outer_bottom`, Hancom paints the declared-height
/// portion at the bottom of the current page and preserves the residual as an empty continuation
/// band on the next page. This deliberately strict predicate keeps that compatibility behavior
/// away from ordinary RowBreak tables and from the global row-splitting tolerances.
pub(crate) fn native_single_cell_rowbreak_saved_residual_split_hu(
    native_hwp5_layout: bool,
    para: &Paragraph,
    table: &Table,
    next_para: Option<&Paragraph>,
) -> Option<(i32, i32)> {
    let has_non_whitespace_text = |paragraph: &Paragraph| {
        paragraph
            .text
            .chars()
            .any(|ch| ch > '\u{001F}' && ch != '\u{FFFC}' && !ch.is_whitespace())
    };
    fn only_real_line(paragraph: &Paragraph) -> Option<&LineSeg> {
        let mut lines = paragraph
            .line_segs
            .iter()
            .filter(|seg| seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0);
        let line = lines.next()?;
        lines.next().is_none().then_some(line)
    }
    fn first_real_line(paragraph: &Paragraph) -> Option<&LineSeg> {
        paragraph
            .line_segs
            .iter()
            .find(|seg| seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0)
    }

    if !native_hwp5_layout
        || para.controls.len() != 1
        || !matches!(para.controls.first(), Some(Control::Table(_)))
        || has_non_whitespace_text(para)
        || table.common.treat_as_char
        || !is_para_topbottom_float(&table.common)
        || !matches!(table.common.vert_align, VertAlign::Top)
        || signed_hwpunit(table.common.vertical_offset) != 0
        || !matches!(table.page_break, TablePageBreak::RowBreak)
        || table.row_count != 1
        || table.col_count != 1
        || table.cells.len() != 1
        || table.outer_margin_top <= 0
        || table.outer_margin_bottom <= 0
    {
        return None;
    }

    let cell = &table.cells[0];
    if cell.row != 0
        || cell.col != 0
        || cell.row_span != 1
        || cell.col_span != 1
        || !matches!(
            cell.vertical_align,
            crate::model::table::VerticalAlign::Center
        )
        || cell.paragraphs.len() != 1
        || !cell.paragraphs[0].controls.is_empty()
        || !has_non_whitespace_text(&cell.paragraphs[0])
        || only_real_line(&cell.paragraphs[0]).is_none()
    {
        return None;
    }

    let object_height = signed_hwpunit(table.common.height);
    let cell_height = signed_hwpunit(cell.height);
    let residual = cell_height.checked_sub(object_height)?;
    if object_height <= 0 || residual <= 0 {
        return None;
    }

    let host_vpos = only_real_line(para)?.vertical_pos;
    let next = next_para?;
    if !next.controls.is_empty() || !has_non_whitespace_text(next) {
        return None;
    }
    let next_vpos = first_real_line(next)?.vertical_pos;
    let saved_advance = residual
        .saturating_add(i32::from(table.outer_margin_top))
        .saturating_add(i32::from(table.outer_margin_bottom));
    if next_vpos <= 0 || host_vpos <= next_vpos || (next_vpos - saved_advance).abs() > 1 {
        return None;
    }

    Some((object_height, residual))
}

/// Per-fragment flow inset for a native-HWP CellBreak table whose leading body style carries a
/// stable stored trailing line gap.
///
/// Hancom repeats the visible outer-top inset on every continuation and keeps the stored cell
/// line gap clear at the fragment bottom.  The latter is a fragment boundary gap, not part of
/// every row: adding it to each cell line would inflate large tables catastrophically.  Require a
/// stable positive witness across the first body rows so ordinary/mixed CellBreak tables retain
/// their existing layout. Later rows may legitimately switch paragraph styles; Hancom keeps the
/// fragment boundary contract established by the leading body band. The returned pair is
/// `(top, trailing)` and its sum is the larger of the stored line gap and the two visible outer
/// margins.
pub(crate) fn native_uniform_cellbreak_fragment_spacing_hu(
    native_hwp5_layout: bool,
    para: &Paragraph,
    table: &Table,
) -> Option<(i32, i32)> {
    let has_non_whitespace_text = para
        .text
        .chars()
        .any(|ch| ch > '\u{001F}' && ch != '\u{FFFC}' && !ch.is_whitespace());
    if !native_hwp5_layout
        || has_non_whitespace_text
        || table.common.treat_as_char
        || !is_para_topbottom_float(&table.common)
        || !matches!(table.common.vert_align, VertAlign::Top | VertAlign::Inside)
        || !matches!(table.page_break, TablePageBreak::CellBreak)
        || !table.repeat_header
        || signed_hwpunit(table.common.vertical_offset) <= 0
        || table.outer_margin_top <= 0
        || table.outer_margin_bottom < 0
        || para.controls.len() != 1
        || !matches!(para.controls.first(), Some(Control::Table(_)))
    {
        return None;
    }

    let header_rows = table.leading_header_rows();
    let first_body_row = header_rows.len();
    let row_count = table.row_count as usize;
    if first_body_row == 0 || first_body_row >= row_count {
        return None;
    }

    const LEADING_BODY_GAP_WITNESS_ROWS: usize = 8;
    let witness_end = (first_body_row + LEADING_BODY_GAP_WITNESS_ROWS).min(row_count);
    let mut row_gaps = vec![0i32; witness_end - first_body_row];
    for cell in &table.cells {
        let row = cell.row as usize;
        if row < first_body_row || row >= witness_end || cell.row_span != 1 {
            continue;
        }
        let gap = cell
            .paragraphs
            .last()
            .and_then(|paragraph| {
                paragraph.line_segs.iter().rev().find(|seg| {
                    seg.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0
                })
            })
            .map(|seg| seg.line_spacing)
            .unwrap_or(0);
        if gap > 0 {
            row_gaps[row - first_body_row] = row_gaps[row - first_body_row].max(gap);
        }
    }

    let stored_gap = *row_gaps.first()?;
    if stored_gap <= 0 || row_gaps.iter().any(|gap| *gap != stored_gap) {
        return None;
    }

    let outer_top = i32::from(table.outer_margin_top);
    let outer_bottom = i32::from(table.outer_margin_bottom).max(0);
    let total = stored_gap.max(outer_top.saturating_add(outer_bottom));
    Some((outer_top, total.saturating_sub(outer_top)))
}

/// [Task #1658 v3] 페이지 하단 고정(vert=쪽·valign=Bottom) 자리차지 개체 (결재/서명 틀).
/// 한글은 이를 본문 하단에 절대배치(겹침 허용)하고 본문 텍스트를 그 위까지만 흐르게
/// 한다(하단 배타 영역) — 문서순 flow 소비 대상이 아니다. #1653 RCA 패턴 B.
pub(crate) fn is_page_bottom_fixed_float(common: &CommonObjAttr) -> bool {
    !common.treat_as_char
        && matches!(common.text_wrap, TextWrap::TopAndBottom)
        && matches!(common.vert_rel_to, VertRelTo::Page)
        && matches!(common.vert_align, VertAlign::Bottom)
}

/// Horizontal reference data used by float placement and table layout.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FloatPlacementContext {
    pub col_area: LayoutRect,
    pub body_area: Option<LayoutRect>,
    pub paper_width: Option<f64>,
    pub host_margin_left: f64,
    pub host_margin_right: f64,
}

impl FloatPlacementContext {
    pub(crate) fn new(col_area: LayoutRect) -> Self {
        Self {
            col_area,
            body_area: None,
            paper_width: None,
            host_margin_left: 0.0,
            host_margin_right: 0.0,
        }
    }

    pub(crate) fn with_body_area(mut self, body_area: LayoutRect) -> Self {
        self.body_area = Some(body_area);
        self
    }

    pub(crate) fn with_paper_width(mut self, paper_width: f64) -> Self {
        self.paper_width = Some(paper_width);
        self
    }

    pub(crate) fn with_host_margins(mut self, left: f64, right: f64) -> Self {
        self.host_margin_left = left;
        self.host_margin_right = right;
        self
    }
}

/// Complete reference boxes used to position a floating object.
///
/// `paragraph` is the paragraph's usable horizontal box. `line_y` is the current
/// anchor-line top; HWP's paragraph-relative vertical coordinate moves with this
/// value when the paragraph is repaginated or moved to another column.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ObjectPlacementContext {
    pub paper: LayoutRect,
    pub page: LayoutRect,
    pub column: LayoutRect,
    pub paragraph: LayoutRect,
    pub line_y: f64,
}

/// Resolve a non-inline object's visual frame from the common object attributes.
/// Offsets are deliberately interpreted as signed HWPUNIT values.
pub(crate) fn object_frame(
    common: &CommonObjAttr,
    width: f64,
    height: f64,
    ctx: ObjectPlacementContext,
    dpi: f64,
) -> LayoutRect {
    let h_offset = hwpunit_to_px(signed_hwpunit(common.horizontal_offset), dpi);
    let v_offset = hwpunit_to_px(signed_hwpunit(common.vertical_offset), dpi);
    let (ref_x, ref_w) = match common.horz_rel_to {
        HorzRelTo::Paper => (ctx.paper.x, ctx.paper.width),
        HorzRelTo::Page => (ctx.page.x, ctx.page.width),
        HorzRelTo::Column => (ctx.column.x, ctx.column.width),
        HorzRelTo::Para => (ctx.paragraph.x, ctx.paragraph.width),
    };
    let x = match common.horz_align {
        HorzAlign::Left | HorzAlign::Inside => ref_x + h_offset,
        HorzAlign::Center => ref_x + (ref_w - width) / 2.0 + h_offset,
        HorzAlign::Right | HorzAlign::Outside => ref_x + ref_w - width - h_offset,
    };

    let (ref_y, ref_h) = match common.vert_rel_to {
        VertRelTo::Paper => (ctx.paper.y, ctx.paper.height),
        VertRelTo::Page => (ctx.page.y, ctx.page.height),
        // Paragraph-relative placement is anchored to the current line, while the
        // remaining paragraph/column extent supplies center and bottom alignment.
        VertRelTo::Para => (
            ctx.line_y,
            (ctx.paragraph.y + ctx.paragraph.height - ctx.line_y).max(0.0),
        ),
    };
    let y = match common.vert_align {
        VertAlign::Top | VertAlign::Inside => ref_y + v_offset,
        VertAlign::Center => ref_y + (ref_h - height) / 2.0 + v_offset,
        VertAlign::Bottom | VertAlign::Outside => ref_y + ref_h - height - v_offset,
    };

    LayoutRect {
        x,
        y,
        width: width.max(0.0),
        height: height.max(0.0),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum WrapGeometry {
    /// Rectangular contour fallback. Tight/Through use this until native contours
    /// are available in the IR.
    Side(TextFlow),
    TopAndBottom,
}

/// Text-exclusion rectangle, kept separate from paint order. Callers may sort
/// render nodes by z-order without changing this geometry.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FloatExclusion {
    pub rect: LayoutRect,
    pub geometry: WrapGeometry,
}

pub(crate) fn float_exclusion(
    common: &CommonObjAttr,
    frame: LayoutRect,
    dpi: f64,
) -> Option<FloatExclusion> {
    if common.treat_as_char {
        return None;
    }
    let geometry = match common.text_wrap {
        TextWrap::Square | TextWrap::Tight | TextWrap::Through => {
            WrapGeometry::Side(common.text_flow)
        }
        TextWrap::TopAndBottom => WrapGeometry::TopAndBottom,
        TextWrap::BehindText | TextWrap::InFrontOfText => return None,
    };
    let left = hwpunit_to_px(common.margin.left as i32, dpi);
    let right = hwpunit_to_px(common.margin.right as i32, dpi);
    let top = hwpunit_to_px(common.margin.top as i32, dpi);
    let bottom = hwpunit_to_px(common.margin.bottom as i32, dpi);
    Some(FloatExclusion {
        rect: LayoutRect {
            x: frame.x - left,
            y: frame.y - top,
            width: frame.width + left + right,
            height: frame.height + top + bottom,
        },
        geometry,
    })
}

fn rect_intersects_band(rect: LayoutRect, top: f64, bottom: f64) -> bool {
    rect.y < bottom && top < rect.y + rect.height
}

/// Return the horizontal text intervals available in a line band after applying
/// every active float exclusion. Input order is ignored, so z-order cannot affect
/// line geometry.
pub(crate) fn available_text_intervals(
    column: LayoutRect,
    line_top: f64,
    line_bottom: f64,
    exclusions: &[FloatExclusion],
) -> Vec<(f64, f64)> {
    let column_right = column.x + column.width;
    let mut intervals = vec![(column.x, column_right)];

    let mut active: Vec<_> = exclusions
        .iter()
        .copied()
        .filter(|exclusion| rect_intersects_band(exclusion.rect, line_top, line_bottom))
        .collect();
    active.sort_by(|a, b| {
        a.rect
            .x
            .total_cmp(&b.rect.x)
            .then_with(|| a.rect.width.total_cmp(&b.rect.width))
    });

    for exclusion in active {
        if matches!(exclusion.geometry, WrapGeometry::TopAndBottom)
            && exclusion.rect.x < column_right
            && exclusion.rect.x + exclusion.rect.width > column.x
        {
            return Vec::new();
        }

        let (cut_left, cut_right) = match exclusion.geometry {
            WrapGeometry::TopAndBottom => continue,
            WrapGeometry::Side(TextFlow::BothSides) => {
                (exclusion.rect.x, exclusion.rect.x + exclusion.rect.width)
            }
            WrapGeometry::Side(TextFlow::LeftOnly) => (exclusion.rect.x, column_right),
            WrapGeometry::Side(TextFlow::RightOnly) => {
                (column.x, exclusion.rect.x + exclusion.rect.width)
            }
            WrapGeometry::Side(TextFlow::LargestOnly) => {
                let left_width = (exclusion.rect.x - column.x).max(0.0);
                let right_width =
                    (column_right - (exclusion.rect.x + exclusion.rect.width)).max(0.0);
                if left_width >= right_width {
                    (exclusion.rect.x, column_right)
                } else {
                    (column.x, exclusion.rect.x + exclusion.rect.width)
                }
            }
        };
        let cut_left = cut_left.max(column.x);
        let cut_right = cut_right.min(column_right);
        if cut_left >= cut_right {
            continue;
        }
        let mut next = Vec::new();
        for (start, end) in intervals {
            if end <= cut_left || start >= cut_right {
                next.push((start, end));
            } else {
                if start < cut_left {
                    next.push((start, cut_left));
                }
                if cut_right < end {
                    next.push((cut_right, end));
                }
            }
        }
        intervals = next;
    }
    intervals
}

/// Advance the flow cursor for a placed paragraph-relative TopAndBottom object.
/// Side wraps and overlay planes never consume the object's full height.
pub(crate) fn flow_cursor_after_float(
    common: &CommonObjAttr,
    frame: LayoutRect,
    column: LayoutRect,
    current_y: f64,
    dpi: f64,
) -> f64 {
    if !matches!(common.vert_rel_to, VertRelTo::Para)
        || !matches!(common.text_wrap, TextWrap::TopAndBottom)
    {
        return current_y;
    }
    let Some(exclusion) = float_exclusion(common, frame, dpi) else {
        return current_y;
    };
    let exclusion_right = exclusion.rect.x + exclusion.rect.width;
    let column_right = column.x + column.width;
    if exclusion_right <= column.x || exclusion.rect.x >= column_right {
        return current_y;
    }
    current_y.max(exclusion.rect.y + exclusion.rect.height)
}

/// Compute the same depth-0 horizontal range used by table layout.
pub(crate) fn horizontal_range(
    common: &CommonObjAttr,
    width_px: f64,
    ctx: FloatPlacementContext,
    dpi: f64,
) -> (f64, f64) {
    let h_offset = hwpunit_to_px(signed_hwpunit(common.horizontal_offset), dpi);
    let col_area = ctx.col_area;
    let (ref_x, ref_w) = match common.horz_rel_to {
        HorzRelTo::Paper => {
            let fallback_paper_w = if width_px > col_area.width {
                col_area.x * 2.0 + width_px
            } else {
                col_area.x * 2.0 + col_area.width
            };
            let paper_w = ctx.paper_width.unwrap_or(fallback_paper_w);
            (0.0, paper_w)
        }
        HorzRelTo::Page => ctx
            .body_area
            .filter(|body| body.width > 0.0)
            .map(|body| (body.x, body.width))
            .unwrap_or((col_area.x, col_area.width)),
        HorzRelTo::Para => (
            col_area.x + ctx.host_margin_left,
            (col_area.width - ctx.host_margin_left - ctx.host_margin_right).max(0.0),
        ),
        HorzRelTo::Column => (col_area.x, col_area.width),
    };

    let x = match common.horz_align {
        HorzAlign::Left | HorzAlign::Inside => ref_x + h_offset,
        HorzAlign::Center => ref_x + (ref_w - width_px).max(0.0) / 2.0 + h_offset,
        HorzAlign::Right | HorzAlign::Outside => ref_x + (ref_w - width_px).max(0.0) - h_offset,
    };
    (x, x + width_px.max(0.0))
}

/// A placed float lane in page/column-relative coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct FloatLane {
    pub x_start: f64,
    pub x_end: f64,
    pub top: f64,
    pub bottom: f64,
}

impl FloatLane {
    fn overlaps_x(&self, x_start: f64, x_end: f64) -> bool {
        ranges_overlap(self.x_start, self.x_end, x_start, x_end)
    }
}

/// Tracks bottom reservations for horizontally independent float lanes.
#[derive(Debug, Default, Clone)]
pub(crate) struct FloatLaneSet {
    lanes: Vec<FloatLane>,
}

impl FloatLaneSet {
    pub(crate) fn new() -> Self {
        Self { lanes: Vec::new() }
    }

    pub(crate) fn clear(&mut self) {
        self.lanes.clear();
    }

    pub(crate) fn lanes(&self) -> &[FloatLane] {
        &self.lanes
    }

    pub(crate) fn pushed_top(&self, x_start: f64, x_end: f64, raw_top: f64) -> f64 {
        self.lanes
            .iter()
            .filter(|lane| lane.overlaps_x(x_start, x_end))
            .fold(raw_top, |top, lane| top.max(lane.bottom))
    }

    pub(crate) fn place(
        &mut self,
        x_start: f64,
        x_end: f64,
        raw_top: f64,
        height: f64,
    ) -> FloatLane {
        let top = self.pushed_top(x_start, x_end, raw_top);
        let lane = FloatLane {
            x_start,
            x_end,
            top,
            bottom: top + height.max(0.0),
        };
        self.lanes.push(lane);
        lane
    }

    /// Place a float according to HWP's allowOverlap contract. Overlap-enabled
    /// objects retain their requested top but are still recorded so a later
    /// overlap-disabled object can avoid them.
    pub(crate) fn place_with_policy(
        &mut self,
        x_start: f64,
        x_end: f64,
        raw_top: f64,
        height: f64,
        allow_overlap: bool,
    ) -> FloatLane {
        let top = if allow_overlap {
            raw_top
        } else {
            self.pushed_top(x_start, x_end, raw_top)
        };
        let lane = FloatLane {
            x_start,
            x_end,
            top,
            bottom: top + height.max(0.0),
        };
        self.lanes.push(lane);
        lane
    }

    pub(crate) fn max_bottom(&self) -> f64 {
        self.lanes
            .iter()
            .map(|lane| lane.bottom)
            .fold(0.0, f64::max)
    }
}

pub(crate) fn ranges_overlap(a_start: f64, a_end: f64, b_start: f64, b_end: f64) -> bool {
    let a0 = a_start.min(a_end);
    let a1 = a_start.max(a_end);
    let b0 = b_start.min(b_end);
    let b1 = b_start.max(b_end);
    a0 < b1 && b0 < a1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::control::Control;
    use crate::model::paragraph::{LineSeg, Paragraph};
    use crate::model::shape::{HorzAlign, HorzRelTo, TextFlow, VertAlign};
    use crate::model::table::{Cell, Table, TablePageBreak};

    fn base_common() -> CommonObjAttr {
        CommonObjAttr {
            text_wrap: TextWrap::TopAndBottom,
            vert_rel_to: VertRelTo::Para,
            horz_rel_to: HorzRelTo::Column,
            horz_align: HorzAlign::Left,
            ..Default::default()
        }
    }

    fn uniform_cellbreak_fixture() -> (Paragraph, Table) {
        let stored_para = |gap| Paragraph {
            text: "row".to_string(),
            line_segs: vec![LineSeg {
                line_height: 1000,
                line_spacing: gap,
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut table = Table {
            row_count: 3,
            col_count: 1,
            page_break: TablePageBreak::CellBreak,
            repeat_header: true,
            outer_margin_top: 141,
            outer_margin_bottom: 141,
            common: CommonObjAttr {
                treat_as_char: false,
                text_wrap: TextWrap::TopAndBottom,
                vert_rel_to: VertRelTo::Para,
                vert_align: VertAlign::Top,
                vertical_offset: 140,
                ..Default::default()
            },
            ..Default::default()
        };
        table.cells = vec![
            Cell {
                row: 0,
                col: 0,
                row_span: 1,
                col_span: 1,
                is_header: true,
                paragraphs: vec![stored_para(0)],
                ..Default::default()
            },
            Cell {
                row: 1,
                col: 0,
                row_span: 1,
                col_span: 1,
                paragraphs: vec![stored_para(600)],
                ..Default::default()
            },
            Cell {
                row: 2,
                col: 0,
                row_span: 1,
                col_span: 1,
                paragraphs: vec![stored_para(600)],
                ..Default::default()
            },
        ];
        let para = Paragraph {
            controls: vec![Control::Table(Box::new(table.clone()))],
            ..Default::default()
        };
        (para, table)
    }

    fn saved_residual_rowbreak_fixture() -> (Paragraph, Table, Paragraph) {
        let stored_para = |text: &str, vertical_pos| Paragraph {
            text: text.to_string(),
            line_segs: vec![LineSeg {
                vertical_pos,
                line_height: 1000,
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut table = Table {
            row_count: 1,
            col_count: 1,
            page_break: TablePageBreak::RowBreak,
            outer_margin_top: 141,
            outer_margin_bottom: 141,
            common: CommonObjAttr {
                height: 8464,
                treat_as_char: false,
                text_wrap: TextWrap::TopAndBottom,
                vert_rel_to: VertRelTo::Para,
                vert_align: VertAlign::Top,
                vertical_offset: 0,
                ..Default::default()
            },
            ..Default::default()
        };
        table.cells = vec![Cell {
            row: 0,
            col: 0,
            row_span: 1,
            col_span: 1,
            height: 11753,
            vertical_align: crate::model::table::VerticalAlign::Center,
            paragraphs: vec![stored_para("placeholder", 0)],
            ..Default::default()
        }];
        let host = Paragraph {
            controls: vec![Control::Table(Box::new(table.clone()))],
            line_segs: vec![LineSeg {
                vertical_pos: 64005,
                line_height: 1000,
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut next = stored_para("following text wrapping across stored lines", 3571);
        next.line_segs.extend([
            LineSeg {
                vertical_pos: 5491,
                line_height: 1000,
                ..Default::default()
            },
            LineSeg {
                vertical_pos: 7411,
                line_height: 1000,
                ..Default::default()
            },
        ]);
        (host, table, next)
    }

    #[test]
    fn native_single_cell_rowbreak_preserves_saved_residual_blank_band() {
        let (host, table, next) = saved_residual_rowbreak_fixture();
        assert_eq!(
            native_single_cell_rowbreak_saved_residual_split_hu(true, &host, &table, Some(&next)),
            Some((8464, 3289))
        );
    }

    #[test]
    fn native_single_cell_rowbreak_rejects_non_exact_saved_residual_contract() {
        let (host, mut table, mut next) = saved_residual_rowbreak_fixture();
        assert_eq!(
            native_single_cell_rowbreak_saved_residual_split_hu(false, &host, &table, Some(&next)),
            None
        );

        next.line_segs[0].vertical_pos += 2;
        assert_eq!(
            native_single_cell_rowbreak_saved_residual_split_hu(true, &host, &table, Some(&next)),
            None
        );

        next.line_segs[0].vertical_pos -= 2;
        table.common.vertical_offset = 1;
        assert_eq!(
            native_single_cell_rowbreak_saved_residual_split_hu(true, &host, &table, Some(&next)),
            None
        );
    }

    #[test]
    fn native_uniform_cellbreak_repeats_outer_top_and_stored_fragment_gap() {
        let (para, table) = uniform_cellbreak_fixture();
        assert_eq!(
            native_uniform_cellbreak_fragment_spacing_hu(true, &para, &table),
            Some((141, 459)),
            "600HU stored body-row gap contains the 141HU visible top inset"
        );
    }

    #[test]
    fn native_uniform_cellbreak_rejects_mixed_and_non_native_tables() {
        let (para, mut table) = uniform_cellbreak_fixture();
        assert_eq!(
            native_uniform_cellbreak_fragment_spacing_hu(false, &para, &table),
            None
        );

        table.cells[2].paragraphs[0].line_segs[0].line_spacing = 500;
        let mixed_para = Paragraph {
            controls: vec![Control::Table(Box::new(table.clone()))],
            ..Default::default()
        };
        assert_eq!(
            native_uniform_cellbreak_fragment_spacing_hu(true, &mixed_para, &table),
            None
        );

        table.page_break = TablePageBreak::RowBreak;
        let rowbreak_para = Paragraph {
            controls: vec![Control::Table(Box::new(table.clone()))],
            ..Default::default()
        };
        assert_eq!(
            native_uniform_cellbreak_fragment_spacing_hu(true, &rowbreak_para, &table),
            None
        );
    }

    #[test]
    fn signed_hwpunit_preserves_negative_offsets() {
        assert_eq!(signed_hwpunit((-43892i32) as u32), -43892);
        assert_eq!(signed_hwpunit(51100), 51100);
    }

    #[test]
    fn para_topbottom_float_predicate_requires_non_tac_para_topbottom() {
        let mut common = base_common();
        assert!(is_para_topbottom_float(&common));

        common.treat_as_char = true;
        assert!(!is_para_topbottom_float(&common));

        common.treat_as_char = false;
        common.text_wrap = TextWrap::Square;
        assert!(!is_para_topbottom_float(&common));

        common.text_wrap = TextWrap::TopAndBottom;
        common.vert_rel_to = VertRelTo::Page;
        assert!(!is_para_topbottom_float(&common));
    }

    #[test]
    fn lane_set_does_not_push_non_overlapping_ranges() {
        let mut lanes = FloatLaneSet::new();
        let first = lanes.place(0.0, 100.0, 10.0, 40.0);
        let second = lanes.place(120.0, 200.0, 10.0, 20.0);

        assert_eq!(first.bottom, 50.0);
        assert_eq!(second.bottom, 30.0);
        assert_eq!(lanes.max_bottom(), 50.0);
    }

    #[test]
    fn lane_set_pushes_overlapping_ranges() {
        let mut lanes = FloatLaneSet::new();
        lanes.place(0.0, 100.0, 10.0, 40.0);
        let second = lanes.place(90.0, 160.0, 10.0, 20.0);

        assert_eq!(second.bottom, 70.0);
        assert_eq!(lanes.max_bottom(), 70.0);
    }

    #[test]
    fn horizontal_range_matches_column_right_offset_rule() {
        let mut common = base_common();
        common.horz_align = HorzAlign::Right;
        common.horizontal_offset = 10;

        let ctx = FloatPlacementContext::new(LayoutRect {
            x: 20.0,
            y: 0.0,
            width: 200.0,
            height: 100.0,
        });
        let (x0, x1) = horizontal_range(&common, 50.0, ctx, 7200.0);

        assert_eq!(x0, 160.0);
        assert_eq!(x1, 210.0);
    }

    #[test]
    fn horizontal_range_uses_body_area_for_page_relative_objects() {
        let mut common = base_common();
        common.horz_rel_to = HorzRelTo::Page;
        common.horz_align = HorzAlign::Center;

        let ctx = FloatPlacementContext::new(LayoutRect {
            x: 20.0,
            y: 0.0,
            width: 200.0,
            height: 100.0,
        })
        .with_body_area(LayoutRect {
            x: 40.0,
            y: 0.0,
            width: 300.0,
            height: 100.0,
        });
        let (x0, x1) = horizontal_range(&common, 100.0, ctx, 7200.0);

        assert_eq!(x0, 140.0);
        assert_eq!(x1, 240.0);
    }

    #[test]
    fn object_frame_resolves_references_alignments_and_negative_offsets() {
        let ctx = ObjectPlacementContext {
            paper: LayoutRect {
                x: 0.0,
                y: 0.0,
                width: 600.0,
                height: 800.0,
            },
            page: LayoutRect {
                x: 50.0,
                y: 70.0,
                width: 500.0,
                height: 660.0,
            },
            column: LayoutRect {
                x: 60.0,
                y: 70.0,
                width: 230.0,
                height: 660.0,
            },
            paragraph: LayoutRect {
                x: 80.0,
                y: 100.0,
                width: 180.0,
                height: 630.0,
            },
            line_y: 140.0,
        };
        let mut common = base_common();
        common.horz_rel_to = HorzRelTo::Para;
        common.horz_align = HorzAlign::Right;
        common.horizontal_offset = (-10i32) as u32;
        common.vert_rel_to = VertRelTo::Para;
        common.vert_align = VertAlign::Top;
        common.vertical_offset = (-20i32) as u32;

        let frame = object_frame(&common, 40.0, 30.0, ctx, 7200.0);
        // Right/Outside offsets are distances inward, so a negative value moves right.
        assert_eq!(frame.x, 230.0);
        assert_eq!(frame.y, 120.0);
    }

    #[test]
    fn page_relative_position_stays_fixed_across_column_transitions() {
        let mut common = base_common();
        common.horz_rel_to = HorzRelTo::Page;
        common.horz_align = HorzAlign::Center;
        common.vert_rel_to = VertRelTo::Page;
        common.vert_align = VertAlign::Top;
        let base = ObjectPlacementContext {
            paper: LayoutRect {
                x: 0.0,
                y: 0.0,
                width: 600.0,
                height: 800.0,
            },
            page: LayoutRect {
                x: 50.0,
                y: 70.0,
                width: 500.0,
                height: 660.0,
            },
            column: LayoutRect {
                x: 50.0,
                y: 70.0,
                width: 240.0,
                height: 660.0,
            },
            paragraph: LayoutRect {
                x: 50.0,
                y: 100.0,
                width: 240.0,
                height: 630.0,
            },
            line_y: 100.0,
        };
        let next_column = ObjectPlacementContext {
            column: LayoutRect {
                x: 310.0,
                ..base.column
            },
            paragraph: LayoutRect {
                x: 310.0,
                ..base.paragraph
            },
            line_y: 90.0,
            ..base
        };
        assert_eq!(
            object_frame(&common, 100.0, 40.0, base, 7200.0).x,
            object_frame(&common, 100.0, 40.0, next_column, 7200.0).x
        );

        common.horz_rel_to = HorzRelTo::Column;
        assert_ne!(
            object_frame(&common, 100.0, 40.0, base, 7200.0).x,
            object_frame(&common, 100.0, 40.0, next_column, 7200.0).x
        );
    }

    #[test]
    fn side_exclusion_keeps_text_on_both_sides_and_applies_margins() {
        let mut common = base_common();
        common.text_wrap = TextWrap::Square;
        common.text_flow = TextFlow::BothSides;
        common.margin.left = 5;
        common.margin.right = 10;
        let exclusion = float_exclusion(
            &common,
            LayoutRect {
                x: 80.0,
                y: 10.0,
                width: 40.0,
                height: 50.0,
            },
            7200.0,
        )
        .unwrap();
        let available = available_text_intervals(
            LayoutRect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 300.0,
            },
            20.0,
            30.0,
            &[exclusion],
        );
        assert_eq!(available, vec![(0.0, 75.0), (130.0, 200.0)]);
    }

    #[test]
    fn exclusions_are_independent_of_z_order_or_input_order() {
        let mut common = base_common();
        common.text_wrap = TextWrap::Tight;
        let left = float_exclusion(
            &common,
            LayoutRect {
                x: 20.0,
                y: 0.0,
                width: 40.0,
                height: 50.0,
            },
            7200.0,
        )
        .unwrap();
        let right = float_exclusion(
            &common,
            LayoutRect {
                x: 140.0,
                y: 0.0,
                width: 30.0,
                height: 50.0,
            },
            7200.0,
        )
        .unwrap();
        let col = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 300.0,
        };
        assert_eq!(
            available_text_intervals(col, 10.0, 20.0, &[left, right]),
            available_text_intervals(col, 10.0, 20.0, &[right, left])
        );
        assert_eq!(
            available_text_intervals(col, 10.0, 20.0, &[left, right]),
            vec![(0.0, 20.0), (60.0, 140.0), (170.0, 200.0)]
        );
    }

    #[test]
    fn top_bottom_blocks_band_while_overlay_wraps_do_not() {
        let frame = LayoutRect {
            x: 20.0,
            y: 10.0,
            width: 40.0,
            height: 50.0,
        };
        let col = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 300.0,
        };
        let mut common = base_common();
        let top_bottom = float_exclusion(&common, frame, 7200.0).unwrap();
        assert!(available_text_intervals(col, 20.0, 30.0, &[top_bottom]).is_empty());

        common.text_wrap = TextWrap::BehindText;
        assert!(float_exclusion(&common, frame, 7200.0).is_none());
        common.text_wrap = TextWrap::InFrontOfText;
        assert!(float_exclusion(&common, frame, 7200.0).is_none());
    }

    #[test]
    fn overlap_policy_stacks_only_when_overlap_is_disallowed() {
        let mut lanes = FloatLaneSet::new();
        lanes.place_with_policy(0.0, 100.0, 10.0, 40.0, false);
        let allowed = lanes.place_with_policy(20.0, 80.0, 10.0, 20.0, true);
        let blocked = lanes.place_with_policy(20.0, 80.0, 10.0, 20.0, false);
        assert_eq!(allowed.bottom, 30.0);
        assert_eq!(blocked.bottom, 70.0);
    }

    #[test]
    fn flow_advance_uses_placed_bottom_and_ignores_side_wraps() {
        let column = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 300.0,
        };
        let frame = LayoutRect {
            x: 20.0,
            y: 70.0,
            width: 50.0,
            height: 40.0,
        };
        let mut common = base_common();
        common.margin.bottom = 10;
        assert_eq!(
            flow_cursor_after_float(&common, frame, column, 50.0, 7200.0),
            120.0
        );

        common.text_wrap = TextWrap::Square;
        assert_eq!(
            flow_cursor_after_float(&common, frame, column, 50.0, 7200.0),
            50.0
        );
    }
}
