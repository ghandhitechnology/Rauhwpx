//! Recognize saved wrapping produced by a previous font-metric policy.
//! This is not a general permission to discard stored line or page breaks.

use super::{reflow_line_segs, LineSeg, Paragraph, ResolvedStyleSet};
use crate::model::control::Control;

pub(crate) fn repair_metric_stale_cell_lines(
    paragraphs: &mut [Paragraph],
    previous_styles: &ResolvedStyleSet,
    current_styles: &ResolvedStyleSet,
    dpi: f64,
) -> bool {
    let mut changed = false;
    for paragraph in paragraphs {
        for control in &mut paragraph.controls {
            let Control::Table(table) = control else {
                continue;
            };
            for cell in &mut table.cells {
                if cell.text_direction != 0 || cell.width >= 0x8000_0000 {
                    continue;
                }
                let pad = cell.effective_padding(&table.padding);
                let inner_width = crate::renderer::hwpunit_to_px(
                    cell.width as i32 - pad.left as i32 - pad.right as i32,
                    dpi,
                );
                for para in &mut cell.paragraphs {
                    let style = current_styles.para_styles.get(para.para_shape_id as usize);
                    let width = inner_width - style.map_or(0.0, |s| s.margin_left + s.margin_right);
                    if let Some(lines) = cell_lines_from_previous_font_metrics(
                        para,
                        width,
                        previous_styles,
                        current_styles,
                        dpi,
                    ) {
                        para.line_segs = lines;
                        changed = true;
                    }
                }
                changed |= repair_metric_stale_cell_lines(
                    &mut cell.paragraphs,
                    previous_styles,
                    current_styles,
                    dpi,
                );
            }
        }
    }
    changed
}

fn geometry(seg: &LineSeg) -> [i32; 7] {
    [
        seg.vertical_pos,
        seg.line_height,
        seg.text_height,
        seg.baseline_distance,
        seg.line_spacing,
        seg.column_start,
        seg.segment_width,
    ]
}

/// Return replacement boundaries only when the entire saved layout is exactly
/// reproducible with the old policy, and the new policy changes no line geometry.
/// Callers must independently establish the document's exporter lineage and
/// active font policy. Apply the result to a render copy, never the source IR.
pub(crate) fn cell_lines_from_previous_font_metrics(
    para: &Paragraph,
    width_px: f64,
    previous_styles: &ResolvedStyleSet,
    current_styles: &ResolvedStyleSet,
    dpi: f64,
) -> Option<Vec<LineSeg>> {
    if para.line_segs.len() < 2
        || width_px <= 0.0
        || para.text.contains(['\n', '\r', '\t'])
        || para.controls.is_empty()
        || !para
            .controls
            .iter()
            .all(|ctrl| matches!(ctrl, Control::Picture(pic) if pic.common.treat_as_char))
        || para
            .line_segs
            .iter()
            .any(|seg| seg.tag != LineSeg::TAG_SINGLE_SEGMENT_LINE)
        || para
            .line_segs
            .windows(2)
            .any(|pair| pair[1].vertical_pos <= pair[0].vertical_pos)
    {
        return None;
    }
    let mut previous = para.clone();
    reflow_line_segs(&mut previous, width_px, previous_styles, dpi);
    if previous.line_segs.len() != para.line_segs.len()
        || !previous
            .line_segs
            .iter()
            .zip(&para.line_segs)
            .all(|(a, b)| {
                a.text_start == b.text_start && a.tag == b.tag && geometry(a) == geometry(b)
            })
    {
        return None;
    }
    let mut current = para.clone();
    reflow_line_segs(&mut current, width_px, current_styles, dpi);
    if current.line_segs.len() != para.line_segs.len()
        || !current
            .line_segs
            .iter()
            .zip(&para.line_segs)
            .all(|(a, b)| a.tag == b.tag && geometry(a) == geometry(b))
        || current
            .line_segs
            .iter()
            .zip(&para.line_segs)
            .all(|(a, b)| a.text_start == b.text_start)
    {
        return None;
    }
    Some(current.line_segs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::provenance::FontMetricsPolicy;
    use crate::renderer::{hwpunit_to_px, style_resolver::resolve_styles};

    #[test]
    fn captured_legacy_cell_wraps_are_exactly_reproduced_by_previous_metrics() {
        for id in [
            "cell-mixed-text",
            "cell-fit-width",
            "cell-paragraph-spacing",
        ] {
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/editing_parity");
            let doc = crate::parser::parse_document(
                &std::fs::read(root.join("mac-hancom-12.30.0").join(id).join("edited.hwpx"))
                    .unwrap(),
            )
            .unwrap();
            let mut info = doc.doc_info.clone();
            info.font_metrics_policy = FontMetricsPolicy::HancomWindows;
            let previous = resolve_styles(&info, 96.0);
            info.font_metrics_policy = FontMetricsPolicy::HcrDeclared;
            let current = resolve_styles(&info, 96.0);
            let table = doc.sections[0].paragraphs[0]
                .controls
                .iter()
                .find_map(|c| {
                    if let Control::Table(t) = c {
                        Some(t)
                    } else {
                        None
                    }
                })
                .unwrap();
            let cell = &table.cells[0];
            let pad = cell.effective_padding(&table.padding);
            let para = &cell.paragraphs[0];
            let style = &current.para_styles[para.para_shape_id as usize];
            let width = hwpunit_to_px(cell.width as i32 - pad.left as i32 - pad.right as i32, 96.0)
                - style.margin_left
                - style.margin_right;
            let result =
                cell_lines_from_previous_font_metrics(para, width, &previous, &current, 96.0)
                    .unwrap_or_else(|| panic!("{id}: not an exact old-policy layout"));
            let mut already_current = para.clone();
            already_current.line_segs = result.clone();
            assert!(cell_lines_from_previous_font_metrics(
                &already_current,
                width,
                &previous,
                &current,
                96.0,
            )
            .is_none());
            let corrected = crate::parser::parse_document(
                &std::fs::read(
                    root.join("mac-hancom-12.30.0-xml14")
                        .join(id)
                        .join("edited.hwpx"),
                )
                .unwrap(),
            )
            .unwrap();
            let corrected_table = corrected.sections[0].paragraphs[0]
                .controls
                .iter()
                .find_map(|c| {
                    if let Control::Table(t) = c {
                        Some(t)
                    } else {
                        None
                    }
                })
                .unwrap();
            assert_eq!(
                result.iter().map(|s| s.text_start).collect::<Vec<_>>(),
                corrected_table.cells[0].paragraphs[0]
                    .line_segs
                    .iter()
                    .map(|s| s.text_start)
                    .collect::<Vec<_>>(),
                "{id}"
            );
            let mut intentional = para.clone();
            intentional.line_segs[1].vertical_pos += 1;
            assert!(cell_lines_from_previous_font_metrics(
                &intentional,
                width,
                &previous,
                &current,
                96.0
            )
            .is_none());
            intentional = para.clone();
            intentional.line_segs[1].tag |= LineSeg::TAG_FIRST_LINE_OF_PAGE;
            assert!(cell_lines_from_previous_font_metrics(
                &intentional,
                width,
                &previous,
                &current,
                96.0
            )
            .is_none());
            for alteration in 0..4 {
                let mut intentional = para.clone();
                match alteration {
                    0 => intentional.line_segs[1].text_start += 1,
                    1 => intentional.line_segs[1].vertical_pos = 0,
                    2 => intentional.text.push('\n'),
                    _ => intentional.line_segs[1].column_start += 10,
                }
                assert!(
                    cell_lines_from_previous_font_metrics(
                        &intentional,
                        width,
                        &previous,
                        &current,
                        96.0,
                    )
                    .is_none(),
                    "{id}: alteration {alteration} must retain stored layout"
                );
            }
        }
    }
}
