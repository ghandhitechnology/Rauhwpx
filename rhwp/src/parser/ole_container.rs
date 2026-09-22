//! OLE 컨테이너 내부 CFB 파싱 (Task #195 단계 7)
//!
//! BinData/BIN000N.OLE 스트림의 압축 해제 후 바이트는 표준 CFB(Compound File Binary) 컨테이너이다.
//! 이 모듈은 그 내부 스트림(`\x02OlePres000`, `OOXMLChartContents`, `Contents`)을 추출한다.

use cfb::CompoundFile;
use std::io::{Cursor, Read};

use crate::parser::cfb_reader::validate_cfb_directory_entry_budget;
use crate::parser::limits::{
    MAX_BINARY_BYTES, MAX_CONTAINER_BYTES, MAX_STRUCTURAL_BYTES, MAX_THUMBNAIL_BYTES,
};

const MAX_RELEVANT_OLE_STREAMS: usize = 16;

fn read_limited<R: Read>(reader: &mut R, max_bytes: usize) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((max_bytes as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= max_bytes).then_some(bytes)
}

/// OLE 컨테이너에서 추출한 네이티브 이미지 종류
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeImageKind {
    Bmp,
    Png,
    Jpeg,
    Gif,
}

impl NativeImageKind {
    pub fn mime(&self) -> &'static str {
        match self {
            Self::Bmp => "image/bmp",
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
        }
    }
}

/// OLE 컨테이너 내용
#[derive(Debug, Clone, Default)]
pub struct OleContainer {
    /// `\x02OlePres000` 스트림에서 추출한 EMF 바이트 (OLE Presentation Stream 헤더 스킵됨)
    pub preview_emf: Option<Vec<u8>>,
    /// [#3363] `\x02OlePres000` 스트림에서 추출한 WMF 바이트 — EMF 부재 시 폴백.
    /// HWP3 내장 OLE(글맵시 등)의 프레젠테이션은 표준 WMF 다 (SO-SUEOP 실측:
    /// 40바이트 헤더 뒤 `01 00 09 00 03` 표준 WMF).
    pub preview_wmf: Option<Vec<u8>>,
    /// `OOXMLChartContents` 원본 바이트 (OOXML 차트 XML)
    pub ooxml_chart: Option<Vec<u8>>,
    /// `Contents` 원본 바이트 (내부 OLE 데이터)
    pub raw_contents: Option<Vec<u8>>,
    /// `\x01Ole10Native` 스트림에서 추출한 네이티브 임베딩 바이트 (BMP/PNG/JPEG 등)
    pub native_image: Option<(NativeImageKind, Vec<u8>)>,
}

impl OleContainer {
    /// OOXML 차트 XML을 포함하는지 여부
    pub fn has_ooxml_chart(&self) -> bool {
        self.ooxml_chart.as_ref().is_some_and(|b| !b.is_empty())
    }

    /// 메타파일(EMF/WMF) 프리뷰를 포함하는지 여부
    pub fn has_preview(&self) -> bool {
        self.preview_emf.as_ref().is_some_and(|b| !b.is_empty())
            || self.preview_wmf.as_ref().is_some_and(|b| !b.is_empty())
    }
}

/// 해제된 BinData 바이트(CFB 컨테이너)에서 주요 스트림 추출
///
/// 입력: CFB 매직(`D0CF11E0...`)로 시작하는 바이트 슬라이스
/// 반환: 내부 스트림이 하나라도 존재하면 `Some(container)`, CFB 파싱 실패 시 `None`
pub fn parse_ole_container(cfb_bytes: &[u8]) -> Option<OleContainer> {
    if cfb_bytes.len() < 8 || cfb_bytes.len() as u64 > MAX_CONTAINER_BYTES {
        return None;
    }
    validate_cfb_directory_entry_budget(cfb_bytes).ok()?;
    let cursor = Cursor::new(cfb_bytes);
    let mut comp = CompoundFile::open(cursor).ok()?;

    let mut container = OleContainer::default();

    // 최상위 스트림 목록 수집
    let mut entries: Vec<String> = comp
        .walk()
        .filter(|entry| entry.is_stream())
        .filter_map(|entry| {
            let path = entry.path().to_string_lossy();
            let name = path.trim_start_matches('/');
            (name == "\u{0002}OlePres000"
                || name.ends_with("OlePres000")
                || name == "OOXMLChartContents"
                || name == "Contents"
                || name == "\u{0001}Ole10Native"
                || name.ends_with("Ole10Native"))
            .then(|| path.into_owned())
        })
        .take(MAX_RELEVANT_OLE_STREAMS)
        .collect();
    // Prefer a real Ole10Native payload over a DIB synthesized from the preview,
    // regardless of attacker-controlled directory order.
    entries.sort_by_key(|path| (!path.ends_with("Ole10Native")) as u8);

    let mut retained_bytes = 0u64;

    for path in entries {
        let name = path.trim_start_matches('/');
        if name == "\u{0002}OlePres000" || name.ends_with("OlePres000") {
            if container.has_preview() {
                continue;
            }
            if let Ok(mut s) = comp.open_stream(&path) {
                let remaining = MAX_CONTAINER_BYTES.saturating_sub(retained_bytes) as usize;
                let limit = MAX_THUMBNAIL_BYTES.min(remaining);
                if s.len() <= limit as u64 {
                    let Some(buf) = read_limited(&mut s, limit) else {
                        continue;
                    };
                    container.preview_emf = strip_ole_presentation_header(&buf);
                    // [#3363] EMF 부재 시 WMF 프레젠테이션 폴백 (HWP3 내장 OLE·글맵시)
                    if container.preview_emf.is_none() {
                        container.preview_wmf = strip_ole_presentation_header_wmf(&buf);
                    }
                    let mut newly_retained = container
                        .preview_emf
                        .as_ref()
                        .or(container.preview_wmf.as_ref())
                        .map_or(0, Vec::len);
                    if container.preview_emf.is_none()
                        && container.preview_wmf.is_none()
                        && container.native_image.is_none()
                    {
                        if let Some(bmp) = extract_dib_as_bmp(&buf) {
                            if bmp.len() <= remaining {
                                newly_retained = bmp.len();
                                container.native_image = Some((NativeImageKind::Bmp, bmp));
                            }
                        }
                    }
                    retained_bytes = retained_bytes.saturating_add(newly_retained as u64);
                }
            }
        } else if name == "OOXMLChartContents" && container.ooxml_chart.is_none() {
            if let Ok(mut s) = comp.open_stream(&path) {
                let remaining = MAX_CONTAINER_BYTES.saturating_sub(retained_bytes) as usize;
                let limit = MAX_STRUCTURAL_BYTES.min(remaining);
                if s.len() <= limit as u64 {
                    let Some(buf) = read_limited(&mut s, limit) else {
                        continue;
                    };
                    if buf.is_empty() {
                        continue;
                    }
                    retained_bytes = retained_bytes.saturating_add(buf.len() as u64);
                    container.ooxml_chart = Some(buf);
                }
            }
        } else if name == "Contents" && container.raw_contents.is_none() {
            if let Ok(mut s) = comp.open_stream(&path) {
                let remaining = MAX_CONTAINER_BYTES.saturating_sub(retained_bytes) as usize;
                let limit = MAX_BINARY_BYTES.min(remaining);
                if s.len() <= limit as u64 {
                    let Some(buf) = read_limited(&mut s, limit) else {
                        continue;
                    };
                    if buf.is_empty() {
                        continue;
                    }
                    retained_bytes = retained_bytes.saturating_add(buf.len() as u64);
                    container.raw_contents = Some(buf);
                }
            }
        } else if name == "\u{0001}Ole10Native" || name.ends_with("Ole10Native") {
            if container.native_image.is_some() {
                continue;
            }
            if let Ok(mut s) = comp.open_stream(&path) {
                let remaining = MAX_CONTAINER_BYTES.saturating_sub(retained_bytes) as usize;
                let limit = MAX_BINARY_BYTES.min(remaining);
                if s.len() <= limit as u64 {
                    let Some(mut buf) = read_limited(&mut s, limit) else {
                        continue;
                    };
                    if buf.len() <= 4 {
                        continue;
                    }
                    // Ole10Native: [u32 LE length][payload] — payload가 BMP/PNG/JPEG 등 네이티브 바이트
                    buf.drain(..4);
                    if let Some(img) = detect_native_image_owned(buf) {
                        retained_bytes = retained_bytes.saturating_add(img.1.len() as u64);
                        container.native_image = Some(img);
                    }
                }
            }
        }
    }

    if container.preview_emf.is_some()
        || container.preview_wmf.is_some()
        || container.ooxml_chart.is_some()
        || container.raw_contents.is_some()
        || container.native_image.is_some()
    {
        Some(container)
    } else {
        None
    }
}

/// 한글 글맵시(HMapsi) 계열 OLE 컨테이너인지 빠르게 판별한다.
///
/// 구형/변환 HWPX의 글맵시 OLE는 일반 EMF/DIB preview 없이 `HMapsi`/`Hmapsi file`
/// 네이티브 스트림만 가진다. 현재는 전용 parser가 없으므로 렌더러의 preview clip
/// fallback 대상인지 판정하는 용도로 사용한다.
pub fn is_hmapsi_ole_container(cfb_bytes: &[u8]) -> bool {
    contains_bytes(cfb_bytes, b"HMapsi") || contains_bytes(cfb_bytes, b"Hmapsi file")
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// 바이트 슬라이스의 선두 매직으로 이미지 포맷을 판별
pub fn detect_native_image(data: &[u8]) -> Option<(NativeImageKind, Vec<u8>)> {
    if data.len() < 4 || data.len() > MAX_BINARY_BYTES {
        return None;
    }
    detect_native_image_owned(data.to_vec())
}

fn detect_native_image_owned(data: Vec<u8>) -> Option<(NativeImageKind, Vec<u8>)> {
    if data.starts_with(b"BM") {
        return Some((NativeImageKind::Bmp, data));
    }
    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some((NativeImageKind::Png, data));
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some((NativeImageKind::Jpeg, data));
    }
    if data.starts_with(b"GIF8") {
        return Some((NativeImageKind::Gif, data));
    }
    None
}

/// OlePres000 스트림에서 DIB(Device Independent Bitmap) 데이터를 찾아 BMP 파일 바이트로 재포장한다.
///
/// DIB 시그니처: BITMAPINFOHEADER는 `biSize=40` (0x28 0x00 0x00 0x00)로 시작.
/// 앞에 BMP FILEHEADER(14바이트, "BM"+파일크기+예약+픽셀오프셋)를 합성하여 표준 BMP로 만든다.
fn extract_dib_as_bmp(data: &[u8]) -> Option<Vec<u8>> {
    let scan_limit = data.len().min(4096);
    for i in 0..scan_limit.saturating_sub(40) {
        // BITMAPINFOHEADER.biSize == 40
        let bi_size = u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
        if bi_size != 40 {
            continue;
        }
        // 유효성: width/height가 현실적인 범위
        let w = i32::from_le_bytes([data[i + 4], data[i + 5], data[i + 6], data[i + 7]]);
        let h = i32::from_le_bytes([data[i + 8], data[i + 9], data[i + 10], data[i + 11]]);
        if w <= 0 || w > 100_000 || h == 0 || h.unsigned_abs() > 100_000 {
            continue;
        }
        let bit_count = u16::from_le_bytes([data[i + 14], data[i + 15]]);
        if !matches!(bit_count, 1 | 4 | 8 | 16 | 24 | 32) {
            continue;
        }
        let compression =
            u32::from_le_bytes([data[i + 16], data[i + 17], data[i + 18], data[i + 19]]);
        // 색상 테이블 크기 계산
        let clr_used = u32::from_le_bytes([data[i + 32], data[i + 33], data[i + 34], data[i + 35]]);
        let palette_entries = if bit_count <= 8 {
            if clr_used > 0 && clr_used <= 256 {
                clr_used
            } else {
                1u32 << bit_count
            }
        } else {
            0
        };
        let palette_bytes = palette_entries * 4;
        let dib_and_data = &data[i..];
        let offset_to_pixels = 14 + 40 + palette_bytes as usize;
        // 파일 전체 크기 = 14 헤더 + DIB 나머지
        let file_size = 14 + dib_and_data.len() as u32;
        let mut bmp = Vec::with_capacity(file_size as usize);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&file_size.to_le_bytes());
        bmp.extend_from_slice(&[0u8; 4]); // reserved
        bmp.extend_from_slice(&(offset_to_pixels as u32).to_le_bytes());
        bmp.extend_from_slice(dib_and_data);
        let _ = compression;
        return Some(bmp);
    }
    None
}

/// [#7266] `Contents` 안에서 `EMR_HEADER` 부터의 EMF 조각을 돌려준다.
///
/// 한컴 산출 변형은 앞에 `u32` 길이를 붙인다 — 2817919 실측 `6C 00 00 00`
/// (= 뒤따르는 `EMR_HEADER` 사본 108B) + 사본 + 본 EMF. `data[0..4] == 1` 만 보면
/// 이 갈래를 통째로 놓쳐, 미리보기가 실패해도 `Contents` 폴백이 받지 못한다.
pub fn contents_emf_payload(data: &[u8]) -> Option<&[u8]> {
    fn emf_header_at(data: &[u8], at: usize) -> bool {
        data.len() >= at + 44
            && u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]) == 1
            && &data[at + 40..at + 44] == b" EMF"
    }

    if emf_header_at(data, 0) {
        return Some(data);
    }
    if data.len() >= 8 {
        let declared = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        if (44..=data.len()).contains(&declared) && emf_header_at(data, 4) {
            return Some(&data[4..]);
        }
    }
    None
}

/// [#5724] `Contents` 가 EMF 인지 — `contents_emf_payload` 와 같다.
pub fn raw_contents_is_emf(data: &[u8]) -> bool {
    contents_emf_payload(data).is_some()
}

/// [#5725] `Contents` 가 한글 수식 편집기 봉투면 수식 스크립트를 꺼낸다.
///
/// 봉투 구조 (2921145 `BinData/ole1.ole` 실측):
/// - offset 0..32: 시그니처 `Hwp 5.0 Equation Editor(HwpEq5x)` (정확히 32바이트)
/// - offset 52: u32 LE 버전 (실측 5)
/// - offset 68: u32 LE 스크립트 바이트 길이
/// - offset 72: UTF-16LE 수식 스크립트
///
/// 이 OLE 들의 `\x02OlePres000` 은 전부 28바이트 스텁(헤더만)이라 미리보기
/// 폴백으로는 그릴 것이 없다 — 스크립트가 유일한 출처다.
pub fn parse_equation_contents_script(data: &[u8]) -> Option<String> {
    const SIG: &[u8] = b"Hwp 5.0 Equation Editor(HwpEq5x)";
    if data.len() < 72 || !data.starts_with(SIG) {
        return None;
    }
    let len = u32::from_le_bytes([data[68], data[69], data[70], data[71]]) as usize;
    let end = 72usize.checked_add(len)?;
    if len == 0 || !len.is_multiple_of(2) || end > data.len() {
        return None;
    }
    let units: Vec<u16> = data[72..end]
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let script = String::from_utf16_lossy(&units)
        .trim_end_matches('\0')
        .to_string();
    if script.trim().is_empty() {
        None
    } else {
        Some(script)
    }
}

/// OLE Presentation Stream 헤더를 스킵하고 내부 EMF/메타파일 바이트를 반환한다.
///
/// OLE Presentation Stream 대략 구조 (MS-OLEDS):
/// `ULONG ansiClipboardFormat, ULONG tgtDevSize, tgtDev(variable), ULONG aspect,
///  ULONG lindex, ULONG advf, ULONG reserved, DWORD width, DWORD height, DWORD size, bytes[size]`
///
/// 여기서는 EMR_HEADER 매직(record_type=0x00000001 + " EMF" @ offset +40)을
/// 찾아서 그 위치부터 바이트를 반환한다. 매직을 찾지 못하면 `None`.
pub fn strip_ole_presentation_header(data: &[u8]) -> Option<Vec<u8>> {
    // EMF record header: u32 type=1, u32 size, 16 bytes bounds, 16 bytes frame, u32 signature=" EMF"(0x464D4520)
    // signature(" EMF")는 EMR_HEADER의 offset 40부터
    if data.len() < 64 {
        return None;
    }
    // [#7266] EMF-in-WMF 가 먼저다. 아래 바이트 스캔은 `WMFC` 주석 헤더를 EMF 안에 남긴다.
    if let Some(emf) = emf_from_wmf_comment_chunks(data) {
        return Some(emf);
    }
    // 스캔 범위 제한 (OLE 헤더가 보통 수십~수백 바이트)
    let scan_limit = data.len().min(4096);
    for i in 0..(scan_limit.saturating_sub(44)) {
        let type_ok = u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]) == 1;
        if !type_ok {
            continue;
        }
        // " EMF" = 0x20 0x45 0x4D 0x46
        let sig = &data[i + 40..i + 44];
        if sig == b" EMF" {
            return Some(data[i..].to_vec());
        }
    }
    None
}

/// [#3363] OLE Presentation Stream 헤더 뒤의 표준/placeable WMF 를 찾아 반환한다.
/// EMF 스트립과 동일한 스캔 방식 — 표준 WMF 매직(mtType=1|2, mtHeaderSize=9,
/// mtVersion 0x0100|0x0300) 또는 placeable WMF 매직(`D7 CD C6 9A`)을 탐색한다.
fn strip_ole_presentation_header_wmf(data: &[u8]) -> Option<Vec<u8>> {
    wmf_start_offset(data).map(|at| data[at..].to_vec())
}

/// WMF 가 시작하는 offset — placeable 매직 또는 표준 METAHEADER 중 먼저 나오는 쪽.
fn wmf_start_offset(data: &[u8]) -> Option<usize> {
    if data.len() < 26 {
        return None;
    }
    let scan_limit = data.len().min(4096);
    for i in 0..(scan_limit.saturating_sub(8)) {
        // placeable WMF
        if data[i..i + 4] == [0xD7, 0xCD, 0xC6, 0x9A] {
            return Some(i);
        }
        // 표준 WMF: mtType(1=memory, 2=file) u16 + mtHeaderSize=9 u16 + mtVersion u16
        let mt_type = u16::from_le_bytes([data[i], data[i + 1]]);
        let header_size = u16::from_le_bytes([data[i + 2], data[i + 3]]);
        let version = u16::from_le_bytes([data[i + 4], data[i + 5]]);
        if (mt_type == 1 || mt_type == 2)
            && header_size == 9
            && (version == 0x0100 || version == 0x0300)
        {
            return Some(i);
        }
    }
    None
}

/// [#7266] `OlePres000` 이 EMF 를 WMF 주석 청크로 쪼개 담았으면 원본 EMF 를 복원한다.
///
/// 한컴·GDI+ 산출 프레젠테이션 스트림은 EMF 를 통째로 넣지 않고
/// `META_ESCAPE`(func `0x0626`) + `META_ESCAPE_ENHANCED_METAFILE`(escape `0x000F`) 의
/// `WMFC` 주석으로 나눠 싣는다 — 청크마다 44B 헤더(레코드 6B + escape/count 4B +
/// `EmfComment` 34B) + 데이터 ≤ 8,192B.
///
/// `" EMF"` 를 바이트 스캔해 뒤를 통째로 복사하면 8,192바이트마다 그 44B 가 EMF 안에
/// 박힌다. 복원본이 첫 청크의 `EnhancedMetafileDataSize` 선언값과 `EMR_HEADER` 서명을
/// **함께** 만족할 때만 채택한다. 아니면 `None` 을 돌려 종전 바이트 스캔으로 내려간다.
fn emf_from_wmf_comment_chunks(data: &[u8]) -> Option<Vec<u8>> {
    const META_ESCAPE: u16 = 0x0626;
    const ENHANCED_METAFILE: u16 = 0x000F;
    /// `EmfComment` 헤더: WMFC(4) + Type(4) + Version(4) + Checksum(2) + Flags(4)
    /// + RecordCount(4) + CurrentRecordSize(4) + RemainingBytes(4) + TotalSize(4).
    const EMF_COMMENT_HEADER: usize = 34;
    /// `EnhancedMetafileDataSize` 의 `EmfComment` 헤더 안 offset.
    const TOTAL_SIZE_AT: usize = 30;

    let start = wmf_start_offset(data)?;
    let placeable = data[start..].starts_with(&[0xD7, 0xCD, 0xC6, 0x9A]);
    // placeable 헤더 22B 뒤에 METAHEADER 18B 가 온다.
    let mut pos = start.checked_add(if placeable { 22 + 18 } else { 18 })?;

    let mut emf: Vec<u8> = Vec::new();
    let mut declared: Option<usize> = None;
    while pos + 6 <= data.len() {
        let size_words =
            u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        let function = u16::from_le_bytes([data[pos + 4], data[pos + 5]]);
        // 최소 레코드(rdSize + rdFunction)는 3워드. 그보다 작으면 프레이밍이 깨진 것이다.
        if size_words < 3 {
            break;
        }
        let end = pos.checked_add(size_words.checked_mul(2)?)?;
        if end > data.len() {
            break;
        }
        if function == META_ESCAPE && size_words >= 5 {
            let escape = u16::from_le_bytes([data[pos + 6], data[pos + 7]]);
            let count = u16::from_le_bytes([data[pos + 8], data[pos + 9]]) as usize;
            let body = pos + 10;
            if escape == ENHANCED_METAFILE
                && count >= EMF_COMMENT_HEADER
                && body + count <= end
                && &data[body..body + 4] == b"WMFC"
            {
                if declared.is_none() {
                    let at = body + TOTAL_SIZE_AT;
                    declared = Some(u32::from_le_bytes([
                        data[at],
                        data[at + 1],
                        data[at + 2],
                        data[at + 3],
                    ]) as usize);
                }
                emf.extend_from_slice(&data[body + EMF_COMMENT_HEADER..body + count]);
            }
        }
        pos = end;
    }

    if emf.len() < 44 || declared != Some(emf.len()) {
        return None;
    }
    if u32::from_le_bytes([emf[0], emf[1], emf[2], emf[3]]) != 1 || &emf[40..44] != b" EMF" {
        return None;
    }
    Some(emf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_strip_no_emf_magic() {
        let data = vec![0u8; 100];
        assert!(strip_ole_presentation_header(&data).is_none());
    }

    #[test]
    fn test_strip_emf_at_offset() {
        // 헤더 20바이트 + EMR_HEADER(44바이트: type=1, size, 32바이트 bounds/frame, " EMF")
        let mut data = vec![0u8; 20];
        // type = 1
        data.extend_from_slice(&1u32.to_le_bytes());
        // size = 100
        data.extend_from_slice(&100u32.to_le_bytes());
        // bounds(16) + frame(16) = 32 bytes zero
        data.extend_from_slice(&[0u8; 32]);
        // " EMF"
        data.extend_from_slice(b" EMF");
        // 더미 남은 바이트
        data.extend_from_slice(&[0xAA; 20]);

        let stripped = strip_ole_presentation_header(&data).expect("EMF should be found");
        assert_eq!(&stripped[..4], &1u32.to_le_bytes()); // record type
        assert_eq!(&stripped[40..44], b" EMF");
    }

    #[test]
    fn test_parse_empty_bytes() {
        assert!(parse_ole_container(&[]).is_none());
        assert!(parse_ole_container(&[0u8; 4]).is_none());
    }

    fn equation_contents_envelope(sig: &[u8], script: &str, len: Option<u32>) -> Vec<u8> {
        let script_bytes: Vec<u8> = script
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let mut data = vec![0u8; 72];
        data[..sig.len()].copy_from_slice(sig);
        data[68..72].copy_from_slice(&len.unwrap_or(script_bytes.len() as u32).to_le_bytes());
        data.extend_from_slice(&script_bytes);
        data
    }

    #[test]
    fn parse_equation_contents_script_reads_utf16le_after_envelope() {
        const SIG: &[u8] = b"Hwp 5.0 Equation Editor(HwpEq5x)";
        let data = equation_contents_envelope(SIG, "a over b", None);
        assert_eq!(
            parse_equation_contents_script(&data).as_deref(),
            Some("a over b")
        );
        assert!(parse_equation_contents_script(b"not an equation envelope").is_none());
        let prefix_only = equation_contents_envelope(b"Hwp 5.0 Equation Editor", "a over b", None);
        assert!(
            parse_equation_contents_script(&prefix_only).is_none(),
            "prefix without (HwpEq5x) is not a hwpeq5x envelope"
        );
        let wrap_len = equation_contents_envelope(SIG, "a over b", Some(0xFFFF_FFFE));
        assert!(
            parse_equation_contents_script(&wrap_len).is_none(),
            "script length that overflows 72+len must not slice"
        );
    }

    #[test]
    fn test_parse_non_cfb() {
        // CFB 매직이 아닌 임의 바이트
        let bytes: Vec<u8> = (0..128u8).collect();
        assert!(parse_ole_container(&bytes).is_none());
    }

    #[test]
    fn dib_minimum_signed_height_is_rejected_without_abs_overflow() {
        let mut data = vec![0u8; 64];
        data[0..4].copy_from_slice(&40u32.to_le_bytes());
        data[4..8].copy_from_slice(&1i32.to_le_bytes());
        data[8..12].copy_from_slice(&i32::MIN.to_le_bytes());
        data[14..16].copy_from_slice(&24u16.to_le_bytes());

        assert!(extract_dib_as_bmp(&data).is_none());
    }

    #[test]
    fn nested_stream_reader_rejects_the_first_byte_over_its_budget() {
        assert_eq!(
            read_limited(&mut Cursor::new([1u8, 2, 3]), 3),
            Some(vec![1, 2, 3])
        );
        assert!(read_limited(&mut Cursor::new([1u8, 2, 3, 4]), 3).is_none());
    }

    #[test]
    fn hancell_ole_presentation_exposes_a_renderable_wmf_preview() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/한셀OLE.hwp");
        let bytes = std::fs::read(path).expect("read Hancell OLE fixture");
        let document = crate::parser::parse_hwp(&bytes).expect("parse Hancell OLE fixture");
        let ole_bytes = document.bin_data_content[0].data.load();
        let container = parse_ole_container(&ole_bytes).expect("parse embedded OLE container");
        let wmf = container
            .preview_wmf
            .as_deref()
            .expect("extract OLE presentation WMF");

        let converted =
            crate::wmf::converter::WMFConverter::new(wmf, crate::wmf::converter::SVGPlayer::new())
                .run()
                .expect("convert OLE presentation WMF");
        let svg = String::from_utf8(converted).expect("WMF converter emits UTF-8 SVG");
        assert!(
            svg.contains("<image"),
            "spreadsheet preview must retain its DIB"
        );
    }
}
