//! 책갈피 조회/조작 기능

use crate::document_core::helpers::find_control_text_positions;
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::{Bookmark, Control};

/// 책갈피 정보
#[derive(Debug, Clone)]
struct BookmarkInfo {
    name: String,
    sec: usize,
    para: usize,
    ctrl_idx: usize,
    /// 텍스트 내 위치 (정렬용)
    char_pos: usize,
}

impl DocumentCore {
    /// 문서 내 모든 책갈피 목록을 JSON으로 반환
    pub fn get_bookmarks_native(&self) -> Result<String, HwpError> {
        let bookmarks = self.collect_bookmarks();
        let items: Vec<String> = bookmarks
            .iter()
            .map(|b| {
                format!(
                    "{{\"name\":{},\"sec\":{},\"para\":{},\"ctrlIdx\":{},\"charPos\":{}}}",
                    json_escape(&b.name),
                    b.sec,
                    b.para,
                    b.ctrl_idx,
                    b.char_pos
                )
            })
            .collect();
        Ok(format!("[{}]", items.join(",")))
    }

    /// 책갈피 추가
    ///
    /// 지정 위치에 Bookmark 컨트롤을 삽입한다.
    /// 중복 이름은 거부한다.
    pub fn add_bookmark_native(
        &mut self,
        sec: usize,
        para: usize,
        char_offset: usize,
        name: &str,
    ) -> Result<String, HwpError> {
        if name.trim().is_empty() {
            return Ok(r#"{"ok":false,"error":"책갈피 이름을 입력하세요."}"#.to_string());
        }

        // 중복 검사
        let existing = self.collect_bookmarks();
        if existing.iter().any(|b| b.name == name) {
            return Ok(
                r#"{"ok":false,"error":"같은 이름의 책갈피가 이미 등록되어 있습니다."}"#
                    .to_string(),
            );
        }

        let section = self
            .document
            .sections
            .get_mut(sec)
            .ok_or_else(|| HwpError::RenderError("구역 범위 초과".into()))?;
        let paragraph = section
            .paragraphs
            .get_mut(para)
            .ok_or_else(|| HwpError::RenderError("문단 범위 초과".into()))?;

        // char_offset에 해당하는 컨트롤 삽입 위치 결정
        let insert_idx = find_control_insert_index(paragraph, char_offset);

        // 책갈피도 확장 컨트롤이라 char_offsets 사이의 8 code unit 갭을 차지한다.
        // char_offsets 는 텍스트 글자마다 하나이므로 항목을 끼우지 않고 뒤쪽 글자를 민다.
        paragraph.shift_for_inline_control_insert(char_offset);
        paragraph.controls.insert(
            insert_idx,
            Control::Bookmark(Bookmark {
                name: name.to_string(),
            }),
        );

        // CTRL_DATA 레코드 생성 (ParameterSet: 책갈피 이름)
        let ctrl_data = build_bookmark_ctrl_data(name);
        if paragraph.ctrl_data_records.len() >= insert_idx {
            paragraph
                .ctrl_data_records
                .insert(insert_idx, Some(ctrl_data));
        }
        for field in &mut paragraph.field_ranges {
            if field.control_idx >= insert_idx {
                field.control_idx += 1;
            }
        }
        paragraph.char_count += 8;

        // 원본 스트림 무효화 — serialize_section 은 raw_stream 이 있으면 IR 을 무시하고
        // 원본 바이트를 그대로 반환하므로(serializer/body_text.rs), 비우지 않으면 방금
        // 삽입한 책갈피 컨트롤이 저장 시 통째로 사라진다.
        section.raw_stream = None;
        self.finish_bookmark_edit(sec, para);

        Ok(r#"{"ok":true}"#.to_string())
    }

    /// 책갈피 삭제
    pub fn delete_bookmark_native(
        &mut self,
        sec: usize,
        para: usize,
        ctrl_idx: usize,
    ) -> Result<String, HwpError> {
        let section = self
            .document
            .sections
            .get_mut(sec)
            .ok_or_else(|| HwpError::RenderError("구역 범위 초과".into()))?;
        let paragraph = section
            .paragraphs
            .get_mut(para)
            .ok_or_else(|| HwpError::RenderError("문단 범위 초과".into()))?;

        if ctrl_idx >= paragraph.controls.len() {
            return Ok(r#"{"ok":false,"error":"컨트롤 인덱스 범위 초과"}"#.to_string());
        }

        // Bookmark인지 확인
        if !matches!(&paragraph.controls[ctrl_idx], Control::Bookmark(_)) {
            return Ok(r#"{"ok":false,"error":"해당 컨트롤이 책갈피가 아닙니다."}"#.to_string());
        }

        // 컨트롤과 그 8 code unit 갭을 함께 지운다 (글자 모양·영역 태그·필드 참조 포함).
        Self::remove_inline_control_with_metadata(paragraph, ctrl_idx);

        // 원본 스트림 무효화 — 비우지 않으면 삭제한 책갈피가 저장 시 원본 바이트로 되살아난다.
        section.raw_stream = None;
        self.finish_bookmark_edit(sec, para);

        Ok(r#"{"ok":true}"#.to_string())
    }

    /// 책갈피 이름 변경
    pub fn rename_bookmark_native(
        &mut self,
        sec: usize,
        para: usize,
        ctrl_idx: usize,
        new_name: &str,
    ) -> Result<String, HwpError> {
        if new_name.trim().is_empty() {
            return Ok(r#"{"ok":false,"error":"책갈피 이름을 입력하세요."}"#.to_string());
        }

        // 중복 검사 (자기 자신 제외)
        let existing = self.collect_bookmarks();
        if existing.iter().any(|b| {
            b.name == new_name && !(b.sec == sec && b.para == para && b.ctrl_idx == ctrl_idx)
        }) {
            return Ok(
                r#"{"ok":false,"error":"같은 이름의 책갈피가 이미 등록되어 있습니다."}"#
                    .to_string(),
            );
        }

        let section = self
            .document
            .sections
            .get_mut(sec)
            .ok_or_else(|| HwpError::RenderError("구역 범위 초과".into()))?;
        let paragraph = section
            .paragraphs
            .get_mut(para)
            .ok_or_else(|| HwpError::RenderError("문단 범위 초과".into()))?;

        if ctrl_idx >= paragraph.controls.len() {
            return Ok(r#"{"ok":false,"error":"컨트롤 인덱스 범위 초과"}"#.to_string());
        }

        if let Control::Bookmark(ref mut bm) = paragraph.controls[ctrl_idx] {
            bm.name = new_name.to_string();
            // CTRL_DATA도 갱신
            if ctrl_idx < paragraph.ctrl_data_records.len() {
                paragraph.ctrl_data_records[ctrl_idx] = Some(build_bookmark_ctrl_data(new_name));
            }
            // 원본 스트림 무효화 — 비우지 않으면 이름 변경이 저장 시 옛 이름으로 되돌아간다.
            if let Some(s) = self.document.sections.get_mut(sec) {
                s.raw_stream = None;
            }
            // 스냅샷이 옛 문단을 공유하지 않도록 문단 revision 을 올린다.
            self.event_log.mark_paragraph_changed(sec, para);
            self.recompose_section(sec);
            Ok(r#"{"ok":true}"#.to_string())
        } else {
            Ok(r#"{"ok":false,"error":"해당 컨트롤이 책갈피가 아닙니다."}"#.to_string())
        }
    }

    /// 책갈피 추가·삭제 뒤처리. 문단 revision 을 올리지 않으면 이후 스냅샷이 옛 문단을
    /// 공유해 undo/승인 복원에서 책갈피가 사라진다. 갭이 줄 시작 위치를 밀었으므로
    /// 문단을 다시 흘린다.
    fn finish_bookmark_edit(&mut self, sec: usize, para: usize) {
        self.event_log.mark_paragraph_changed(sec, para);
        self.reflow_paragraph(sec, para);
        self.recompose_section(sec);
        self.paginate_if_needed();
    }

    /// 내부: 모든 책갈피 수집 (중첩 구조 포함)
    fn collect_bookmarks(&self) -> Vec<BookmarkInfo> {
        let mut result = vec![];
        for (sec_idx, section) in self.document.sections.iter().enumerate() {
            collect_bookmarks_from_paragraphs(&section.paragraphs, sec_idx, None, &mut result);
        }
        result
    }
}

/// 문단 목록에서 책갈피를 재귀적으로 수집 (표 셀, 글상자 등 중첩 구조 포함)
///
/// `host_para`: 중첩 구조의 경우 소속 최상위 문단 인덱스. None이면 최상위 레벨.
fn collect_bookmarks_from_paragraphs(
    paragraphs: &[crate::model::paragraph::Paragraph],
    sec: usize,
    host_para: Option<usize>,
    result: &mut Vec<BookmarkInfo>,
) {
    for (para_idx, para) in paragraphs.iter().enumerate() {
        // 최상위 레벨이면 para_idx 사용, 중첩이면 호스트 문단 인덱스 유지
        let effective_para = host_para.unwrap_or(para_idx);
        let positions = find_control_text_positions(para);
        for (ctrl_idx, ctrl) in para.controls.iter().enumerate() {
            match ctrl {
                Control::Bookmark(bm) => {
                    let char_pos = if host_para.is_some() {
                        // 중첩 구조 내 책갈피: 호스트 문단 시작점으로 이동
                        0
                    } else {
                        positions.get(ctrl_idx).copied().unwrap_or(0)
                    };
                    result.push(BookmarkInfo {
                        name: bm.name.clone(),
                        sec,
                        para: effective_para,
                        ctrl_idx,
                        char_pos,
                    });
                }
                Control::Table(t) => {
                    for cell in &t.cells {
                        collect_bookmarks_from_paragraphs(
                            &cell.paragraphs,
                            sec,
                            Some(effective_para),
                            result,
                        );
                    }
                }
                Control::Header(h) => {
                    collect_bookmarks_from_paragraphs(
                        &h.paragraphs,
                        sec,
                        Some(effective_para),
                        result,
                    );
                }
                Control::Footer(f) => {
                    collect_bookmarks_from_paragraphs(
                        &f.paragraphs,
                        sec,
                        Some(effective_para),
                        result,
                    );
                }
                Control::Footnote(n) => {
                    collect_bookmarks_from_paragraphs(
                        &n.paragraphs,
                        sec,
                        Some(effective_para),
                        result,
                    );
                }
                Control::Endnote(n) => {
                    collect_bookmarks_from_paragraphs(
                        &n.paragraphs,
                        sec,
                        Some(effective_para),
                        result,
                    );
                }
                Control::HiddenComment(hc) => {
                    collect_bookmarks_from_paragraphs(
                        &hc.paragraphs,
                        sec,
                        Some(effective_para),
                        result,
                    );
                }
                _ => {}
            }
        }
    }
}

/// 문단 내 char_offset에 해당하는 컨트롤 삽입 위치를 결정
fn find_control_insert_index(
    para: &crate::model::paragraph::Paragraph,
    char_offset: usize,
) -> usize {
    let positions = find_control_text_positions(para);
    // char_offset보다 큰 위치를 가진 첫 번째 컨트롤의 인덱스
    for (i, &pos) in positions.iter().enumerate() {
        if pos > char_offset {
            return i;
        }
    }
    para.controls.len()
}

/// 책갈피 CTRL_DATA 바이너리 생성 (ParameterSet 형식)
///
/// 구조: ps_id(2) + count(2) + dummy(2) + item_id(2) + item_type(2) + name_len(2) + name(UTF-16LE)
fn build_bookmark_ctrl_data(name: &str) -> Vec<u8> {
    let utf16: Vec<u16> = name.encode_utf16().collect();
    let mut data = Vec::with_capacity(12 + utf16.len() * 2);
    data.extend_from_slice(&0x021Bu16.to_le_bytes()); // ps_id
    data.extend_from_slice(&1i16.to_le_bytes()); // count = 1
    data.extend_from_slice(&0u16.to_le_bytes()); // dummy
    data.extend_from_slice(&0x4000u16.to_le_bytes()); // item_id
    data.extend_from_slice(&1u16.to_le_bytes()); // item_type = String
    data.extend_from_slice(&(utf16.len() as u16).to_le_bytes()); // name_len
    for &ch in &utf16 {
        data.extend_from_slice(&ch.to_le_bytes());
    }
    data
}

/// JSON 문자열 이스케이프
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    //! 책갈피 추가/삭제/이름변경의 raw_stream 무효화 회귀 테스트.
    //!
    //! serialize_section(serializer/body_text.rs)은 raw_stream 이 Some 이면 IR 을 무시하고
    //! 원본 바이트를 그대로 반환한다. HWP5 파서는 모든 섹션에 raw_stream 을 채우므로
    //! (parser/mod.rs), 세 뮤테이터가 raw_stream 을 비우지 않으면 — 책갈피 추가·삭제·
    //! 이름변경만 하고 저장하는 워크플로에서 — 편집이 저장 시 통째로 유실된다.
    //! recompose_section 은 화면만 갱신할 뿐 raw_stream 을 건드리지 않는다.
    //! 누름틀 set_field_value_*(field_query.rs)·양식 set_form_value_*(form_query.rs)는
    //! 같은 불변식을 이미 지킨다.

    use crate::document_core::DocumentCore;
    use crate::model::control::{Bookmark, Control};
    use crate::model::document::{Document, Section};
    use crate::model::paragraph::Paragraph;
    use crate::serializer::body_text::serialize_section;

    const SENTINEL: u8 = 0xAB;

    fn core_from(doc: Document) -> DocumentCore {
        let mut core = DocumentCore::new_empty();
        core.document = doc;
        core.composed = vec![Vec::new()];
        core.dirty_sections = vec![true];
        core.dirty_paragraphs = vec![None];
        core
    }

    /// 파싱된 문서를 흉내낸다 — 섹션이 원본 스트림 바이트를 물고 있는 상태.
    fn doc_with_raw_stream(paragraphs: Vec<Paragraph>) -> Document {
        let mut doc = Document::default();
        doc.sections.push(Section {
            paragraphs,
            raw_stream: Some(vec![SENTINEL; 64]),
            raw_provenance: None,
            ..Default::default()
        });
        doc
    }

    fn text_para(text: &str) -> Paragraph {
        let mut p = Paragraph {
            text: text.to_string(),
            char_offsets: (0..text.chars().count() as u32).collect(),
            char_count: text.chars().count() as u32,
            ..Default::default()
        };
        p.has_para_text = true;
        p
    }

    fn para_with_bookmark(name: &str) -> Paragraph {
        let mut p = Paragraph::default();
        p.controls.push(Control::Bookmark(Bookmark {
            name: name.to_string(),
        }));
        p
    }

    /// 책갈피는 글자 사이 갭을 차지한다 — 글자 오프셋을 흩뜨리지 않고, 이후 스냅샷이
    /// 옛 문단을 공유하지 않아 승인/undo 복원에서 사라지지 않아야 한다.
    #[test]
    fn add_bookmark_keeps_text_offsets_and_survives_snapshots() {
        use crate::document_core::helpers::find_control_text_positions;
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().expect("blank document");
        core.insert_text_native(0, 0, 0, "Closing paragraph.")
            .expect("text");
        core.insert_footnote_native(0, 0, 3).expect("footnote");
        let offsets_before = core.document.sections[0].paragraphs[0].char_offsets.clone();
        let baseline = core.save_snapshot_native();

        core.add_bookmark_native(0, 0, 1, "mark").expect("bookmark");
        let para = &core.document.sections[0].paragraphs[0];
        assert_eq!(para.text, "Closing paragraph.");
        assert_eq!(para.char_offsets.len(), para.text.chars().count());
        let kinds: Vec<(bool, usize)> = para
            .controls
            .iter()
            .zip(find_control_text_positions(para))
            .filter(|(c, _)| matches!(c, Control::Bookmark(_) | Control::Footnote(_)))
            .map(|(c, pos)| (matches!(c, Control::Bookmark(_)), pos))
            .collect();
        assert_eq!(
            kinds,
            vec![(true, 1), (false, 3)],
            "책갈피가 각주 앞, 제자리에 놓인다"
        );
        let bookmark_idx = para
            .controls
            .iter()
            .position(|c| matches!(c, Control::Bookmark(_)))
            .unwrap();

        let with_bookmark = core.save_snapshot_native();
        core.restore_snapshot_native(baseline).expect("baseline");
        core.restore_snapshot_native(with_bookmark)
            .expect("with bookmark");
        assert!(core.get_bookmarks_native().unwrap().contains("\"mark\""));

        core.delete_bookmark_native(0, 0, bookmark_idx)
            .expect("delete");
        assert_eq!(
            core.document.sections[0].paragraphs[0].char_offsets,
            offsets_before
        );
    }

    #[test]
    fn add_bookmark_invalidates_raw_stream() {
        let mut core = core_from(doc_with_raw_stream(vec![text_para("안녕하세요")]));
        let r = core
            .add_bookmark_native(0, 0, 2, "중간지점")
            .expect("호출 성공");
        assert!(r.contains(r#""ok":true"#), "전제: 책갈피 추가 성공 ({r})");

        assert!(
            core.document.sections[0].raw_stream.is_none(),
            "raw_stream 이 남으면 추가한 책갈피가 저장 시 사라진다"
        );
        let out = serialize_section(&core.document.sections[0]);
        assert_ne!(
            out,
            vec![SENTINEL; 64],
            "직렬화가 원본 바이트를 반환하면 유실"
        );
    }

    #[test]
    fn delete_bookmark_invalidates_raw_stream() {
        let mut core = core_from(doc_with_raw_stream(vec![para_with_bookmark("삭제대상")]));
        let r = core.delete_bookmark_native(0, 0, 0).expect("호출 성공");
        assert!(r.contains(r#""ok":true"#), "전제: 책갈피 삭제 성공 ({r})");

        assert!(
            core.document.sections[0].raw_stream.is_none(),
            "raw_stream 이 남으면 삭제한 책갈피가 저장 시 되살아난다"
        );
    }

    #[test]
    fn rename_bookmark_invalidates_raw_stream() {
        let mut core = core_from(doc_with_raw_stream(vec![para_with_bookmark("옛이름")]));
        let r = core
            .rename_bookmark_native(0, 0, 0, "새이름")
            .expect("호출 성공");
        assert!(r.contains(r#""ok":true"#), "전제: 이름 변경 성공 ({r})");

        // 이름은 IR 에 반영됐고,
        match &core.document.sections[0].paragraphs[0].controls[0] {
            Control::Bookmark(b) => assert_eq!(b.name, "새이름"),
            _ => panic!("책갈피여야 함"),
        }
        // raw_stream 은 무효화돼야 한다 — 남으면 저장 시 옛 이름으로 되돌아간다.
        assert!(
            core.document.sections[0].raw_stream.is_none(),
            "raw_stream 이 남으면 이름 변경이 저장 시 옛 이름으로 되돌아간다"
        );
    }
}
