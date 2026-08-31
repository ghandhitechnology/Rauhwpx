//! Cross-document native paragraph transfer.
//!
//! HTML is intentionally not used here: it cannot represent paragraph controls or
//! the DocInfo/BinData references those controls depend on.  The importer parses the
//! original source document, clones the selected native paragraphs, appends a fully
//! remapped copy of the source resource tables, and only then swaps the staged target
//! document into the live core.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::event::DocumentEvent;
use crate::model::paragraph::Paragraph;
use crate::model::shape::{Caption, CommonObjAttr, DrawingObjAttr, ShapeObject};
use crate::model::style::{Fill, HeadType};
use crate::xml_attr::{decimal_u32_ascii, image_ref_u16_ascii, ExactXmlAttributeScanner};

#[derive(Debug)]
struct ResourceMap {
    font_bases: [u16; 7],
    border_base: u16,
    char_base: u32,
    tab_base: u16,
    numbering_base: u16,
    bullet_base: u16,
    para_base: u16,
    style_base: u8,
    bin_ids: Vec<u16>,
    bin_storage_ids: HashMap<u16, u16>,
}

impl ResourceMap {
    fn bin_id(&self, old: u16) -> Result<u16, HwpError> {
        if old == 0 {
            return Ok(0);
        }
        if let Some(id) = self.bin_storage_ids.get(&old) {
            return Ok(*id);
        }
        if let Some(id) = self.bin_ids.get(old as usize - 1) {
            return Ok(*id);
        }
        Err(transfer_error(format!(
            "BinData reference {old} is not present in the source document"
        )))
    }

    fn border_id(&self, old: u16) -> Result<u16, HwpError> {
        if old == 0 {
            Ok(0)
        } else {
            checked_u16_add(old, self.border_base, "border-fill ID")
        }
    }
}

#[derive(Default)]
struct TransferInventory {
    controls: BTreeMap<&'static str, usize>,
    structural_controls: usize,
    contains_unknown: bool,
    contains_chart: bool,
    bookmarks: HashSet<String>,
    duplicate_bookmarks: HashSet<String>,
    begin_field_ids: HashSet<u32>,
    referenced_begin_field_ids: HashSet<u32>,
}

impl TransferInventory {
    fn bump(&mut self, name: &'static str) {
        *self.controls.entry(name).or_default() += 1;
    }
}

#[derive(Default)]
struct IdentityMap {
    object_ids: HashMap<u32, u32>,
    drawing_ids: HashMap<u32, u32>,
    field_ids: HashMap<u32, u32>,
    field_instance_ids: HashMap<u32, u32>,
    next_object_id: u32,
    next_drawing_id: u32,
    next_field_id: u32,
    next_field_instance_id: u32,
}

impl IdentityMap {
    fn allocate_object(&mut self, old: u32) -> Result<u32, HwpError> {
        allocate_id(
            &mut self.object_ids,
            &mut self.next_object_id,
            old,
            "object instance ID",
        )
    }

    fn allocate_drawing(&mut self, old: u32) -> Result<u32, HwpError> {
        allocate_id(
            &mut self.drawing_ids,
            &mut self.next_drawing_id,
            old,
            "drawing instance ID",
        )
    }

    fn allocate_field(&mut self, old: u32) -> Result<u32, HwpError> {
        allocate_id(
            &mut self.field_ids,
            &mut self.next_field_id,
            old,
            "field ID",
        )
    }

    fn allocate_field_instance(&mut self, old: u32) -> Result<u32, HwpError> {
        allocate_id(
            &mut self.field_instance_ids,
            &mut self.next_field_instance_id,
            old,
            "field instance ID",
        )
    }
}

fn transfer_error(message: impl Into<String>) -> HwpError {
    HwpError::RenderError(format!(
        "native document-block transfer: {}",
        message.into()
    ))
}

fn checked_u16_add(value: u16, base: u16, what: &str) -> Result<u16, HwpError> {
    value
        .checked_add(base)
        .ok_or_else(|| transfer_error(format!("{what} space is exhausted")))
}

fn checked_u32_add(value: u32, base: u32, what: &str) -> Result<u32, HwpError> {
    value
        .checked_add(base)
        .ok_or_else(|| transfer_error(format!("{what} space is exhausted")))
}

fn remap_char_shape_id(value: u32, base: u32) -> Result<u32, HwpError> {
    // HWPX compose/numbering records use UINT32_MAX as an explicit "no charPr"
    // sentinel. It is not a table index and must not participate in offset math.
    if value == u32::MAX {
        Ok(value)
    } else {
        checked_u32_add(value, base, "character shape ID")
    }
}

fn allocate_id(
    map: &mut HashMap<u32, u32>,
    next: &mut u32,
    old: u32,
    what: &str,
) -> Result<u32, HwpError> {
    if old == 0 {
        return Ok(0);
    }
    if let Some(mapped) = map.get(&old) {
        return Ok(*mapped);
    }
    let mapped = (*next).max(1);
    *next = mapped
        .checked_add(1)
        .ok_or_else(|| transfer_error(format!("{what} space is exhausted")))?;
    map.insert(old, mapped);
    Ok(mapped)
}

fn checked_len_u16(len: usize, what: &str) -> Result<u16, HwpError> {
    u16::try_from(len).map_err(|_| transfer_error(format!("too many {what} resources")))
}

fn checked_len_u32(len: usize, what: &str) -> Result<u32, HwpError> {
    u32::try_from(len).map_err(|_| transfer_error(format!("too many {what} resources")))
}

fn checked_len_u8(len: usize, what: &str) -> Result<u8, HwpError> {
    u8::try_from(len).map_err(|_| transfer_error(format!("too many {what} resources")))
}

fn ensure_capacity(
    current: usize,
    incoming: usize,
    max: usize,
    what: &str,
) -> Result<(), HwpError> {
    if current
        .checked_add(incoming)
        .is_none_or(|total| total > max)
    {
        return Err(transfer_error(format!(
            "{what} resource table would overflow"
        )));
    }
    Ok(())
}

fn build_resource_map(target: &Document, source: &Document) -> Result<ResourceMap, HwpError> {
    ensure_capacity(
        target.doc_info.border_fills.len(),
        source.doc_info.border_fills.len(),
        u16::MAX as usize,
        "border fill",
    )?;
    ensure_capacity(
        target.doc_info.char_shapes.len(),
        source.doc_info.char_shapes.len(),
        u32::MAX as usize,
        "character shape",
    )?;
    ensure_capacity(
        target.doc_info.tab_defs.len(),
        source.doc_info.tab_defs.len(),
        u16::MAX as usize + 1,
        "tab",
    )?;
    ensure_capacity(
        target.doc_info.numberings.len(),
        source.doc_info.numberings.len(),
        u16::MAX as usize,
        "numbering",
    )?;
    ensure_capacity(
        target.doc_info.bullets.len(),
        source.doc_info.bullets.len(),
        u16::MAX as usize,
        "bullet",
    )?;
    ensure_capacity(
        target.doc_info.para_shapes.len(),
        source.doc_info.para_shapes.len(),
        u16::MAX as usize + 1,
        "paragraph shape",
    )?;
    ensure_capacity(
        target.doc_info.styles.len(),
        source.doc_info.styles.len(),
        u8::MAX as usize + 1,
        "style",
    )?;
    ensure_capacity(
        target.doc_info.bin_data_list.len(),
        source.doc_info.bin_data_list.len(),
        u16::MAX as usize,
        "binary data",
    )?;

    let mut font_bases = [0u16; 7];
    for (language, base) in font_bases.iter_mut().enumerate() {
        let target_len = target
            .doc_info
            .font_faces
            .get(language)
            .map(Vec::len)
            .unwrap_or(0);
        let source_len = source
            .doc_info
            .font_faces
            .get(language)
            .map(Vec::len)
            .unwrap_or(0);
        ensure_capacity(target_len, source_len, u16::MAX as usize + 1, "font")?;
        *base = checked_len_u16(target_len, "font")?;
    }

    let mut bin_ids = Vec::with_capacity(source.doc_info.bin_data_list.len());
    let mut bin_storage_ids = HashMap::new();
    let mut used_bin_ids: HashSet<u16> = target
        .doc_info
        .bin_data_list
        .iter()
        .map(|bin| bin.storage_id)
        .chain(target.bin_data_content.iter().map(|content| content.id))
        .filter(|id| *id != 0)
        .collect();
    let mut next_bin_id = 1u32;
    for bin in &source.doc_info.bin_data_list {
        while next_bin_id <= u32::from(u16::MAX) && used_bin_ids.contains(&(next_bin_id as u16)) {
            next_bin_id += 1;
        }
        let new_id = u16::try_from(next_bin_id)
            .map_err(|_| transfer_error("BinData ID space is exhausted"))?;
        used_bin_ids.insert(new_id);
        next_bin_id += 1;
        bin_ids.push(new_id);
        if bin.storage_id != 0 {
            if let Some(existing) = bin_storage_ids.insert(bin.storage_id, new_id) {
                if existing != new_id {
                    return Err(transfer_error(format!(
                        "source BinData storage ID {} is duplicated",
                        bin.storage_id
                    )));
                }
            }
        }
    }

    Ok(ResourceMap {
        font_bases,
        border_base: checked_len_u16(target.doc_info.border_fills.len(), "border fill")?,
        char_base: checked_len_u32(target.doc_info.char_shapes.len(), "character shape")?,
        tab_base: checked_len_u16(target.doc_info.tab_defs.len(), "tab")?,
        numbering_base: checked_len_u16(target.doc_info.numberings.len(), "numbering")?,
        bullet_base: checked_len_u16(target.doc_info.bullets.len(), "bullet")?,
        para_base: checked_len_u16(target.doc_info.para_shapes.len(), "paragraph shape")?,
        style_base: checked_len_u8(target.doc_info.styles.len(), "style")?,
        bin_ids,
        bin_storage_ids,
    })
}

fn remap_decimal_xml_attr<F>(xml: &str, attr: &str, mapper: F) -> Result<String, HwpError>
where
    F: Fn(u32) -> Result<u32, HwpError>,
{
    let max_bytes = crate::parser::limits::MAX_STRUCTURAL_BYTES;
    if xml.len() > max_bytes {
        return Err(transfer_error(format!(
            "preserved XML exceeds structural byte limit: {} > {max_bytes}",
            xml.len()
        )));
    }

    let mut projected_len = xml.len();
    let mut scanner = ExactXmlAttributeScanner::new(xml);
    while let Some((value_start, value_end)) = scanner.next_value(attr) {
        let value = xml[value_start..value_end]
            .parse::<u32>()
            .map_err(|_| transfer_error(format!("non-numeric {attr} in preserved XML")))?;
        let mapped = mapper(value)?;
        let mut replacement_buffer = [0u8; 10];
        let replacement = decimal_u32_ascii(mapped, &mut replacement_buffer);
        projected_len = projected_len
            .checked_sub(value_end - value_start)
            .and_then(|length| length.checked_add(replacement.len()))
            .ok_or_else(|| transfer_error(format!("{attr} rewrite size overflow")))?;
    }
    if projected_len > max_bytes {
        return Err(transfer_error(format!(
            "rewritten preserved XML exceeds structural byte limit: {projected_len} > {max_bytes}"
        )));
    }

    let mut out = String::new();
    out.try_reserve_exact(projected_len)
        .map_err(|error| transfer_error(format!("{attr} rewrite allocation failed: {error}")))?;
    let mut copied = 0usize;
    let mut scanner = ExactXmlAttributeScanner::new(xml);
    while let Some((value_start, value_end)) = scanner.next_value(attr) {
        let value = xml[value_start..value_end]
            .parse::<u32>()
            .map_err(|_| transfer_error(format!("non-numeric {attr} in preserved XML")))?;
        let mapped = mapper(value)?;
        let mut replacement_buffer = [0u8; 10];
        let replacement = decimal_u32_ascii(mapped, &mut replacement_buffer);
        out.push_str(&xml[copied..value_start]);
        out.push_str(replacement);
        copied = value_end;
    }
    out.push_str(&xml[copied..]);
    debug_assert_eq!(out.len(), projected_len);
    Ok(out)
}

fn remap_image_xml_attr(xml: &str, resources: &ResourceMap) -> Result<String, HwpError> {
    const ATTR: &str = "binaryItemIDRef";
    let max_bytes = crate::parser::limits::MAX_STRUCTURAL_BYTES;
    if xml.len() > max_bytes {
        return Err(transfer_error(format!(
            "preserved XML exceeds structural byte limit: {} > {max_bytes}",
            xml.len()
        )));
    }

    let mut projected_len = xml.len();
    let mut scanner = ExactXmlAttributeScanner::new(xml);
    while let Some((value_start, value_end)) = scanner.next_value(ATTR) {
        let value = &xml[value_start..value_end];
        let Some(digits) = value.strip_prefix("image") else {
            continue;
        };
        let value = digits
            .parse::<u16>()
            .map_err(|_| transfer_error("non-numeric binaryItemIDRef in preserved XML"))?;
        let mapped = resources.bin_id(value)?;
        let mut replacement_buffer = [0u8; 10];
        let replacement = image_ref_u16_ascii(mapped, &mut replacement_buffer);
        projected_len = projected_len
            .checked_sub(value_end - value_start)
            .and_then(|length| length.checked_add(replacement.len()))
            .ok_or_else(|| transfer_error("binaryItemIDRef rewrite size overflow"))?;
    }
    if projected_len > max_bytes {
        return Err(transfer_error(format!(
            "rewritten preserved XML exceeds structural byte limit: {projected_len} > {max_bytes}"
        )));
    }

    let mut out = String::new();
    out.try_reserve_exact(projected_len).map_err(|error| {
        transfer_error(format!(
            "binaryItemIDRef rewrite allocation failed: {error}"
        ))
    })?;
    let mut copied = 0usize;
    let mut scanner = ExactXmlAttributeScanner::new(xml);
    while let Some((value_start, value_end)) = scanner.next_value(ATTR) {
        let value = &xml[value_start..value_end];
        let Some(digits) = value.strip_prefix("image") else {
            continue;
        };
        let value = digits
            .parse::<u16>()
            .map_err(|_| transfer_error("non-numeric binaryItemIDRef in preserved XML"))?;
        let mapped = resources.bin_id(value)?;
        let mut replacement_buffer = [0u8; 10];
        let replacement = image_ref_u16_ascii(mapped, &mut replacement_buffer);
        out.push_str(&xml[copied..value_start]);
        out.push_str(replacement);
        copied = value_end;
    }
    out.push_str(&xml[copied..]);
    debug_assert_eq!(out.len(), projected_len);
    Ok(out)
}

fn remap_fill(fill: &mut Fill, resources: &ResourceMap) -> Result<(), HwpError> {
    if let Some(image) = fill.image.as_mut() {
        image.bin_data_id = resources.bin_id(image.bin_data_id)?;
    }
    Ok(())
}

fn append_resources(
    target: &mut Document,
    source: &Document,
    resources: &ResourceMap,
) -> Result<(), HwpError> {
    while target.doc_info.font_faces.len() < 7 {
        target.doc_info.font_faces.push(Vec::new());
    }

    for (index, source_bin) in source.doc_info.bin_data_list.iter().enumerate() {
        let mut bin = source_bin.clone();
        bin.raw_data = None;
        bin.storage_id = resources.bin_ids[index];
        target.doc_info.bin_data_list.push(bin);
    }
    for source_content in &source.bin_data_content {
        if source_content.extension == "ooxml_chart" && source_content.id > 60_000 {
            continue;
        }
        let Some(new_id) = resources
            .bin_storage_ids
            .get(&source_content.id)
            .copied()
            .or_else(|| {
                resources
                    .bin_ids
                    .get(source_content.id.saturating_sub(1) as usize)
                    .copied()
            })
        else {
            continue;
        };
        let mut content = source_content.clone();
        content.id = new_id;
        target.bin_data_content.push(content);
    }

    for language in 0..7 {
        let Some(source_fonts) = source.doc_info.font_faces.get(language) else {
            continue;
        };
        for source_font in source_fonts {
            let mut font = source_font.clone();
            font.raw_data = None;
            if let Some(id) = font.resolved_bin_data_id {
                font.resolved_bin_data_id = Some(resources.bin_id(id)?);
            }
            if let Some(substitute) = font.subst_font.as_mut() {
                if let Some(id) = substitute.resolved_bin_data_id {
                    substitute.resolved_bin_data_id = Some(resources.bin_id(id)?);
                }
            }
            target.doc_info.font_faces[language].push(font);
        }
    }

    for source_border in &source.doc_info.border_fills {
        let mut border = source_border.clone();
        border.raw_data = None;
        remap_fill(&mut border.fill, resources)?;
        target.doc_info.border_fills.push(border);
    }
    for source_shape in &source.doc_info.char_shapes {
        let mut shape = source_shape.clone();
        shape.raw_data = None;
        for (language, font_id) in shape.font_ids.iter_mut().enumerate() {
            *font_id = checked_u16_add(*font_id, resources.font_bases[language], "font ID")?;
        }
        shape.border_fill_id = resources.border_id(shape.border_fill_id)?;
        target.doc_info.char_shapes.push(shape);
    }
    for source_tab in &source.doc_info.tab_defs {
        let mut tab = source_tab.clone();
        tab.raw_data = None;
        target.doc_info.tab_defs.push(tab);
    }
    for source_numbering in &source.doc_info.numberings {
        let mut numbering = source_numbering.clone();
        numbering.raw_data = None;
        for head in &mut numbering.heads {
            head.char_shape_id = remap_char_shape_id(head.char_shape_id, resources.char_base)?;
        }
        if let Some(raw) = numbering.raw_para_heads.take() {
            numbering.raw_para_heads = Some(remap_decimal_xml_attr(&raw, "charPrIDRef", |id| {
                remap_char_shape_id(id, resources.char_base)
            })?);
        }
        target.doc_info.numberings.push(numbering);
    }
    for source_bullet in &source.doc_info.bullets {
        let mut bullet = source_bullet.clone();
        bullet.raw_data = None;
        bullet.char_shape_id = remap_char_shape_id(bullet.char_shape_id, resources.char_base)?;
        if bullet.image_bullet > 0 {
            bullet.image_bullet = i32::from(resources.bin_id(bullet.image_bullet as u16)?);
        }
        if let Some(raw) = bullet.raw_para_head.take() {
            let raw = remap_decimal_xml_attr(&raw, "charPrIDRef", |id| {
                remap_char_shape_id(id, resources.char_base)
            })?;
            bullet.raw_para_head = Some(remap_image_xml_attr(&raw, resources)?);
        }
        target.doc_info.bullets.push(bullet);
    }
    for source_para in &source.doc_info.para_shapes {
        let mut para = source_para.clone();
        para.raw_data = None;
        para.tab_def_id = checked_u16_add(para.tab_def_id, resources.tab_base, "tab ID")?;
        para.numbering_id = match para.head_type {
            HeadType::Bullet if para.numbering_id > 0 => {
                checked_u16_add(para.numbering_id, resources.bullet_base, "bullet ID")?
            }
            HeadType::Number | HeadType::Outline if para.numbering_id > 0 => {
                checked_u16_add(para.numbering_id, resources.numbering_base, "numbering ID")?
            }
            _ => para.numbering_id,
        };
        para.border_fill_id = resources.border_id(para.border_fill_id)?;
        target.doc_info.para_shapes.push(para);
    }
    for source_style in &source.doc_info.styles {
        let mut style = source_style.clone();
        style.raw_data = None;
        style.next_style_id = style
            .next_style_id
            .checked_add(resources.style_base)
            .ok_or_else(|| transfer_error("style ID space is exhausted"))?;
        style.para_shape_id = checked_u16_add(
            style.para_shape_id,
            resources.para_base,
            "paragraph shape ID",
        )?;
        style.char_shape_id = u16::try_from(checked_u32_add(
            u32::from(style.char_shape_id),
            resources.char_base,
            "character shape ID",
        )?)
        .map_err(|_| transfer_error("style character-shape ID exceeds u16"))?;
        target.doc_info.styles.push(style);
    }

    target.doc_info.bullet_count = target.doc_info.bullets.len() as u32;
    target.doc_info.raw_stream = None;
    target.doc_info.raw_stream_dirty = true;
    Ok(())
}

fn inspect_paragraphs(paragraphs: &[Paragraph], inventory: &mut TransferInventory) {
    for paragraph in paragraphs {
        for orphan in &paragraph.orphan_field_ends {
            inventory
                .referenced_begin_field_ids
                .insert(orphan.begin_id_ref);
        }
        for control in &paragraph.controls {
            inspect_control(control, inventory);
        }
    }
}

fn inspect_caption(caption: &Option<Caption>, inventory: &mut TransferInventory) {
    if let Some(caption) = caption {
        inspect_paragraphs(&caption.paragraphs, inventory);
    }
}

fn inspect_drawing(drawing: &DrawingObjAttr, inventory: &mut TransferInventory) {
    if let Some(text_box) = &drawing.text_box {
        inspect_paragraphs(&text_box.paragraphs, inventory);
    }
    inspect_caption(&drawing.caption, inventory);
}

fn inspect_shape(shape: &ShapeObject, inventory: &mut TransferInventory) {
    match shape {
        ShapeObject::Group(group) => {
            for child in &group.children {
                inspect_shape(child, inventory);
            }
            inspect_caption(&group.caption, inventory);
        }
        ShapeObject::Picture(picture) => inspect_caption(&picture.caption, inventory),
        ShapeObject::Chart(chart) => {
            inventory.contains_chart = true;
            inspect_drawing(&chart.drawing, inventory);
            inspect_caption(&chart.caption, inventory);
        }
        ShapeObject::Ole(ole) => {
            inspect_drawing(&ole.drawing, inventory);
            inspect_caption(&ole.caption, inventory);
        }
        _ => {
            if let Some(drawing) = shape.drawing() {
                inspect_drawing(drawing, inventory);
            }
        }
    }
}

fn inspect_control(control: &Control, inventory: &mut TransferInventory) {
    let name = match control {
        Control::SectionDef(_) => {
            inventory.structural_controls += 1;
            "sectionDef"
        }
        Control::ColumnDef(_) => {
            inventory.structural_controls += 1;
            "columnDef"
        }
        Control::Table(table) => {
            for cell in &table.cells {
                inspect_paragraphs(&cell.paragraphs, inventory);
            }
            inspect_caption(&table.caption, inventory);
            "table"
        }
        Control::Shape(shape) => {
            inspect_shape(shape, inventory);
            "shape"
        }
        Control::Picture(picture) => {
            inspect_caption(&picture.caption, inventory);
            "picture"
        }
        Control::Header(header) => {
            inspect_paragraphs(&header.paragraphs, inventory);
            "header"
        }
        Control::Footer(footer) => {
            inspect_paragraphs(&footer.paragraphs, inventory);
            "footer"
        }
        Control::Footnote(note) => {
            inspect_paragraphs(&note.paragraphs, inventory);
            "footnote"
        }
        Control::Endnote(note) => {
            inspect_paragraphs(&note.paragraphs, inventory);
            "endnote"
        }
        Control::AutoNumber(_) => "autoNumber",
        Control::NewNumber(_) => "newNumber",
        Control::PageNumberPos(_) => "pageNumberPosition",
        Control::Bookmark(bookmark) => {
            if !inventory.bookmarks.insert(bookmark.name.clone()) {
                inventory.duplicate_bookmarks.insert(bookmark.name.clone());
            }
            "bookmark"
        }
        Control::Hyperlink(_) => "hyperlink",
        Control::Ruby(_) => "ruby",
        Control::CharOverlap(_) => "characterOverlap",
        Control::PageHide(_) => "pageHide",
        Control::HiddenComment(comment) => {
            inspect_paragraphs(&comment.paragraphs, inventory);
            "hiddenComment"
        }
        Control::Equation(_) => "equation",
        Control::Field(field) => {
            inventory.begin_field_ids.insert(field.field_id);
            inspect_paragraphs(&field.memo_paragraphs, inventory);
            "field"
        }
        Control::Form(_) => "form",
        Control::Unknown(_) => {
            inventory.contains_unknown = true;
            "unknown"
        }
    };
    inventory.bump(name);
}

fn collect_target_bookmarks(paragraphs: &[Paragraph], names: &mut HashSet<String>) {
    for paragraph in paragraphs {
        for control in &paragraph.controls {
            match control {
                Control::Bookmark(bookmark) => {
                    names.insert(bookmark.name.clone());
                }
                Control::Table(table) => {
                    for cell in &table.cells {
                        collect_target_bookmarks(&cell.paragraphs, names);
                    }
                    if let Some(caption) = &table.caption {
                        collect_target_bookmarks(&caption.paragraphs, names);
                    }
                }
                Control::Shape(shape) => collect_shape_bookmarks(shape, names),
                Control::Picture(picture) => {
                    if let Some(caption) = &picture.caption {
                        collect_target_bookmarks(&caption.paragraphs, names);
                    }
                }
                Control::Header(header) => collect_target_bookmarks(&header.paragraphs, names),
                Control::Footer(footer) => collect_target_bookmarks(&footer.paragraphs, names),
                Control::Footnote(note) => collect_target_bookmarks(&note.paragraphs, names),
                Control::Endnote(note) => collect_target_bookmarks(&note.paragraphs, names),
                Control::HiddenComment(comment) => {
                    collect_target_bookmarks(&comment.paragraphs, names)
                }
                Control::Field(field) => collect_target_bookmarks(&field.memo_paragraphs, names),
                _ => {}
            }
        }
    }
}

fn collect_shape_bookmarks(shape: &ShapeObject, names: &mut HashSet<String>) {
    if let Some(drawing) = shape.drawing() {
        if let Some(text_box) = &drawing.text_box {
            collect_target_bookmarks(&text_box.paragraphs, names);
        }
        if let Some(caption) = &drawing.caption {
            collect_target_bookmarks(&caption.paragraphs, names);
        }
    }
    match shape {
        ShapeObject::Group(group) => {
            for child in &group.children {
                collect_shape_bookmarks(child, names);
            }
            if let Some(caption) = &group.caption {
                collect_target_bookmarks(&caption.paragraphs, names);
            }
        }
        ShapeObject::Picture(picture) => {
            if let Some(caption) = &picture.caption {
                collect_target_bookmarks(&caption.paragraphs, names);
            }
        }
        ShapeObject::Chart(chart) => {
            if let Some(caption) = &chart.caption {
                collect_target_bookmarks(&caption.paragraphs, names);
            }
        }
        ShapeObject::Ole(ole) => {
            if let Some(caption) = &ole.caption {
                collect_target_bookmarks(&caption.paragraphs, names);
            }
        }
        _ => {}
    }
}

fn max_ids_in_paragraphs(paragraphs: &[Paragraph], ids: &mut IdentityMap) {
    for paragraph in paragraphs {
        if paragraph.raw_header_extra.len() >= 10 {
            ids.next_object_id = ids.next_object_id.max(u32::from_le_bytes(
                paragraph.raw_header_extra[6..10].try_into().unwrap(),
            ));
        }
        for range in &paragraph.field_ranges {
            ids.next_field_instance_id = ids.next_field_instance_id.max(range.end_field_id);
        }
        for orphan in &paragraph.orphan_field_ends {
            ids.next_field_id = ids.next_field_id.max(orphan.begin_id_ref);
            ids.next_field_instance_id = ids.next_field_instance_id.max(orphan.field_id);
        }
        for control in &paragraph.controls {
            max_ids_in_control(control, ids);
        }
    }
}

fn max_common(common: &CommonObjAttr, ids: &mut IdentityMap) {
    ids.next_object_id = ids.next_object_id.max(common.instance_id);
}

fn max_drawing(drawing: &DrawingObjAttr, ids: &mut IdentityMap) {
    ids.next_drawing_id = ids.next_drawing_id.max(drawing.inst_id);
    if let Some(text_box) = &drawing.text_box {
        max_ids_in_paragraphs(&text_box.paragraphs, ids);
    }
    if let Some(caption) = &drawing.caption {
        max_ids_in_paragraphs(&caption.paragraphs, ids);
    }
}

fn max_ids_in_shape(shape: &ShapeObject, ids: &mut IdentityMap) {
    max_common(shape.common(), ids);
    if let Some(drawing) = shape.drawing() {
        max_drawing(drawing, ids);
    }
    match shape {
        ShapeObject::Group(group) => {
            for child in &group.children {
                max_ids_in_shape(child, ids);
            }
            if let Some(caption) = &group.caption {
                max_ids_in_paragraphs(&caption.paragraphs, ids);
            }
        }
        ShapeObject::Picture(picture) => {
            ids.next_object_id = ids.next_object_id.max(picture.instance_id);
            if let Some(caption) = &picture.caption {
                max_ids_in_paragraphs(&caption.paragraphs, ids);
            }
        }
        ShapeObject::Chart(chart) => {
            if let Some(caption) = &chart.caption {
                max_ids_in_paragraphs(&caption.paragraphs, ids);
            }
        }
        ShapeObject::Ole(ole) => {
            if let Some(caption) = &ole.caption {
                max_ids_in_paragraphs(&caption.paragraphs, ids);
            }
        }
        _ => {}
    }
}

fn max_ids_in_control(control: &Control, ids: &mut IdentityMap) {
    match control {
        Control::Table(table) => {
            max_common(&table.common, ids);
            for cell in &table.cells {
                max_ids_in_paragraphs(&cell.paragraphs, ids);
            }
            if let Some(caption) = &table.caption {
                max_ids_in_paragraphs(&caption.paragraphs, ids);
            }
        }
        Control::Shape(shape) => max_ids_in_shape(shape, ids),
        Control::Picture(picture) => {
            max_common(&picture.common, ids);
            ids.next_object_id = ids.next_object_id.max(picture.instance_id);
            if let Some(caption) = &picture.caption {
                max_ids_in_paragraphs(&caption.paragraphs, ids);
            }
        }
        Control::Header(header) => max_ids_in_paragraphs(&header.paragraphs, ids),
        Control::Footer(footer) => max_ids_in_paragraphs(&footer.paragraphs, ids),
        Control::Footnote(note) => {
            ids.next_object_id = ids.next_object_id.max(note.instance_id);
            max_ids_in_paragraphs(&note.paragraphs, ids);
        }
        Control::Endnote(note) => {
            ids.next_object_id = ids.next_object_id.max(note.instance_id);
            max_ids_in_paragraphs(&note.paragraphs, ids);
        }
        Control::HiddenComment(comment) => max_ids_in_paragraphs(&comment.paragraphs, ids),
        Control::Equation(equation) => max_common(&equation.common, ids),
        Control::Field(field) => {
            ids.next_field_id = ids.next_field_id.max(field.field_id);
            ids.next_field_instance_id = ids
                .next_field_instance_id
                .max(field.instance_id.unwrap_or(0));
            max_ids_in_paragraphs(&field.memo_paragraphs, ids);
        }
        _ => {}
    }
}

fn seed_identity_map(target: &Document) -> IdentityMap {
    let mut ids = IdentityMap::default();
    for section in &target.sections {
        max_ids_in_paragraphs(&section.paragraphs, &mut ids);
    }
    ids.next_object_id = ids.next_object_id.saturating_add(1).max(1);
    ids.next_drawing_id = ids.next_drawing_id.saturating_add(1).max(1);
    ids.next_field_id = ids.next_field_id.saturating_add(1).max(1);
    ids.next_field_instance_id = ids.next_field_instance_id.saturating_add(1).max(1);
    ids
}

fn preallocate_paragraph_ids(
    paragraphs: &[Paragraph],
    ids: &mut IdentityMap,
) -> Result<(), HwpError> {
    for paragraph in paragraphs {
        if paragraph.raw_header_extra.len() >= 10 {
            let old = u32::from_le_bytes(paragraph.raw_header_extra[6..10].try_into().unwrap());
            ids.allocate_object(old)?;
        }
        for range in &paragraph.field_ranges {
            ids.allocate_field_instance(range.end_field_id)?;
        }
        for orphan in &paragraph.orphan_field_ends {
            ids.allocate_field_instance(orphan.field_id)?;
        }
        for control in &paragraph.controls {
            preallocate_control_ids(control, ids)?;
        }
    }
    Ok(())
}

fn preallocate_drawing_ids(
    drawing: &DrawingObjAttr,
    ids: &mut IdentityMap,
) -> Result<(), HwpError> {
    ids.allocate_drawing(drawing.inst_id)?;
    if let Some(text_box) = &drawing.text_box {
        preallocate_paragraph_ids(&text_box.paragraphs, ids)?;
    }
    if let Some(caption) = &drawing.caption {
        preallocate_paragraph_ids(&caption.paragraphs, ids)?;
    }
    Ok(())
}

fn preallocate_shape_ids(shape: &ShapeObject, ids: &mut IdentityMap) -> Result<(), HwpError> {
    ids.allocate_object(shape.common().instance_id)?;
    if let Some(drawing) = shape.drawing() {
        preallocate_drawing_ids(drawing, ids)?;
    }
    match shape {
        ShapeObject::Group(group) => {
            for child in &group.children {
                preallocate_shape_ids(child, ids)?;
            }
            if let Some(caption) = &group.caption {
                preallocate_paragraph_ids(&caption.paragraphs, ids)?;
            }
        }
        ShapeObject::Picture(picture) => {
            ids.allocate_object(picture.instance_id)?;
            if let Some(caption) = &picture.caption {
                preallocate_paragraph_ids(&caption.paragraphs, ids)?;
            }
        }
        ShapeObject::Chart(chart) => {
            if let Some(caption) = &chart.caption {
                preallocate_paragraph_ids(&caption.paragraphs, ids)?;
            }
        }
        ShapeObject::Ole(ole) => {
            if let Some(caption) = &ole.caption {
                preallocate_paragraph_ids(&caption.paragraphs, ids)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn preallocate_control_ids(control: &Control, ids: &mut IdentityMap) -> Result<(), HwpError> {
    match control {
        Control::Table(table) => {
            ids.allocate_object(table.common.instance_id)?;
            for cell in &table.cells {
                preallocate_paragraph_ids(&cell.paragraphs, ids)?;
            }
            if let Some(caption) = &table.caption {
                preallocate_paragraph_ids(&caption.paragraphs, ids)?;
            }
        }
        Control::Shape(shape) => preallocate_shape_ids(shape, ids)?,
        Control::Picture(picture) => {
            ids.allocate_object(picture.common.instance_id)?;
            ids.allocate_object(picture.instance_id)?;
            if let Some(caption) = &picture.caption {
                preallocate_paragraph_ids(&caption.paragraphs, ids)?;
            }
        }
        Control::Header(header) => preallocate_paragraph_ids(&header.paragraphs, ids)?,
        Control::Footer(footer) => preallocate_paragraph_ids(&footer.paragraphs, ids)?,
        Control::Footnote(note) => {
            ids.allocate_object(note.instance_id)?;
            preallocate_paragraph_ids(&note.paragraphs, ids)?;
        }
        Control::Endnote(note) => {
            ids.allocate_object(note.instance_id)?;
            preallocate_paragraph_ids(&note.paragraphs, ids)?;
        }
        Control::HiddenComment(comment) => preallocate_paragraph_ids(&comment.paragraphs, ids)?,
        Control::Equation(equation) => {
            ids.allocate_object(equation.common.instance_id)?;
        }
        Control::Field(field) => {
            ids.allocate_field(field.field_id)?;
            ids.allocate_field_instance(field.instance_id.unwrap_or(0))?;
            preallocate_paragraph_ids(&field.memo_paragraphs, ids)?;
        }
        _ => {}
    }
    Ok(())
}

fn remap_common(common: &mut CommonObjAttr, ids: &mut IdentityMap) -> Result<(), HwpError> {
    common.instance_id = ids.allocate_object(common.instance_id)?;
    Ok(())
}

fn remap_drawing(
    drawing: &mut DrawingObjAttr,
    resources: &ResourceMap,
    ids: &mut IdentityMap,
) -> Result<(), HwpError> {
    drawing.inst_id = ids.allocate_drawing(drawing.inst_id)?;
    remap_fill(&mut drawing.fill, resources)?;
    if let Some(text_box) = drawing.text_box.as_mut() {
        remap_paragraphs(&mut text_box.paragraphs, resources, ids)?;
    }
    if let Some(caption) = drawing.caption.as_mut() {
        remap_paragraphs(&mut caption.paragraphs, resources, ids)?;
    }
    Ok(())
}

fn remap_picture(
    picture: &mut crate::model::image::Picture,
    resources: &ResourceMap,
    ids: &mut IdentityMap,
) -> Result<(), HwpError> {
    remap_common(&mut picture.common, ids)?;
    picture.instance_id = ids.allocate_object(picture.instance_id)?;
    picture.image_attr.bin_data_id = resources.bin_id(picture.image_attr.bin_data_id)?;
    if let Some(caption) = picture.caption.as_mut() {
        remap_paragraphs(&mut caption.paragraphs, resources, ids)?;
    }
    Ok(())
}

fn remap_shape(
    shape: &mut ShapeObject,
    resources: &ResourceMap,
    ids: &mut IdentityMap,
) -> Result<(), HwpError> {
    remap_common(shape.common_mut(), ids)?;
    if let Some(drawing) = shape.drawing_mut() {
        remap_drawing(drawing, resources, ids)?;
    }
    match shape {
        ShapeObject::Line(line) => {
            if let Some(connector) = line.connector.as_mut() {
                if connector.start_subject_id != 0 {
                    connector.start_subject_id = ids
                        .drawing_ids
                        .get(&connector.start_subject_id)
                        .copied()
                        .or_else(|| ids.object_ids.get(&connector.start_subject_id).copied())
                        .ok_or_else(|| {
                            transfer_error("connector starts outside the selected block")
                        })?;
                }
                if connector.end_subject_id != 0 {
                    connector.end_subject_id = ids
                        .drawing_ids
                        .get(&connector.end_subject_id)
                        .copied()
                        .or_else(|| ids.object_ids.get(&connector.end_subject_id).copied())
                        .ok_or_else(|| {
                            transfer_error("connector ends outside the selected block")
                        })?;
                }
            }
        }
        ShapeObject::Group(group) => {
            for child in &mut group.children {
                remap_shape(child, resources, ids)?;
            }
            if let Some(caption) = group.caption.as_mut() {
                remap_paragraphs(&mut caption.paragraphs, resources, ids)?;
            }
        }
        ShapeObject::Picture(picture) => remap_picture(picture, resources, ids)?,
        ShapeObject::Chart(_) => {
            return Err(transfer_error(
                "chart package relationships are opaque; the block was not inserted",
            ));
        }
        ShapeObject::Ole(ole) => {
            ole.bin_data_id = u32::from(
                resources.bin_id(
                    u16::try_from(ole.bin_data_id)
                        .map_err(|_| transfer_error("OLE BinData ID exceeds u16"))?,
                )?,
            );
            ole.raw_tag_data.clear();
            if let Some(caption) = ole.caption.as_mut() {
                remap_paragraphs(&mut caption.paragraphs, resources, ids)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn remap_control(
    control: &mut Control,
    resources: &ResourceMap,
    ids: &mut IdentityMap,
) -> Result<(), HwpError> {
    match control {
        Control::SectionDef(_) | Control::ColumnDef(_) => {}
        Control::Table(table) => {
            remap_common(&mut table.common, ids)?;
            table.raw_ctrl_data.clear();
            table.border_fill_id = resources.border_id(table.border_fill_id)?;
            for zone in &mut table.zones {
                zone.border_fill_id = resources.border_id(zone.border_fill_id)?;
            }
            for cell in &mut table.cells {
                cell.border_fill_id = resources.border_id(cell.border_fill_id)?;
                remap_paragraphs(&mut cell.paragraphs, resources, ids)?;
            }
            if let Some(caption) = table.caption.as_mut() {
                remap_paragraphs(&mut caption.paragraphs, resources, ids)?;
            }
        }
        Control::Shape(shape) => remap_shape(shape, resources, ids)?,
        Control::Picture(picture) => remap_picture(picture, resources, ids)?,
        Control::Header(header) => remap_paragraphs(&mut header.paragraphs, resources, ids)?,
        Control::Footer(footer) => remap_paragraphs(&mut footer.paragraphs, resources, ids)?,
        Control::Footnote(note) => {
            note.instance_id = ids.allocate_object(note.instance_id)?;
            remap_paragraphs(&mut note.paragraphs, resources, ids)?;
        }
        Control::Endnote(note) => {
            note.instance_id = ids.allocate_object(note.instance_id)?;
            remap_paragraphs(&mut note.paragraphs, resources, ids)?;
        }
        Control::HiddenComment(comment) => {
            remap_paragraphs(&mut comment.paragraphs, resources, ids)?;
        }
        Control::Equation(equation) => {
            remap_common(&mut equation.common, ids)?;
            equation.raw_ctrl_data.clear();
        }
        Control::Field(field) => {
            field.field_id = ids.allocate_field(field.field_id)?;
            if let Some(instance_id) = field.instance_id {
                field.instance_id = Some(ids.allocate_field_instance(instance_id)?);
            }
            remap_paragraphs(&mut field.memo_paragraphs, resources, ids)?;
        }
        Control::Ruby(ruby) => {
            ruby.style_id_ref = checked_u16_add(
                ruby.style_id_ref,
                u16::from(resources.style_base),
                "ruby style ID",
            )?;
        }
        Control::CharOverlap(overlap) => {
            for id in &mut overlap.char_shape_ids {
                *id = remap_char_shape_id(*id, resources.char_base)?;
            }
        }
        Control::Form(form) => {
            if let Some(id) = form.properties.get("CharShapeID").cloned() {
                let id = id
                    .parse::<u32>()
                    .map_err(|_| transfer_error("form CharShapeID is not numeric"))?;
                form.properties.insert(
                    "CharShapeID".to_string(),
                    checked_u32_add(id, resources.char_base, "form character shape ID")?
                        .to_string(),
                );
            }
        }
        Control::Unknown(_) => {
            return Err(transfer_error(
                "the selected block contains an opaque control whose references cannot be verified",
            ));
        }
        _ => {}
    }
    Ok(())
}

fn remap_paragraphs(
    paragraphs: &mut [Paragraph],
    resources: &ResourceMap,
    ids: &mut IdentityMap,
) -> Result<(), HwpError> {
    for paragraph in paragraphs {
        paragraph.para_shape_id = checked_u16_add(
            paragraph.para_shape_id,
            resources.para_base,
            "paragraph shape ID",
        )?;
        paragraph.style_id = paragraph
            .style_id
            .checked_add(resources.style_base)
            .ok_or_else(|| transfer_error("style ID space is exhausted"))?;
        for char_shape in &mut paragraph.char_shapes {
            char_shape.char_shape_id =
                remap_char_shape_id(char_shape.char_shape_id, resources.char_base)?;
        }
        if paragraph.raw_header_extra.len() >= 10 {
            let old = u32::from_le_bytes(paragraph.raw_header_extra[6..10].try_into().unwrap());
            let new = ids.allocate_object(old)?;
            paragraph.raw_header_extra[6..10].copy_from_slice(&new.to_le_bytes());
        }
        for range in &mut paragraph.field_ranges {
            range.end_field_id = ids.allocate_field_instance(range.end_field_id)?;
        }
        for orphan in &mut paragraph.orphan_field_ends {
            orphan.begin_id_ref = ids
                .field_ids
                .get(&orphan.begin_id_ref)
                .copied()
                .ok_or_else(|| {
                    transfer_error("a field end refers to a field begin outside the selected block")
                })?;
            orphan.field_id = ids.allocate_field_instance(orphan.field_id)?;
        }
        for control in &mut paragraph.controls {
            remap_control(control, resources, ids)?;
        }
    }
    Ok(())
}

fn insert_paragraphs(
    document: &mut Document,
    section_idx: usize,
    para_idx: usize,
    char_offset: usize,
    clip_paragraphs: &[Paragraph],
) -> Result<(usize, usize), HwpError> {
    if clip_paragraphs.is_empty() {
        return Err(transfer_error("the selected block is empty"));
    }
    let section = document
        .sections
        .get_mut(section_idx)
        .ok_or_else(|| transfer_error(format!("target section {section_idx} does not exist")))?;
    let paragraph = section
        .paragraphs
        .get(para_idx)
        .ok_or_else(|| transfer_error(format!("target paragraph {para_idx} does not exist")))?;
    if char_offset > paragraph.text.chars().count() {
        return Err(transfer_error(format!(
            "target character offset {char_offset} exceeds paragraph length {}",
            paragraph.text.chars().count()
        )));
    }

    section.raw_stream = None;
    let right_half = section.paragraphs[para_idx].split_at(char_offset);
    section.paragraphs[para_idx].merge_from(&clip_paragraphs[0]);
    let mut insert_idx = para_idx + 1;
    for paragraph in &clip_paragraphs[1..] {
        section.paragraphs.insert(insert_idx, paragraph.clone());
        insert_idx += 1;
    }
    let last_para_idx = insert_idx - 1;
    let merge_point = section.paragraphs[last_para_idx].merge_from(&right_half);
    Ok((last_para_idx, merge_point))
}

impl DocumentCore {
    /// Insert a source document paragraph range without flattening it through HTML.
    ///
    /// The source bytes may be HWP, HWPX, or HML. The operation is atomic: parsing,
    /// validation, resource remapping, and paragraph insertion happen on a staged
    /// `Document` clone, and the live document is replaced only after all checks pass.
    pub fn paste_document_block_native(
        &mut self,
        source_bytes: &[u8],
        source_section_idx: usize,
        start_para_idx: usize,
        end_para_idx: usize,
        target_section_idx: usize,
        target_para_idx: usize,
        target_char_offset: usize,
    ) -> Result<String, HwpError> {
        if source_bytes.is_empty() {
            return Err(transfer_error("source document bytes are empty"));
        }
        if start_para_idx > end_para_idx {
            return Err(transfer_error("source paragraph range is reversed"));
        }

        let mut source_core = DocumentCore::from_bytes(source_bytes)?;
        let source_section = source_core
            .document()
            .sections
            .get(source_section_idx)
            .ok_or_else(|| {
                transfer_error(format!(
                    "source section {source_section_idx} does not exist"
                ))
            })?;
        let end_offset = source_section
            .paragraphs
            .get(end_para_idx)
            .ok_or_else(|| {
                transfer_error(format!("source paragraph {end_para_idx} does not exist"))
            })?
            .text
            .chars()
            .count();
        let selected_source_paragraphs = source_section
            .paragraphs
            .get(start_para_idx..=end_para_idx)
            .ok_or_else(|| {
                transfer_error(format!("source paragraph {start_para_idx} does not exist"))
            })?;
        let mut source_inventory = TransferInventory::default();
        inspect_paragraphs(selected_source_paragraphs, &mut source_inventory);
        let structural_controls = source_inventory.structural_controls;
        source_core.copy_selection_native(
            source_section_idx,
            start_para_idx,
            0,
            end_para_idx,
            end_offset,
        )?;
        let mut paragraphs = source_core
            .clipboard
            .take()
            .ok_or_else(|| transfer_error("source selection did not produce native paragraphs"))?
            .paragraphs;

        let mut inventory = TransferInventory::default();
        inspect_paragraphs(&paragraphs, &mut inventory);
        // Native clipboard selection deliberately removes section/column definitions.
        // Preserve their count from the source range so the caller is told exactly
        // which structural controls were intentionally left owned by the target.
        inventory.structural_controls = structural_controls;
        if inventory.contains_unknown {
            return Err(transfer_error(
                "the selected block contains an opaque control; no target changes were made",
            ));
        }
        if inventory.contains_chart {
            return Err(transfer_error(
                "the selected block contains a chart with package relationships that cannot yet be remapped safely; no target changes were made",
            ));
        }
        if !inventory.duplicate_bookmarks.is_empty() {
            return Err(transfer_error(format!(
                "the selected block contains duplicate bookmark names: {}",
                inventory
                    .duplicate_bookmarks
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        if let Some(missing) = inventory
            .referenced_begin_field_ids
            .difference(&inventory.begin_field_ids)
            .next()
        {
            return Err(transfer_error(format!(
                "field end {missing} refers to a field begin outside the selected block"
            )));
        }

        let mut target_bookmarks = HashSet::new();
        for section in &self.document().sections {
            collect_target_bookmarks(&section.paragraphs, &mut target_bookmarks);
        }
        if let Some(conflict) = inventory.bookmarks.intersection(&target_bookmarks).next() {
            return Err(transfer_error(format!(
                "bookmark name `{conflict}` already exists in the target document"
            )));
        }

        let mut staged = self.document().clone();
        let resources = build_resource_map(&staged, source_core.document())?;
        append_resources(&mut staged, source_core.document(), &resources)?;

        let mut identities = seed_identity_map(&staged);
        preallocate_paragraph_ids(&paragraphs, &mut identities)?;
        remap_paragraphs(&mut paragraphs, &resources, &mut identities)?;
        let (last_para_idx, char_offset) = insert_paragraphs(
            &mut staged,
            target_section_idx,
            target_para_idx,
            target_char_offset,
            &paragraphs,
        )?;

        self.set_document(staged);
        for para_idx in target_para_idx..=last_para_idx {
            self.reflow_paragraph(target_section_idx, para_idx);
        }
        self.recompose_section(target_section_idx);
        self.paginate_if_needed();
        self.event_log.push(DocumentEvent::ContentPasted {
            section: target_section_idx,
            para: target_para_idx,
        });

        let mut warnings = Vec::new();
        let mut skipped_features = Vec::new();
        if inventory.structural_controls > 0 {
            warnings.push(
                "Section and column definitions stay owned by the target section; use template_apply_section_layout for those surfaces.",
            );
            skipped_features.push("sectionStructure");
        }
        Ok(serde_json::json!({
            "ok": true,
            "paraIdx": last_para_idx,
            "charOffset": char_offset,
            "insertedParagraphCount": paragraphs.len(),
            "controlCounts": inventory.controls,
            "warnings": warnings,
            "skippedFeatures": skipped_features,
        })
        .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserved_decimal_attribute_rewrite_uses_exact_start_tag_attributes() {
        let xml = concat!(
            r#"<!-- charPrIDRef="1" -->"#,
            r#"<t>charPrIDRef="1"</t>"#,
            r#"<x x:charPrIDRef="1" charPrIDRefExtra="1"/>"#,
            r#"<x a=charPrIDRef="1"/>"#,
            r#"<x charPrIDRef="1"/>"#,
        );
        let expected = xml.replacen(r#"<x charPrIDRef="1"/>"#, r#"<x charPrIDRef="11"/>"#, 1);

        let rewritten = remap_decimal_xml_attr(xml, "charPrIDRef", |id| Ok(id + 10)).unwrap();

        assert_eq!(rewritten, expected);
    }

    #[test]
    fn preserved_image_attribute_rewrite_uses_exact_start_tag_attributes() {
        let resources = ResourceMap {
            font_bases: [0; 7],
            border_base: 0,
            char_base: 0,
            tab_base: 0,
            numbering_base: 0,
            bullet_base: 0,
            para_base: 0,
            style_base: 0,
            bin_ids: vec![7],
            bin_storage_ids: HashMap::new(),
        };
        let xml = concat!(
            r#"<!-- binaryItemIDRef="image1" -->"#,
            r#"<t>binaryItemIDRef="image1"</t>"#,
            r#"<x x:binaryItemIDRef="image1" binaryItemIDRefExtra="image1"/>"#,
            r#"<x a=binaryItemIDRef="image1"/>"#,
            r#"<x binaryItemIDRef="image1"/>"#,
        );
        let expected = xml.replacen(
            r#"<x binaryItemIDRef="image1"/>"#,
            r#"<x binaryItemIDRef="image7"/>"#,
            1,
        );

        let rewritten = remap_image_xml_attr(xml, &resources).unwrap();

        assert_eq!(rewritten, expected);
    }

    fn count_tables(paragraphs: &[Paragraph]) -> usize {
        let mut count = 0;
        for paragraph in paragraphs {
            for control in &paragraph.controls {
                match control {
                    Control::Table(table) => {
                        count += 1;
                        for cell in &table.cells {
                            count += count_tables(&cell.paragraphs);
                        }
                        if let Some(caption) = &table.caption {
                            count += count_tables(&caption.paragraphs);
                        }
                    }
                    Control::Shape(shape) => count += count_tables_in_shape(shape),
                    Control::Picture(picture) => {
                        if let Some(caption) = &picture.caption {
                            count += count_tables(&caption.paragraphs);
                        }
                    }
                    Control::Header(header) => count += count_tables(&header.paragraphs),
                    Control::Footer(footer) => count += count_tables(&footer.paragraphs),
                    Control::Footnote(note) => count += count_tables(&note.paragraphs),
                    Control::Endnote(note) => count += count_tables(&note.paragraphs),
                    Control::HiddenComment(comment) => count += count_tables(&comment.paragraphs),
                    Control::Field(field) => count += count_tables(&field.memo_paragraphs),
                    _ => {}
                }
            }
        }
        count
    }

    fn count_tables_in_shape(shape: &ShapeObject) -> usize {
        let mut count = 0;
        if let Some(drawing) = shape.drawing() {
            if let Some(text_box) = &drawing.text_box {
                count += count_tables(&text_box.paragraphs);
            }
            if let Some(caption) = &drawing.caption {
                count += count_tables(&caption.paragraphs);
            }
        }
        match shape {
            ShapeObject::Group(group) => {
                for child in &group.children {
                    count += count_tables_in_shape(child);
                }
                if let Some(caption) = &group.caption {
                    count += count_tables(&caption.paragraphs);
                }
            }
            ShapeObject::Picture(picture) => {
                if let Some(caption) = &picture.caption {
                    count += count_tables(&caption.paragraphs);
                }
            }
            ShapeObject::Chart(chart) => {
                if let Some(caption) = &chart.caption {
                    count += count_tables(&caption.paragraphs);
                }
            }
            ShapeObject::Ole(ole) => {
                if let Some(caption) = &ole.caption {
                    count += count_tables(&caption.paragraphs);
                }
            }
            _ => {}
        }
        count
    }

    fn count_pictures(paragraphs: &[Paragraph]) -> usize {
        let mut count = 0;
        for paragraph in paragraphs {
            for control in &paragraph.controls {
                match control {
                    Control::Picture(picture) => {
                        count += 1;
                        if let Some(caption) = &picture.caption {
                            count += count_pictures(&caption.paragraphs);
                        }
                    }
                    Control::Table(table) => {
                        for cell in &table.cells {
                            count += count_pictures(&cell.paragraphs);
                        }
                        if let Some(caption) = &table.caption {
                            count += count_pictures(&caption.paragraphs);
                        }
                    }
                    Control::Shape(shape) => count += count_pictures_in_shape(shape),
                    Control::Header(header) => count += count_pictures(&header.paragraphs),
                    Control::Footer(footer) => count += count_pictures(&footer.paragraphs),
                    Control::Footnote(note) => count += count_pictures(&note.paragraphs),
                    Control::Endnote(note) => count += count_pictures(&note.paragraphs),
                    Control::HiddenComment(comment) => count += count_pictures(&comment.paragraphs),
                    Control::Field(field) => count += count_pictures(&field.memo_paragraphs),
                    _ => {}
                }
            }
        }
        count
    }

    fn count_pictures_in_shape(shape: &ShapeObject) -> usize {
        let mut count = usize::from(matches!(shape, ShapeObject::Picture(_)));
        if let Some(drawing) = shape.drawing() {
            if let Some(text_box) = &drawing.text_box {
                count += count_pictures(&text_box.paragraphs);
            }
            if let Some(caption) = &drawing.caption {
                count += count_pictures(&caption.paragraphs);
            }
        }
        match shape {
            ShapeObject::Group(group) => {
                for child in &group.children {
                    count += count_pictures_in_shape(child);
                }
                if let Some(caption) = &group.caption {
                    count += count_pictures(&caption.paragraphs);
                }
            }
            ShapeObject::Picture(picture) => {
                if let Some(caption) = &picture.caption {
                    count += count_pictures(&caption.paragraphs);
                }
            }
            ShapeObject::Chart(chart) => {
                if let Some(caption) = &chart.caption {
                    count += count_pictures(&caption.paragraphs);
                }
            }
            ShapeObject::Ole(ole) => {
                if let Some(caption) = &ole.caption {
                    count += count_pictures(&caption.paragraphs);
                }
            }
            _ => {}
        }
        count
    }

    #[test]
    fn native_transfer_preserves_control_only_tables_after_save_reload() {
        let source_bytes = std::fs::read("samples/table-001.hwp").expect("table fixture");
        let source = DocumentCore::from_bytes(&source_bytes).expect("source parse");
        let source_tables: usize = source
            .document()
            .sections
            .iter()
            .map(|section| count_tables(&section.paragraphs))
            .sum();
        assert!(source_tables > 0);

        let mut target =
            DocumentCore::from_bytes(&std::fs::read("saved/blank2010.hwp").expect("blank fixture"))
                .expect("target parse");
        let end_para = source.document().sections[0].paragraphs.len() - 1;
        let result = target
            .paste_document_block_native(&source_bytes, 0, 0, end_para, 0, 0, 0)
            .expect("native transfer");
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["controlCounts"]["table"], source_tables);
        assert_eq!(result["skippedFeatures"][0], "sectionStructure");
        assert_eq!(
            count_tables(&target.document().sections[0].paragraphs),
            source_tables
        );

        let saved = target.export_hwpx_native().expect("save HWPX");
        let reparsed = DocumentCore::from_bytes(&saved).expect("reparse saved HWPX");
        assert_eq!(
            count_tables(&reparsed.document().sections[0].paragraphs),
            source_tables,
            "tables must survive the serializer boundary"
        );
        let saved_hwp = target.export_hwp_native().expect("save HWP");
        let reparsed_hwp = DocumentCore::from_bytes(&saved_hwp).expect("reparse saved HWP");
        assert_eq!(
            count_tables(&reparsed_hwp.document().sections[0].paragraphs),
            source_tables,
            "tables must survive the HWP serializer boundary"
        );
    }

    #[test]
    fn native_transfer_rejects_opaque_controls_atomically() {
        use crate::model::control::{Control, UnknownControl};

        let mut source =
            DocumentCore::from_bytes(&std::fs::read("saved/blank2010.hwp").expect("blank fixture"))
                .expect("source parse");
        source.document_mut().sections[0].paragraphs[0]
            .controls
            .push(Control::Unknown(UnknownControl {
                ctrl_id: 0x1234_5678,
                raw_ctrl_data: vec![1, 2, 3],
                raw_child_records: Vec::new(),
            }));
        source.document_mut().sections[0].raw_stream = None;
        let source_bytes = source.export_hwp_native().expect("serialize opaque source");

        let mut target =
            DocumentCore::from_bytes(&std::fs::read("saved/blank2010.hwp").expect("blank fixture"))
                .expect("target parse");
        let before = target.export_hwp_native().expect("target before");
        let error = target
            .paste_document_block_native(&source_bytes, 0, 0, 0, 0, 0, 0)
            .expect_err("opaque controls must fail closed");
        assert!(error.to_string().contains("opaque control"));
        assert_eq!(target.export_hwp_native().expect("target after"), before);
    }

    #[test]
    fn native_transfer_preserves_picture_controls_and_binary_payloads() {
        let source_bytes = std::fs::read("samples/test-image.hwp").expect("picture fixture");
        let source = DocumentCore::from_bytes(&source_bytes).expect("source parse");
        let source_pictures: usize = source
            .document()
            .sections
            .iter()
            .map(|section| count_pictures(&section.paragraphs))
            .sum();
        assert!(source_pictures > 0);

        let mut target =
            DocumentCore::from_bytes(&std::fs::read("saved/blank2010.hwp").expect("blank fixture"))
                .expect("target parse");
        let target_binary_count = target.document().bin_data_content.len();
        let end_para = source.document().sections[0].paragraphs.len() - 1;
        target
            .paste_document_block_native(&source_bytes, 0, 0, end_para, 0, 0, 0)
            .expect("native picture transfer");
        assert_eq!(
            count_pictures(&target.document().sections[0].paragraphs),
            source_pictures
        );
        assert!(target.document().bin_data_content.len() > target_binary_count);
        assert!(target.document().bin_data_content[target_binary_count..]
            .iter()
            .all(|content| !content.data.load().is_empty()));

        let saved = target.export_hwpx_native().expect("save picture HWPX");
        let reparsed = DocumentCore::from_bytes(&saved).expect("reparse picture HWPX");
        assert_eq!(
            count_pictures(&reparsed.document().sections[0].paragraphs),
            source_pictures,
            "picture controls must survive the serializer boundary"
        );
        assert!(reparsed
            .document()
            .bin_data_content
            .iter()
            .any(|content| !content.data.load().is_empty()));
        let saved_hwp = target.export_hwp_native().expect("save picture HWP");
        let reparsed_hwp = DocumentCore::from_bytes(&saved_hwp).expect("reparse saved picture HWP");
        assert_eq!(
            count_pictures(&reparsed_hwp.document().sections[0].paragraphs),
            source_pictures,
            "picture controls must survive the HWP serializer boundary"
        );
    }

    #[test]
    fn native_transfer_special_control_matrix_survives_save_reload() {
        let fixtures = [
            ("samples/issue-505-equations.hwp", "equation"),
            ("samples/field-01.hwp", "field"),
            ("samples/form-01.hwp", "form"),
            ("samples/footnote-01.hwp", "footnote"),
            (
                "samples/hwpx/opengov/36389301_결재문서본문_직장훈련계획_덧말.hwpx",
                "ruby",
            ),
            ("samples/한셀OLE.hwpx", "shape"),
            (
                "samples/valign_fixtures/centered_cell_nested_table.hwpx",
                "table",
            ),
        ];

        for (path, feature) in fixtures {
            let source_bytes = std::fs::read(path).unwrap_or_else(|error| {
                panic!("failed to read {path}: {error}");
            });
            let source = DocumentCore::from_bytes(&source_bytes)
                .unwrap_or_else(|error| panic!("failed to parse {path}: {error}"));
            let mut source_inventory = TransferInventory::default();
            inspect_paragraphs(
                &source.document().sections[0].paragraphs,
                &mut source_inventory,
            );
            let expected = source_inventory.controls.get(feature).copied().unwrap_or(0);
            assert!(expected > 0, "{path} must exercise {feature}");

            let mut target = DocumentCore::from_bytes(
                &std::fs::read("saved/blank2010.hwp").expect("blank fixture"),
            )
            .expect("target parse");
            let end_para = source.document().sections[0].paragraphs.len() - 1;
            let result = target
                .paste_document_block_native(&source_bytes, 0, 0, end_para, 0, 0, 0)
                .unwrap_or_else(|error| panic!("native transfer failed for {path}: {error}"));
            let result: serde_json::Value = serde_json::from_str(&result).unwrap();
            assert_eq!(result["controlCounts"][feature], expected, "{path}");

            let saved = target
                .export_hwpx_native()
                .unwrap_or_else(|error| panic!("save failed for {path}: {error}"));
            let reparsed = DocumentCore::from_bytes(&saved)
                .unwrap_or_else(|error| panic!("reparse failed for {path}: {error}"));
            let mut saved_inventory = TransferInventory::default();
            inspect_paragraphs(
                &reparsed.document().sections[0].paragraphs,
                &mut saved_inventory,
            );
            assert_eq!(
                saved_inventory.controls.get(feature).copied().unwrap_or(0),
                expected,
                "{feature} controls must survive save/reload for {path}"
            );
        }
    }
}
