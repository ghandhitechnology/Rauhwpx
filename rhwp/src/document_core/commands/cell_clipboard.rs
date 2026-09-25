//! 셀 블록의 일반 복사·잘라내기·붙여넣기. 내부 문단 클립보드와 HTML 내보내기를 공유한다.

use crate::document_core::{ClipboardData, DocumentCore};
use crate::error::HwpError;
use crate::model::{
    control::Control,
    paragraph::Paragraph,
    table::{Cell, Table},
};

type Rect = (u16, u16, u16, u16);

fn intersects(cell: &Cell, (sr, sc, er, ec): Rect) -> bool {
    cell.row <= er
        && cell.col <= ec
        && cell.row.saturating_add(cell.row_span) > sr
        && cell.col.saturating_add(cell.col_span) > sc
}

fn contained(cell: &Cell, (sr, sc, er, ec): Rect) -> bool {
    cell.row >= sr
        && cell.col >= sc
        && u32::from(cell.row) + u32::from(cell.row_span) <= u32::from(er) + 1
        && u32::from(cell.col) + u32::from(cell.col_span) <= u32::from(ec) + 1
}

fn validate_rect(table: &Table, rect: Rect) -> Result<(), HwpError> {
    let (sr, sc, er, ec) = rect;
    if sr > er || sc > ec || er >= table.row_count || ec >= table.col_count {
        return Err(HwpError::RenderError(
            "셀 범위가 표 크기를 벗어났습니다".into(),
        ));
    }
    if table
        .cells
        .iter()
        .any(|cell| intersects(cell, rect) && !contained(cell, rect))
    {
        return Err(HwpError::RenderError(
            "병합 셀 전체를 포함해 선택해 주세요".into(),
        ));
    }
    Ok(())
}

/// 선택 모서리가 병합 셀 안에 있으면 맞닿은 병합 셀 전체까지 확장한다.
fn expanded_rect(table: &Table, mut rect: Rect) -> Result<Rect, HwpError> {
    loop {
        let before = rect;
        for cell in &table.cells {
            if intersects(cell, rect) {
                rect.0 = rect.0.min(cell.row);
                rect.1 = rect.1.min(cell.col);
                rect.2 = rect.2.max(cell.row + cell.row_span.saturating_sub(1));
                rect.3 = rect.3.max(cell.col + cell.col_span.saturating_sub(1));
            }
        }
        if rect == before {
            break;
        }
    }
    validate_rect(table, rect)?;
    Ok(rect)
}

fn sync_dimensions(table: &mut Table, width: u32, height: u32) {
    use crate::model::shape::common_obj_offsets;
    table.common.width = width;
    table.common.height = height;
    if table.raw_ctrl_data.len() >= common_obj_offsets::HEIGHT.end {
        table.raw_ctrl_data[common_obj_offsets::WIDTH].copy_from_slice(&width.to_le_bytes());
        table.raw_ctrl_data[common_obj_offsets::HEIGHT].copy_from_slice(&height.to_le_bytes());
    }
}

fn refresh_structure(table: &mut Table) {
    table.cells.sort_by_key(|cell| (cell.row, cell.col));
    table.row_sizes = (0..table.row_count)
        .map(|row| table.cells.iter().filter(|cell| cell.row == row).count() as i16)
        .collect();
    // 셀 번호가 바뀌므로 이전 번호로 저장된 표시 폭/높이 보정은 재사용할 수 없다.
    table.local_resize_cell_widths.clear();
    table.local_resize_cell_heights.clear();
    table.rebuild_grid();
    table.dirty = true;
}

impl DocumentCore {
    pub fn copy_table_cell_range_native(
        &mut self,
        section: usize,
        parent: usize,
        path: &[(usize, usize, usize)],
        start_row: u16,
        start_col: u16,
        end_row: u16,
        end_col: u16,
    ) -> Result<String, HwpError> {
        let rect = (start_row, start_col, end_row, end_col);
        let source = self.resolve_table_by_path(section, parent, path)?;
        let rect = expanded_rect(source, rect)?;
        let (start_row, start_col, end_row, end_col) = rect;
        // 병합 셀만 남은 열도 renderer와 같은 격자 폭으로 계산한다.
        let columns = self
            .layout_engine
            .resolve_column_widths(source, source.col_count as usize);
        let width = crate::renderer::px_to_hwpunit_round(
            columns[start_col as usize..=end_col as usize].iter().sum(),
            self.dpi,
        )
        .max(0) as u32;
        let mut table = source.clone();
        table.cells.retain(|cell| contained(cell, rect));
        for cell in &mut table.cells {
            cell.row -= start_row;
            cell.col -= start_col;
            // 병합 직후에는 각 원본 셀 문단이 vpos=0을 가진다. 복사본은 새 셀의
            // 연속 문단이므로 좌표와 최소 높이를 확정한 뒤 중첩 표에도 재사용한다.
            super::text_editing::recalculate_cell_paragraph_vpos(
                &mut cell.paragraphs,
                0,
                None,
                &self.styles,
                self.dpi,
                self.document.layout_profile().hwp3_layout(),
            );
            let content_bottom = cell
                .paragraphs
                .iter()
                .flat_map(|paragraph| &paragraph.line_segs)
                .map(|line| line.vertical_pos.saturating_add(line.line_height))
                .max()
                .unwrap_or(0)
                .max(0) as u32;
            let padding = cell.effective_padding(&table.padding);
            let padding_height = i32::from(padding.top)
                .saturating_add(i32::from(padding.bottom))
                .max(0) as u32;
            cell.height = cell
                .height
                .max(content_bottom.saturating_add(padding_height));
        }
        table.row_count = end_row - start_row + 1;
        table.col_count = end_col - start_col + 1;
        table.zones.clear();
        table.caption = None;
        table.local_resize_rows.clear();
        table.local_resize_cols.clear();
        refresh_structure(&mut table);
        let height = table.get_row_heights().iter().sum();
        sync_dimensions(&mut table, width, height);
        let html = self.table_to_html(&table);
        let mut paragraph = Paragraph::new_empty();
        paragraph.char_count = 9;
        paragraph.control_mask = 1 << 11;
        paragraph.has_para_text = true;
        paragraph.controls.push(Control::Table(Box::new(table)));
        paragraph.ctrl_data_records.push(None);
        let text = super::clipboard::paragraph_plain_text(&paragraph);
        self.clipboard = Some(ClipboardData {
            paragraphs: vec![paragraph],
            plain_text: text.clone(),
        });
        self.paste_cascade_count = 0;
        Ok(serde_json::json!({"ok": true, "text": text, "html": html}).to_string())
    }

    /// 셀에 삽입하는 표 복사본만 대상 폭으로 맞추고 자식 문단의 흐름을 다시 만든다.
    pub(super) fn prepare_pasted_tables_for_cell(
        &self,
        paragraphs: &mut [Paragraph],
        available_width: u32,
    ) {
        use crate::renderer::{composer::reflow_line_segs, hwpunit_to_px, px_to_hwpunit_round};
        for paragraph in paragraphs {
            for control in &mut paragraph.controls {
                let Control::Table(table) = control else {
                    continue;
                };
                // 셀 안에 새로 붙인 표는 글자 흐름에 참여해야 기존 글과 겹치지 않는다.
                table.common.treat_as_char = true;
                table.common.attr |= 1;
                if table.raw_ctrl_data.len() >= 4 {
                    let flags =
                        u32::from_le_bytes(table.raw_ctrl_data[..4].try_into().unwrap()) | 1;
                    table.raw_ctrl_data[..4].copy_from_slice(&flags.to_le_bytes());
                }
                let columns = self
                    .layout_engine
                    .resolve_column_widths(table, table.col_count as usize);
                let current_width: f64 = columns.iter().sum();
                let maximum = hwpunit_to_px(available_width as i32, self.dpi);
                let scale = if current_width > maximum && current_width > 0.0 {
                    maximum / current_width
                } else {
                    1.0
                };
                let widths: Vec<u32> = columns
                    .iter()
                    .map(|width| px_to_hwpunit_round(width * scale, self.dpi).max(1) as u32)
                    .collect();
                let _ = table.set_column_widths(&widths);
                table.local_resize_cell_widths.clear();
                table.local_resize_cell_heights.clear();
                for cell in &mut table.cells {
                    let padding = cell.effective_padding(&table.padding);
                    let horizontal_padding =
                        (i32::from(padding.left) + i32::from(padding.right)).max(0) as u32;
                    let inner_width = cell.width.saturating_sub(horizontal_padding);
                    self.prepare_pasted_tables_for_cell(&mut cell.paragraphs, inner_width);
                    for paragraph in &mut cell.paragraphs {
                        let style = self
                            .styles
                            .para_styles
                            .get(paragraph.para_shape_id as usize);
                        let margins =
                            style.map_or(0.0, |style| style.margin_left + style.margin_right);
                        reflow_line_segs(
                            paragraph,
                            (hwpunit_to_px(inner_width as i32, self.dpi) - margins).max(0.0),
                            &self.styles,
                            self.dpi,
                        );
                    }
                    super::text_editing::recalculate_cell_paragraph_vpos(
                        &mut cell.paragraphs,
                        0,
                        None,
                        &self.styles,
                        self.dpi,
                        self.document.layout_profile().hwp3_layout(),
                    );
                    let bottom = cell
                        .paragraphs
                        .iter()
                        .flat_map(|paragraph| &paragraph.line_segs)
                        .map(|line| line.vertical_pos.saturating_add(line.line_height))
                        .max()
                        .unwrap_or(0)
                        .max(0) as u32;
                    let vertical_padding =
                        (i32::from(padding.top) + i32::from(padding.bottom)).max(0) as u32;
                    cell.height = cell.height.max(bottom.saturating_add(vertical_padding));
                }
                let height = table.get_row_heights().iter().sum();
                sync_dimensions(table, widths.iter().sum(), height);
                table.dirty = true;
            }
        }
    }

    pub fn paste_table_cell_range_native(
        &mut self,
        section: usize,
        parent: usize,
        path: &[(usize, usize, usize)],
        start_row: u16,
        start_col: u16,
    ) -> Result<String, HwpError> {
        let mut paragraphs = self
            .clipboard
            .as_ref()
            .map(|clip| clip.paragraphs.clone())
            .ok_or_else(|| HwpError::RenderError("복사한 셀이 없습니다".into()))?;
        self.renumber_pasted_field_ids(&mut paragraphs);
        let source = match paragraphs.as_slice() {
            [paragraph] if paragraph.text.is_empty() => match paragraph.controls.as_slice() {
                [Control::Table(table)] => table.as_ref(),
                _ => {
                    return Err(HwpError::RenderError(
                        "복사한 내용이 셀 블록이 아닙니다".into(),
                    ))
                }
            },
            _ => {
                return Err(HwpError::RenderError(
                    "복사한 내용이 셀 블록이 아닙니다".into(),
                ))
            }
        };
        let er = start_row
            .checked_add(source.row_count.saturating_sub(1))
            .ok_or_else(|| HwpError::RenderError("대상 행 범위가 너무 큽니다".into()))?;
        let ec = start_col
            .checked_add(source.col_count.saturating_sub(1))
            .ok_or_else(|| HwpError::RenderError("대상 열 범위가 너무 큽니다".into()))?;
        let rect = (start_row, start_col, er, ec);
        let table = self.resolve_table_mut_by_cell_path(section, parent, path)?;
        validate_rect(table, rect)?;
        if table
            .cells
            .iter()
            .any(|cell| contained(cell, rect) && cell.cell_protect())
        {
            return Err(HwpError::RenderError(
                "보호된 셀은 수정할 수 없습니다".into(),
            ));
        }
        let widths = table.get_column_widths();
        let heights = table.get_row_heights();
        table.cells.retain(|cell| !contained(cell, rect));
        for cell in &source.cells {
            let mut cell = cell.clone();
            cell.row += start_row;
            cell.col += start_col;
            cell.width = widths[cell.col as usize..(cell.col + cell.col_span) as usize]
                .iter()
                .sum();
            cell.height = heights[cell.row as usize..(cell.row + cell.row_span) as usize]
                .iter()
                .sum();
            table.cells.push(cell);
        }
        refresh_structure(table);
        let changed: Vec<_> = table
            .cells
            .iter()
            .enumerate()
            .filter(|(_, cell)| contained(cell, rect))
            .map(|(index, cell)| (index, cell.paragraphs.len()))
            .collect();
        self.finish_cell_clipboard_edit(section, parent, path, &changed);
        Ok("{\"ok\":true}".into())
    }

    pub fn clear_table_cell_range_native(
        &mut self,
        section: usize,
        parent: usize,
        path: &[(usize, usize, usize)],
        start_row: u16,
        start_col: u16,
        end_row: u16,
        end_col: u16,
    ) -> Result<String, HwpError> {
        let rect = (start_row, start_col, end_row, end_col);
        let table = self.resolve_table_mut_by_cell_path(section, parent, path)?;
        let rect = expanded_rect(table, rect)?;
        if table
            .cells
            .iter()
            .any(|cell| contained(cell, rect) && cell.cell_protect())
        {
            return Err(HwpError::RenderError(
                "보호된 셀은 수정할 수 없습니다".into(),
            ));
        }
        let mut changed = Vec::new();
        for (index, cell) in table
            .cells
            .iter_mut()
            .enumerate()
            .filter(|(_, cell)| contained(cell, rect))
        {
            let empty = Cell::new_from_template(cell.col, cell.row, cell.width, cell.height, cell);
            cell.paragraphs = empty.paragraphs;
            changed.push((index, 1));
        }
        table.dirty = true;
        self.finish_cell_clipboard_edit(section, parent, path, &changed);
        Ok("{\"ok\":true}".into())
    }

    fn finish_cell_clipboard_edit(
        &mut self,
        section: usize,
        parent: usize,
        path: &[(usize, usize, usize)],
        changed: &[(usize, usize)],
    ) {
        let mut target = path.to_vec();
        let depth = target.len() - 1;
        for &(cell, count) in changed {
            target[depth].1 = cell;
            for paragraph in 0..count {
                target[depth].2 = paragraph;
                self.reflow_cell_paragraph_by_path(section, parent, &target, paragraph);
            }
            target[depth].2 = 0;
            self.recalculate_cell_paragraph_vpos_by_path(section, parent, &target, 0, None);
        }
        self.event_log
            .push(crate::model::event::DocumentEvent::CellTextChanged {
                section,
                para: parent,
                ctrl: path[0].0,
                cell: path[0].1,
            });
        self.mark_cell_control_dirty(section, parent, path[0].0);
        self.document.sections[section].raw_stream = None;
        self.layout_engine.clear_layout_caches();
        self.mark_section_dirty(section);
        self.paginate_if_needed();
    }
}
