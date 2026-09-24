//! Read-only character counts from the document model, independent of pagination.

use super::super::DocumentCore;
use crate::document_core::helpers::{
    find_logical_control_positions, get_textbox_from_shape, logical_paragraph_length,
    logical_to_text_offset,
};
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;
use crate::model::shape::ShapeObject;
use unicode_segmentation::UnicodeSegmentation;

fn invisible(ch: char) -> bool {
    ch.is_whitespace()
        || ch.is_control()
        || matches!(
            ch,
            '\u{200b}'
                | '\u{200c}'
                | '\u{200d}'
                | '\u{2060}'
                | '\u{fe0e}'
                | '\u{fe0f}'
                | '\u{feff}'
                | '\u{fffc}'
        )
}

pub(crate) fn written_characters(text: &str) -> usize {
    text.graphemes(true)
        .filter(|cluster| cluster.chars().any(|ch| !invisible(ch)))
        .count()
}

fn count_shape(shape: &ShapeObject) -> usize {
    let mut count = 0;
    if let Some(text_box) = get_textbox_from_shape(shape) {
        count += count_paragraphs(&text_box.paragraphs);
    }
    let specific_caption = match shape {
        ShapeObject::Group(group) => group.caption.as_ref(),
        ShapeObject::Picture(picture) => picture.caption.as_ref(),
        ShapeObject::Chart(chart) => chart.caption.as_ref(),
        ShapeObject::Ole(ole) => ole.caption.as_ref(),
        _ => None,
    };
    if let Some(caption) =
        specific_caption.or_else(|| shape.drawing().and_then(|drawing| drawing.caption.as_ref()))
    {
        count += count_paragraphs(&caption.paragraphs);
    }
    match shape {
        ShapeObject::Group(group) => {
            count += group.children.iter().map(count_shape).sum::<usize>();
        }
        _ => {}
    }
    count
}

fn count_control(control: &Control) -> usize {
    match control {
        Control::Table(table) => {
            let cells: usize = table
                .cells
                .iter()
                .map(|cell| count_paragraphs(&cell.paragraphs))
                .sum();
            let caption = table
                .caption
                .as_ref()
                .map_or(0, |caption| count_paragraphs(&caption.paragraphs));
            cells + caption
        }
        Control::Shape(shape) => count_shape(shape),
        Control::Picture(picture) => picture
            .caption
            .as_ref()
            .map_or(0, |caption| count_paragraphs(&caption.paragraphs)),
        Control::Header(header) => count_paragraphs(&header.paragraphs),
        Control::Footer(footer) => count_paragraphs(&footer.paragraphs),
        Control::Footnote(note) => count_paragraphs(&note.paragraphs),
        Control::Endnote(note) => count_paragraphs(&note.paragraphs),
        // Hidden comments, equation source, field commands and alt text are not document prose.
        _ => 0,
    }
}

fn count_paragraphs(paragraphs: &[Paragraph]) -> usize {
    paragraphs
        .iter()
        .map(|paragraph| {
            written_characters(&paragraph.text)
                + paragraph.controls.iter().map(count_control).sum::<usize>()
        })
        .sum()
}

fn count_paragraph_range(paragraph: &Paragraph, from: usize, to: usize) -> Result<usize, HwpError> {
    if from > to || to > logical_paragraph_length(paragraph) {
        return Err(HwpError::RenderError(
            "선택 문자 위치가 범위를 벗어났습니다".to_string(),
        ));
    }
    let text_start = logical_to_text_offset(paragraph, from).0;
    let text_end = logical_to_text_offset(paragraph, to).0;
    let selected: String = paragraph
        .text
        .chars()
        .skip(text_start)
        .take(text_end.saturating_sub(text_start))
        .collect();
    let mut count = written_characters(&selected);
    for (control, logical_pos) in paragraph
        .controls
        .iter()
        .zip(find_logical_control_positions(paragraph))
    {
        if logical_pos >= from && logical_pos < to {
            count += count_control(control);
        }
    }
    Ok(count)
}

impl DocumentCore {
    /// Every authored text scope, counted once in the source model (including nested tables).
    pub fn get_document_character_count(&self) -> usize {
        self.document
            .sections
            .iter()
            .map(|section| {
                count_paragraphs(&section.paragraphs)
                    + section
                        .section_def
                        .master_pages
                        .iter()
                        .map(|page| count_paragraphs(&page.paragraphs))
                        .sum::<usize>()
            })
            .sum()
    }

    /// Count a body selection, including controls whose logical slots are selected.
    pub fn get_body_range_character_count(
        &self,
        start_section: usize,
        start_paragraph: usize,
        start_offset: usize,
        end_section: usize,
        end_paragraph: usize,
        end_offset: usize,
    ) -> Result<usize, HwpError> {
        if (start_section, start_paragraph, start_offset) > (end_section, end_paragraph, end_offset)
        {
            return Err(HwpError::RenderError(
                "선택 범위가 뒤집혔습니다".to_string(),
            ));
        }
        let mut count = 0;
        for section_index in start_section..=end_section {
            let section = self
                .document
                .sections
                .get(section_index)
                .ok_or_else(|| HwpError::RenderError("구역을 찾을 수 없습니다".to_string()))?;
            let first = if section_index == start_section {
                start_paragraph
            } else {
                0
            };
            let last = if section_index == end_section {
                end_paragraph
            } else {
                section.paragraphs.len().saturating_sub(1)
            };
            for paragraph_index in first..=last {
                let paragraph = section
                    .paragraphs
                    .get(paragraph_index)
                    .ok_or_else(|| HwpError::RenderError("문단을 찾을 수 없습니다".to_string()))?;
                let from = if section_index == start_section && paragraph_index == start_paragraph {
                    start_offset
                } else {
                    0
                };
                let to = if section_index == end_section && paragraph_index == end_paragraph {
                    end_offset
                } else {
                    logical_paragraph_length(paragraph)
                };
                count += count_paragraph_range(paragraph, from, to)?;
            }
        }
        Ok(count)
    }

    /// Count the entire innermost cell/text box addressed by a cursor path.
    fn container_paragraphs_by_path(
        &self,
        section: usize,
        parent_paragraph: usize,
        path: &[(usize, usize, usize)],
    ) -> Result<&[Paragraph], HwpError> {
        let Some((last, ancestors)) = path.split_last() else {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        };
        let paragraph = if ancestors.is_empty() {
            self.document
                .sections
                .get(section)
                .and_then(|section| section.paragraphs.get(parent_paragraph))
                .ok_or_else(|| HwpError::RenderError("본문 문단을 찾을 수 없습니다".to_string()))?
        } else {
            self.resolve_paragraph_by_path(section, parent_paragraph, ancestors)?
        };
        let paragraphs = match paragraph.controls.get(last.0) {
            Some(Control::Table(table)) => table
                .cells
                .get(last.1)
                .map(|cell| cell.paragraphs.as_slice()),
            Some(Control::Shape(shape)) if last.1 == 0 => {
                get_textbox_from_shape(shape).map(|box_| box_.paragraphs.as_slice())
            }
            Some(Control::Picture(picture)) if last.1 == 0 => picture
                .caption
                .as_ref()
                .map(|caption| caption.paragraphs.as_slice()),
            _ => None,
        }
        .ok_or_else(|| HwpError::RenderError("셀 또는 글상자를 찾을 수 없습니다".to_string()))?;
        Ok(paragraphs)
    }

    pub fn get_container_character_count_by_path(
        &self,
        section: usize,
        parent_paragraph: usize,
        path: &[(usize, usize, usize)],
    ) -> Result<usize, HwpError> {
        Ok(count_paragraphs(self.container_paragraphs_by_path(
            section,
            parent_paragraph,
            path,
        )?))
    }

    pub fn get_container_range_character_count_by_path(
        &self,
        section: usize,
        parent_paragraph: usize,
        path: &[(usize, usize, usize)],
        start_paragraph: usize,
        start_offset: usize,
        end_paragraph: usize,
        end_offset: usize,
    ) -> Result<usize, HwpError> {
        if (start_paragraph, start_offset) > (end_paragraph, end_offset) {
            return Err(HwpError::RenderError(
                "선택 범위가 뒤집혔습니다".to_string(),
            ));
        }
        let paragraphs = self.container_paragraphs_by_path(section, parent_paragraph, path)?;
        let mut count = 0;
        for index in start_paragraph..=end_paragraph {
            let paragraph = paragraphs
                .get(index)
                .ok_or_else(|| HwpError::RenderError("셀 문단을 찾을 수 없습니다".to_string()))?;
            let from = if index == start_paragraph {
                start_offset
            } else {
                0
            };
            let to = if index == end_paragraph {
                end_offset
            } else {
                logical_paragraph_length(paragraph)
            };
            count += count_paragraph_range(paragraph, from, to)?;
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::document::{Document, Section};
    use crate::model::shape::CommonObjAttr;
    use crate::model::table::{Cell, Table};

    #[test]
    fn korean_blocks_emoji_and_whitespace() {
        assert_eq!(written_characters("한글 한 👩‍💻\n"), 4);
        assert_eq!(written_characters("\u{0002}\u{fffc}\u{200b}"), 0);
    }

    #[test]
    fn counts_nested_tables_once_and_inner_cell() {
        let inner = Table {
            cells: vec![Cell {
                paragraphs: vec![Paragraph {
                    text: "안쪽".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            common: CommonObjAttr {
                treat_as_char: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let outer = Table {
            cells: vec![Cell {
                paragraphs: vec![Paragraph {
                    text: "바깥".into(),
                    char_offsets: vec![0, 1],
                    controls: vec![Control::Table(Box::new(inner))],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            common: CommonObjAttr {
                treat_as_char: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let document = Document {
            sections: vec![Section {
                paragraphs: vec![Paragraph {
                    text: "본문".into(),
                    char_offsets: vec![0, 1],
                    controls: vec![Control::Table(Box::new(outer))],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut core = DocumentCore::new_empty();
        core.document = document;
        assert_eq!(core.get_document_character_count(), 6);
        assert_eq!(
            core.get_container_character_count_by_path(0, 0, &[(0, 0, 0)])
                .unwrap(),
            4
        );
        assert_eq!(
            core.get_container_character_count_by_path(0, 0, &[(0, 0, 0), (0, 0, 0)])
                .unwrap(),
            2
        );
        assert_eq!(
            logical_paragraph_length(&core.document.sections[0].paragraphs[0]),
            3
        );
        let Control::Table(table) = &core.document.sections[0].paragraphs[0].controls[0] else {
            panic!("table")
        };
        assert_eq!(logical_paragraph_length(&table.cells[0].paragraphs[0]), 3);
        assert_eq!(
            core.get_body_range_character_count(0, 0, 0, 0, 0, 3)
                .unwrap(),
            6
        );
        assert_eq!(
            core.get_body_range_character_count(0, 0, 0, 0, 0, 2)
                .unwrap(),
            2
        );
        assert_eq!(
            core.get_container_range_character_count_by_path(0, 0, &[(0, 0, 0)], 0, 0, 0, 3)
                .unwrap(),
            4
        );
        assert_eq!(
            core.get_container_range_character_count_by_path(0, 0, &[(0, 0, 0)], 0, 0, 0, 2)
                .unwrap(),
            2
        );
    }
}
