//! 편집 캐럿 좌표(논리 오프셋) 기반 텍스트 편집.
//!
//! Studio 캐럿·히트 테스트·커서 좌표·문단 분할은 글자처럼 취급 개체(수식·그림 등)를
//! 1칸으로 세는 논리 오프셋을 쓴다. 반면 삽입·삭제 네이티브는 개체를 세지 않는 텍스트
//! 오프셋을 받는다(에이전트 도구가 이 계약을 쓴다). 에디터 경로는 여기서 논리 오프셋을
//! 텍스트 오프셋으로 바꾼 뒤 기존 네이티브를 호출한다.

use crate::document_core::helpers::{
    caret_text_range, has_block_table, inline_objects_in_logical_range, is_block_table_control,
    logical_paragraph_length, CaretTextRange,
};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::paragraph::Paragraph;

/// 캐럿이 가리키는 문단.
#[derive(Clone, Copy)]
pub enum CaretParagraph<'a> {
    Body {
        section: usize,
        para: usize,
    },
    Cell {
        section: usize,
        parent_para: usize,
        control: usize,
        cell: usize,
        cell_para: usize,
    },
    Path {
        section: usize,
        parent_para: usize,
        path: &'a [(usize, usize, usize)],
    },
}

impl DocumentCore {
    fn caret_paragraph(&self, target: CaretParagraph<'_>) -> Result<&Paragraph, HwpError> {
        match target {
            CaretParagraph::Body { section, para } => self
                .document
                .sections
                .get(section)
                .and_then(|s| s.paragraphs.get(para))
                .ok_or_else(|| {
                    HwpError::RenderError(format!("문단 접근 실패: sec={}, para={}", section, para))
                }),
            CaretParagraph::Cell {
                section,
                parent_para,
                control,
                cell,
                cell_para,
            } => self
                .get_cell_paragraph_ref(section, parent_para, control, cell, cell_para)
                .ok_or_else(|| {
                    HwpError::RenderError(format!(
                        "셀 문단 접근 실패: sec={}, para={}, ctrl={}, cell={}, cellPara={}",
                        section, parent_para, control, cell, cell_para
                    ))
                }),
            CaretParagraph::Path {
                section,
                parent_para,
                path,
            } => self.resolve_paragraph_by_path(section, parent_para, path),
        }
    }

    /// 논리 범위를 텍스트 범위로 바꾼다. `logical` 이 아니면 입력을 그대로 텍스트 범위로 본다.
    pub(crate) fn caret_text_range_native(
        &self,
        target: CaretParagraph<'_>,
        offset: usize,
        count: usize,
        logical: bool,
    ) -> Result<CaretTextRange, HwpError> {
        if !logical {
            return Ok(CaretTextRange {
                start: offset,
                end: offset + count,
                after_control: None,
            });
        }
        Ok(caret_text_range(
            self.caret_paragraph(target)?,
            offset,
            count,
        ))
    }

    /// 캐럿 삽입/교체를 준비한다. 텍스트 범위를 반환하고, 캐럿이 개체 바로 뒤이면
    /// 다음 삽입 한 번이 그 개체 뒤에 들어가도록 표시한다.
    pub(crate) fn prepare_caret_insert(
        &mut self,
        target: CaretParagraph<'_>,
        offset: usize,
        delete_count: usize,
        logical: bool,
    ) -> Result<CaretTextRange, HwpError> {
        let range = self.caret_text_range_native(target, offset, delete_count, logical)?;
        self.caret_insert_after_control = range.after_control;
        Ok(range)
    }

    /// `prepare_caret_insert` 의 표시를 지운다. 네이티브가 오류로 끝나 표시를 소비하지
    /// 못했어도 다음 (에이전트) 삽입에 새지 않게 래퍼가 항상 호출한다.
    pub(crate) fn finish_caret_insert(&mut self) {
        self.caret_insert_after_control = None;
    }

    /// 논리 범위를 지운다. 범위 안의 글자처럼 취급 개체도 함께 지운다.
    ///
    /// `cell` 이 `Some((parent_para, path))` 이면 셀(중첩 포함) 문단, 아니면 본문이다.
    pub(crate) fn delete_caret_range_native(
        &mut self,
        section_idx: usize,
        cell: Option<(usize, &[(usize, usize, usize)])>,
        start_para: usize,
        start_offset: usize,
        end_para: usize,
        end_offset: usize,
    ) -> Result<String, HwpError> {
        let (text_start, mut text_end, stripped, through_final_table) = {
            let paras: &mut Vec<Paragraph> = match cell {
                Some((parent_para, path)) => {
                    self.get_cell_paragraphs_mut_by_path(section_idx, parent_para, path)?
                }
                None => {
                    &mut self
                        .document
                        .sections
                        .get_mut(section_idx)
                        .ok_or_else(|| {
                            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
                        })?
                        .paragraphs
                }
            };
            if start_para >= paras.len() || end_para >= paras.len() || start_para > end_para {
                return Err(HwpError::RenderError(format!(
                    "문단 인덱스 범위 오류 (start={}, end={}, 총 {}개)",
                    start_para,
                    end_para,
                    paras.len()
                )));
            }
            let end_host = &paras[end_para];
            let through_final_table =
                end_offset == logical_paragraph_length(end_host) + 1 && has_block_table(end_host);
            let (text_start, text_end, stripped) =
                strip_logical_range(paras, start_para, start_offset, end_para, end_offset);
            (text_start, text_end, stripped, through_final_table)
        };

        if through_final_table {
            let end_host = match cell {
                Some((parent_para, path)) => {
                    let paras =
                        self.get_cell_paragraphs_mut_by_path(section_idx, parent_para, path)?;
                    &mut paras[end_para]
                }
                None => &mut self.document.sections[section_idx].paragraphs[end_para],
            };
            remove_block_tables(end_host);
            text_end -= 1;
        }

        match cell {
            Some((parent_para, path)) => self.delete_range_in_cell_by_path(
                section_idx,
                parent_para,
                path,
                start_para,
                text_start,
                end_para,
                text_end,
            ),
            None => {
                if stripped && start_para == end_para && text_start == text_end {
                    // 개체만 지운 경우 delete_range_native 는 줄 높이를 다시 계산하지 않는다.
                    self.reflow_paragraph(section_idx, start_para);
                    self.document.sections[section_idx].raw_stream = None;
                }
                self.delete_range_native(
                    section_idx,
                    start_para,
                    text_start,
                    end_para,
                    text_end,
                    None,
                )
            }
        }
    }

    /// 구역을 넘는 본문 논리 범위를 지운다. 양 끝 문단의 범위 안 개체도 함께 지운다.
    pub(crate) fn delete_caret_range_across_sections_native(
        &mut self,
        start_section: usize,
        start_para: usize,
        start_offset: usize,
        end_section: usize,
        end_para: usize,
        end_offset: usize,
    ) -> Result<String, HwpError> {
        if start_section == end_section {
            return self.delete_caret_range_native(
                start_section,
                None,
                start_para,
                start_offset,
                end_para,
                end_offset,
            );
        }
        let text_start = strip_paragraph_logical_range(
            body_paragraph_mut(self, start_section, start_para)?,
            start_offset,
            usize::MAX,
        )
        .0;
        let through_final_table = {
            let host = body_paragraph_mut(self, end_section, end_para)?;
            end_offset == logical_paragraph_length(host) + 1 && has_block_table(host)
        };
        let mut text_end = strip_paragraph_logical_range(
            body_paragraph_mut(self, end_section, end_para)?,
            0,
            end_offset,
        )
        .1;
        if through_final_table {
            remove_block_tables(body_paragraph_mut(self, end_section, end_para)?);
            text_end -= 1;
        }
        self.delete_range_across_sections_native(
            start_section,
            start_para,
            text_start,
            end_section,
            end_para,
            text_end,
        )
    }
}

fn body_paragraph_mut(
    core: &mut DocumentCore,
    sec: usize,
    para: usize,
) -> Result<&mut Paragraph, HwpError> {
    core.document
        .sections
        .get_mut(sec)
        .and_then(|s| s.paragraphs.get_mut(para))
        .ok_or_else(|| HwpError::RenderError(format!("문단 접근 실패: sec={}, para={}", sec, para)))
}

fn remove_block_tables(para: &mut Paragraph) {
    for index in (0..para.controls.len()).rev() {
        if is_block_table_control(&para.controls[index]) {
            DocumentCore::remove_inline_control_with_metadata(para, index);
        }
    }
}

/// 논리 범위의 양 끝을 텍스트 오프셋으로 바꾸고 범위 안의 개체를 지운다.
/// 반환: (시작 문단 텍스트 오프셋, 끝 문단 텍스트 오프셋, 개체를 지웠는지)
fn strip_logical_range(
    paras: &mut [Paragraph],
    start_para: usize,
    start_offset: usize,
    end_para: usize,
    end_offset: usize,
) -> (usize, usize, bool) {
    if start_para == end_para {
        let (start, end, stripped) =
            strip_paragraph_logical_range(&mut paras[start_para], start_offset, end_offset);
        return (start, end, stripped);
    }
    let (text_start, _, stripped_start) =
        strip_paragraph_logical_range(&mut paras[start_para], start_offset, usize::MAX);
    let (_, text_end, stripped_end) =
        strip_paragraph_logical_range(&mut paras[end_para], 0, end_offset);
    (text_start, text_end, stripped_start || stripped_end)
}

/// 한 문단의 논리 범위 `[start, end)` 를 텍스트 범위로 바꾸고 범위 안 개체를 지운다.
/// 개체는 텍스트 글자가 아니므로 지워도 텍스트 오프셋은 변하지 않는다.
fn strip_paragraph_logical_range(
    para: &mut Paragraph,
    start: usize,
    end: usize,
) -> (usize, usize, bool) {
    let logical_len = crate::document_core::helpers::logical_paragraph_length(para);
    let through_final_table = end == logical_len + 1 && has_block_table(para);
    let end = end.min(logical_len).max(start.min(logical_len));
    let range = caret_text_range(para, start, end - start.min(end));
    let objects = inline_objects_in_logical_range(para, start, end);
    for control_idx in &objects {
        DocumentCore::remove_inline_control_with_metadata(para, *control_idx);
    }
    (
        range.start,
        range.end + usize::from(through_final_table),
        !objects.is_empty(),
    )
}

#[cfg(test)]
mod cross_table_selection_tests {
    use crate::document_core::DocumentCore;
    use crate::model::control::Control;

    #[test]
    fn 마지막_블록_표까지_선택하면_복사와_삭제에_표가_포함된다() {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core.insert_text_native(0, 0, 0, "앞").unwrap();
        core.split_paragraph_native(0, 0, 1, None).unwrap();
        let made: serde_json::Value =
            serde_json::from_str(&core.create_table_native(0, 1, 0, 1, 1).unwrap()).unwrap();
        let table_para = made["paraIdx"].as_u64().unwrap() as usize;
        let control = made["controlIdx"].as_u64().unwrap() as usize;
        core.document.sections[0]
            .paragraphs
            .truncate(table_para + 1);

        let (_, after) = core
            .table_boundary_position_native(0, table_para, &[], table_para, control, true)
            .unwrap();
        let refs: serde_json::Value = serde_json::from_str(
            &core
                .table_controls_in_selection_native(0, 0, &[], 0, 0, table_para, after)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(refs.as_array().unwrap().len(), 1);
        assert_eq!(refs[0]["ppi"], table_para);
        core.copy_selection_native(0, 0, 0, table_para, after)
            .unwrap();
        let copied = core.clipboard.as_ref().unwrap();
        assert!(copied
            .paragraphs
            .iter()
            .any(|para| para.controls.iter().any(|c| matches!(c, Control::Table(_)))));

        let before = format!("{:?}", core.document.sections);
        let snapshot = core.save_snapshot_native();
        core.delete_caret_range_native(0, None, 0, 0, table_para, after)
            .unwrap();
        assert!(!core.document.sections[0]
            .paragraphs
            .iter()
            .any(|para| para.controls.iter().any(|c| matches!(c, Control::Table(_)))));
        core.restore_snapshot_native(snapshot).unwrap();
        assert_eq!(format!("{:?}", core.document.sections), before);
    }
}
