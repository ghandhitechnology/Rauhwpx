//! HWPX ZIP 컨테이너 읽기
//!
//! HWPX 파일은 ZIP 아카이브이다. 내부 파일을 읽는 래퍼를 제공한다.
//!
//! ## 압축 해제 폭탄 방어
//!
//! ZIP은 높은 압축률을 허용하므로, 수 KB짜리 HWPX가 수 GB로 팽창하는
//! "zip bomb"을 만들 수 있다. 단일 `.xml` 엔트리가 무제한으로 `read_to_end`
//! 되면 호스트 프로세스를 OOM으로 몰 수 있다.
//!
//! [`MAX_XML_SIZE`] / [`MAX_BINDATA_SIZE`] 상한을 적용해 이를 차단한다.
//! 실제 한국 법령/보도자료 HWPX는 충분히 이 한도 아래에 있다.

use std::collections::HashSet;
use std::io::{self, Cursor, Read};
use std::sync::Arc;
use zip::ZipArchive;

use super::HwpxError;
use crate::parser::limits::{
    MAX_BINARY_BYTES, MAX_CONTAINER_BYTES, MAX_HWPX_CENTRAL_DIRECTORY_BYTES, MAX_HWPX_ENTRIES,
    MAX_HWPX_ENTRY_NAME_BYTES, MAX_STRUCTURAL_BYTES, MAX_THUMBNAIL_BYTES,
};

/// XML 엔트리(section, header, content.hpf 등) 엔트리당 압축 해제 상한.
///
/// [#1917 XML 축] 종전 32MB 는 실문서를 거부했다 — 정책연구 최종보고서
/// (KYRBS, 1790387-202300133)의 Contents/section1.xml 이 **75.2MB**
/// (압축 2.2MB, 압축비 35:1)로 실재하며 한글은 정상 열람한다. 정상 XML 도
/// 압축비가 수십 배에 달해 압축비 기반 가드는 오탐 — 절대 상한을 256MB 로
/// 상향한다 (관측 최대 ×3 여유). zip-bomb 방어(무제한 read_to_end 차단)
/// 목적은 유지된다.
pub const MAX_XML_SIZE: usize = MAX_STRUCTURAL_BYTES;

/// BinData(이미지·폰트 등) 엔트리당 압축 해제 상한.
///
/// [#1917] 종전 64MB 는 실문서를 거부했다 — 정부 보도자료 계열에 비압축
/// BMP/TIF 대형 이미지가 실재한다 (10k 서베이: 최대 103.7MB BMP, 한글은
/// 정상 열람). 로드 거부는 그림 소실 + 재직렬화에서 pic 컨트롤 드롭(왕복
/// 데이터 손실)으로 이어지므로 512MB 로 상향한다. zip-bomb 방어(무제한
/// read_to_end 차단)라는 목적은 유지된다.
pub const MAX_BINDATA_SIZE: usize = MAX_BINARY_BYTES;

/// Preview images are UI hints, not document content. They get a smaller cap
/// so a thumbnail request cannot materialize a full-size binary member.
pub const MAX_PREVIEW_SIZE: usize = MAX_THUMBNAIL_BYTES;

/// `reader`에서 최대 `max` 바이트까지 읽는다. 초과 시 `InvalidData` 에러.
///
/// `Read::take(max + 1)`을 사용해 오버플로를 감지하되, 버퍼는 실제 읽은
/// 크기 + 1 이상으로 자라지 않는다.
fn read_limited<R: Read>(reader: &mut R, max: usize) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    let cap = (max as u64).saturating_add(1);
    reader.take(cap).read_to_end(&mut buf)?;
    if buf.len() > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "HWPX entry exceeds {} byte limit (possible decompression bomb)",
                max
            ),
        ));
    }
    Ok(buf)
}

/// HWPX ZIP 컨테이너 리더
pub struct HwpxReader {
    archive: ZipArchive<Cursor<Arc<[u8]>>>,
}

impl HwpxReader {
    /// ZIP 아카이브를 연다.
    pub fn open(data: &[u8]) -> Result<Self, HwpxError> {
        Self::open_shared(Arc::from(data))
    }

    /// Open a ZIP over shared immutable bytes.
    ///
    /// The parser and lazy BinData resolver use clones of the same `Arc`, so a
    /// document does not retain two full copies of its source archive.
    pub(crate) fn open_shared(data: Arc<[u8]>) -> Result<Self, HwpxError> {
        if data.len() as u64 > MAX_CONTAINER_BYTES {
            return Err(HwpxError::ZipError(format!(
                "HWPX input exceeds the {} byte container limit",
                MAX_CONTAINER_BYTES
            )));
        }
        preflight_zip_metadata(&data)?;
        let cursor = Cursor::new(data);
        let mut archive = ZipArchive::new(cursor)?;
        validate_archive_metadata(&mut archive)?;
        Ok(HwpxReader { archive })
    }

    /// 지정한 경로의 파일을 UTF-8 문자열로 읽는다.
    ///
    /// 엔트리 압축 해제 크기는 [`MAX_XML_SIZE`]로 제한된다.
    ///
    /// [Issue #1932] UTF-8 이 부분 손상된 실문서(통계청 보도자료 계열 —
    /// header.xml 선두부 invalid byte)를 한글은 정상 열람하므로, 엄격 변환
    /// 실패 시 관용(lossy) 디코딩으로 폴백한다 (손상 바이트는 U+FFFD 치환,
    /// 경고 로그). 문서 전체를 버리는 종전 동작은 한글 대비 과잉 거부였다.
    pub fn read_file(&mut self, path: &str) -> Result<String, HwpxError> {
        let mut file = self
            .archive
            .by_name(path)
            .map_err(|e| HwpxError::MissingFile(format!("{}: {}", path, e)))?;
        reject_declared_size(path, file.size(), MAX_XML_SIZE)?;
        let bytes = read_limited(&mut file, MAX_XML_SIZE)
            .map_err(|e| HwpxError::ZipError(format!("{} 읽기 실패: {}", path, e)))?;
        match String::from_utf8(bytes) {
            Ok(s) => Ok(s),
            Err(e) => {
                let utf8_error = e.utf8_error();
                eprintln!(
                    "경고: {} UTF-8 손상({}) — 관용(lossy) 디코딩 적용 (U+FFFD 치환)",
                    path, utf8_error
                );
                decode_utf8_lossy_bounded(&e.into_bytes(), MAX_XML_SIZE).map_err(|error| {
                    HwpxError::ZipError(format!("{} UTF-8 변환 실패: {}", path, error))
                })
            }
        }
    }

    /// 지정한 경로의 파일을 바이트 배열로 읽는다.
    ///
    /// 엔트리 압축 해제 크기는 [`MAX_BINDATA_SIZE`]로 제한된다.
    pub fn read_file_bytes(&mut self, path: &str) -> Result<Vec<u8>, HwpxError> {
        self.read_file_bytes_limited(path, MAX_BINDATA_SIZE)
    }

    /// 지정한 경로의 파일을 `max_bytes` 바이트까지만 압축 해제한다.
    pub fn read_file_bytes_limited(
        &mut self,
        path: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, HwpxError> {
        let mut file = self
            .archive
            .by_name(path)
            .map_err(|e| HwpxError::MissingFile(format!("{}: {}", path, e)))?;
        let policy_limit = member_limit(path);
        let max_bytes = max_bytes.min(policy_limit);
        reject_declared_size(path, file.size(), max_bytes)?;
        read_limited(&mut file, max_bytes)
            .map_err(|e| HwpxError::ZipError(format!("{} 읽기 실패: {}", path, e)))
    }

    /// 아카이브 내 파일 목록을 반환한다.
    pub fn file_names(&self) -> Vec<String> {
        self.archive.file_names().map(|s| s.to_string()).collect()
    }
}

const ZIP_EOCD_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
const ZIP64_EOCD_LOCATOR_SIGNATURE: &[u8; 4] = b"PK\x06\x07";
const ZIP_CENTRAL_HEADER_SIGNATURE: &[u8; 4] = b"PK\x01\x02";
const ZIP_CENTRAL_DIGITAL_SIGNATURE: &[u8; 4] = b"PK\x05\x05";
const ZIP_EOCD_MIN_BYTES: usize = 22;
const ZIP_MAX_COMMENT_BYTES: usize = u16::MAX as usize;

fn zip_u16(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        data.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn zip_u32(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        data.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn preflight_error(message: impl Into<String>) -> HwpxError {
    HwpxError::ZipError(message.into())
}

fn is_central_digital_signature(data: &[u8], start: usize, end: usize) -> bool {
    if data.get(start..start.saturating_add(4)) != Some(ZIP_CENTRAL_DIGITAL_SIGNATURE.as_slice()) {
        return false;
    }
    let Some(length) = zip_u16(data, start + 4).map(usize::from) else {
        return false;
    };
    start
        .checked_add(6)
        .and_then(|offset| offset.checked_add(length))
        == Some(end)
}

/// Validate bounded central-directory metadata before `ZipArchive::new`.
///
/// `zip` allocates one metadata object per footer-declared entry while opening.
/// Checking `archive.len()` afterwards therefore cannot stop an entry-count or
/// oversized-name allocation bomb. HWPX inputs are at most 512 MiB and 4096
/// members, so ZIP64 is unnecessary and rejected at this boundary.
fn preflight_zip_metadata(data: &[u8]) -> Result<(), HwpxError> {
    if data.len() < ZIP_EOCD_MIN_BYTES {
        return Err(preflight_error("HWPX ZIP footer is missing"));
    }
    let search_start = data
        .len()
        .saturating_sub(ZIP_EOCD_MIN_BYTES + ZIP_MAX_COMMENT_BYTES);
    let search_end = data.len() - ZIP_EOCD_MIN_BYTES;

    for eocd in (search_start..=search_end).rev() {
        if data.get(eocd..eocd + 4) != Some(ZIP_EOCD_SIGNATURE.as_slice()) {
            continue;
        }
        let Some(comment_len) = zip_u16(data, eocd + 20).map(usize::from) else {
            continue;
        };
        if eocd
            .checked_add(ZIP_EOCD_MIN_BYTES)
            .and_then(|end| end.checked_add(comment_len))
            != Some(data.len())
        {
            continue;
        }

        let Some(disk) = zip_u16(data, eocd + 4) else {
            continue;
        };
        let Some(directory_disk) = zip_u16(data, eocd + 6) else {
            continue;
        };
        let Some(entries_on_disk) = zip_u16(data, eocd + 8).map(usize::from) else {
            continue;
        };
        let Some(entries) = zip_u16(data, eocd + 10).map(usize::from) else {
            continue;
        };
        let Some(directory_size) = zip_u32(data, eocd + 12).map(|value| value as usize) else {
            continue;
        };
        let Some(relative_directory_offset) = zip_u32(data, eocd + 16) else {
            continue;
        };
        if disk != 0 || directory_disk != 0 || entries_on_disk != entries {
            continue;
        }
        if eocd >= 20
            && data.get(eocd - 20..eocd - 16) == Some(ZIP64_EOCD_LOCATOR_SIGNATURE.as_slice())
        {
            return Err(preflight_error(
                "ZIP64 is not accepted within the bounded HWPX container policy",
            ));
        }
        if entries == usize::from(u16::MAX)
            || directory_size == u32::MAX as usize
            || relative_directory_offset == u32::MAX
        {
            return Err(preflight_error(
                "ZIP64 is not accepted within the bounded HWPX container policy",
            ));
        }
        let relative_directory_offset = relative_directory_offset as usize;
        if entries == 0 {
            if directory_size == 0 && relative_directory_offset <= eocd {
                return Ok(());
            }
            continue;
        }
        if relative_directory_offset >= eocd {
            continue;
        }
        // Match the ZIP crate's archive-offset discovery: the first CDFH at or
        // after the relative offset becomes the real directory start. This
        // prevents a forged directory-size field from steering preflight to a
        // harmless fake table while the crate parses a different one.
        let Some(relative_signature_offset) = data[relative_directory_offset..eocd]
            .windows(ZIP_CENTRAL_HEADER_SIGNATURE.len())
            .position(|window| window == ZIP_CENTRAL_HEADER_SIGNATURE)
        else {
            continue;
        };
        let directory_start = relative_directory_offset + relative_signature_offset;
        let Some(directory_end) = directory_start.checked_add(directory_size) else {
            continue;
        };
        if directory_end > eocd {
            continue;
        }

        // Prove enough well-formed records to distinguish a real oversized
        // directory from an EOCD-like byte sequence embedded in a comment.
        let records_to_scan = entries.min(MAX_HWPX_ENTRIES.saturating_add(1));
        let mut cursor = directory_start;
        let mut structurally_valid = true;
        for index in 0..records_to_scan {
            if data.get(cursor..cursor.saturating_add(4))
                != Some(ZIP_CENTRAL_HEADER_SIGNATURE.as_slice())
            {
                structurally_valid = false;
                break;
            }
            let Some(name_len) = zip_u16(data, cursor + 28).map(usize::from) else {
                structurally_valid = false;
                break;
            };
            let Some(extra_len) = zip_u16(data, cursor + 30).map(usize::from) else {
                structurally_valid = false;
                break;
            };
            let Some(entry_comment_len) = zip_u16(data, cursor + 32).map(usize::from) else {
                structurally_valid = false;
                break;
            };
            let Some(record_len) = 46usize
                .checked_add(name_len)
                .and_then(|length| length.checked_add(extra_len))
                .and_then(|length| length.checked_add(entry_comment_len))
            else {
                structurally_valid = false;
                break;
            };
            let Some(next) = cursor.checked_add(record_len) else {
                structurally_valid = false;
                break;
            };
            if next > directory_end {
                structurally_valid = false;
                break;
            }
            if name_len > MAX_HWPX_ENTRY_NAME_BYTES {
                return Err(preflight_error(format!(
                    "HWPX archive entry {index} name exceeds the {MAX_HWPX_ENTRY_NAME_BYTES} byte limit"
                )));
            }
            cursor = next;
        }
        if !structurally_valid {
            continue;
        }
        if entries > MAX_HWPX_ENTRIES {
            return Err(preflight_error(format!(
                "HWPX archive has {entries} entries and exceeds the {MAX_HWPX_ENTRIES} entry limit"
            )));
        }
        if directory_size > MAX_HWPX_CENTRAL_DIRECTORY_BYTES {
            return Err(preflight_error(format!(
                "HWPX central directory exceeds the {MAX_HWPX_CENTRAL_DIRECTORY_BYTES} byte limit"
            )));
        }

        // The central-directory digital signature is optional and is emitted
        // inconsistently inside or immediately after the declared size.
        if cursor != directory_end && !is_central_digital_signature(data, cursor, directory_end) {
            continue;
        }
        if directory_end != eocd && !is_central_digital_signature(data, directory_end, eocd) {
            continue;
        }
        return Ok(());
    }

    Err(preflight_error(
        "HWPX ZIP footer or central directory is invalid",
    ))
}

fn member_limit(path: &str) -> usize {
    if path.starts_with("Preview/PrvImage") {
        MAX_PREVIEW_SIZE
    } else if path.rsplit_once('.').is_some_and(|(_, extension)| {
        extension.eq_ignore_ascii_case("xml") || extension.eq_ignore_ascii_case("hpf")
    }) {
        MAX_XML_SIZE
    } else {
        MAX_BINDATA_SIZE
    }
}

fn reject_declared_size(path: &str, declared: u64, limit: usize) -> Result<(), HwpxError> {
    if declared > limit as u64 {
        return Err(HwpxError::ZipError(format!(
            "{} 읽기 실패: HWPX entry exceeds {} byte limit (possible decompression bomb)",
            path, limit
        )));
    }
    Ok(())
}

fn decode_utf8_lossy_bounded(bytes: &[u8], max_bytes: usize) -> io::Result<String> {
    let mut output = String::with_capacity(bytes.len().min(max_bytes));
    let mut remaining = bytes;
    while !remaining.is_empty() {
        match std::str::from_utf8(remaining) {
            Ok(valid) => {
                if valid.len() > max_bytes.saturating_sub(output.len()) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "lossy UTF-8 output exceeds structural byte limit",
                    ));
                }
                output.push_str(valid);
                break;
            }
            Err(error) => {
                let valid = &remaining[..error.valid_up_to()];
                let replacement_bytes = '\u{fffd}'.len_utf8();
                let added = valid.len().checked_add(replacement_bytes).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "lossy UTF-8 size overflow")
                })?;
                if added > max_bytes.saturating_sub(output.len()) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "lossy UTF-8 output exceeds structural byte limit",
                    ));
                }
                // `valid_up_to` always ends at a UTF-8 boundary.
                output.push_str(std::str::from_utf8(valid).expect("validated UTF-8 prefix"));
                output.push('\u{fffd}');
                let invalid_len = error.error_len().unwrap_or(remaining.len() - valid.len());
                remaining = &remaining[valid.len() + invalid_len..];
            }
        }
    }
    Ok(output)
}

fn safe_member_name(name: &str) -> bool {
    let path = name.strip_suffix('/').unwrap_or(name);
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && !path
            .split('/')
            .next()
            .is_some_and(|component| component.ends_with(':'))
        && path
            .split('/')
            .all(|component| !component.is_empty() && component != "." && component != "..")
}

fn add_expanded_size(total: &mut u64, amount: u64) -> Result<(), HwpxError> {
    let next = total
        .checked_add(amount)
        .ok_or_else(|| HwpxError::ZipError("HWPX expanded size overflow".to_string()))?;
    if next > MAX_CONTAINER_BYTES {
        return Err(HwpxError::ZipError(format!(
            "HWPX expands beyond the {} byte container limit",
            MAX_CONTAINER_BYTES
        )));
    }
    *total = next;
    Ok(())
}

fn validate_archive_metadata(archive: &mut ZipArchive<Cursor<Arc<[u8]>>>) -> Result<(), HwpxError> {
    if archive.len() > MAX_HWPX_ENTRIES {
        return Err(HwpxError::ZipError(format!(
            "HWPX archive has {} entries and exceeds the {} entry limit",
            archive.len(),
            MAX_HWPX_ENTRIES
        )));
    }

    let mut names = HashSet::with_capacity(archive.len().min(MAX_HWPX_ENTRIES));
    let mut expanded_bytes = 0u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index)?;
        let raw_name = file.name_raw();
        let name = std::str::from_utf8(raw_name).map_err(|_| {
            HwpxError::ZipError(format!(
                "HWPX archive contains a non-UTF-8 entry name at index {}",
                index
            ))
        })?;
        if raw_name.len() > MAX_HWPX_ENTRY_NAME_BYTES || !safe_member_name(name) {
            return Err(HwpxError::ZipError(format!(
                "HWPX archive contains an unsafe or oversized entry name at index {}",
                index
            )));
        }
        if !names.insert(name.to_string()) {
            return Err(HwpxError::ZipError(format!(
                "HWPX archive contains duplicate entry: {}",
                name
            )));
        }
        reject_declared_size(name, file.size(), member_limit(name))?;
        add_expanded_size(&mut expanded_bytes, file.size())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_invalid_zip() {
        let result = HwpxReader::open(&[0u8; 100]);
        assert!(result.is_err());
    }

    /// [#1946] ODF 암호화 manifest 감지 + 비암호화 manifest 무시.
    #[test]
    fn test_detect_odf_encryption() {
        use crate::parser::hwpx::{detect_odf_encryption, parse_hwpx, HwpxError};
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let enc = br#"<odf:manifest><odf:file-entry full-path="Contents/header.xml"><odf:encryption-data><odf:algorithm algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/><odf:key-derivation key-derivation-name="...#pbkdf2"/></odf:encryption-data></odf:file-entry></odf:manifest>"#;
        let detail = detect_odf_encryption(enc).expect("암호화 감지");
        assert!(detail.contains("AES-256-CBC"), "{detail}");
        assert!(detail.contains("PBKDF2"), "{detail}");

        let plain =
            br#"<odf:manifest><odf:file-entry full-path="Contents/header.xml"/></odf:manifest>"#;
        assert!(detect_odf_encryption(plain).is_none());

        // parse_hwpx 진입 감지: 암호화 manifest + 암호문 header.xml → Encrypted 에러.
        let mut out = Cursor::new(Vec::<u8>::new());
        {
            let mut zip = ZipWriter::new(&mut out);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("mimetype", opts).unwrap();
            zip.write_all(b"application/hwp+zip").unwrap();
            zip.start_file("META-INF/manifest.xml", opts).unwrap();
            zip.write_all(enc).unwrap();
            zip.start_file("Contents/header.xml", opts).unwrap();
            zip.write_all(&[0x93u8, 0xFF, 0x00, 0x11]).unwrap(); // 암호문(비 UTF-8) 모사
            zip.finish().unwrap();
        }
        let bytes = out.into_inner();
        match parse_hwpx(&bytes) {
            Err(e @ HwpxError::Encrypted(_)) => {
                assert!(e.is_encrypted());
                assert!(e.to_string().contains("암호화된 문서"), "{e}");
            }
            other => panic!("expected Encrypted, got {other:?}"),
        }
    }

    #[test]
    fn test_read_limited_under_cap() {
        let data = vec![0u8; 1000];
        let mut cursor = Cursor::new(data.clone());
        let result = read_limited(&mut cursor, 2000).unwrap();
        assert_eq!(result.len(), 1000);
    }

    #[test]
    fn test_read_limited_at_cap() {
        let data = vec![0u8; 1000];
        let mut cursor = Cursor::new(data.clone());
        let result = read_limited(&mut cursor, 1000).unwrap();
        assert_eq!(result.len(), 1000);
    }

    #[test]
    fn test_read_limited_over_cap() {
        let data = vec![0u8; 1001];
        let mut cursor = Cursor::new(data);
        let result = read_limited(&mut cursor, 1000);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn lossy_utf8_expansion_obeys_the_structural_output_budget() {
        assert_eq!(
            decode_utf8_lossy_bounded(b"ok\xff", 5).unwrap(),
            "ok\u{fffd}"
        );
        let error = decode_utf8_lossy_bounded(b"ok\xff", 4).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn test_compressed_entry_limited_read_rejects_before_materialization() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let mut out = Cursor::new(Vec::<u8>::new());
        {
            let mut zip = ZipWriter::new(&mut out);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("BinData/font.ttf", options).unwrap();
            zip.write_all(&vec![b'A'; 4096]).unwrap();
            zip.finish().unwrap();
        }

        let mut reader = HwpxReader::open(&out.into_inner()).unwrap();
        let error = reader
            .read_file_bytes_limited("BinData/font.ttf", 1024)
            .expect_err("oversized deflated entry must be rejected");
        assert!(error.to_string().contains("1024 byte limit"));
    }

    #[test]
    fn aggregate_and_path_guards_handle_boundaries_without_allocating_payloads() {
        let mut total = MAX_CONTAINER_BYTES - 1;
        add_expanded_size(&mut total, 1).unwrap();
        assert_eq!(total, MAX_CONTAINER_BYTES);
        assert!(add_expanded_size(&mut total, 1).is_err());

        assert!(safe_member_name("Contents/section0.xml"));
        assert!(safe_member_name("Contents/"));
        assert!(!safe_member_name("../section0.xml"));
        assert!(!safe_member_name("C:/section0.xml"));
        assert_eq!(member_limit("Preview/PrvImage.png"), MAX_PREVIEW_SIZE);
        assert_eq!(member_limit("Contents/section0.xml"), MAX_XML_SIZE);
        assert_eq!(member_limit("Contents/section0.XML"), MAX_XML_SIZE);
        assert_eq!(member_limit("BinData/BIN0001.png"), MAX_BINDATA_SIZE);
    }

    #[test]
    fn archive_entry_count_is_rejected_at_4097() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let mut out = Cursor::new(Vec::<u8>::new());
        {
            let mut zip = ZipWriter::new(&mut out);
            let options = SimpleFileOptions::default();
            for index in 0..=MAX_HWPX_ENTRIES {
                zip.start_file(format!("empty/{index}"), options).unwrap();
                zip.write_all(&[]).unwrap();
            }
            zip.finish().unwrap();
        }

        let error = HwpxReader::open(&out.into_inner())
            .err()
            .expect("4097 entries must be rejected");
        assert!(error.to_string().contains("4096 entry limit"));
    }

    /// [#1917 XML 축] 실문서급 대형 XML(40MB — 종전 32MB 한도 초과, 새 256MB
    /// 한도 이내)은 수용되어야 한다 (KYRBS section1.xml 75.2MB 실측 대응).
    #[test]
    fn test_large_legit_xml_entry_accepted() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let mut out = Cursor::new(Vec::<u8>::new());
        {
            let mut zip = ZipWriter::new(&mut out);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("Contents/section1.xml", opts).unwrap();
            let payload = vec![b'A'; 40 * 1024 * 1024]; // 40MB — 종전 한도(32MB) 초과
            zip.write_all(&payload).unwrap();
            zip.finish().unwrap();
        }
        let bytes = out.into_inner();
        let mut reader = HwpxReader::open(&bytes).unwrap();
        let result = reader.read_file("Contents/section1.xml");
        assert!(
            result.is_ok(),
            "40MB XML entry should be accepted: {:?}",
            result.err()
        );
        assert_eq!(result.unwrap().len(), 40 * 1024 * 1024);
    }

    /// [#1932] UTF-8 부분 손상 엔트리는 lossy 폴백으로 수용되어야 한다
    /// (한글 정합 — 통계청 보도자료 header.xml invalid byte 실측 대응).
    #[test]
    fn test_invalid_utf8_entry_lossy_accepted() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let mut out = Cursor::new(Vec::<u8>::new());
        {
            let mut zip = ZipWriter::new(&mut out);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("Contents/header.xml", opts).unwrap();
            // 유효 XML 사이에 invalid UTF-8 바이트(0x93) 삽입 — 실측 케이스 모사
            zip.write_all(b"<hwpml>\x93</hwpml>").unwrap();
            zip.finish().unwrap();
        }
        let bytes = out.into_inner();
        let mut reader = HwpxReader::open(&bytes).unwrap();
        let s = reader
            .read_file("Contents/header.xml")
            .expect("#1932: 손상 UTF-8 은 lossy 폴백으로 수용되어야 함");
        assert!(s.starts_with("<hwpml>"));
        assert!(
            s.contains('\u{FFFD}'),
            "손상 바이트는 U+FFFD 로 치환: {s:?}"
        );
        assert!(s.ends_with("</hwpml>"));
    }

    /// A central-directory declaration over the structural cap is rejected
    /// before the reader reserves or inflates the claimed payload.
    #[test]
    fn test_oversized_xml_declaration_rejected_before_materialization() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let mut out = Cursor::new(Vec::<u8>::new());
        {
            let mut zip = ZipWriter::new(&mut out);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("Contents/bomb.xml", opts).unwrap();
            zip.write_all(b"x").unwrap();
            zip.finish().unwrap();
        }
        let mut bytes = out.into_inner();
        let central = bytes
            .windows(4)
            .position(|window| window == [0x50, 0x4b, 0x01, 0x02])
            .expect("central directory");
        let oversized = u32::try_from(MAX_XML_SIZE + 1).unwrap();
        bytes[central + 24..central + 28].copy_from_slice(&oversized.to_le_bytes());

        let error = HwpxReader::open(&bytes)
            .err()
            .expect("oversized declaration must be rejected");
        assert!(error.to_string().contains("byte limit"));
    }
}
