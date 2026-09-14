//! 링크 색/밑줄의 원래 값을 범위별로 보존한다. 글꼴/굵기 등은 복원 대상이 아니다.
//! HWP의 미정의 ParameterSet ID를 만들지 않는다. 전용 보조 엔트리는
//! 링크 ID·현재 텍스트/Command 해시가 맞을 때만 읽고, 외부 재저장으로 사라지면
//! 복원 정보 없음으로 처리한다. 한컴 자체의 원래 서식 저장 규약은 아니다.
use super::{
    control::{Control, FieldType},
    document::Document,
    paragraph::Paragraph,
    style::{CharShape, CharShapeMods, UnderlineType},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const HWP_STREAM: &str = "/RhwpHyperlinkFormat";
pub const HWPX_ENTRY: &str = "META-INF/rhwp-hyperlink-format.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Format {
    color: u32,
    underline: u8,
    underline_color: u32,
}
impl Format {
    fn from_shape(s: &CharShape) -> Self {
        Self {
            color: s.text_color,
            underline: match s.underline_type {
                UnderlineType::None => 0,
                UnderlineType::Bottom => 1,
                UnderlineType::Top => 2,
            },
            underline_color: s.underline_color,
        }
    }
    fn mods(self) -> CharShapeMods {
        CharShapeMods {
            text_color: Some(self.color),
            underline_color: Some(self.underline_color),
            underline_type: Some(match self.underline {
                1 => UnderlineType::Bottom,
                2 => UnderlineType::Top,
                _ => UnderlineType::None,
            }),
            ..Default::default()
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Run {
    len: usize,
    format: Format,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginalFormat {
    runs: Vec<Run>,
}
impl OriginalFormat {
    pub fn capture(p: &Paragraph, shapes: &[CharShape], start: usize, end: usize) -> Option<Self> {
        let mut out = Self::default();
        for i in start..end {
            let raw = *p.char_offsets.get(i)?;
            let id = p
                .char_shapes
                .iter()
                .rev()
                .find(|s| s.start_pos <= raw)?
                .char_shape_id;
            out.push(1, Format::from_shape(shapes.get(id as usize)?));
        }
        Some(out)
    }
    fn push(&mut self, len: usize, format: Format) {
        if len == 0 {
            return;
        }
        if let Some(last) = self.runs.last_mut() {
            if last.format == format {
                last.len += len;
                return;
            }
        }
        self.runs.push(Run { len, format });
    }
    pub fn valid_for(&self, len: usize) -> bool {
        self.runs
            .iter()
            .all(|r| r.len > 0 && r.format.underline <= 2)
            && self
                .runs
                .iter()
                .try_fold(0usize, |n, r| n.checked_add(r.len))
                == Some(len)
    }
    pub fn edits(&self, start: usize) -> Vec<(usize, usize, CharShapeMods)> {
        let mut offset = start;
        self.runs
            .iter()
            .map(|r| {
                let a = offset;
                offset += r.len;
                (a, offset, r.format.mods())
            })
            .collect()
    }
    pub fn replace(&mut self, start: usize, end: usize, count: usize) {
        let mut out = Self::default();
        let mut offset = 0;
        let inherited = self.runs.iter().find_map(|r| {
            offset += r.len;
            (start.saturating_sub(1) < offset).then_some(r.format)
        });
        offset = 0;
        for r in &self.runs {
            let next = offset + r.len;
            out.push(next.min(start).saturating_sub(offset), r.format);
            offset = next;
        }
        if let Some(format) = inherited {
            out.push(count, format);
        }
        offset = 0;
        for r in &self.runs {
            let next = offset + r.len;
            out.push(next.saturating_sub(offset.max(end)), r.format);
            offset = next;
        }
        *self = out;
    }
    pub fn repeat_first(&mut self, count: usize) {
        if let Some(r) = self.runs.first().cloned() {
            self.runs = vec![Run { len: count, ..r }];
        }
    }
}

/// 텍스트 축을 바꾸는 공통 경로에서 복원 범위도 함께 갱신한다.
pub fn text_edit(p: &mut Paragraph, start: usize, end: usize, count: usize) {
    for range in &p.field_ranges {
        let Some(Control::Field(field)) = p.controls.get_mut(range.control_idx) else {
            continue;
        };
        let Some(format) = &mut field.hyperlink_format else {
            continue;
        };
        let len = range.end_char_idx.saturating_sub(range.start_char_idx);
        if !format.valid_for(len) {
            field.hyperlink_format = None;
            continue;
        }
        if start == end {
            if range.start_char_idx < start && start < range.end_char_idx {
                format.replace(
                    start - range.start_char_idx,
                    start - range.start_char_idx,
                    count,
                );
            }
        } else if start < range.end_char_idx && range.start_char_idx < end {
            format.replace(
                start.saturating_sub(range.start_char_idx),
                end.min(range.end_char_idx) - range.start_char_idx,
                count,
            );
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Record {
    id: u32,
    fingerprint: Vec<u8>,
    format: Box<OriginalFormat>,
}
#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u8,
    records: Vec<Record>,
}
fn fingerprint(p: &Paragraph, start: usize, end: usize, command: &str) -> Vec<u8> {
    let mut h = blake3::Hasher::new();
    h.update(&(command.len() as u64).to_le_bytes());
    h.update(command.as_bytes());
    for c in p.text.chars().skip(start).take(end.saturating_sub(start)) {
        h.update(&(c as u32).to_le_bytes());
    }
    h.finalize().as_bytes().to_vec()
}
fn collect(paras: &[Paragraph], out: &mut Vec<Record>) {
    for p in paras {
        for range in &p.field_ranges {
            let Some(Control::Field(f)) = p.controls.get(range.control_idx) else {
                continue;
            };
            let Some(format) = &f.hyperlink_format else {
                continue;
            };
            if f.field_type == FieldType::Hyperlink
                && range.start_char_idx <= range.end_char_idx
                && format.valid_for(range.end_char_idx - range.start_char_idx)
            {
                out.push(Record {
                    id: f.field_id,
                    fingerprint: fingerprint(
                        p,
                        range.start_char_idx,
                        range.end_char_idx,
                        &f.command,
                    ),
                    format: format.clone(),
                });
            }
        }
        for c in &p.controls {
            collect_control(c, out);
        }
    }
}

fn collect_control(c: &Control, out: &mut Vec<Record>) {
    match c {
        Control::Table(t) => {
            for cell in &t.cells {
                collect(&cell.paragraphs, out);
            }
            if let Some(caption) = &t.caption {
                collect(&caption.paragraphs, out);
            }
        }
        Control::Shape(s) => collect_shape(s, out),
        Control::Picture(pic) => {
            if let Some(caption) = &pic.caption {
                collect(&caption.paragraphs, out);
            }
        }
        Control::Header(h) => collect(&h.paragraphs, out),
        Control::Footer(h) => collect(&h.paragraphs, out),
        Control::Footnote(h) => collect(&h.paragraphs, out),
        Control::Endnote(h) => collect(&h.paragraphs, out),
        Control::HiddenComment(h) => collect(&h.paragraphs, out),
        Control::SectionDef(s) => {
            for m in &s.master_pages {
                collect(&m.paragraphs, out);
            }
        }
        Control::Field(f) => collect(&f.memo_paragraphs, out),
        _ => {}
    }
}

fn collect_shape(shape: &crate::model::shape::ShapeObject, out: &mut Vec<Record>) {
    use crate::model::shape::ShapeObject;
    if let Some(drawing) = shape.drawing() {
        if let Some(text_box) = &drawing.text_box {
            collect(&text_box.paragraphs, out);
        }
        if let Some(caption) = &drawing.caption {
            collect(&caption.paragraphs, out);
        }
    }
    let caption = match shape {
        ShapeObject::Group(g) => {
            for child in &g.children {
                collect_shape(child, out);
            }
            g.caption.as_ref()
        }
        ShapeObject::Picture(p) => p.caption.as_ref(),
        ShapeObject::Chart(c) => c.caption.as_ref(),
        ShapeObject::Ole(o) => o.caption.as_ref(),
        _ => None,
    };
    if let Some(caption) = caption {
        collect(&caption.paragraphs, out);
    }
}

pub fn encode(doc: &Document) -> Option<Vec<u8>> {
    let mut records = Vec::new();
    for s in &doc.sections {
        collect(&s.paragraphs, &mut records);
    }
    if records.is_empty() {
        None
    } else {
        serde_json::to_vec(&Envelope {
            version: 1,
            records,
        })
        .ok()
    }
}

/// HWP extra_streams에 현재 복원 정보를 반영한 복사본을 만든다.
pub fn extra_streams_for_hwp(doc: &Document) -> Vec<(String, Vec<u8>)> {
    let mut extra_streams = doc.extra_streams.clone();
    extra_streams.retain(|(path, _)| path != HWP_STREAM);
    if let Some(bytes) = encode(doc) {
        extra_streams.push((HWP_STREAM.into(), bytes));
    }
    extra_streams
}

fn attach(paras: &mut [Paragraph], records: &HashMap<u32, Record>) {
    for p in paras {
        for range in &p.field_ranges {
            let Some(Control::Field(f)) = p.controls.get(range.control_idx) else {
                continue;
            };
            let Some(r) = records.get(&f.field_id) else {
                continue;
            };
            if f.field_type != FieldType::Hyperlink
                || range.start_char_idx > range.end_char_idx
                || !r
                    .format
                    .valid_for(range.end_char_idx - range.start_char_idx)
                || r.fingerprint
                    != fingerprint(p, range.start_char_idx, range.end_char_idx, &f.command)
            {
                continue;
            }
            if let Control::Field(f) = &mut p.controls[range.control_idx] {
                f.hyperlink_format = Some(r.format.clone());
            }
        }
        for c in &mut p.controls {
            attach_control(c, records);
        }
    }
}

fn attach_control(c: &mut Control, records: &HashMap<u32, Record>) {
    match c {
        Control::Table(t) => {
            for cell in &mut t.cells {
                attach(&mut cell.paragraphs, records);
            }
            if let Some(caption) = &mut t.caption {
                attach(&mut caption.paragraphs, records);
            }
        }
        Control::Shape(s) => attach_shape(s, records),
        Control::Picture(pic) => {
            if let Some(caption) = &mut pic.caption {
                attach(&mut caption.paragraphs, records);
            }
        }
        Control::Header(h) => attach(&mut h.paragraphs, records),
        Control::Footer(h) => attach(&mut h.paragraphs, records),
        Control::Footnote(h) => attach(&mut h.paragraphs, records),
        Control::Endnote(h) => attach(&mut h.paragraphs, records),
        Control::HiddenComment(h) => attach(&mut h.paragraphs, records),
        Control::SectionDef(s) => {
            for m in &mut s.master_pages {
                attach(&mut m.paragraphs, records);
            }
        }
        Control::Field(f) => attach(&mut f.memo_paragraphs, records),
        _ => {}
    }
}

fn attach_shape(shape: &mut crate::model::shape::ShapeObject, records: &HashMap<u32, Record>) {
    use crate::model::shape::ShapeObject;
    if let Some(drawing) = shape.drawing_mut() {
        if let Some(text_box) = &mut drawing.text_box {
            attach(&mut text_box.paragraphs, records);
        }
        if let Some(caption) = &mut drawing.caption {
            attach(&mut caption.paragraphs, records);
        }
    }
    match shape {
        ShapeObject::Group(g) => {
            for child in &mut g.children {
                attach_shape(child, records);
            }
            if let Some(caption) = &mut g.caption {
                attach(&mut caption.paragraphs, records);
            }
        }
        ShapeObject::Picture(p) => {
            if let Some(caption) = &mut p.caption {
                attach(&mut caption.paragraphs, records);
            }
        }
        ShapeObject::Chart(c) => {
            if let Some(caption) = &mut c.caption {
                attach(&mut caption.paragraphs, records);
            }
        }
        ShapeObject::Ole(o) => {
            if let Some(caption) = &mut o.caption {
                attach(&mut caption.paragraphs, records);
            }
        }
        _ => {}
    }
}

pub fn decode(doc: &mut Document, bytes: &[u8]) {
    // 잘못된 부가 정보가 본문 읽기를 막거나 임의 서식을 적용하지 않게 한다.
    let Ok(data) = serde_json::from_slice::<Envelope>(bytes) else {
        return;
    };
    if data.version != 1 {
        return;
    }
    let mut records = HashMap::new();
    let mut duplicate = std::collections::HashSet::new();
    for r in data.records {
        if records.contains_key(&r.id) {
            duplicate.insert(r.id);
        }
        records.insert(r.id, r);
    }
    records.retain(|id, _| !duplicate.contains(id));
    for s in &mut doc.sections {
        attach(&mut s.paragraphs, &records);
    }
}
