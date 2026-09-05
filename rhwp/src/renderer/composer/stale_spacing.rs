//! Recognize a sequential body layout saved with doubled paragraph margins.
//! Only the render copy changes. Ambiguous positions and explicit breaks survive.
//! The caller must gate this to HWP5-origin HWPX exports, not native HWP.

use super::{LineSeg, Paragraph, ResolvedStyleSet};
use crate::model::{control::Control, paragraph::ColumnBreakType};

pub(crate) fn doubled_body_spacing_projection(
    paragraphs: &[Paragraph],
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> Option<Vec<Paragraph>> {
    if paragraphs.len() < 3 {
        return None;
    }
    let mut has_spaced_picture = false;
    for (index, para) in paragraphs.iter().enumerate() {
        let style = styles.para_styles.get(para.para_shape_id as usize)?;
        if para.line_segs.is_empty()
            || !(para.raw_break_type == 0 && para.column_type == ColumnBreakType::None
                || index == 0
                    && para.raw_break_type == 3
                    && para.column_type == ColumnBreakType::Section)
            || !style.spacing_before.is_finite()
            || !style.spacing_after.is_finite()
            || style.spacing_before < 0.0
            || style.spacing_after < 0.0
            || style.page_break_before
            || para.line_segs.iter().any(|seg| {
                seg.tag != LineSeg::TAG_SINGLE_SEGMENT_LINE
                    || seg.vertical_pos < 0
                    || seg.line_height <= 0
                    || seg.line_spacing < 0
                    || seg.column_start != 0
                    || seg.segment_width <= 0
            })
            || para.line_segs.windows(2).any(|pair| {
                pair[1].text_start <= pair[0].text_start
                    || i64::from(pair[1].vertical_pos)
                        != i64::from(pair[0].vertical_pos)
                            + i64::from(pair[0].line_height)
                            + i64::from(pair[0].line_spacing)
            })
        {
            return None;
        }
        for control in &para.controls {
            match control {
                Control::Picture(picture)
                    if picture.common.treat_as_char && picture.caption.is_none() =>
                {
                    has_spaced_picture |= index > 0
                        && index + 1 < paragraphs.len()
                        && style.spacing_before > 0.0
                        && style.spacing_after > 0.0;
                }
                Control::SectionDef(section) if index == 0 && section.text_direction == 0 => {}
                Control::ColumnDef(columns) if index == 0 && columns.column_count == 1 => {}
                _ => return None,
            }
        }
    }
    if !has_spaced_picture || paragraphs[0].line_segs[0].vertical_pos != 0 {
        return None;
    }
    let mut shifts = vec![0_i64];
    for pair in paragraphs.windows(2) {
        let previous = pair[0].line_segs.last()?;
        let current = pair[1].line_segs.first()?;
        let after = styles
            .para_styles
            .get(pair[0].para_shape_id as usize)?
            .spacing_after;
        let before = styles
            .para_styles
            .get(pair[1].para_shape_id as usize)?
            .spacing_before;
        let gap = crate::renderer::px_to_hwpunit_round(after + before, dpi);
        let stored_gap = i64::from(current.vertical_pos)
            - i64::from(previous.vertical_pos)
            - i64::from(previous.line_height)
            - i64::from(previous.line_spacing);
        // An edit can already have recalculated some boundaries. Accept only
        // current or doubled property-driven gaps throughout the simple flow;
        // any unexplained gap makes the whole projection ambiguous.
        if stored_gap != i64::from(gap) && stored_gap != 2 * i64::from(gap) {
            return None;
        }
        shifts.push(shifts.last()? + stored_gap - i64::from(gap));
    }
    if *shifts.last()? == 0 {
        return None;
    }
    let mut corrected = paragraphs.to_vec();
    for (para, shift) in corrected.iter_mut().zip(shifts) {
        for seg in &mut para.line_segs {
            seg.vertical_pos = i32::try_from(i64::from(seg.vertical_pos) - shift).ok()?;
        }
    }
    Some(corrected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_body_spacing_is_a_doubled_sequential_layout() {
        let bytes = include_bytes!("../../../tests/fixtures/editing_parity/mac-hancom-12.30.0/body-paragraph-spacing/edited.hwpx");
        let doc = crate::parser::parse_document(bytes).unwrap();
        let styles = crate::renderer::style_resolver::resolve_styles(&doc.doc_info, 96.0);
        let paragraphs = &doc.sections[0].paragraphs;
        let corrected = doubled_body_spacing_projection(paragraphs, &styles, 96.0).unwrap();
        assert_eq!(
            corrected
                .iter()
                .map(|p| p.line_segs[0].vertical_pos)
                .collect::<Vec<_>>(),
            vec![0, 1900, 11650]
        );
        assert!(doubled_body_spacing_projection(&corrected, &styles, 96.0).is_none());
        let mut partly_edited = paragraphs.clone();
        partly_edited[2].line_segs[0].vertical_pos = 11950;
        let partly_corrected =
            doubled_body_spacing_projection(&partly_edited, &styles, 96.0).unwrap();
        assert_eq!(partly_corrected[1].line_segs[0].vertical_pos, 1900);
        assert_eq!(partly_corrected[2].line_segs[0].vertical_pos, 11650);
        for (before, after) in [(100, 200), (700, 350), (1200, 600)] {
            let mut varied = paragraphs.clone();
            let mut varied_styles = styles.clone();
            let picture_style = &mut varied_styles.para_styles[varied[1].para_shape_id as usize];
            picture_style.spacing_before = crate::renderer::hwpunit_to_px(before, 96.0);
            picture_style.spacing_after = crate::renderer::hwpunit_to_px(after, 96.0);
            varied[1].line_segs[0].vertical_pos = 1600 + before * 2;
            varied[2].line_segs[0].vertical_pos = 11200 + (before + after) * 2;
            let result = doubled_body_spacing_projection(&varied, &varied_styles, 96.0).unwrap();
            assert_eq!(result[1].line_segs[0].vertical_pos, 1600 + before);
            assert_eq!(result[2].line_segs[0].vertical_pos, 11200 + before + after);
        }
        for alteration in 0..6 {
            let mut intentional = paragraphs.clone();
            match alteration {
                0 => intentional[1].line_segs[0].vertical_pos += 1,
                1 => intentional[2].line_segs[0].vertical_pos = 0,
                2 => intentional[1].line_segs[0].tag |= LineSeg::TAG_FIRST_LINE_OF_PAGE,
                3 => intentional[1].column_type = ColumnBreakType::Page,
                4 => intentional[2].raw_break_type = 4,
                _ => intentional[1].line_segs[0].column_start = 10,
            }
            assert!(
                doubled_body_spacing_projection(&intentional, &styles, 96.0).is_none(),
                "alteration {alteration}"
            );
        }
    }
}
