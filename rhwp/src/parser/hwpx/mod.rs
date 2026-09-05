//! HWPX 파일 파서 모듈
//!
//! HWPX(XML 기반 HWP) 파일을 파싱하여 Document 모델로 변환한다.
//! HWPX는 ZIP 패키지 내 XML 파일로 구성된 KS X 6101:2024 표준 포맷이다.
//!
//! ## 파싱 순서
//! 1. ZIP 컨테이너 열기 (reader)
//! 2. content.hpf → 섹션 파일 목록 추출 (content)
//! 3. header.xml → DocInfo 변환 (header)
//! 4. section*.xml → Section 변환 (section)
//! 5. BinData → 이미지 로딩

pub mod content;
mod contract_streams;
pub mod header;
pub mod reader;
pub mod section;
pub mod utils;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::model::bin_data::{BinData, BinDataContent, BinDataType};
use crate::model::document::{Document, FileHeader, HwpVersion, Section};
use crate::xml_attr::{image_ref_u16_ascii, ExactXmlAttributeScanner};

fn is_internal_bin_data_href(href: &str) -> bool {
    let href = href.to_ascii_lowercase();
    href.starts_with("bindata/") || href.contains("/bindata/")
}

fn is_internal_ole_package_item(item: &content::PackageItem) -> bool {
    let href = item.href.to_ascii_lowercase();
    is_internal_bin_data_href(&href)
        && (item.media_type.eq_ignore_ascii_case("application/ole") || href.ends_with(".ole"))
}

fn hwpx_bin_data_extension(item: &content::PackageItem) -> String {
    if is_internal_ole_package_item(item) {
        "OLE".to_string()
    } else {
        item.href.rsplit('.').next().unwrap_or("dat").to_string()
    }
}

fn normalize_internal_ole_data(item: &content::PackageItem, data: Vec<u8>) -> Vec<u8> {
    if !is_internal_ole_package_item(item) {
        return data;
    }
    normalize_ole_bytes(data)
}

/// 내부 OLE 바이트에서 선두 4-byte LE size prefix 를 제거한다.
///
/// [Task #2263] 지연 로딩 시점에도 동일 정규화를 적용해야 하므로
/// `PackageItem` 의존 없는 바이트 전용 함수로 분리했다.
fn normalize_ole_bytes(mut data: Vec<u8>) -> Vec<u8> {
    if data.len() < 12 {
        return data;
    }

    const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    if data[..8] != CFB_MAGIC && data[4..12] == CFB_MAGIC {
        data.drain(..4);
    }
    data
}

/// [Task #2263] HWPX ZIP 원본을 보유하고 요청 시점에 BinData 엔트리를 압축 해제한다.
///
/// 파싱 시점에 모든 내장 이미지를 풀어 IR 에 상주시키면 원본 파일 크기의
/// 수십 배 메모리를 쓰게 된다 (무손실 비트맵 다수 내장 시 특히). ZIP 안의
/// 이미지는 deflate 압축 상태이므로, 원본 컨테이너만 들고 있다가 실제로
/// 렌더·직렬화되는 항목만 그때 푼다.
struct HwpxBinResolver {
    reader: std::sync::Mutex<reader::HwpxReader>,
    /// 선두 size prefix 정규화가 필요한 내부 OLE 엔트리 경로
    ole_hrefs: HashSet<String>,
}

impl std::fmt::Debug for HwpxBinResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HwpxBinResolver")
            .field("ole_hrefs", &self.ole_hrefs.len())
            .finish()
    }
}

impl crate::model::bin_data::BinDataResolver for HwpxBinResolver {
    fn resolve(&self, key: &str) -> Vec<u8> {
        let mut reader = match self.reader.lock() {
            Ok(r) => r,
            Err(poisoned) => poisoned.into_inner(),
        };
        match reader.read_file_bytes(key) {
            Ok(data) => {
                if self.ole_hrefs.contains(key) {
                    normalize_ole_bytes(data)
                } else {
                    data
                }
            }
            Err(e) => {
                // [#1917] 로드 실패 시에도 엔트리는 등록된 상태를 유지한다
                // (manifest·binaryItemIDRef 보존). 이미지 데이터만 소실.
                eprintln!(
                    "경고: BinData '{}' 로드 실패: {} — 이미지 데이터 소실",
                    key, e
                );
                Vec::new()
            }
        }
    }

    fn resolve_limited(&self, key: &str, max_bytes: usize) -> Option<Vec<u8>> {
        let mut reader = match self.reader.lock() {
            Ok(reader) => reader,
            Err(poisoned) => poisoned.into_inner(),
        };
        match reader.read_file_bytes_limited(key, max_bytes) {
            Ok(data) => Some(if self.ole_hrefs.contains(key) {
                normalize_ole_bytes(data)
            } else {
                data
            }),
            Err(HwpxError::MissingFile(error)) => {
                // Preserve the established #1917 placeholder behavior for a
                // manifest item whose package part is absent. Resource-limit
                // and decompression failures remain `None` so serializers do
                // not silently replace oversized attacker data with empties.
                eprintln!(
                    "경고: BinData '{}' bounded 로드 실패: {} — 빈 placeholder 유지",
                    key, error
                );
                Some(Vec::new())
            }
            Err(error) => {
                eprintln!("경고: BinData '{}' bounded 로드 실패: {}", key, error);
                None
            }
        }
    }

    fn payload_identity(
        &self,
        key: &str,
    ) -> Option<crate::model::bin_data::BinDataPayloadIdentity> {
        let mut reader = match self.reader.lock() {
            Ok(reader) => reader,
            Err(poisoned) => poisoned.into_inner(),
        };
        let (byte_len, digest) = reader
            .fingerprint_file_limited(key, crate::parser::limits::MAX_BINARY_BYTES)
            .ok()?;
        let domain = if self.ole_hrefs.contains(key) {
            "hwpx-entry:ole"
        } else {
            "hwpx-entry"
        };
        Some(crate::model::bin_data::BinDataPayloadIdentity::new(
            domain, byte_len, digest,
        ))
    }
}

/// HWPX 파싱 에러
#[derive(Debug)]
pub enum HwpxError {
    /// ZIP 컨테이너 오류
    ZipError(String),
    /// XML 파싱 오류
    XmlError(String),
    /// 필수 파일 누락
    MissingFile(String),
    /// 데이터 변환 오류
    ConversionError(String),
    /// [Issue #1946] 비밀번호 암호화 HWPX(ODF encryption-data, AES-256-CBC).
    /// 복호화 미지원 — 암호문을 UTF-8 로 오독하는 대신 명확히 분류한다.
    Encrypted(String),
}

impl HwpxError {
    /// 암호화 문서 여부 — 배치 게이트의 ENCRYPTED_SKIP 분류에 사용.
    pub fn is_encrypted(&self) -> bool {
        matches!(self, HwpxError::Encrypted(_))
    }
}

impl std::fmt::Display for HwpxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HwpxError::ZipError(e) => write!(f, "ZIP 오류: {}", e),
            HwpxError::XmlError(e) => write!(f, "XML 파싱 오류: {}", e),
            HwpxError::MissingFile(e) => write!(f, "필수 파일 누락: {}", e),
            HwpxError::ConversionError(e) => write!(f, "변환 오류: {}", e),
            HwpxError::Encrypted(e) => write!(f, "암호화된 문서(복호화 미지원): {}", e),
        }
    }
}

impl std::error::Error for HwpxError {}

/// [Issue #1946] META-INF/manifest.xml 바이트에서 ODF 암호화 표식을 감지한다.
/// 암호화면 알고리즘 요약을, 아니면 None 을 반환한다. manifest 자체는 평문이므로
/// UTF-8 손실 없이 검사 가능하나, 안전을 위해 lossy 로 읽어 부분 손상에도 동작한다.
fn detect_odf_encryption(manifest_bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(manifest_bytes);
    if !text.contains("encryption-data") {
        return None;
    }
    let algo = if text.contains("aes256-cbc") {
        "AES-256-CBC"
    } else if text.contains("aes128-cbc") {
        "AES-128-CBC"
    } else {
        "미상 알고리즘"
    };
    let kdf = if text.contains("pbkdf2") {
        " + PBKDF2"
    } else {
        ""
    };
    Some(format!(
        "ODF encryption-data 감지 ({}{}) — 비밀번호 보호 문서",
        algo, kdf
    ))
}

impl From<zip::result::ZipError> for HwpxError {
    fn from(e: zip::result::ZipError) -> Self {
        HwpxError::ZipError(e.to_string())
    }
}

impl From<quick_xml::Error> for HwpxError {
    fn from(e: quick_xml::Error) -> Self {
        HwpxError::XmlError(e.to_string())
    }
}

fn resolve_master_page_hrefs<'a, 'b>(
    id_refs: &'b [String],
    master_page_items: &'a [content::PackageItem],
) -> (Vec<&'a str>, Vec<&'b str>) {
    let href_by_id: HashMap<&str, &str> = master_page_items
        .iter()
        .map(|item| (item.id.as_str(), item.href.as_str()))
        .collect();
    let mut seen_hrefs = HashSet::new();
    let mut hrefs = Vec::new();
    let mut missing_refs = Vec::new();

    for id_ref in id_refs {
        match href_by_id.get(id_ref.as_str()).copied() {
            Some(href) if seen_hrefs.insert(href) => hrefs.push(href),
            Some(_) => {}
            None => missing_refs.push(id_ref.as_str()),
        }
    }

    (hrefs, missing_refs)
}

#[derive(Debug)]
struct HwpxBinDataIds {
    ordered: Vec<u16>,
    by_manifest_id: HashMap<String, u16>,
}

fn exact_manifest_numeric_id(value: &str) -> Option<u16> {
    let digits = value
        .strip_prefix("image")
        .or_else(|| value.strip_prefix("ole"))
        .or_else(|| value.chars().all(|ch| ch.is_ascii_digit()).then_some(value))?;
    (!digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit()))
        .then(|| digits.parse::<u16>().ok())
        .flatten()
        .filter(|id| *id != 0)
}

fn build_hwpx_bin_data_ids(
    items: &[content::PackageItem],
    chart_ids: impl IntoIterator<Item = u16>,
) -> Result<HwpxBinDataIds, HwpxError> {
    if items.len() > usize::from(u16::MAX) {
        return Err(HwpxError::XmlError(format!(
            "HWPX manifest contains {} BinData items; at most {} are representable",
            items.len(),
            u16::MAX
        )));
    }

    let candidates = items
        .iter()
        .map(|item| exact_manifest_numeric_id(&item.id))
        .collect::<Vec<_>>();
    let mut used = chart_ids.into_iter().collect::<HashSet<_>>();
    let mut ordered = vec![0; items.len()];

    // Reserve every unique exact numeric manifest ID before allocating IDs for
    // arbitrary names. This keeps a preceding `font-resource-alpha` from
    // stealing the ID of a later `image1` entry.
    for (index, candidate) in candidates.iter().copied().enumerate() {
        if let Some(id) = candidate.filter(|id| !used.contains(id)) {
            used.insert(id);
            ordered[index] = id;
        }
    }
    let mut next_free = 1u32;
    for id in &mut ordered {
        if *id != 0 {
            continue;
        }
        while next_free <= u32::from(u16::MAX) && used.contains(&(next_free as u16)) {
            next_free += 1;
        }
        let allocated = u16::try_from(next_free).map_err(|_| {
            HwpxError::XmlError("HWPX manifest has no collision-free BinData ID".to_string())
        })?;
        used.insert(allocated);
        *id = allocated;
        next_free += 1;
    }

    let mut by_manifest_id = HashMap::with_capacity(items.len());
    for (item, id) in items.iter().zip(ordered.iter().copied()) {
        // Duplicate manifest IDs are ambiguous by definition. Keep the first
        // declaration as the deterministic typed-reference target while still
        // assigning every declaration a unique storage ID.
        by_manifest_id.entry(item.id.clone()).or_insert(id);
    }
    Ok(HwpxBinDataIds {
        ordered,
        by_manifest_id,
    })
}

fn rewrite_binary_item_id_refs<'a>(
    xml: &'a str,
    ids: &HashMap<String, u16>,
) -> Result<Cow<'a, str>, HwpxError> {
    rewrite_binary_item_id_refs_limited(xml, ids, crate::parser::limits::MAX_STRUCTURAL_BYTES)
}

fn rewrite_binary_item_id_refs_limited<'a>(
    xml: &'a str,
    ids: &HashMap<String, u16>,
    max_bytes: usize,
) -> Result<Cow<'a, str>, HwpxError> {
    if xml.len() > max_bytes {
        return Err(HwpxError::XmlError(format!(
            "HWPX XML exceeds structural byte limit: {} > {max_bytes}",
            xml.len()
        )));
    }
    if ids.is_empty() {
        return Ok(Cow::Borrowed(xml));
    }

    // Pass one is allocation-free. It both keeps unchanged members borrowed
    // and computes the exact final size before the one member-sized allocation
    // is attempted.
    let mut changed = false;
    let mut scanner = ExactXmlAttributeScanner::new(xml);
    let mut projected_len = xml.len();
    while let Some((value_start, value_end)) = scanner.next_value("binaryItemIDRef") {
        if let Some(id) = ids.get(&xml[value_start..value_end]) {
            let mut replacement_buffer = [0u8; 10];
            let replacement = image_ref_u16_ascii(*id, &mut replacement_buffer);
            let original = &xml[value_start..value_end];
            if replacement != original {
                changed = true;
                projected_len = projected_len
                    .checked_sub(original.len())
                    .and_then(|length| length.checked_add(replacement.len()))
                    .ok_or_else(|| {
                        HwpxError::XmlError(
                            "HWPX binaryItemIDRef rewrite size overflow".to_string(),
                        )
                    })?;
            }
        }
    }
    if !changed {
        return Ok(Cow::Borrowed(xml));
    }
    if projected_len > max_bytes {
        return Err(HwpxError::XmlError(format!(
            "HWPX rewritten XML exceeds structural byte limit: {projected_len} > {max_bytes}"
        )));
    }

    let mut output = String::new();
    output.try_reserve_exact(projected_len).map_err(|error| {
        HwpxError::XmlError(format!(
            "HWPX binaryItemIDRef rewrite allocation failed: {error}"
        ))
    })?;
    let mut copied_cursor = 0usize;
    let mut scanner = ExactXmlAttributeScanner::new(xml);
    while let Some((value_start, value_end)) = scanner.next_value("binaryItemIDRef") {
        if let Some(id) = ids.get(&xml[value_start..value_end]) {
            let mut replacement_buffer = [0u8; 10];
            let replacement = image_ref_u16_ascii(*id, &mut replacement_buffer);
            if replacement != &xml[value_start..value_end] {
                output.push_str(&xml[copied_cursor..value_start]);
                output.push_str(&replacement);
                copied_cursor = value_end;
            }
        }
    }
    output.push_str(&xml[copied_cursor..]);
    debug_assert_eq!(output.len(), projected_len);
    debug_assert!(output.capacity() >= projected_len);
    Ok(Cow::Owned(output))
}

fn restore_font_manifest_refs(
    target: &mut crate::model::document::DocInfo,
    original: &crate::model::document::DocInfo,
) {
    for (target_group, original_group) in
        target.font_faces.iter_mut().zip(original.font_faces.iter())
    {
        for (target_font, original_font) in target_group.iter_mut().zip(original_group.iter()) {
            target_font.bin_item_id_ref = original_font.bin_item_id_ref.clone();
            if let (Some(target_substitute), Some(original_substitute)) = (
                target_font.subst_font.as_mut(),
                original_font.subst_font.as_ref(),
            ) {
                target_substitute.bin_item_id_ref = original_substitute.bin_item_id_ref.clone();
            }
        }
    }
}

fn attach_hwpx_master_page(
    reader: &mut reader::HwpxReader,
    section: &mut Section,
    master_page_href: &str,
    bin_data_ids: &HashMap<String, u16>,
) -> Result<bool, HwpxError> {
    match reader.read_file(master_page_href) {
        Ok(master_page_xml) => {
            let rewritten = rewrite_binary_item_id_refs(&master_page_xml, bin_data_ids)?;
            match section::parse_hwpx_master_page(&rewritten) {
                Ok(master_page) => {
                    section.section_def.master_pages.push(master_page);
                    Ok(true)
                }
                Err(e) => {
                    eprintln!("경고: {} 파싱 실패: {}", master_page_href, e);
                    Ok(false)
                }
            }
        }
        Err(e) => {
            eprintln!("경고: {} 읽기 실패: {}", master_page_href, e);
            Ok(false)
        }
    }
}

/// HWPX 파일 바이트 데이터를 파싱하여 Document IR로 변환
pub fn parse_hwpx(data: &[u8]) -> Result<Document, HwpxError> {
    validate_untrusted_input_size(data.len())?;
    parse_hwpx_validated(data)
}

pub(super) fn validate_untrusted_input_size(byte_len: usize) -> Result<(), HwpxError> {
    if byte_len > crate::parser::limits::MAX_UNTRUSTED_INPUT_BYTES {
        return Err(HwpxError::ZipError(format!(
            "HWPX input is {} bytes and exceeds the {} byte untrusted-input limit",
            byte_len,
            crate::parser::limits::MAX_UNTRUSTED_INPUT_BYTES
        )));
    }
    Ok(())
}

pub(crate) fn parse_hwpx_validated(data: &[u8]) -> Result<Document, HwpxError> {
    // 1. ZIP 컨테이너 열기. The active reader and lazy binary resolver share
    // one immutable source allocation instead of each cloning the archive.
    let source_bytes: Arc<[u8]> = Arc::from(data);
    let mut reader = reader::HwpxReader::open_shared(source_bytes.clone())?;

    // [Issue #1946] 암호화 HWPX 조기 감지. META-INF/manifest.xml 은 암호화 문서에서도
    // 평문이며, 암호화된 엔트리마다 <odf:encryption-data> 블록을 갖는다. 감지하면
    // 암호문(Contents/*.xml)을 UTF-8 로 오독하기 전에 명확한 Encrypted 에러로 반환한다
    // (종전엔 "UTF-8 변환 실패" 오진단). manifest 부재/평문 문서는 종전 경로 유지.
    if let Ok(manifest) = reader.read_file_bytes("META-INF/manifest.xml") {
        if let Some(detail) = detect_odf_encryption(&manifest) {
            return Err(HwpxError::Encrypted(detail));
        }
    }

    // 1-1. 보조 엔트리 원본 보존 (라운드트립 무손실).
    //   IR 로 모델링되지 않는 엔트리(version.xml/settings.xml/Preview/*)는
    //   직렬화기가 하드코딩 상수로 재생성하면서 원본 플랫폼/인쇄설정/미리보기를
    //   잃는다. 여기서 원본 바이트를 그대로 보존해 직렬화 시 passthrough 한다.
    const HWPX_AUX_PATHS: &[&str] = &[
        "version.xml",
        "settings.xml",
        "Preview/PrvText.txt",
        "Preview/PrvImage.png",
        crate::model::document::HWP5_ORIGIN_HWPX_MARKER_PATH,
    ];
    let mut hwpx_aux_entries: Vec<(String, Vec<u8>)> = Vec::new();
    for path in HWPX_AUX_PATHS {
        if let Ok(bytes) = reader.read_file_bytes(path) {
            hwpx_aux_entries.push((path.to_string(), bytes));
        }
    }

    // 2. content.hpf → 섹션 파일 목록 + BinData 목록
    let content_xml = reader.read_file("Contents/content.hpf")?;
    // content.hpf 의 manifest/spine 은 본문 의존(섹션/BinData)이라 재생성하지만,
    // <opf:metadata>(저작자/생성·수정일자/주제 등)는 본문과 무관하므로 직렬화 시
    // 원본 블록을 그대로 splice 하기 위해 원본 바이트를 보존한다.
    let package_info = content::parse_content_hpf(&content_xml)?;
    hwpx_aux_entries.push(("Contents/content.hpf".to_string(), content_xml.into_bytes()));

    // Preserve package parts that are not represented by the IR.  In particular,
    // Hancom stores document scripts and editable OOXML charts outside Contents/
    // and BinData/.  Dropping those ZIP entries on save can disable scripts or
    // turn a chart into an unusable fallback object.
    let package_file_names = reader.file_names();
    let bin_data_ids = build_hwpx_bin_data_ids(
        &package_info.bin_data_items,
        package_file_names
            .iter()
            .filter_map(|path| chart_number_from_path(path).map(|number| 60000 + number)),
    )?;
    let mut modeled_paths: HashSet<String> = [
        "mimetype",
        "version.xml",
        "settings.xml",
        "Preview/PrvText.txt",
        "Preview/PrvImage.png",
        "Contents/header.xml",
        "Contents/content.hpf",
        "META-INF/container.rdf",
        "META-INF/container.xml",
        "META-INF/manifest.xml",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    modeled_paths.extend(package_info.section_files.iter().cloned());
    modeled_paths.extend(
        package_info
            .master_page_items
            .iter()
            .map(|item| item.href.clone()),
    );
    modeled_paths.extend(
        package_info
            .bin_data_items
            .iter()
            // Some Hancom chart fallbacks incorrectly declare an internal
            // BinData/*.ole part as isEmbeded="0".  It is still modeled and
            // must not also enter the generic passthrough set.
            .filter(|item| item.is_embedded || is_internal_bin_data_href(&item.href))
            .map(|item| item.href.clone()),
    );
    for path in &package_file_names {
        if modeled_paths.contains(path)
            || hwpx_aux_entries.iter().any(|(saved, _)| saved == path)
            || !is_safe_hwpx_passthrough_path(path)
        {
            continue;
        }
        if let Ok(bytes) = reader.read_file_bytes(path) {
            hwpx_aux_entries.push((path.clone(), bytes));
        }
    }

    // 3. header.xml → DocInfo, DocProperties
    let header_xml = reader.read_file("Contents/header.xml")?;
    let margin_units = header::ParagraphMarginUnits::from_package_version(
        hwpx_aux_entries
            .iter()
            .find(|(path, _)| path == "version.xml")
            .map(|(_, bytes)| bytes.as_slice()),
    );
    let (original_doc_info, doc_properties) =
        header::parse_hwpx_header_with_margin_units(&header_xml, margin_units)?;
    let remapped_header_xml =
        rewrite_binary_item_id_refs(&header_xml, &bin_data_ids.by_manifest_id)?;
    let mut doc_info = if matches!(&remapped_header_xml, Cow::Borrowed(_)) {
        original_doc_info
    } else {
        let (mut remapped_doc_info, _) =
            header::parse_hwpx_header_with_margin_units(&remapped_header_xml, margin_units)?;
        restore_font_manifest_refs(&mut remapped_doc_info, &original_doc_info);
        remapped_doc_info
    };
    resolve_embedded_font_references(&mut doc_info, &bin_data_ids.by_manifest_id);

    // [Task #1608] head version("1.4")은 HWPML **스키마 버전**일 뿐 HWP3→HWPX 변환 지표가
    // 아니다. 네이티브 한글2022 HWPX(version.xml: major=5 minor=1 "Hancom Office Hangul")도
    // head version 1.4 라, 과거 `is_hwp3_origin = (head version == "1.4")` (Task #554) 판정은
    // 거의 모든 모던 HWPX 를 HWP3-origin 으로 오탐지해 부당한 "마지막 줄" tolerance(1600 HU)를
    // 부여했고, 이것이 경계 문서를 1쪽 적게 렌더하는 −1쪽 갭의 한 요인이었다(Task #1600 요인 A).
    // 메타데이터로 진짜 변환본과 네이티브를 구별할 판별자가 없어(조사 확정), 파싱 시점의 HWP3
    // tolerance 부여를 제거한다.
    let hwpml_version = header::parse_hwpx_hwpml_version(&header_xml);
    // Preserve the source declaration. The serializer may raise the emitted
    // version when its regenerated HwpUnitChar representation requires it.
    doc_info.hwpml_version = hwpml_version.clone();

    // BinData 목록을 DocInfo에 등록
    // [Task #873] isEmbeded="0" 인 외부 file 참조 (예: HWP3 → HWPX 변환본 의 절대 경로)
    // 는 BinDataType::Link + abs_path 로 등록. 이후 populate_link_image_paths (parser/mod.rs)
    // 가 Picture.external_path 설정 → Task #741 fallback 로 같은 dir 영역 image load.
    for (item, storage_id) in package_info
        .bin_data_items
        .iter()
        .zip(bin_data_ids.ordered.iter().copied())
    {
        let ext = hwpx_bin_data_extension(item);
        let (data_type, abs_path) = if is_internal_ole_package_item(item) {
            (BinDataType::Storage, None)
        } else if item.is_embedded {
            (BinDataType::Embedding, None)
        } else {
            (BinDataType::Link, Some(item.href.clone()))
        };
        doc_info.bin_data_list.push(BinData {
            data_type,
            storage_id,
            extension: Some(ext),
            abs_path,
            ..Default::default()
        });
    }

    // 4. section*.xml → Section 변환
    let mut sections = Vec::new();
    for (section_idx, section_href) in package_info.section_files.iter().enumerate() {
        let section_xml = reader.read_file(section_href)?;
        let master_page_refs = match section::collect_hwpx_section_master_page_refs(&section_xml) {
            Ok(refs) => refs,
            Err(e) => {
                eprintln!("경고: {} masterPage 참조 파싱 실패: {}", section_href, e);
                Vec::new()
            }
        };
        let remapped_section_xml =
            rewrite_binary_item_id_refs(&section_xml, &bin_data_ids.by_manifest_id)?;
        match section::parse_hwpx_section(&remapped_section_xml) {
            Ok(mut section) => {
                let (master_page_hrefs, missing_master_page_refs) =
                    resolve_master_page_hrefs(&master_page_refs, &package_info.master_page_items);
                for missing_ref in missing_master_page_refs {
                    eprintln!(
                        "경고: {} masterPage idRef '{}' manifest 항목 없음",
                        section_href, missing_ref
                    );
                }

                let mut attached_master_page_count = 0usize;
                for master_page_href in master_page_hrefs {
                    if attach_hwpx_master_page(
                        &mut reader,
                        &mut section,
                        master_page_href,
                        &bin_data_ids.by_manifest_id,
                    )? {
                        attached_master_page_count += 1;
                    }
                }

                if attached_master_page_count == 0 {
                    if let Some(master_page_files) =
                        package_info.section_master_page_files.get(section_idx)
                    {
                        let mut fallback_seen = HashSet::new();
                        for master_page_href in master_page_files {
                            if fallback_seen.insert(master_page_href.as_str()) {
                                attach_hwpx_master_page(
                                    &mut reader,
                                    &mut section,
                                    master_page_href,
                                    &bin_data_ids.by_manifest_id,
                                )?;
                            }
                        }
                    }
                }
                sections.push(section);
            }
            Err(e) => {
                return Err(HwpxError::XmlError(format!(
                    "{} 파싱 실패: {}",
                    section_href, e
                )));
            }
        }
    }

    // [Task #1608] (제거) 과거 Task #554 의 HWP3-origin tolerance 부여는
    // head version == "1.4" 오탐지로 네이티브 HWPX 전반에 부당 적용되어 삭제했다.
    // 상세 사유는 위 hwpml_version 파싱부 주석 참조.

    // 5. BinData 이미지 등록 (지연 로딩)
    //
    // [Task #2263] 여기서 바이트를 미리 풀지 않는다. ZIP 원본을 보유한
    // 리졸버만 등록하고, 실제로 렌더·직렬화되는 항목만 그 시점에 압축을 푼다.
    // 로드 실패(상한 초과·엔트리 손상 등) 시에도 엔트리 자체는 등록되므로
    // [#1917] 의 manifest·binaryItemIDRef 보존 의미는 그대로 유지된다
    // (리졸버가 빈 바이트를 반환 → 이미지 데이터만 소실).
    let ole_hrefs: HashSet<String> = package_info
        .bin_data_items
        .iter()
        .filter(|item| is_internal_ole_package_item(item))
        .map(|item| item.href.clone())
        .collect();
    let bin_data_budget = reader.expanded_budget_handle();
    let raw_bin_resolver: std::sync::Arc<dyn crate::model::bin_data::BinDataResolver> =
        std::sync::Arc::new(HwpxBinResolver {
            reader: std::sync::Mutex::new(reader::HwpxReader::open_shared_with_budget(
                source_bytes,
                bin_data_budget,
            )?),
            ole_hrefs,
        });
    let bin_resolver: std::sync::Arc<dyn crate::model::bin_data::BinDataResolver> =
        std::sync::Arc::new(crate::model::bin_data::SharedBinDataResolver::new(
            raw_bin_resolver,
        ));

    let mut bin_data_content = Vec::new();
    for (item, storage_id) in package_info
        .bin_data_items
        .iter()
        .zip(bin_data_ids.ordered.iter().copied())
    {
        // isEmbeded="0"은 ZIP에 포함되지 않은 외부 파일 참조다.
        // populate_link_image_paths + populate_external_images_from_dir 가 후처리.
        //
        // Issue #1283: 일부 HWPX는 ZIP 내부 OLE(`BinData/*.ole`)에도 isEmbeded="0"을
        // 기록한다. 이 경우는 외부 링크가 아니므로 로드해야 기존 OLE `/Contents`
        // 차트 렌더러가 동작한다.
        if !item.is_embedded && !is_internal_ole_package_item(item) {
            continue;
        }
        bin_data_content.push(BinDataContent {
            id: storage_id,
            data: crate::model::bin_data::BinDataBytes::lazy(
                bin_resolver.clone(),
                item.href.clone(),
            ),
            extension: hwpx_bin_data_extension(item),
        });
    }

    // 5-1. Chart/chartN.xml (OOXML 차트) 로딩.  The synthetic ID is an
    // in-memory renderer bridge only; the HWPX serializer maps it back to the
    // native Chart/ package part and <hp:chart>, never to BinData/OLE.
    for (n, path) in package_file_names
        .iter()
        .filter_map(|path| chart_number_from_path(path).map(|n| (n, path)))
    {
        let data = reader.read_file_bytes(path)?;
        bin_data_content.push(BinDataContent {
            id: 60000 + n,
            data: data.into(),
            extension: "ooxml_chart".to_string(),
        });
    }

    // Document 조립
    let model_header = FileHeader {
        version: HwpVersion {
            major: 5,
            minor: 1,
            build: 0,
            revision: 0,
        },
        flags: 0,
        compressed: false,
        encrypted: false,
        distribution: false,
        raw_data: None,
    };

    // [Task #852 Stage 2.1] HWPX ZIP 컨테이너 → HWP OLE contract 스트림 변환.
    // 한컴 HWP 정답지 contract (Preview/PrvText, Preview/PrvImage, Scripts/
    // DefaultJScript) 를 HWPX 컨테이너 동등 파일 (Preview/PrvText.txt,
    // Preview/PrvImage.png, Scripts/sourceScripts) 로부터 변환. HWPX 에
    // 동등 데이터가 없는 contract 스트림 (HwpSummaryInformation, DocOptions/
    // _LinkDoc, Scripts/JScriptVersion) 은 Stage 2.2 의 blank2010.hwp
    // fallback 으로 보강. cfb_writer (`src/serializer/cfb_writer.rs:155`)
    // 가 Document::extra_streams 를 그대로 OLE 스트림으로 작성.
    let contract = contract_streams::extract_contract_streams(&mut reader);

    let mut doc = Document {
        header: model_header,
        doc_properties,
        doc_info,
        sections,
        preview: None,
        bin_data_content,
        extra_streams: contract.streams,
        hwpx_aux_entries,
        is_hwp3_variant: false,
        is_hwpx_variant: false,
        provenance: crate::model::provenance::SourceProvenance {
            format: crate::model::provenance::SourceFormat::Hwpx,
            hwp3_lineage: false,
            hwpx_lineage: false,
        },
    };

    // BinData Link의 외부 파일 경로를 Picture.external_path로 전달한다.
    // 이후 populate_external_images_from_dir가 문서 폴더에서 파일명이 일치하는 그림을 읽는다.
    populate_hwpx_link_image_paths(&mut doc);

    Ok(doc)
}

/// HWPX typed BinData references are manifest item IDs, whereas HWP5 typed
/// image references are one-based declaration slots. The shared HWP helper
/// therefore cannot resolve sparse HWPX IDs without silently selecting the
/// wrong declaration.
fn populate_hwpx_link_image_paths(doc: &mut Document) {
    use crate::model::control::Control;
    use crate::model::image::Picture;
    use crate::model::paragraph::Paragraph;
    use crate::model::shape::{Caption, DrawingObjAttr, ShapeObject};

    fn set_picture_path(picture: &mut Picture, links: &HashMap<u16, String>) {
        if picture.image_attr.external_path.is_none() {
            picture.image_attr.external_path = links.get(&picture.image_attr.bin_data_id).cloned();
        }
    }

    fn visit_caption(caption: &mut Option<Caption>, links: &HashMap<u16, String>) {
        if let Some(caption) = caption {
            visit_paragraphs(&mut caption.paragraphs, links);
        }
    }

    fn visit_drawing(drawing: &mut DrawingObjAttr, links: &HashMap<u16, String>) {
        if let Some(text_box) = &mut drawing.text_box {
            visit_paragraphs(&mut text_box.paragraphs, links);
        }
        visit_caption(&mut drawing.caption, links);
    }

    fn visit_shape(shape: &mut ShapeObject, links: &HashMap<u16, String>) {
        if let Some(drawing) = shape.drawing_mut() {
            visit_drawing(drawing, links);
        }
        match shape {
            ShapeObject::Group(group) => {
                visit_caption(&mut group.caption, links);
                for child in &mut group.children {
                    visit_shape(child, links);
                }
            }
            ShapeObject::Picture(picture) => {
                set_picture_path(picture, links);
                visit_caption(&mut picture.caption, links);
            }
            ShapeObject::Chart(chart) => visit_caption(&mut chart.caption, links),
            ShapeObject::Ole(ole) => visit_caption(&mut ole.caption, links),
            _ => {}
        }
    }

    fn visit_paragraphs(paragraphs: &mut [Paragraph], links: &HashMap<u16, String>) {
        for paragraph in paragraphs {
            for control in &mut paragraph.controls {
                match control {
                    Control::SectionDef(section_def) => {
                        for page in &mut section_def.master_pages {
                            visit_paragraphs(&mut page.paragraphs, links);
                        }
                    }
                    Control::Table(table) => {
                        for cell in &mut table.cells {
                            visit_paragraphs(&mut cell.paragraphs, links);
                        }
                        visit_caption(&mut table.caption, links);
                    }
                    Control::Shape(shape) => visit_shape(shape, links),
                    Control::Picture(picture) => {
                        set_picture_path(picture, links);
                        visit_caption(&mut picture.caption, links);
                    }
                    Control::Header(header) => visit_paragraphs(&mut header.paragraphs, links),
                    Control::Footer(footer) => visit_paragraphs(&mut footer.paragraphs, links),
                    Control::Footnote(footnote) => {
                        visit_paragraphs(&mut footnote.paragraphs, links)
                    }
                    Control::Endnote(endnote) => visit_paragraphs(&mut endnote.paragraphs, links),
                    Control::HiddenComment(comment) => {
                        visit_paragraphs(&mut comment.paragraphs, links)
                    }
                    Control::Field(field) => visit_paragraphs(&mut field.memo_paragraphs, links),
                    _ => {}
                }
            }
        }
    }

    let links = doc
        .doc_info
        .bin_data_list
        .iter()
        .filter(|bin_data| matches!(bin_data.data_type, BinDataType::Link))
        .filter_map(|bin_data| {
            bin_data
                .abs_path
                .as_ref()
                .filter(|path| !path.is_empty())
                .or_else(|| bin_data.rel_path.as_ref().filter(|path| !path.is_empty()))
                .map(|path| (bin_data.storage_id, path.clone()))
        })
        .collect::<HashMap<_, _>>();

    for section in &mut doc.sections {
        visit_paragraphs(&mut section.paragraphs, &links);
        for page in &mut section.section_def.master_pages {
            visit_paragraphs(&mut page.paragraphs, &links);
        }
    }
}

fn is_safe_hwpx_passthrough_path(path: &str) -> bool {
    !path.is_empty()
        && !path.ends_with('/')
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|component| !component.is_empty() && component != "." && component != "..")
}

fn chart_number_from_path(path: &str) -> Option<u16> {
    path.strip_prefix("Chart/chart")?
        .strip_suffix(".xml")?
        .parse::<u16>()
        .ok()
        .filter(|number| *number > 0 && *number <= u16::MAX - 60000)
}

fn resolve_embedded_font_references(
    doc_info: &mut crate::model::document::DocInfo,
    item_ids: &HashMap<String, u16>,
) {
    for font in doc_info.font_faces.iter_mut().flatten() {
        font.resolved_bin_data_id = font
            .is_embedded
            .then(|| item_ids.get(font.bin_item_id_ref.as_str()).copied())
            .flatten();
        if let Some(substitute) = font.subst_font.as_mut() {
            substitute.resolved_bin_data_id = substitute
                .is_embedded
                .then(|| item_ids.get(substitute.bin_item_id_ref.as_str()).copied())
                .flatten();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_hwpx_size_policy_rejects_one_byte_over_untrusted_limit_without_allocation() {
        assert!(
            validate_untrusted_input_size(crate::parser::limits::MAX_UNTRUSTED_INPUT_BYTES).is_ok()
        );
        assert!(validate_untrusted_input_size(
            crate::parser::limits::MAX_UNTRUSTED_INPUT_BYTES + 1
        )
        .is_err());
    }

    #[test]
    fn test_parse_hwpx_invalid_data() {
        let result = parse_hwpx(&[0u8; 10]);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_hwpx_not_zip() {
        // CFB/HWP 데이터로 시도
        let result = parse_hwpx(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
        assert!(result.is_err());
    }

    #[test]
    fn manifest_ids_preserve_exact_numeric_values_and_allocate_collisions() {
        let item = |id: &str| content::PackageItem {
            id: id.to_string(),
            href: format!("BinData/{id}.bin"),
            media_type: "application/octet-stream".to_string(),
            is_embedded: true,
        };
        let items = vec![
            item("font-resource-alpha"),
            item("image1"),
            item("ole1"),
            item("image60001"),
            item("42"),
            item("image1"),
        ];

        let ids = build_hwpx_bin_data_ids(&items, [60001]).unwrap();

        assert_eq!(ids.ordered, vec![2, 1, 3, 4, 42, 5]);
        assert_eq!(ids.by_manifest_id["font-resource-alpha"], 2);
        assert_eq!(ids.by_manifest_id["image1"], 1);
        assert_eq!(ids.by_manifest_id["ole1"], 3);
        assert_eq!(ids.by_manifest_id["image60001"], 4);
        assert_eq!(ids.by_manifest_id["42"], 42);
        assert_eq!(ids.ordered.iter().copied().collect::<HashSet<_>>().len(), 6);
    }

    #[test]
    fn binary_item_ref_rewrite_matches_whole_manifest_ids_only() {
        let ids = HashMap::from([
            ("font-resource-123".to_string(), 7),
            ("image10".to_string(), 10),
        ]);
        let xml = r#"<root><a binaryItemIDRef = 'font-resource-123'/><b binaryItemIDRef="asset-123"/><c binaryItemIDRef="image10"/></root>"#;

        let rewritten = rewrite_binary_item_id_refs(xml, &ids).unwrap();

        assert_eq!(
            rewritten.as_ref(),
            r#"<root><a binaryItemIDRef = 'image7'/><b binaryItemIDRef="asset-123"/><c binaryItemIDRef="image10"/></root>"#
        );
    }

    #[test]
    fn binary_item_ref_rewrite_ignores_non_attributes_and_malformed_values() {
        let ids = HashMap::from([("image1".to_string(), 7)]);
        let xml = concat!(
            r#"<root>"#,
            r#"<!-- <x binaryItemIDRef="image1"/> -->"#,
            r#"<![CDATA[<x binaryItemIDRef="image1"/>]]>"#,
            r#"<t>binaryItemIDRef="image1"</t>"#,
            r#"<x x:binaryItemIDRef="image1" binaryItemIDRefExtra="image1"/>"#,
            r#"<x a=binaryItemIDRef="image1"/>"#,
            r#"<x binaryItemIDRef="image1"/>"#,
            r#"</root>"#,
        );
        let expected = xml.replacen(
            r#"<x binaryItemIDRef="image1"/></root>"#,
            r#"<x binaryItemIDRef="image7"/></root>"#,
            1,
        );

        let rewritten = rewrite_binary_item_id_refs(xml, &ids).unwrap();

        assert_eq!(rewritten, expected);
    }

    #[test]
    fn binary_item_ref_rewrite_borrows_when_values_are_already_canonical() {
        let ids = HashMap::from([("image10".to_string(), 10)]);
        let xml = r#"<root binaryItemIDRef="image10"><a binaryItemIDRef="unmapped"/></root>"#;

        let rewritten = rewrite_binary_item_id_refs_limited(xml, &ids, xml.len()).unwrap();

        assert!(matches!(
            rewritten,
            Cow::Borrowed(value) if value.as_ptr() == xml.as_ptr()
        ));
    }

    #[test]
    fn binary_item_ref_rewrite_rejects_expansion_before_structural_limit() {
        let ids = HashMap::from([("x".to_string(), u16::MAX)]);
        let xml = r#"<root binaryItemIDRef="x"/>"#;
        let expanded_len = xml.len() + "image65535".len() - 1;

        let error = rewrite_binary_item_id_refs_limited(xml, &ids, expanded_len - 1)
            .expect_err("expanded XML must remain inside the structural limit");

        assert!(matches!(
            error,
            HwpxError::XmlError(message) if message.contains("rewritten XML exceeds")
        ));
    }

    #[test]
    fn binary_item_ref_rewrite_handles_many_replacements_with_one_output_budget() {
        const REPLACEMENTS: usize = 4096;
        let ids = HashMap::from([("x".to_string(), u16::MAX)]);
        let item = r#"<a binaryItemIDRef="x"/>"#;
        let xml = item.repeat(REPLACEMENTS);
        let projected_len = xml.len() + REPLACEMENTS * ("image65535".len() - 1);

        let rewritten = rewrite_binary_item_id_refs_limited(&xml, &ids, projected_len)
            .expect("many rewrites should use their exact preflighted output budget");

        let Cow::Owned(rewritten) = rewritten else {
            panic!("changed XML must own its rewritten output");
        };
        assert_eq!(rewritten.len(), projected_len);
        assert_eq!(rewritten.matches("image65535").count(), REPLACEMENTS);
    }

    #[test]
    fn sparse_hwpx_link_paths_resolve_by_storage_id_not_declaration_slot() {
        let mut picture = crate::model::image::Picture::default();
        picture.image_attr.bin_data_id = 10;
        let mut doc = Document {
            doc_info: crate::model::document::DocInfo {
                bin_data_list: vec![
                    BinData {
                        data_type: BinDataType::Embedding,
                        storage_id: 1,
                        ..Default::default()
                    },
                    BinData {
                        data_type: BinDataType::Link,
                        storage_id: 10,
                        abs_path: Some("../linked/sparse.png".to_string()),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
            sections: vec![Section {
                paragraphs: vec![crate::model::paragraph::Paragraph {
                    controls: vec![crate::model::control::Control::Picture(Box::new(picture))],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };

        populate_hwpx_link_image_paths(&mut doc);

        let crate::model::control::Control::Picture(picture) =
            &doc.sections[0].paragraphs[0].controls[0]
        else {
            panic!("expected picture control");
        };
        assert_eq!(
            picture.image_attr.external_path.as_deref(),
            Some("../linked/sparse.png")
        );
    }

    #[test]
    fn duplicate_hwpx_entries_share_one_inflated_payload() {
        use crate::model::bin_data::{BinDataBytes, BinDataResolver, SharedBinDataResolver};
        use std::io::{Cursor, Write};
        use std::sync::Arc;
        use zip::write::SimpleFileOptions;

        let expected = vec![0x6d; 64 * 1024];
        let mut output = Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut output);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            archive.start_file("BinData/shared.png", options).unwrap();
            archive.write_all(&expected).unwrap();
            archive.finish().unwrap();
        }
        let raw: Arc<dyn BinDataResolver> = Arc::new(HwpxBinResolver {
            reader: std::sync::Mutex::new(reader::HwpxReader::open(&output.into_inner()).unwrap()),
            ole_hrefs: HashSet::new(),
        });
        let shared: Arc<dyn BinDataResolver> = Arc::new(SharedBinDataResolver::new(raw));
        let first = BinDataBytes::lazy(shared.clone(), "BinData/shared.png".to_string());
        let duplicate = BinDataBytes::lazy(shared, "BinData/shared.png".to_string());

        let first_payload = first.load_shared();
        let duplicate_payload = duplicate.load_shared();
        assert_eq!(first_payload.as_ref(), expected.as_slice());
        assert!(Arc::ptr_eq(&first_payload, &duplicate_payload));
    }

    #[test]
    fn test_resolve_master_page_hrefs_uses_id_ref_order_and_dedups() {
        let items = vec![
            content::PackageItem {
                id: "masterpage1".to_string(),
                href: "Contents/masterpage1.xml".to_string(),
                media_type: "application/xml".to_string(),
                is_embedded: true,
            },
            content::PackageItem {
                id: "masterpage0".to_string(),
                href: "Contents/masterpage0.xml".to_string(),
                media_type: "application/xml".to_string(),
                is_embedded: true,
            },
        ];
        let id_refs = vec![
            "masterpage0".to_string(),
            "missing".to_string(),
            "masterpage1".to_string(),
            "masterpage0".to_string(),
        ];

        let (hrefs, missing_refs) = resolve_master_page_hrefs(&id_refs, &items);

        assert_eq!(
            hrefs,
            vec!["Contents/masterpage0.xml", "Contents/masterpage1.xml"]
        );
        assert_eq!(missing_refs, vec!["missing"]);
    }

    #[test]
    fn embedded_font_reference_uses_exact_manifest_id() {
        let mut parent = crate::model::style::Font {
            name: "Embedded Parent".to_string(),
            is_embedded: true,
            bin_item_id_ref: "font-resource-alpha".to_string(),
            ..Default::default()
        };
        parent.subst_font = Some(crate::model::style::SubstFont {
            face: "Embedded Substitute".to_string(),
            is_embedded: true,
            bin_item_id_ref: "font-resource-beta".to_string(),
            ..Default::default()
        });
        let mut doc_info = crate::model::document::DocInfo {
            font_faces: vec![vec![parent]],
            ..Default::default()
        };
        let items = vec![
            content::PackageItem {
                id: "font-resource-beta".to_string(),
                href: "BinData/beta.ttf".to_string(),
                media_type: "application/x-font-ttf".to_string(),
                is_embedded: true,
            },
            content::PackageItem {
                id: "font-resource-alpha".to_string(),
                href: "BinData/alpha.ttf".to_string(),
                media_type: "application/x-font-ttf".to_string(),
                is_embedded: true,
            },
        ];

        let ids = build_hwpx_bin_data_ids(&items, []).unwrap();
        resolve_embedded_font_references(&mut doc_info, &ids.by_manifest_id);

        let font = &doc_info.font_faces[0][0];
        assert_eq!(font.resolved_bin_data_id, Some(2));
        assert_eq!(
            font.subst_font.as_ref().unwrap().resolved_bin_data_id,
            Some(1)
        );
        assert_eq!(font.bin_item_id_ref, "font-resource-alpha");
    }
}
