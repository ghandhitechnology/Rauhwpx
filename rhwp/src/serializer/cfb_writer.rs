//! CFB 컨테이너 조립 + 스트림 압축
//!
//! `parser::cfb_reader`의 역방향으로, 직렬화된 스트림을 CFB 컨테이너로 조립한다.
//!
//! 구조:
//! - /FileHeader (256바이트, 비압축)
//! - /DocInfo (레코드 바이트, 조건부 deflate)
//! - /BodyText/Section{N} (레코드 바이트, 조건부 deflate)
//! - /BinData/BIN{XXXX}.{ext} (바이너리 데이터)

use std::borrow::Cow;
use std::collections::HashSet;
use std::io::{self, Read, Write};

use crate::model::bin_data::{BinData, BinDataContent, BinDataStreamEncoding, BinDataType};
use crate::model::document::{Document, Preview};

use super::body_text::{serialize_section, serialize_section_limited};
use super::doc_info::{
    serialize_doc_info, serialize_doc_info_generated_limited, serialize_doc_info_limited,
    surgical_update_section_count,
};
use super::header::serialize_file_header;
use super::mini_cfb;
use super::SerializeError;

/// Document IR을 HWP 5.0 CFB 바이너리로 직렬화
pub fn serialize_hwp(doc: &Document) -> Result<Vec<u8>, SerializeError> {
    serialize_hwp_with_limits(doc, HwpWriteLimits::production())
}

#[derive(Clone, Copy)]
struct HwpWriteLimits {
    max_structural_member_bytes: usize,
    max_expanded_bytes: u64,
    max_encoded_bytes: u64,
    max_output_bytes: usize,
}

impl HwpWriteLimits {
    fn production() -> Self {
        Self {
            max_structural_member_bytes: crate::parser::limits::MAX_STRUCTURAL_BYTES,
            max_expanded_bytes: crate::parser::limits::MAX_CONTAINER_BYTES,
            max_encoded_bytes: crate::parser::limits::MAX_CONTAINER_BYTES,
            max_output_bytes: crate::parser::limits::MAX_CONTAINER_BYTES as usize,
        }
    }
}

struct ExpandedWriteBudget {
    used: u64,
    max: u64,
}

impl ExpandedWriteBudget {
    fn new(max: u64) -> Self {
        Self { used: 0, max }
    }

    fn remaining_member(&self, member_limit: usize) -> usize {
        usize::try_from(self.max.saturating_sub(self.used))
            .unwrap_or(usize::MAX)
            .min(member_limit)
    }

    fn reserve(&mut self, path: &str, bytes: usize) -> Result<(), SerializeError> {
        let next = self.used.checked_add(bytes as u64).ok_or_else(|| {
            SerializeError::CfbError("expanded HWP stream budget overflow".to_string())
        })?;
        if next > self.max {
            return Err(SerializeError::CfbError(format!(
                "expanded HWP stream budget exceeded while adding {path}: {next} > {} bytes",
                self.max
            )));
        }
        self.used = next;
        Ok(())
    }
}

struct PreviewParts<'a> {
    image: Option<&'a [u8]>,
    text: Option<Cow<'a, str>>,
}

/// PrvText 가 비었거나 placeholder 면 본문 텍스트로 채운다.
///
/// 원본 미리보기가 실재하면 그대로 둔다 (라운드트립 보존).
fn supplement_preview(doc: &Document) -> PreviewParts<'_> {
    let image = doc
        .preview
        .as_ref()
        .and_then(|preview| preview.image.as_ref())
        .map(|image| image.data.as_slice());
    let original_text = doc
        .preview
        .as_ref()
        .and_then(|preview| preview.text.as_ref());
    let has_real_text = doc
        .preview
        .as_ref()
        .and_then(|preview| preview.text.as_ref())
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);

    if has_real_text {
        return PreviewParts {
            image,
            text: original_text.map(|text| Cow::Borrowed(text.as_str())),
        };
    }

    let text = build_preview_text(doc);
    if text.trim().is_empty() {
        return PreviewParts {
            image,
            text: original_text.map(|text| Cow::Borrowed(text.as_str())),
        };
    }

    PreviewParts {
        image,
        text: Some(Cow::Owned(text)),
    }
}

/// 본문 문단에서 미리보기 텍스트를 만든다.
///
/// 한컴은 앞부분 일부만 담는다 (shortcut.hwp 실측 2044B ≈ 1022자).
/// 표/글상자 안 텍스트는 제외하고 본문 문단만 이어 붙인다.
fn build_preview_text(doc: &Document) -> String {
    const MAX_CHARS: usize = 1000;

    let mut out = String::new();
    let mut written = 0usize;
    for section in &doc.sections {
        for para in &section.paragraphs {
            let line = para.text.trim_end_matches('\u{0}');
            if line.is_empty() {
                continue;
            }
            for ch in line.chars().chain("\r\n".chars()) {
                if written == MAX_CHARS {
                    return out;
                }
                out.push(ch);
                written += 1;
            }
        }
    }
    out
}

/// raw deflate 압축 (wbits=-15)
fn compress_stream(data: &[u8]) -> Result<Vec<u8>, SerializeError> {
    compress_stream_limited(data, usize::MAX)
}

struct LimitedVecWriter {
    bytes: Vec<u8>,
    max_bytes: usize,
}

impl LimitedVecWriter {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: Vec::new(),
            max_bytes,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.bytes
    }
}

impl Write for LimitedVecWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let next = self
            .bytes
            .len()
            .checked_add(buf.len())
            .ok_or_else(|| io::Error::other("compressed stream size overflow"))?;
        if next > self.max_bytes {
            return Err(io::Error::other(format!(
                "compressed stream exceeds byte limit: {next} > {}",
                self.max_bytes
            )));
        }
        if next > self.bytes.capacity() {
            let target_capacity = self
                .bytes
                .capacity()
                .saturating_mul(2)
                .max(next)
                .min(self.max_bytes);
            self.bytes
                .try_reserve_exact(target_capacity - self.bytes.len())
                .map_err(|error| {
                    io::Error::other(format!("compression allocation failed: {error}"))
                })?;
        }
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn compress_stream_limited(data: &[u8], max_bytes: usize) -> Result<Vec<u8>, SerializeError> {
    use flate2::write::DeflateEncoder;
    use flate2::Compression;

    let mut encoder = DeflateEncoder::new(LimitedVecWriter::new(max_bytes), Compression::default());
    encoder
        .write_all(data)
        .map_err(|e| SerializeError::CompressError(e.to_string()))?;
    encoder
        .finish()
        .map(LimitedVecWriter::into_inner)
        .map_err(|e| SerializeError::CompressError(e.to_string()))
}

struct DecodedStreamMeasure {
    len: usize,
    prefix: [u8; 12],
    prefix_len: usize,
}

enum MeasureStreamError {
    Limit,
    Decode(String),
}

fn measure_reader_limited<R: Read>(
    mut reader: R,
    max_bytes: usize,
) -> Result<DecodedStreamMeasure, MeasureStreamError> {
    let mut result = DecodedStreamMeasure {
        len: 0,
        prefix: [0; 12],
        prefix_len: 0,
    };
    let mut buffer = [0u8; 8 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| MeasureStreamError::Decode(error.to_string()))?;
        if read == 0 {
            return Ok(result);
        }
        let next = result
            .len
            .checked_add(read)
            .ok_or(MeasureStreamError::Limit)?;
        if next > max_bytes {
            return Err(MeasureStreamError::Limit);
        }
        if result.prefix_len < result.prefix.len() {
            let copy_len = read.min(result.prefix.len() - result.prefix_len);
            result.prefix[result.prefix_len..result.prefix_len + copy_len]
                .copy_from_slice(&buffer[..copy_len]);
            result.prefix_len += copy_len;
        }
        result.len = next;
    }
}

fn measure_preserved_bin_data_expanded_len(
    encoded: &[u8],
    encoding: BinDataStreamEncoding,
    max_expanded_bytes: usize,
    path: &str,
) -> Result<usize, SerializeError> {
    // HWP OLE streams may contain a four-byte decoded size prefix which the
    // parser removes. Permit those four bytes while counting, then charge the
    // normalized payload length used by the parser's aggregate budget.
    let decode_limit = max_expanded_bytes
        .checked_add(usize::from(encoding.ole_storage) * 4)
        .unwrap_or(max_expanded_bytes);
    let measured = if encoding.compressed {
        let raw = measure_reader_limited(flate2::read::DeflateDecoder::new(encoded), decode_limit);
        match raw {
            Ok(measured) => measured,
            Err(raw_error) => {
                let raw_exceeded = matches!(raw_error, MeasureStreamError::Limit);
                match measure_reader_limited(flate2::read::ZlibDecoder::new(encoded), decode_limit)
                {
                    Ok(measured) => measured,
                    Err(MeasureStreamError::Limit) => {
                        return Err(SerializeError::CfbError(format!(
                            "expanded BinData stream exceeds remaining byte budget: {path}"
                        )));
                    }
                    Err(MeasureStreamError::Decode(_)) if raw_exceeded => {
                        return Err(SerializeError::CfbError(format!(
                            "expanded BinData stream exceeds remaining byte budget: {path}"
                        )));
                    }
                    Err(MeasureStreamError::Decode(error)) => {
                        return Err(SerializeError::CfbError(format!(
                            "compressed BinData stream could not be measured safely: {path}: {error}"
                        )));
                    }
                }
            }
        }
    } else {
        if encoded.len() > decode_limit {
            return Err(SerializeError::CfbError(format!(
                "expanded BinData stream exceeds remaining byte budget: {path}"
            )));
        }
        let mut prefix = [0; 12];
        let prefix_len = encoded.len().min(prefix.len());
        prefix[..prefix_len].copy_from_slice(&encoded[..prefix_len]);
        DecodedStreamMeasure {
            len: encoded.len(),
            prefix,
            prefix_len,
        }
    };

    const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    let has_ole_size_prefix = encoding.ole_storage
        && measured.prefix_len >= 12
        && measured.prefix[..8] != CFB_MAGIC
        && measured.prefix[4..12] == CFB_MAGIC;
    let expanded_len = measured.len - usize::from(has_ole_size_prefix) * 4;
    if expanded_len > max_expanded_bytes {
        return Err(SerializeError::CfbError(format!(
            "expanded BinData stream exceeds remaining byte budget: {path}"
        )));
    }
    Ok(expanded_len)
}

fn stream_budget_error(path: &str, actual: u64, limit: u64) -> SerializeError {
    SerializeError::CfbError(format!(
        "encoded stream budget exceeded while adding {path}: {actual} > {limit} bytes"
    ))
}

fn remaining_stream_budget(encoded_bytes: u64, max_encoded_bytes: u64) -> usize {
    usize::try_from(max_encoded_bytes.saturating_sub(encoded_bytes)).unwrap_or(usize::MAX)
}

struct StreamAccumulator<'a> {
    streams: Vec<(String, mini_cfb::CfbStreamData<'a>)>,
    encoded_bytes: u64,
    max_encoded_bytes: u64,
}

impl<'a> StreamAccumulator<'a> {
    fn new(max_encoded_bytes: u64) -> Self {
        Self {
            streams: Vec::new(),
            encoded_bytes: 0,
            max_encoded_bytes,
        }
    }

    fn remaining(&self) -> usize {
        remaining_stream_budget(self.encoded_bytes, self.max_encoded_bytes)
    }

    fn push(
        &mut self,
        path: String,
        data: mini_cfb::CfbStreamData<'a>,
    ) -> Result<(), SerializeError> {
        let next = self
            .encoded_bytes
            .checked_add(data.len() as u64)
            .ok_or_else(|| stream_budget_error(&path, u64::MAX, self.max_encoded_bytes))?;
        if next > self.max_encoded_bytes {
            return Err(stream_budget_error(&path, next, self.max_encoded_bytes));
        }
        self.streams.push((path, data));
        self.encoded_bytes = next;
        Ok(())
    }

    fn finish(self, max_output_bytes: usize) -> Result<Vec<u8>, SerializeError> {
        mini_cfb::build_cfb_streams_with_limit(self.streams, max_output_bytes)
            .map_err(SerializeError::CfbError)
    }
}

struct StreamMetadata {
    extra_preview_image: bool,
    extra_preview_text: bool,
}

fn validate_stream_metadata(
    section_count: usize,
    bin_data_list: &[BinData],
    bin_data_content: &[BinDataContent],
    preview: &PreviewParts<'_>,
    extra_streams: &[(String, Vec<u8>)],
    compressed: bool,
) -> Result<StreamMetadata, SerializeError> {
    // Validate the complete path/collision metadata before cloning or
    // materializing any payload. Programmatic Documents and format converters
    // can carry paths that did not originate in a strict CFB parser.
    // Root plus every stream that is always emitted is a cheap lower bound.
    // Preview streams and implicit storage entries are counted exactly below;
    // omitting them here avoids rejecting a valid near-limit document merely
    // because its optional previews are absent or shadowed by extra streams.
    let minimum_directory_entries = 1usize
        .checked_add(2)
        .and_then(|count| count.checked_add(section_count))
        .and_then(|count| count.checked_add(bin_data_content.len()))
        .and_then(|count| count.checked_add(extra_streams.len()))
        .ok_or_else(|| SerializeError::CfbError("CFB stream count overflow".to_string()))?;
    if minimum_directory_entries > crate::parser::limits::MAX_CFB_DIRECTORY_ENTRIES {
        return Err(SerializeError::CfbError(format!(
            "CFB directory entry count exceeds limit: {minimum_directory_entries} > {}",
            crate::parser::limits::MAX_CFB_DIRECTORY_ENTRIES
        )));
    }
    let mut generated_paths = HashSet::new();
    let mut emitted_paths = vec!["/FileHeader".to_string(), "/DocInfo".to_string()];
    for path in ["/FileHeader", "/DocInfo"] {
        generated_paths.insert(mini_cfb::cfb_path_key(path));
    }
    for index in 0..section_count {
        let path = format!("/BodyText/Section{index}");
        generated_paths.insert(mini_cfb::cfb_path_key(&path));
        emitted_paths.push(path);
    }
    for content in bin_data_content {
        let (storage_id, ext, _, _) =
            find_bin_data_info_with_compress(bin_data_list, content, compressed);
        let storage_name = format!("BIN{:04X}.{}", storage_id, ext);
        crate::parser::cfb_reader::validate_bin_data_storage_name(&storage_name)
            .map_err(|error| SerializeError::CfbError(error.to_string()))?;
        let path = format!("/BinData/{storage_name}");
        if !generated_paths.insert(mini_cfb::cfb_path_key(&path)) {
            return Err(SerializeError::CfbError(format!(
                "duplicate generated BinData stream: {path}"
            )));
        }
        emitted_paths.push(path);
    }
    if preview.image.is_some() {
        generated_paths.insert(mini_cfb::cfb_path_key("/PrvImage"));
    }
    if preview.text.is_some() {
        generated_paths.insert(mini_cfb::cfb_path_key("/PrvText"));
    }
    let preview_keys = [
        mini_cfb::cfb_path_key("/PrvImage"),
        mini_cfb::cfb_path_key("/PrvText"),
    ];
    let mut extra_paths = HashSet::with_capacity(extra_streams.len());
    for (path, _) in extra_streams {
        mini_cfb::validate_cfb_path(path).map_err(SerializeError::CfbError)?;
        let key = mini_cfb::cfb_path_key(path);
        if !extra_paths.insert(key.clone()) {
            return Err(SerializeError::CfbError(format!(
                "duplicate extra HWP stream: {path}"
            )));
        }
        if generated_paths.contains(&key) && !preview_keys.contains(&key) {
            return Err(SerializeError::CfbError(format!(
                "extra stream conflicts with generated HWP stream: {path}"
            )));
        }
    }

    let extra_preview_image = extra_paths.contains(&preview_keys[0]);
    let extra_preview_text = extra_paths.contains(&preview_keys[1]);
    if preview.image.is_some() && !extra_preview_image {
        emitted_paths.push("/PrvImage".to_string());
    }
    if preview.text.is_some() && !extra_preview_text {
        emitted_paths.push("/PrvText".to_string());
    }
    emitted_paths.extend(extra_streams.iter().map(|(path, _)| path.clone()));
    mini_cfb::validate_cfb_stream_paths(emitted_paths).map_err(SerializeError::CfbError)?;

    Ok(StreamMetadata {
        extra_preview_image,
        extra_preview_text,
    })
}

fn push_structural<'a>(
    streams: &mut StreamAccumulator<'a>,
    path: String,
    bytes: Cow<'a, [u8]>,
    compressed: bool,
) -> Result<(), SerializeError> {
    let data = if compressed {
        mini_cfb::CfbStreamData::Owned(compress_stream_limited(
            bytes.as_ref(),
            streams.remaining(),
        )?)
    } else {
        match bytes {
            Cow::Borrowed(bytes) => mini_cfb::CfbStreamData::Borrowed(bytes),
            Cow::Owned(bytes) => mini_cfb::CfbStreamData::Owned(bytes),
        }
    };
    streams.push(path, data)
}

fn serialize_hwp_with_limits(
    doc: &Document,
    limits: HwpWriteLimits,
) -> Result<Vec<u8>, SerializeError> {
    let compressed = doc.header.compressed;
    let preview = supplement_preview(doc);
    let metadata = validate_stream_metadata(
        doc.sections.len(),
        &doc.doc_info.bin_data_list,
        &doc.bin_data_content,
        &preview,
        &doc.extra_streams,
        compressed,
    )?;
    let mut expanded = ExpandedWriteBudget::new(limits.max_expanded_bytes);
    let mut streams = StreamAccumulator::new(limits.max_encoded_bytes);

    // [Task #1768] Distribution/encryption flags are cleared because this
    // writer emits ordinary BodyText, never ViewText/DISTRIBUTE_DOC_DATA.
    let header_limit = expanded.remaining_member(limits.max_structural_member_bytes);
    if doc
        .header
        .raw_data
        .as_ref()
        .is_some_and(|raw| raw.len() > header_limit)
    {
        return Err(SerializeError::CfbError(format!(
            "HWP FileHeader structural stream exceeds byte limit: {} > {header_limit}",
            doc.header.raw_data.as_ref().map_or(0, Vec::len)
        )));
    }
    let mut header_bytes = if let Some(raw) = doc.header.raw_data.as_deref() {
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(raw.len())
            .map_err(|error| SerializeError::CfbError(format!("FileHeader: {error}")))?;
        bytes.extend_from_slice(raw);
        bytes
    } else {
        serialize_file_header(&doc.header)
    };
    if doc.header.distribution || doc.header.encrypted {
        if header_bytes.len() >= 40 {
            let flags = u32::from_le_bytes([
                header_bytes[36],
                header_bytes[37],
                header_bytes[38],
                header_bytes[39],
            ]) & !0x06u32;
            header_bytes[36..40].copy_from_slice(&flags.to_le_bytes());
        }
    }
    if header_bytes.len() > header_limit {
        return Err(SerializeError::CfbError(format!(
            "HWP FileHeader structural stream exceeds byte limit: {} > {header_limit}",
            header_bytes.len()
        )));
    }
    expanded.reserve("/FileHeader", header_bytes.len())?;
    streams.push(
        "/FileHeader".to_string(),
        mini_cfb::CfbStreamData::Owned(header_bytes),
    )?;

    // DOCUMENT_PROPERTIES.section_count must match the streams emitted below.
    let emitted_sections = doc.sections.len().min(u16::MAX as usize) as u16;
    let doc_info_limit = expanded.remaining_member(limits.max_structural_member_bytes);
    let mut doc_info_bytes =
        serialize_doc_info_limited(&doc.doc_info, &doc.doc_properties, doc_info_limit)
            .map_err(SerializeError::CfbError)?;
    if surgical_update_section_count(&mut doc_info_bytes, emitted_sections).is_err() {
        drop(doc_info_bytes);
        doc_info_bytes = serialize_doc_info_generated_limited(
            &doc.doc_info,
            &doc.doc_properties,
            emitted_sections,
            doc_info_limit,
        )
        .map_err(SerializeError::CfbError)?;
    }
    expanded.reserve("/DocInfo", doc_info_bytes.len())?;
    push_structural(
        &mut streams,
        "/DocInfo".to_string(),
        Cow::Owned(doc_info_bytes),
        compressed,
    )?;

    // Sections are serialized and (when enabled) compressed one at a time.
    // The raw Vec for one section is dropped before the next section begins.
    for (index, section) in doc.sections.iter().enumerate() {
        let path = format!("/BodyText/Section{index}");
        let section_limit = expanded.remaining_member(limits.max_structural_member_bytes);
        let bytes =
            serialize_section_limited(section, section_limit).map_err(SerializeError::CfbError)?;
        expanded.reserve(&path, bytes.len())?;
        push_structural(&mut streams, path, bytes, compressed)?;
    }

    append_bin_data(
        &mut streams,
        &mut expanded,
        &doc.doc_info.bin_data_list,
        &doc.bin_data_content,
        compressed,
    )?;
    append_preview(
        &mut streams,
        &mut expanded,
        &preview,
        &metadata,
        limits.max_structural_member_bytes,
    )?;
    append_extra_streams(
        &mut streams,
        &mut expanded,
        &doc.extra_streams,
        limits.max_structural_member_bytes,
    )?;

    streams.finish(limits.max_output_bytes)
}

fn append_bin_data<'a>(
    streams: &mut StreamAccumulator<'a>,
    expanded: &mut ExpandedWriteBudget,
    bin_data_list: &'a [BinData],
    bin_data_content: &'a [BinDataContent],
    compressed: bool,
) -> Result<(), SerializeError> {
    const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    for content in bin_data_content {
        let (storage_id, ext, should_compress, ole_storage) =
            find_bin_data_info_with_compress(bin_data_list, content, compressed);
        let storage_name = format!("BIN{:04X}.{}", storage_id, ext);
        let path = format!("/BinData/{storage_name}");
        let expanded_remaining = expanded.remaining_member(crate::parser::limits::MAX_BINARY_BYTES);
        let decoded = content.data.load_limited_payload(expanded_remaining);
        if decoded
            .as_ref()
            .is_none_or(|payload| payload.as_ref().is_empty())
        {
            let encoding = BinDataStreamEncoding {
                compressed: should_compress,
                ole_storage,
            };
            if let Some(original) = content
                .data
                .load_original_stream_limited(encoding, streams.remaining())
            {
                if decoded.is_none() || !original.is_empty() {
                    let expanded_len = measure_preserved_bin_data_expanded_len(
                        &original,
                        encoding,
                        expanded_remaining,
                        &path,
                    )?;
                    expanded.reserve(&path, expanded_len)?;
                    streams.push(path, mini_cfb::CfbStreamData::Owned(original))?;
                    continue;
                }
            }
        }
        let bytes = decoded.ok_or_else(|| {
            SerializeError::CfbError(format!(
                "BinData stream could not be materialized safely: {path}"
            ))
        })?;
        let byte_slice = bytes.as_ref();
        let is_ole_storage = byte_slice.len() >= 8 && byte_slice[..8] == CFB_MAGIC && ole_storage;
        let payload = if is_ole_storage {
            let payload_len = byte_slice.len().checked_add(4).ok_or_else(|| {
                SerializeError::CfbError(format!("BinData size overflow: {path}"))
            })?;
            if (!should_compress && payload_len > streams.remaining())
                || payload_len > expanded.remaining_member(crate::parser::limits::MAX_BINARY_BYTES)
            {
                return Err(SerializeError::CfbError(format!(
                    "BinData stream exceeds remaining byte budget: {path}"
                )));
            }
            let mut value = Vec::new();
            value
                .try_reserve_exact(payload_len)
                .map_err(|error| SerializeError::CfbError(format!("{path}: {error}")))?;
            value.extend_from_slice(&(byte_slice.len() as u32).to_le_bytes());
            value.extend_from_slice(byte_slice);
            mini_cfb::CfbStreamData::Owned(value)
        } else {
            match bytes {
                crate::model::bin_data::BinDataPayload::Borrowed(bytes) => {
                    mini_cfb::CfbStreamData::Borrowed(bytes)
                }
                crate::model::bin_data::BinDataPayload::Shared(bytes) => {
                    mini_cfb::CfbStreamData::Shared(bytes)
                }
            }
        };
        expanded.reserve(&path, payload.len())?;
        let data = if should_compress {
            mini_cfb::CfbStreamData::Owned(compress_stream_limited(
                payload.as_ref(),
                streams.remaining(),
            )?)
        } else {
            payload
        };
        streams.push(path, data)?;
    }
    Ok(())
}

fn encode_preview_text_limited(text: &str, max_bytes: usize) -> Result<Vec<u8>, SerializeError> {
    let code_units = text.encode_utf16().count();
    let byte_len = code_units
        .checked_mul(2)
        .ok_or_else(|| SerializeError::CfbError("PrvText size overflow".to_string()))?;
    if byte_len > max_bytes {
        return Err(SerializeError::CfbError(format!(
            "HWP PrvText stream exceeds byte limit: {byte_len} > {max_bytes}"
        )));
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(byte_len)
        .map_err(|error| SerializeError::CfbError(format!("PrvText: {error}")))?;
    for code_unit in text.encode_utf16() {
        bytes.extend_from_slice(&code_unit.to_le_bytes());
    }
    Ok(bytes)
}

fn append_preview<'a>(
    streams: &mut StreamAccumulator<'a>,
    expanded: &mut ExpandedWriteBudget,
    preview: &PreviewParts<'a>,
    metadata: &StreamMetadata,
    max_structural_member_bytes: usize,
) -> Result<(), SerializeError> {
    if !metadata.extra_preview_image {
        if let Some(image) = preview.image {
            let limit = streams
                .remaining()
                .min(expanded.remaining_member(crate::parser::limits::MAX_THUMBNAIL_BYTES));
            if image.len() > limit {
                return Err(SerializeError::CfbError(format!(
                    "HWP PrvImage stream exceeds byte limit: {} > {limit}",
                    image.len()
                )));
            }
            expanded.reserve("/PrvImage", image.len())?;
            streams.push(
                "/PrvImage".to_string(),
                mini_cfb::CfbStreamData::Borrowed(image),
            )?;
        }
    }
    if !metadata.extra_preview_text {
        if let Some(text) = preview.text.as_deref() {
            let limit = streams
                .remaining()
                .min(expanded.remaining_member(max_structural_member_bytes));
            let bytes = encode_preview_text_limited(text, limit)?;
            expanded.reserve("/PrvText", bytes.len())?;
            streams.push(
                "/PrvText".to_string(),
                mini_cfb::CfbStreamData::Owned(bytes),
            )?;
        }
    }
    Ok(())
}

fn append_extra_streams<'a>(
    streams: &mut StreamAccumulator<'a>,
    expanded: &mut ExpandedWriteBudget,
    extra_streams: &'a [(String, Vec<u8>)],
    max_structural_member_bytes: usize,
) -> Result<(), SerializeError> {
    let image_key = mini_cfb::cfb_path_key("/PrvImage");
    let text_key = mini_cfb::cfb_path_key("/PrvText");
    for (path, data) in extra_streams {
        let key = mini_cfb::cfb_path_key(path);
        let member_limit = if key == image_key {
            crate::parser::limits::MAX_THUMBNAIL_BYTES
        } else if key == text_key {
            max_structural_member_bytes
        } else {
            crate::parser::limits::MAX_BINARY_BYTES
        };
        let limit = streams
            .remaining()
            .min(expanded.remaining_member(member_limit));
        if data.len() > limit {
            return Err(SerializeError::CfbError(format!(
                "extra HWP stream exceeds byte limit while adding {path}: {} > {limit}",
                data.len()
            )));
        }
        expanded.reserve(path, data.len())?;
        streams.push(path.clone(), mini_cfb::CfbStreamData::Borrowed(data))?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write_hwp_cfb_with_stream_budget(
    header_bytes: &[u8],
    doc_info_bytes: &[u8],
    section_bytes_list: &[Vec<u8>],
    bin_data_list: &[BinData],
    bin_data_content: &[BinDataContent],
    preview: &Option<Preview>,
    extra_streams: &[(String, Vec<u8>)],
    compressed: bool,
    max_encoded_bytes: u64,
) -> Result<Vec<u8>, SerializeError> {
    let preview = PreviewParts {
        image: preview
            .as_ref()
            .and_then(|value| value.image.as_ref())
            .map(|image| image.data.as_slice()),
        text: preview
            .as_ref()
            .and_then(|value| value.text.as_deref())
            .map(Cow::Borrowed),
    };
    let metadata = validate_stream_metadata(
        section_bytes_list.len(),
        bin_data_list,
        bin_data_content,
        &preview,
        extra_streams,
        compressed,
    )?;
    let mut streams = StreamAccumulator::new(max_encoded_bytes);
    let mut expanded = ExpandedWriteBudget::new(max_encoded_bytes);

    expanded.reserve("/FileHeader", header_bytes.len())?;
    streams.push(
        "/FileHeader".to_string(),
        mini_cfb::CfbStreamData::Borrowed(header_bytes),
    )?;
    expanded.reserve("/DocInfo", doc_info_bytes.len())?;
    push_structural(
        &mut streams,
        "/DocInfo".to_string(),
        Cow::Borrowed(doc_info_bytes),
        compressed,
    )?;
    for (index, bytes) in section_bytes_list.iter().enumerate() {
        let path = format!("/BodyText/Section{index}");
        expanded.reserve(&path, bytes.len())?;
        push_structural(&mut streams, path, Cow::Borrowed(bytes), compressed)?;
    }
    append_bin_data(
        &mut streams,
        &mut expanded,
        bin_data_list,
        bin_data_content,
        compressed,
    )?;
    append_preview(
        &mut streams,
        &mut expanded,
        &preview,
        &metadata,
        crate::parser::limits::MAX_STRUCTURAL_BYTES,
    )?;
    append_extra_streams(
        &mut streams,
        &mut expanded,
        extra_streams,
        crate::parser::limits::MAX_STRUCTURAL_BYTES,
    )?;

    streams.finish(crate::parser::limits::MAX_CONTAINER_BYTES as usize)
}

/// BinDataContent에 대응하는 BinData 정보(storage_id, extension, should_compress) 찾기
///
/// should_compress: BinData의 압축 속성에 따라 재압축 여부 결정
/// - Default: 문서 전체 compressed 플래그 따름
/// - Compress: 항상 압축
/// - NoCompress: 비압축
fn find_bin_data_info_with_compress<'a>(
    bin_data_list: &'a [BinData],
    content: &'a BinDataContent,
    doc_compressed: bool,
) -> (u16, &'a str, bool, bool) {
    use crate::model::bin_data::BinDataCompression;
    for bd in bin_data_list {
        if matches!(bd.data_type, BinDataType::Embedding | BinDataType::Storage)
            && bd.storage_id == content.id
        {
            let ole_storage = bd.data_type == BinDataType::Storage;
            let ext = bd
                .extension
                .as_deref()
                .unwrap_or(if ole_storage { "OLE" } else { "dat" });
            let should_compress = match bd.compression {
                BinDataCompression::Default => doc_compressed,
                BinDataCompression::Compress => true,
                BinDataCompression::NoCompress => false,
            };
            return (bd.storage_id, ext, should_compress, ole_storage);
        }
    }
    // 못 찾으면 content에서 직접 추출 (문서 압축 플래그 따름)
    (content.id, &content.extension, doc_compressed, false)
}

#[cfg(test)]
mod tests;
