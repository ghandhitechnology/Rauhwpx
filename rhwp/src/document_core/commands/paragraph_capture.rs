//! 에이전트 대기 편집의 문단 단위 역연산 저장소.
//!
//! 표 구조·속성 변경, 스타일 적용, 기존 머리말/꼬리말 교체처럼 한 본문 문단 안에서
//! 끝나는 변경을 문서 전체 스냅샷 없이 정확히 되돌린다. 문단 전체(컨트롤 포함)를
//! 복제해 두었다가 같은 자리의 문단과 통째로 바꾼다. 스냅샷 저장소와 달리 코어가
//! 자동 축출하지 않는다 — TS PendingEditManager 가 ID 수명을 소유한다.
//!
//! 내용 지문은 레이아웃(line_segs)을 제외한 텍스트·구조·모양 ID의 해시다. 되돌리기 전
//! 문단이 적용 직후 그대로인지(사이에 사용자가 손대지 않았는지) 판별하는 데 쓴다.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;

/// 보관 한도 — 초과 시 캡처가 실패하고 호출자는 문서 스냅샷으로 폴백한다.
const MAX_PARAGRAPH_CAPTURES: usize = 4096;

fn error(message: String) -> HwpError {
    HwpError::RenderError(message)
}

fn hash_paragraphs(paragraphs: &[Paragraph], h: &mut DefaultHasher) {
    paragraphs.len().hash(h);
    for paragraph in paragraphs {
        hash_paragraph(paragraph, h);
    }
}

fn hash_paragraph(p: &Paragraph, h: &mut DefaultHasher) {
    p.text.hash(h);
    p.char_offsets.hash(h);
    p.para_shape_id.hash(h);
    p.style_id.hash(h);
    // 분할·병합은 같은 모양의 경계를 남기거나 빈 목록을 0번 모양으로 채울 수 있다 —
    // 내용이 같으면 같은 지문이 되도록 빈 목록은 0번 모양 하나로 보고, 앞과 같은
    // 모양으로 바뀌는 경계는 뺀다.
    let mut current = 0u32;
    for run in &p.char_shapes {
        if run.char_shape_id == current {
            continue;
        }
        run.start_pos.hash(h);
        run.char_shape_id.hash(h);
        current = run.char_shape_id;
    }
    p.controls.len().hash(h);
    for control in &p.controls {
        hash_control(control, h);
    }
}

/// 레이아웃 캐시가 없는 순수 속성 값은 Debug 표현으로 지문에 넣는다.
fn hash_debug<T: std::fmt::Debug>(value: &T, h: &mut DefaultHasher) {
    format!("{:?}", value).hash(h);
}

fn hash_control(control: &Control, h: &mut DefaultHasher) {
    std::mem::discriminant(control).hash(h);
    match control {
        Control::Table(t) => {
            t.row_count.hash(h);
            t.col_count.hash(h);
            t.border_fill_id.hash(h);
            t.repeat_header.hash(h);
            t.attr.hash(h);
            t.cell_spacing.hash(h);
            hash_debug(&t.padding, h);
            hash_debug(&t.page_break, h);
            hash_debug(&t.common, h);
            (t.outer_margin_left, t.outer_margin_right).hash(h);
            (t.outer_margin_top, t.outer_margin_bottom).hash(h);
            t.cells.len().hash(h);
            for cell in &t.cells {
                cell.row.hash(h);
                cell.col.hash(h);
                cell.row_span.hash(h);
                cell.col_span.hash(h);
                cell.width.hash(h);
                cell.height.hash(h);
                cell.border_fill_id.hash(h);
                hash_debug(&cell.padding, h);
                hash_debug(&cell.vertical_align, h);
                cell.text_direction.hash(h);
                cell.apply_inner_margin.hash(h);
                cell.is_header.hash(h);
                cell.field_name.hash(h);
                hash_paragraphs(&cell.paragraphs, h);
            }
            match &t.caption {
                Some(caption) => {
                    true.hash(h);
                    hash_paragraphs(&caption.paragraphs, h);
                }
                None => false.hash(h),
            }
        }
        Control::Header(hf) => hash_paragraphs(&hf.paragraphs, h),
        Control::Footer(hf) => hash_paragraphs(&hf.paragraphs, h),
        Control::Footnote(note) => hash_paragraphs(&note.paragraphs, h),
        Control::Endnote(note) => hash_paragraphs(&note.paragraphs, h),
        // 같은 문단의 개체를 사용자가 옮기거나 크기를 바꿨는지 본다.
        Control::Picture(pic) => hash_debug(&pic.common, h),
        Control::Shape(shape) => hash_debug(shape.common(), h),
        Control::Equation(eq) => {
            hash_debug(&eq.common, h);
            eq.script.hash(h);
        }
        _ => {}
    }
}

impl DocumentCore {
    fn check_body_paragraph(&self, section_idx: usize, para_idx: usize) -> Result<(), HwpError> {
        let section = self
            .document
            .sections
            .get(section_idx)
            .ok_or_else(|| error(format!("구역 인덱스 {} 범위 초과", section_idx)))?;
        if para_idx >= section.paragraphs.len() {
            return Err(error(format!("문단 인덱스 {} 범위 초과", para_idx)));
        }
        Ok(())
    }

    /// 본문 문단 하나를 통째로 보관하고 ID를 돌려준다.
    pub fn capture_paragraph_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<u32, HwpError> {
        self.check_body_paragraph(section_idx, para_idx)?;
        if self.paragraph_capture_store.len() >= MAX_PARAGRAPH_CAPTURES {
            return Err(error("문단 보관 한도 초과".to_string()));
        }
        let id = self.next_paragraph_capture_id;
        self.next_paragraph_capture_id = id
            .checked_add(1)
            .ok_or_else(|| error("문단 보관 ID 소진".to_string()))?;
        let paragraph = self.document.sections[section_idx].paragraphs[para_idx].clone();
        self.paragraph_capture_store.push((id, paragraph));
        Ok(id)
    }

    /// 보관한 문단으로 지정 위치의 문단을 바꾼다. 보관본은 남는다(해제는 discard).
    pub fn restore_captured_paragraph_native(
        &mut self,
        id: u32,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<(), HwpError> {
        self.check_body_paragraph(section_idx, para_idx)?;
        let mut paragraph = self
            .paragraph_capture_store
            .iter()
            .find(|(key, _)| *key == id)
            .map(|(_, paragraph)| paragraph.clone())
            .ok_or_else(|| error(format!("문단 보관 ID {} 없음", id)))?;
        // 스냅샷 선택 복원과 같은 규칙: 복원한 표는 측정 캐시를 다시 만든다.
        for control in &mut paragraph.controls {
            if let Control::Table(table) = control {
                table.dirty = true;
            }
        }
        let section = &mut self.document.sections[section_idx];
        section.paragraphs[para_idx] = paragraph;
        section.raw_stream = None;
        self.event_log.mark_paragraph_changed(section_idx, para_idx);
        self.recompose_paragraph(section_idx, para_idx);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();
        Ok(())
    }

    pub fn discard_paragraph_capture_native(&mut self, id: u32) {
        self.paragraph_capture_store.retain(|(key, _)| *key != id);
    }

    /// 레이아웃을 뺀 문단 내용 지문 (16자리 hex).
    pub fn paragraph_content_digest_native(
        &self,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<String, HwpError> {
        self.check_body_paragraph(section_idx, para_idx)?;
        let mut hasher = DefaultHasher::new();
        hash_paragraph(
            &self.document.sections[section_idx].paragraphs[para_idx],
            &mut hasher,
        );
        Ok(format!("{:016x}", hasher.finish()))
    }
}

#[cfg(test)]
mod tests {
    use crate::document_core::DocumentCore;

    fn table_document() -> DocumentCore {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().expect("blank document");
        core.insert_text_native(0, 0, 0, "앞 문단")
            .expect("insert text");
        let created = core
            .create_table_native(0, 0, 4, 3, 2)
            .expect("create table");
        assert!(created.contains("\"ok\":true"), "{created}");
        core
    }

    fn table_para(core: &DocumentCore) -> usize {
        core.document.sections[0]
            .paragraphs
            .iter()
            .position(|p| {
                p.controls
                    .iter()
                    .any(|c| matches!(c, crate::model::control::Control::Table(_)))
            })
            .expect("table paragraph")
    }

    #[test]
    fn restore_brings_back_a_deleted_table_row_exactly() {
        let mut core = table_document();
        let para = table_para(&core);
        let before = core.paragraph_content_digest_native(0, para).unwrap();
        let pages_before = core.page_count();
        let id = core.capture_paragraph_native(0, para).unwrap();

        core.delete_table_row_native(0, para, 0, 1)
            .expect("delete row");
        let after = core.paragraph_content_digest_native(0, para).unwrap();
        assert_ne!(before, after, "행 삭제는 지문을 바꾼다");

        core.restore_captured_paragraph_native(id, 0, para).unwrap();
        assert_eq!(
            core.paragraph_content_digest_native(0, para).unwrap(),
            before
        );
        assert_eq!(core.page_count(), pages_before);
        let dims = core.get_table_dimensions_native(0, para, 0).unwrap();
        assert!(dims.contains("\"rowCount\":3"), "{dims}");

        core.discard_paragraph_capture_native(id);
        assert!(core.restore_captured_paragraph_native(id, 0, para).is_err());
    }

    #[test]
    fn restore_reinserts_a_deleted_table_control() {
        let mut core = table_document();
        let para = table_para(&core);
        let before = core.paragraph_content_digest_native(0, para).unwrap();
        let id = core.capture_paragraph_native(0, para).unwrap();

        core.delete_table_control_native(0, para, 0)
            .expect("delete table");
        assert!(core.get_table_dimensions_native(0, para, 0).is_err());

        core.restore_captured_paragraph_native(id, 0, para).unwrap();
        assert_eq!(
            core.paragraph_content_digest_native(0, para).unwrap(),
            before
        );
        assert!(core.get_table_dimensions_native(0, para, 0).is_ok());
    }

    #[test]
    fn digest_ignores_layout_but_sees_cell_text() {
        let mut core = table_document();
        let para = table_para(&core);
        let before = core.paragraph_content_digest_native(0, para).unwrap();
        core.document.sections[0].paragraphs[para].line_segs.clear();
        assert_eq!(
            core.paragraph_content_digest_native(0, para).unwrap(),
            before
        );
        core.insert_text_in_cell_native(0, para, 0, 0, 0, 0, "셀")
            .expect("cell text");
        assert_ne!(
            core.paragraph_content_digest_native(0, para).unwrap(),
            before
        );
    }
}
