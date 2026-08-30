//! CFB (Compound File Binary) 컨테이너 읽기
//!
//! HWP 파일의 OLE/CFB 컨테이너를 열고 스트림을 추출한다.
//! - FileHeader: 256바이트, 비압축
//! - DocInfo: 레코드 스트림, 압축 가능
//! - BodyText/Section{N}: 레코드 스트림, 압축 가능
//! - ViewText/Section{N}: 배포용 문서 (암호화 + 압축)
//! - BinData/BIN{XXXX}.{ext}: 바이너리 데이터

use std::io::{Cursor, Read};
use std::sync::Arc;

use crate::parser::limits::{
    MAX_BINARY_BYTES, MAX_CFB_DIRECTORY_ENTRIES, MAX_CONTAINER_BYTES, MAX_STRUCTURAL_BYTES,
    MAX_THUMBNAIL_BYTES,
};

// Real Hancom files sometimes keep a few now-unused FAT sectors. This small
// compatibility allowance remains bounded independently of input size.
const CFB_FAT_COMPAT_SLACK_SECTORS: usize = 8;

/// CFB 컨테이너 리더
pub struct CfbReader {
    compound: cfb::CompoundFile<Cursor<Arc<[u8]>>>,
}

/// CFB 리더 에러
#[derive(Debug)]
pub enum CfbError {
    /// OLE 컨테이너 열기 실패
    OpenError(String),
    /// 스트림 읽기 실패
    StreamError(String),
    /// 스트림을 찾을 수 없음
    StreamNotFound(String),
    /// 압축 해제 실패
    DecompressError(String),
    /// 스트림 또는 압축 해제 결과가 호출부 상한을 초과함
    LimitExceeded(usize),
    /// CFB directory entry count exceeds the parser-wide container limit.
    DirectoryEntryLimitExceeded { actual: usize, limit: usize },
}

impl std::fmt::Display for CfbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CfbError::OpenError(e) => write!(f, "CFB 열기 실패: {}", e),
            CfbError::StreamError(e) => write!(f, "스트림 읽기 실패: {}", e),
            CfbError::StreamNotFound(name) => write!(f, "스트림 없음: {}", name),
            CfbError::DecompressError(e) => write!(f, "압축 해제 실패: {}", e),
            CfbError::LimitExceeded(limit) => {
                write!(f, "스트림이 {} 바이트 상한을 초과했습니다", limit)
            }
            CfbError::DirectoryEntryLimitExceeded { actual, limit } => write!(
                f,
                "CFB 디렉터리 엔트리 수 {actual}개가 {limit}개 상한을 초과했습니다"
            ),
        }
    }
}

impl std::error::Error for CfbError {}

impl CfbReader {
    /// 바이트 데이터에서 CFB 컨테이너 열기
    pub fn open(data: &[u8]) -> Result<Self, CfbError> {
        Self::open_shared(Arc::from(data))
    }

    /// Open a CFB reader over shared immutable source bytes.
    pub(crate) fn open_shared(data: Arc<[u8]>) -> Result<Self, CfbError> {
        if data.len() as u64 > MAX_CONTAINER_BYTES {
            return Err(CfbError::LimitExceeded(MAX_CONTAINER_BYTES as usize));
        }
        validate_cfb_directory_entry_budget(&data)?;
        let cursor = Cursor::new(data);
        let compound =
            cfb::CompoundFile::open(cursor).map_err(|e| CfbError::OpenError(e.to_string()))?;
        let reader = CfbReader { compound };
        reader.validate_stream_budget()?;
        Ok(reader)
    }

    fn validate_stream_budget(&self) -> Result<(), CfbError> {
        let mut total = 0u64;
        for entry in self.compound.walk().filter(|entry| entry.is_stream()) {
            let path = entry.path().to_string_lossy().replace('\\', "/");
            let size = entry.len();
            let per_stream_limit = stream_limit(&path) as u64;
            if size > per_stream_limit {
                return Err(CfbError::LimitExceeded(per_stream_limit as usize));
            }
            total = total
                .checked_add(size)
                .ok_or(CfbError::LimitExceeded(MAX_CONTAINER_BYTES as usize))?;
            if total > MAX_CONTAINER_BYTES {
                return Err(CfbError::LimitExceeded(MAX_CONTAINER_BYTES as usize));
            }
        }
        Ok(())
    }

    /// 스트림 존재 여부 확인
    pub fn has_stream(&self, path: &str) -> bool {
        self.compound.is_stream(path)
    }

    /// 스트림 원본 데이터 읽기 (압축 해제 없이)
    pub fn read_stream_raw(&mut self, path: &str) -> Result<Vec<u8>, CfbError> {
        self.read_stream_raw_limited(path, stream_limit(path))
    }

    /// Read a stream without letting its declared or observed size exceed `max_bytes`.
    pub fn read_stream_raw_limited(
        &mut self,
        path: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, CfbError> {
        let max_bytes = max_bytes.min(stream_limit(path));
        if !self.compound.is_stream(path) {
            return Err(CfbError::StreamNotFound(path.to_string()));
        }

        let mut stream = self
            .compound
            .open_stream(path)
            .map_err(|e| CfbError::StreamError(format!("{}: {}", path, e)))?;

        if stream.len() > max_bytes as u64 {
            return Err(CfbError::LimitExceeded(max_bytes));
        }

        let mut data = Vec::new();
        stream
            .by_ref()
            .take((max_bytes as u64).saturating_add(1))
            .read_to_end(&mut data)
            .map_err(|e| CfbError::StreamError(format!("{}: {}", path, e)))?;

        if data.len() > max_bytes {
            return Err(CfbError::LimitExceeded(max_bytes));
        }

        Ok(data)
    }

    /// FileHeader 스트림 읽기 (256바이트, 항상 비압축)
    pub fn read_file_header(&mut self) -> Result<Vec<u8>, CfbError> {
        self.read_file_header_limited(MAX_STRUCTURAL_BYTES)
    }

    pub fn read_file_header_limited(&mut self, max_bytes: usize) -> Result<Vec<u8>, CfbError> {
        self.read_stream_raw_limited("/FileHeader", max_bytes)
    }

    /// DocInfo 스트림 읽기 (압축 가능)
    pub fn read_doc_info(&mut self, compressed: bool) -> Result<Vec<u8>, CfbError> {
        self.read_doc_info_limited(compressed, MAX_STRUCTURAL_BYTES)
    }

    pub fn read_doc_info_limited(
        &mut self,
        compressed: bool,
        max_bytes: usize,
    ) -> Result<Vec<u8>, CfbError> {
        let max_bytes = max_bytes.min(MAX_STRUCTURAL_BYTES);
        let raw = self.read_stream_raw_limited("/DocInfo", max_bytes)?;
        if compressed {
            decompress_stream_limited(&raw, max_bytes)
        } else {
            Ok(raw)
        }
    }

    /// 본문 섹션 스트림 읽기
    ///
    /// 배포용 문서의 경우 ViewText/Section{N}에서 읽는다.
    /// 일반 문서는 BodyText/Section{N}에서 읽는다.
    /// 반환값은 압축 해제된 레코드 데이터.
    ///
    /// 배포용 문서의 경우, 이 함수는 raw 암호화 데이터를 반환한다.
    /// 호출자가 별도로 복호화를 수행해야 한다.
    pub fn read_body_text_section(
        &mut self,
        index: u32,
        compressed: bool,
        distribution: bool,
    ) -> Result<Vec<u8>, CfbError> {
        self.read_body_text_section_limited(index, compressed, distribution, MAX_STRUCTURAL_BYTES)
    }

    pub fn read_body_text_section_limited(
        &mut self,
        index: u32,
        compressed: bool,
        distribution: bool,
        max_bytes: usize,
    ) -> Result<Vec<u8>, CfbError> {
        let max_bytes = max_bytes.min(MAX_STRUCTURAL_BYTES);
        if distribution {
            // 배포용 문서: ViewText 스트림 (암호화됨 → 호출자가 복호화)
            let viewtext_path = format!("/ViewText/Section{}", index);
            if self.has_stream(&viewtext_path) {
                return self.read_stream_raw_limited(&viewtext_path, max_bytes);
            }
        }

        // 일반 문서: BodyText 스트림
        let bodytext_path = format!("/BodyText/Section{}", index);
        if self.has_stream(&bodytext_path) {
            let raw = self.read_stream_raw_limited(&bodytext_path, max_bytes)?;
            return if compressed {
                decompress_stream_limited(&raw, max_bytes)
            } else {
                Ok(raw)
            };
        }

        // 루트 레벨 Section (구버전 호환)
        let section_path = format!("/Section{}", index);
        if self.has_stream(&section_path) {
            let raw = self.read_stream_raw_limited(&section_path, max_bytes)?;
            return if compressed {
                decompress_stream_limited(&raw, max_bytes)
            } else {
                Ok(raw)
            };
        }

        Err(CfbError::StreamNotFound(format!("Section{}", index)))
    }

    /// BinData 스트림 읽기 (BinData/BIN{XXXX}.{ext})
    pub fn read_bin_data(&mut self, storage_name: &str) -> Result<Vec<u8>, CfbError> {
        let path = format!("/BinData/{}", storage_name);
        self.read_stream_raw(&path)
    }

    /// BinData 스트림을 `max_bytes` 바이트까지만 읽는다.
    pub fn read_bin_data_limited(
        &mut self,
        storage_name: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, CfbError> {
        let max_bytes = max_bytes.min(MAX_BINARY_BYTES);
        let path = format!("/BinData/{}", storage_name);
        if !self.compound.is_stream(&path) {
            return Err(CfbError::StreamNotFound(path));
        }
        let mut stream = self
            .compound
            .open_stream(&path)
            .map_err(|error| CfbError::StreamError(format!("{}: {}", path, error)))?;
        let mut data = Vec::new();
        stream
            .by_ref()
            .take((max_bytes as u64).saturating_add(1))
            .read_to_end(&mut data)
            .map_err(|error| CfbError::StreamError(format!("{}: {}", path, error)))?;
        if data.len() > max_bytes {
            return Err(CfbError::LimitExceeded(max_bytes));
        }
        Ok(data)
    }

    /// 본문 섹션 수 계산
    pub fn section_count(&self) -> u32 {
        let mut count = 0;
        loop {
            let has_body = self
                .compound
                .is_stream(&format!("/BodyText/Section{}", count));
            let has_view = self
                .compound
                .is_stream(&format!("/ViewText/Section{}", count));
            let has_root = self.compound.is_stream(&format!("/Section{}", count));

            if has_body || has_view || has_root {
                count += 1;
            } else {
                break;
            }
        }
        count
    }

    /// BinData 스토리지의 스트림 이름 목록
    pub fn list_bin_data(&self) -> Vec<String> {
        let mut names = Vec::new();
        // cfb 크레이트의 walk API로 BinData 하위 항목 탐색
        for entry in self.compound.walk() {
            let path = entry.path().to_string_lossy().replace('\\', "/");
            if path.starts_with("/BinData/") && entry.is_stream() {
                if let Some(name) = path.strip_prefix("/BinData/") {
                    names.push(name.to_string());
                }
            }
        }
        names
    }

    /// 모든 스트림 경로 목록
    pub fn list_streams(&self) -> Vec<String> {
        let mut paths = Vec::new();
        for entry in self.compound.walk() {
            if entry.is_stream() {
                paths.push(entry.path().to_string_lossy().replace('\\', "/"));
            }
        }
        paths
    }

    /// 모든 엔트리(스트림 + 스토리지) 경로와 크기 목록
    pub fn list_all_entries(&self) -> Vec<(String, u64, bool)> {
        let mut entries = Vec::new();
        for entry in self.compound.walk() {
            let path = entry.path().to_string_lossy().replace('\\', "/");
            let size = entry.len();
            let is_stream = entry.is_stream();
            entries.push((path, size, is_stream));
        }
        entries
    }

    /// 미리보기 이미지 스트림 읽기 (PrvImage)
    ///
    /// BMP 또는 GIF 형식의 썸네일 이미지를 반환한다.
    /// 스트림이 없으면 None을 반환한다.
    pub fn read_preview_image(&mut self) -> Option<Vec<u8>> {
        self.read_preview_image_limited(MAX_THUMBNAIL_BYTES)
    }

    pub fn read_preview_image_limited(&mut self, max_bytes: usize) -> Option<Vec<u8>> {
        if self.has_stream("/PrvImage") {
            self.read_stream_raw_limited("/PrvImage", max_bytes.min(MAX_THUMBNAIL_BYTES))
                .ok()
        } else {
            None
        }
    }

    /// 미리보기 텍스트 스트림 읽기 (PrvText)
    ///
    /// UTF-16LE 인코딩된 미리보기 텍스트를 반환한다.
    /// 스트림이 없으면 None을 반환한다.
    pub fn read_preview_text(&mut self) -> Option<String> {
        self.read_preview_text_limited(MAX_STRUCTURAL_BYTES)
    }

    pub fn read_preview_text_limited(&mut self, max_bytes: usize) -> Option<String> {
        if !self.has_stream("/PrvText") {
            return None;
        }

        let max_bytes = max_bytes.min(MAX_STRUCTURAL_BYTES);
        let data = self.read_stream_raw_limited("/PrvText", max_bytes).ok()?;

        // UTF-16LE 디코딩
        if data.len() < 2 {
            return None;
        }

        let mut text = String::with_capacity(data.len().min(max_bytes));
        for chunk in data.chunks_exact(2) {
            let code = u16::from_le_bytes([chunk[0], chunk[1]]);
            let Some(character) = char::from_u32(code as u32) else {
                continue;
            };
            if character.len_utf8() > max_bytes.saturating_sub(text.len()) {
                return None;
            }
            text.push(character);
        }

        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    /// [Task #1001] HWP3 → HWP5 변환본 식별 (휴리스틱).
    ///
    /// HwpSummaryInformation stream 의 text properties 안에 HWP3 시대 (1990-2003)
    /// 의 년 (예: "1998년") 이 포함되어 있으면 변환본으로 판정. 한컴이 HWP3 →
    /// HWP5 변환 시 원본 작성일 / 메모 등을 HwpSummary 의 string field 에 보존
    /// 하는 패턴을 활용.
    ///
    /// 변환본은 ParaShape spacing/margin 값이 HWP3 원본의 2배로 저장되어 있어
    /// 한컴 viewer 가 표시 시 1/2 보정 (HwpUnitChar 단위) 한다. rhwp 도 동일
    /// 보정을 위해 본 식별 신호 사용.
    ///
    /// Misid risk: HwpSummary 의 다른 field 가 우연히 HWP3 시대 년 포함 시
    /// false positive. 그러나 변환본이 아닌 일반 HWP5 의 ParaShape spacing 은
    /// 대부분 0 이라 1/2 보정 영향이 미미함 (시각 회귀 안전).
    pub fn detect_hwp3_variant(&mut self) -> bool {
        // HwpSummaryInformation stream 시도 (다양한 경로)
        let raw = self
            .read_stream_raw("/\u{0005}HwpSummaryInformation")
            .or_else(|_| self.read_stream_raw("\u{0005}HwpSummaryInformation"))
            .or_else(|_| self.read_stream_raw("HwpSummaryInformation"))
            .unwrap_or_default();
        if raw.len() < 16 {
            return false;
        }
        // UTF-16LE 디코딩
        let utf16: Vec<u16> = raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let s = String::from_utf16_lossy(&utf16);
        // HWP3 시대 (1990-2003) 의 년 검출 — HWP5 도입 (2007년) 이전
        (1990..=2003).any(|y| s.contains(&format!("{}년", y)))
    }
}

fn stream_limit(path: &str) -> usize {
    if path == "/PrvImage" || path.starts_with("/Preview/PrvImage") {
        MAX_THUMBNAIL_BYTES
    } else if path == "/FileHeader"
        || path == "/DocInfo"
        || path == "/PrvText"
        || path.starts_with("/BodyText/")
        || path.starts_with("/ViewText/")
        || path.starts_with("/Section")
    {
        MAX_STRUCTURAL_BYTES
    } else {
        MAX_BINARY_BYTES
    }
}

fn sector_range(data_len: usize, sid: u32, sector_size: usize) -> Option<(usize, usize)> {
    // Version 4 CFB pads its 512-byte header to the 4096-byte sector boundary.
    let start = (sid as usize).checked_add(1)?.checked_mul(sector_size)?;
    let end = start.checked_add(sector_size)?;
    (end <= data_len).then_some((start, end))
}

fn cfb_u32(data: &[u8], offset: usize) -> Result<u32, CfbError> {
    let bytes = data
        .get(offset..offset + 4)
        .ok_or_else(|| CfbError::OpenError("CFB 헤더가 잘렸습니다".into()))?;
    Ok(u32::from_le_bytes(
        bytes.try_into().expect("four-byte slice"),
    ))
}

/// Validate the CFB directory chain before handing bytes to the `cfb` crate.
/// That crate materializes every directory record while opening, so counting
/// only after `CompoundFile::open` is too late to prevent an allocation bomb.
pub(crate) fn validate_cfb_directory_entry_budget(data: &[u8]) -> Result<(), CfbError> {
    const END_OF_CHAIN: u32 = 0xFFFF_FFFE;
    const FREE_SECTOR: u32 = 0xFFFF_FFFF;
    // A 512 MiB v3 CFB needs fewer than 65 DIFAT sectors. Keep compatibility
    // slack for permissive legacy files while bounding the crate's DIFAT Vec.
    const MAX_CFB_DIFAT_SECTORS: usize = 128;
    const CFB_MAGIC: &[u8; 8] = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1";

    if data.len() < 512 || data.get(..8) != Some(CFB_MAGIC.as_slice()) {
        return Err(CfbError::OpenError(
            "CFB 헤더 또는 매직 넘버가 올바르지 않습니다".into(),
        ));
    }
    let sector_power = u16::from_le_bytes([data[30], data[31]]) as usize;
    if sector_power != 9 && sector_power != 12 {
        return Err(CfbError::OpenError(format!(
            "CFB 섹터 크기 지수가 사양 범위를 벗어남: {sector_power}"
        )));
    }
    let sector_size = 1usize << sector_power;
    if data.len() < sector_size {
        return Err(CfbError::OpenError("CFB 섹터 헤더가 잘렸습니다".into()));
    }
    let physical_sectors = data.len().div_ceil(sector_size).saturating_sub(1);
    let entries_per_fat_sector = sector_size / 4;
    let declared_fat_sectors = cfb_u32(data, 44)? as usize;
    let maximum_useful_fat_sectors = physical_sectors.div_ceil(entries_per_fat_sector);
    if declared_fat_sectors
        > maximum_useful_fat_sectors.saturating_add(CFB_FAT_COMPAT_SLACK_SECTORS)
    {
        return Err(CfbError::OpenError(format!(
            "CFB declares {declared_fat_sectors} FAT sectors, but {maximum_useful_fat_sectors} can index this file"
        )));
    }

    let mut fat_sector_ids = Vec::with_capacity(declared_fat_sectors.min(109));
    let mut seen_fat_sectors = std::collections::HashSet::new();
    for index in 0..109 {
        if fat_sector_ids.len() == declared_fat_sectors {
            break;
        }
        let sid = cfb_u32(data, 76 + index * 4)?;
        if sid == FREE_SECTOR || sid == END_OF_CHAIN {
            continue;
        }
        if sid as usize >= physical_sectors || !seen_fat_sectors.insert(sid) {
            return Err(CfbError::OpenError(
                "CFB DIFAT에 잘못된 FAT 섹터가 있습니다".into(),
            ));
        }
        fat_sector_ids.push(sid);
    }

    let declared_difat_sectors = cfb_u32(data, 72)? as usize;
    if declared_difat_sectors > MAX_CFB_DIFAT_SECTORS {
        return Err(CfbError::OpenError(
            "CFB DIFAT 섹터 수가 안전 상한을 초과했습니다".into(),
        ));
    }
    let mut difat_sid = cfb_u32(data, 68)?;
    let mut seen_difat_sectors = std::collections::HashSet::new();
    while difat_sid != END_OF_CHAIN && difat_sid != FREE_SECTOR {
        if seen_difat_sectors.len() >= MAX_CFB_DIFAT_SECTORS {
            return Err(CfbError::OpenError(
                "CFB DIFAT 체인이 안전 상한을 초과했습니다".into(),
            ));
        }
        if !seen_difat_sectors.insert(difat_sid) {
            return Err(CfbError::OpenError(
                "CFB DIFAT 체인에 순환이 있습니다".into(),
            ));
        }
        let (offset, _) = sector_range(data.len(), difat_sid, sector_size)
            .ok_or_else(|| CfbError::OpenError("CFB DIFAT 섹터가 파일 밖을 가리킵니다".into()))?;
        for index in 0..entries_per_fat_sector - 1 {
            if fat_sector_ids.len() == declared_fat_sectors {
                break;
            }
            let sid = cfb_u32(data, offset + index * 4)?;
            if sid == FREE_SECTOR || sid == END_OF_CHAIN {
                continue;
            }
            if sid as usize >= physical_sectors || !seen_fat_sectors.insert(sid) {
                return Err(CfbError::OpenError(
                    "CFB DIFAT에 잘못된 FAT 섹터가 있습니다".into(),
                ));
            }
            fat_sector_ids.push(sid);
        }
        difat_sid = cfb_u32(data, offset + sector_size - 4)?;
    }
    if fat_sector_ids.len() != declared_fat_sectors {
        return Err(CfbError::OpenError(
            "CFB FAT 섹터 목록이 불완전합니다".into(),
        ));
    }

    let next_sector = |sid: u32| -> Result<u32, CfbError> {
        let entry_index = sid as usize;
        let fat_list_index = entry_index / entries_per_fat_sector;
        let fat_sid = *fat_sector_ids
            .get(fat_list_index)
            .ok_or_else(|| CfbError::OpenError("CFB 디렉터리 FAT 엔트리가 없습니다".into()))?;
        let (fat_offset, _) = sector_range(data.len(), fat_sid, sector_size)
            .ok_or_else(|| CfbError::OpenError("CFB FAT 섹터가 파일 밖을 가리킵니다".into()))?;
        cfb_u32(
            data,
            fat_offset + (entry_index % entries_per_fat_sector) * 4,
        )
    };

    let entries_per_directory_sector = sector_size / 128;
    let mut directory_sid = cfb_u32(data, 48)?;
    let mut directory_entries = 0usize;
    let mut seen_directory_sectors = std::collections::HashSet::new();
    while directory_sid != END_OF_CHAIN && directory_sid != FREE_SECTOR {
        if directory_sid as usize >= physical_sectors
            || !seen_directory_sectors.insert(directory_sid)
        {
            return Err(CfbError::OpenError(
                "CFB 디렉터리 체인이 잘못되었습니다".into(),
            ));
        }
        directory_entries = directory_entries.saturating_add(entries_per_directory_sector);
        if directory_entries > MAX_CFB_DIRECTORY_ENTRIES {
            return Err(CfbError::DirectoryEntryLimitExceeded {
                actual: directory_entries,
                limit: MAX_CFB_DIRECTORY_ENTRIES,
            });
        }
        directory_sid = next_sector(directory_sid)?;
    }
    Ok(())
}

/// Lenient CFB 리더 (FAT 검증 무시)
///
/// HWP 프로그램이 생성하는 일부 CFB 파일은 표준 cfb 크레이트의
/// FAT 검증("sector 0 pointed to twice")을 통과하지 못한다.
/// 이 구현체는 FAT 중복을 무시하고 스트림을 추출한다.
pub struct LenientCfbReader {
    data: Arc<[u8]>,
    sector_size: usize,
    /// Directory entries: (name, start_sector, size, obj_type)
    entries: Vec<(String, u32, u64, u8)>,
    /// FAT table
    fat: Vec<u32>,
    /// Mini-stream data
    mini_stream: Vec<u8>,
    /// Mini-FAT table
    mini_fat: Vec<u32>,
    /// Mini-stream cutoff size
    mini_stream_cutoff: u32,
}

impl LenientCfbReader {
    const END_OF_CHAIN: u32 = 0xFFFFFFFE;
    const FREE_SECT: u32 = 0xFFFFFFFF;

    pub fn open(data: &[u8]) -> Result<Self, CfbError> {
        Self::open_shared(Arc::from(data))
    }

    pub(crate) fn open_shared(data: Arc<[u8]>) -> Result<Self, CfbError> {
        if data.len() as u64 > MAX_CONTAINER_BYTES {
            return Err(CfbError::LimitExceeded(MAX_CONTAINER_BYTES as usize));
        }
        validate_cfb_directory_entry_budget(&data)?;
        if data.len() < 512 {
            return Err(CfbError::OpenError("파일이 너무 작음".into()));
        }
        // Magic number 확인
        if &data[0..8] != b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" {
            return Err(CfbError::OpenError("CFB 매직 넘버 불일치".into()));
        }

        // 섹터 크기 지수는 파일에서 온 값(0~65535)이라 검증 없이 shift 하면 안 된다.
        // - power >= 64(wasm32 에서는 >= 32): `1usize << power` 가 shift overflow.
        //   debug 는 패닉, release 는 마스킹돼 엉뚱한 sector_size 가 된다.
        // - power 가 0·1 이면 sector_size 가 1·2 라 아래 DIFAT 순회의
        //   `sector_size / 4 - 1` 이 언더플로한다(debug 패닉, release 는 usize::MAX 로
        //   감싸져 곧바로 슬라이스 범위 초과 패닉).
        // CFB 사양상 섹터 크기는 512B(9) 또는 4096B(12)이므로 그 범위를 벗어나면
        // 해석을 포기하고 Err 를 돌려준다. 패닉은 WASM 모듈 전체를 죽여 편집 중인
        // 다른 문서까지 잃게 하므로, 열기 실패로 처리하는 편이 언제나 낫다.
        let sector_size_power = u16::from_le_bytes([data[30], data[31]]) as usize;
        if !(9..=12).contains(&sector_size_power) {
            return Err(CfbError::OpenError(format!(
                "CFB 섹터 크기 지수가 사양 범위를 벗어남: {sector_size_power}"
            )));
        }
        let sector_size = 1usize << sector_size_power;
        let mini_sector_size_power = u16::from_le_bytes([data[32], data[33]]) as usize;
        if mini_sector_size_power >= usize::BITS as usize {
            return Err(CfbError::OpenError(format!(
                "CFB 미니 섹터 크기 지수가 사양 범위를 벗어남: {mini_sector_size_power}"
            )));
        }
        let _mini_sector_size = 1usize << mini_sector_size_power;

        let fat_sectors_count =
            u32::from_le_bytes([data[44], data[45], data[46], data[47]]) as usize;
        let first_dir_sector = u32::from_le_bytes([data[48], data[49], data[50], data[51]]);
        let mini_stream_cutoff = u32::from_le_bytes([data[56], data[57], data[58], data[59]]);
        let first_mini_fat_sector = u32::from_le_bytes([data[60], data[61], data[62], data[63]]);
        let mini_fat_sectors_count =
            u32::from_le_bytes([data[64], data[65], data[66], data[67]]) as usize;
        let first_difat_sector = u32::from_le_bytes([data[68], data[69], data[70], data[71]]);
        let difat_sectors_count =
            u32::from_le_bytes([data[72], data[73], data[74], data[75]]) as usize;
        let physical_sectors = data.len().div_ceil(sector_size).saturating_sub(1);
        let fat_entries_per_sector = sector_size / 4;
        let max_fat_sectors = physical_sectors.div_ceil(fat_entries_per_sector);
        if fat_sectors_count > max_fat_sectors.saturating_add(CFB_FAT_COMPAT_SLACK_SECTORS) {
            return Err(CfbError::OpenError(format!(
                "CFB declares {fat_sectors_count} FAT sectors, but {max_fat_sectors} can index this file"
            )));
        }

        // DIFAT 읽기: 헤더의 109개 + 추가 DIFAT 섹터
        //
        // [정적분석] 유효한 CFB 파일은 각 FAT 섹터 id 를 DIFAT 에 한 번만 기재한다
        // (섹터마다 파일의 서로 다른 영역을 담당하므로). 이 불변식을 검증 없이 신뢰하면,
        // 조작된 파일이 같은 id 를 반복 기재해 물리 섹터 1개만으로 FAT 벡터를
        // 반복 횟수에 비례해(최대 DIFAT 섹터 수 × 섹터당 엔트리 수) 부풀릴 수 있다
        // (#3181 순환 미탐지와 같은 클래스 — "카운트 필드를 무검증으로 반복 사용"하는
        // DoS 증폭). visited_fat_sids 로 중복 id 를 조용히 건너뛴다.
        let mut fat_sector_ids = Vec::new();
        let mut visited_fat_sids = std::collections::HashSet::new();
        for i in 0..109.min(fat_sectors_count) {
            let off = 76 + i * 4;
            let sid = u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
            if sid != Self::FREE_SECT && sid != Self::END_OF_CHAIN && visited_fat_sids.insert(sid) {
                fat_sector_ids.push(sid);
            }
        }
        // 추가 DIFAT 섹터 체인
        if difat_sectors_count > 0 && first_difat_sector != Self::END_OF_CHAIN {
            let mut dsid = first_difat_sector;
            // difat_sectors_count 는 파일 헤더에서 그대로 읽은 값(공격자 통제 가능)이라,
            // 실제 섹터 체인이 짧은 순환을 이뤄도 최대 u32::MAX 번 순회할 수 있다.
            // FAT/미니FAT 체인 순회(read_chain_static)처럼 방문 집합으로 순환을 조기 차단한다.
            let mut visited_difat = std::collections::HashSet::new();
            for _ in 0..difat_sectors_count {
                if !visited_difat.insert(dsid) {
                    break;
                }
                let Some((off, _)) = sector_range(data.len(), dsid, sector_size) else {
                    break;
                };
                let entries_per = sector_size / 4 - 1;
                for i in 0..entries_per {
                    let eoff = off + i * 4;
                    let sid = u32::from_le_bytes([
                        data[eoff],
                        data[eoff + 1],
                        data[eoff + 2],
                        data[eoff + 3],
                    ]);
                    if sid != Self::FREE_SECT
                        && sid != Self::END_OF_CHAIN
                        && visited_fat_sids.insert(sid)
                    {
                        fat_sector_ids.push(sid);
                    }
                }
                // 다음 DIFAT 섹터
                let next_off = off + entries_per * 4;
                dsid = u32::from_le_bytes([
                    data[next_off],
                    data[next_off + 1],
                    data[next_off + 2],
                    data[next_off + 3],
                ]);
                if dsid == Self::END_OF_CHAIN || dsid == Self::FREE_SECT {
                    break;
                }
            }
        }

        // FAT 빌드
        let mut fat = Vec::new();
        for &fsid in &fat_sector_ids {
            let Some((off, _)) = sector_range(data.len(), fsid, sector_size) else {
                continue;
            };
            let entries = sector_size / 4;
            for i in 0..entries {
                let eoff = off + i * 4;
                fat.push(u32::from_le_bytes([
                    data[eoff],
                    data[eoff + 1],
                    data[eoff + 2],
                    data[eoff + 3],
                ]));
            }
        }
        drop(fat_sector_ids);
        drop(visited_fat_sids);

        // Directory entries 읽기
        let dir_data = Self::read_chain_static_limited(
            &data,
            &fat,
            first_dir_sector,
            sector_size,
            MAX_CFB_DIRECTORY_ENTRIES * 128,
        );
        let mut entries = Vec::new();
        let entry_size = 128;
        let n_entries = dir_data.len() / entry_size;
        for i in 0..n_entries {
            let eoff = i * entry_size;
            // name_len 도 파일에서 온 값(0~65535)이다. 이름 필드는 엔트리 선두 64바이트이므로
            // 그보다 큰 값은 손상으로 보고 잘라낸다. 잘라내지 않으면 아래 슬라이스가
            // dir_data(= n_entries * 128 바이트) 범위를 넘어 패닉한다 — 슬라이스 경계 검사는
            // release 에서도 켜져 있어 배포 WASM 에서도 그대로 터진다.
            let name_len =
                (u16::from_le_bytes([dir_data[eoff + 64], dir_data[eoff + 65]]) as usize).min(64);
            let name = if name_len > 2 {
                let name_bytes = &dir_data[eoff..eoff + name_len - 2]; // UTF-16LE, exclude null
                String::from_utf16_lossy(
                    &name_bytes
                        .chunks(2)
                        .map(|c| u16::from_le_bytes([c[0], c.get(1).copied().unwrap_or(0)]))
                        .collect::<Vec<_>>(),
                )
            } else {
                String::new()
            };
            let obj_type = dir_data[eoff + 66];
            let start_sector = u32::from_le_bytes([
                dir_data[eoff + 116],
                dir_data[eoff + 117],
                dir_data[eoff + 118],
                dir_data[eoff + 119],
            ]);
            let size = u64::from_le_bytes([
                dir_data[eoff + 120],
                dir_data[eoff + 121],
                dir_data[eoff + 122],
                dir_data[eoff + 123],
                dir_data[eoff + 124],
                dir_data[eoff + 125],
                dir_data[eoff + 126],
                dir_data[eoff + 127],
            ]);

            if obj_type == 1 || obj_type == 2 || obj_type == 5 {
                entries.push((name, start_sector, size, obj_type));
            }
        }
        drop(dir_data);

        // Mini-FAT 빌드
        let mut mini_fat = Vec::new();
        if mini_fat_sectors_count > 0 && first_mini_fat_sector != Self::END_OF_CHAIN {
            let mfat_data =
                Self::read_chain_static(&data, &fat, first_mini_fat_sector, sector_size);
            for chunk in mfat_data.chunks(4) {
                if chunk.len() == 4 {
                    mini_fat.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
                }
            }
        }

        // Mini-stream: Root entry의 스트림 데이터
        let mini_stream = if !entries.is_empty() && entries[0].3 == 5 {
            let root_size = usize::try_from(entries[0].2)
                .unwrap_or(MAX_BINARY_BYTES)
                .min(MAX_BINARY_BYTES);
            Self::read_chain_static_limited(&data, &fat, entries[0].1, sector_size, root_size)
        } else {
            Vec::new()
        };

        let reader = LenientCfbReader {
            data,
            sector_size,
            entries,
            fat,
            mini_stream,
            mini_fat,
            mini_stream_cutoff,
        };
        reader.validate_stream_budget()?;
        Ok(reader)
    }

    fn read_chain_static(data: &[u8], fat: &[u32], start: u32, sector_size: usize) -> Vec<u8> {
        Self::read_chain_static_limited(data, fat, start, sector_size, data.len())
    }

    fn read_chain_static_limited(
        data: &[u8],
        fat: &[u32],
        start: u32,
        sector_size: usize,
        max_bytes: usize,
    ) -> Vec<u8> {
        let mut result = Vec::with_capacity(max_bytes.min(data.len()).min(1024 * 1024));
        let mut sid = start;
        let mut visited = std::collections::HashSet::new();
        while result.len() < max_bytes && sid != Self::END_OF_CHAIN && sid != Self::FREE_SECT {
            if !visited.insert(sid) {
                break;
            } // 순환 방지
            let Some((off, end)) = sector_range(data.len(), sid, sector_size) else {
                break;
            };
            let take = (max_bytes - result.len()).min(end - off);
            result.extend_from_slice(&data[off..off + take]);
            if (sid as usize) < fat.len() {
                sid = fat[sid as usize];
            } else {
                break;
            }
        }
        result
    }

    fn read_mini_stream(&self, start: u32, size: u64) -> Vec<u8> {
        let mini_sector_size = 64usize;
        let max_bytes = usize::try_from(size)
            .unwrap_or(MAX_BINARY_BYTES)
            .min(MAX_BINARY_BYTES);
        let mut result = Vec::with_capacity(max_bytes.min(1024 * 1024));
        let mut sid = start;
        let mut visited = std::collections::HashSet::new();
        while result.len() < max_bytes && sid != Self::END_OF_CHAIN && sid != Self::FREE_SECT {
            if !visited.insert(sid) {
                break;
            }
            let Some(off) = (sid as usize).checked_mul(mini_sector_size) else {
                break;
            };
            let Some(end) = off.checked_add(mini_sector_size) else {
                break;
            };
            if end > self.mini_stream.len() {
                break;
            }
            let take = (max_bytes - result.len()).min(mini_sector_size);
            result.extend_from_slice(&self.mini_stream[off..off + take]);
            if (sid as usize) < self.mini_fat.len() {
                sid = self.mini_fat[sid as usize];
            } else {
                break;
            }
        }
        result
    }

    /// 디렉토리 경로로 스트림 내용을 가져온다.
    /// 경로 형식: "FileHeader", "DocInfo", "BodyText/Section0" 등
    fn find_entry_idx(&self, path: &str) -> Option<usize> {
        // 경로 "/" 제거 및 트리 탐색 단순화: 이름으로 검색
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        if parts.is_empty() {
            return None;
        }

        // 간단한 DFS - directory entries가 Red-Black 트리이므로
        // child_id/sibling을 써야 하지만, 이름 기반 단순 매칭으로 충분
        // (HWP 파일은 스트림이 많지 않음)
        let target_name = if parts.len() == 1 {
            parts[0].to_string()
        } else {
            // 마지막 세그먼트를 이름으로 사용
            parts.last().unwrap().to_string()
        };

        // 정확한 경로 매칭이 필요하면 트리 탐색해야 하지만,
        // HWP에서는 이름이 유일하므로 단순 매칭
        self.entries
            .iter()
            .position(|(name, _, _, _)| name == &target_name)
    }

    fn validate_stream_budget(&self) -> Result<(), CfbError> {
        let mut total = 0u64;
        for (name, _, size, obj_type) in &self.entries {
            if *obj_type != 2 {
                continue;
            }
            let limit = stream_limit(&format!("/{name}")) as u64;
            if *size > limit {
                return Err(CfbError::LimitExceeded(limit as usize));
            }
            total = total
                .checked_add(*size)
                .ok_or(CfbError::LimitExceeded(MAX_CONTAINER_BYTES as usize))?;
            if total > MAX_CONTAINER_BYTES {
                return Err(CfbError::LimitExceeded(MAX_CONTAINER_BYTES as usize));
            }
        }
        Ok(())
    }

    pub fn read_stream(&self, path: &str) -> Result<Vec<u8>, CfbError> {
        self.read_stream_limited(path, stream_limit(path))
    }

    pub fn read_stream_limited(&self, path: &str, max_bytes: usize) -> Result<Vec<u8>, CfbError> {
        let max_bytes = max_bytes.min(stream_limit(path));
        let idx = self
            .find_entry_idx(path)
            .ok_or_else(|| CfbError::StreamNotFound(path.to_string()))?;
        let (_, start, size, obj_type) = &self.entries[idx];
        if *obj_type != 2 {
            return Err(CfbError::StreamError(format!(
                "{}: 스트림이 아님 (type={})",
                path, obj_type
            )));
        }
        if *size > max_bytes as u64 {
            return Err(CfbError::LimitExceeded(max_bytes));
        }
        let size = usize::try_from(*size).map_err(|_| CfbError::LimitExceeded(max_bytes))?;

        if size < self.mini_stream_cutoff as usize {
            Ok(self.read_mini_stream(*start, size as u64))
        } else {
            Ok(Self::read_chain_static_limited(
                &self.data,
                &self.fat,
                *start,
                self.sector_size,
                size,
            ))
        }
    }

    pub fn has_stream(&self, path: &str) -> bool {
        self.find_entry_idx(path).is_some()
    }

    pub fn read_doc_info(&self, compressed: bool) -> Result<Vec<u8>, CfbError> {
        self.read_doc_info_limited(compressed, MAX_STRUCTURAL_BYTES)
    }

    pub fn read_doc_info_limited(
        &self,
        compressed: bool,
        max_bytes: usize,
    ) -> Result<Vec<u8>, CfbError> {
        let max_bytes = max_bytes.min(MAX_STRUCTURAL_BYTES);
        let raw = self.read_stream_limited("DocInfo", max_bytes)?;
        if compressed {
            decompress_stream_limited(&raw, max_bytes)
        } else {
            Ok(raw)
        }
    }

    pub fn read_body_text_section(
        &self,
        index: u32,
        compressed: bool,
    ) -> Result<Vec<u8>, CfbError> {
        self.read_body_text_section_limited(index, compressed, MAX_STRUCTURAL_BYTES)
    }

    pub fn read_body_text_section_limited(
        &self,
        index: u32,
        compressed: bool,
        max_bytes: usize,
    ) -> Result<Vec<u8>, CfbError> {
        let max_bytes = max_bytes.min(MAX_STRUCTURAL_BYTES);
        let name = format!("Section{}", index);
        let raw = self.read_stream_limited(&name, max_bytes)?;
        if compressed {
            decompress_stream_limited(&raw, max_bytes)
        } else {
            Ok(raw)
        }
    }

    pub fn list_entries(&self) -> &[(String, u32, u64, u8)] {
        &self.entries
    }

    /// FileHeader 스트림 읽기 (256바이트, 항상 비압축)
    pub fn read_file_header(&self) -> Result<Vec<u8>, CfbError> {
        self.read_file_header_limited(MAX_STRUCTURAL_BYTES)
    }

    pub fn read_file_header_limited(&self, max_bytes: usize) -> Result<Vec<u8>, CfbError> {
        self.read_stream_limited("FileHeader", max_bytes)
    }

    /// 본문 섹션 스트림 읽기 (배포용 ViewText 지원)
    pub fn read_body_text_section_full(
        &self,
        index: u32,
        compressed: bool,
        distribution: bool,
    ) -> Result<Vec<u8>, CfbError> {
        self.read_body_text_section_full_limited(
            index,
            compressed,
            distribution,
            MAX_STRUCTURAL_BYTES,
        )
    }

    pub fn read_body_text_section_full_limited(
        &self,
        index: u32,
        compressed: bool,
        distribution: bool,
        max_bytes: usize,
    ) -> Result<Vec<u8>, CfbError> {
        let max_bytes = max_bytes.min(MAX_STRUCTURAL_BYTES);
        if distribution {
            let viewtext_name = format!("Section{}", index);
            // ViewText 하위 스트림 탐색
            if self.has_stream(&viewtext_name) {
                return self.read_stream_limited(&viewtext_name, max_bytes);
            }
        }

        let name = format!("Section{}", index);
        let raw = self.read_stream_limited(&name, max_bytes)?;
        if compressed {
            decompress_stream_limited(&raw, max_bytes)
        } else {
            Ok(raw)
        }
    }

    /// 본문 섹션 수 계산
    pub fn section_count(&self) -> u32 {
        let mut count = 0u32;
        loop {
            let name = format!("Section{}", count);
            if self.entries.iter().any(|(n, _, _, _)| n == &name) {
                count += 1;
            } else {
                break;
            }
        }
        count
    }
}

/// zlib/deflate 압축 해제
///
/// HWP는 raw deflate (wbits=-15) 사용. 실패 시 표준 zlib도 시도.
pub fn decompress_stream(data: &[u8]) -> Result<Vec<u8>, CfbError> {
    decompress_stream_limited(data, MAX_BINARY_BYTES)
}

/// zlib/raw-deflate 데이터를 `max_bytes` 바이트까지만 압축 해제한다.
pub fn decompress_stream_limited(data: &[u8], max_bytes: usize) -> Result<Vec<u8>, CfbError> {
    let max_bytes = max_bytes.min(MAX_BINARY_BYTES);
    fn decode_limited<R: Read>(reader: R, max_bytes: usize) -> Result<Vec<u8>, CfbError> {
        let mut output = Vec::new();
        reader
            .take((max_bytes as u64).saturating_add(1))
            .read_to_end(&mut output)
            .map_err(|error| CfbError::DecompressError(error.to_string()))?;
        if output.len() > max_bytes {
            return Err(CfbError::LimitExceeded(max_bytes));
        }
        Ok(output)
    }

    let raw_result = decode_limited(flate2::read::DeflateDecoder::new(data), max_bytes);
    if let Ok(output) = raw_result {
        return Ok(output);
    }
    let raw_exceeded = matches!(raw_result, Err(CfbError::LimitExceeded(_)));

    match decode_limited(flate2::read::ZlibDecoder::new(data), max_bytes) {
        Ok(output) => Ok(output),
        Err(CfbError::LimitExceeded(_)) => Err(CfbError::LimitExceeded(max_bytes)),
        Err(_) if raw_exceeded => Err(CfbError::LimitExceeded(max_bytes)),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── LenientCfbReader 헤더 필드 검증 ──────────────────────────────────
    //
    // LenientCfbReader 는 엄격 파서가 실패한 뒤에만 쓰인다(parser/mod.rs). 즉 입력 모집단이
    // "이미 손상이 확인된 파일"이라, 헤더 필드에 쓰레기 값이 들어있을 확률이 가장 높은
    // 자리다. 그런데 파일에서 온 값을 검증 없이 shift/슬라이스에 쓰고 있었다.
    // WASM 에서 패닉은 모듈 전체를 트랩시켜 편집 중이던 다른 문서까지 잃게 하므로,
    // 해석 불가한 헤더는 패닉이 아니라 Err 로 돌려줘야 한다.

    /// 최소 CFB 헤더(512B). 섹터 크기 512B, DIFAT/디렉터리 없음.
    fn minimal_header() -> Vec<u8> {
        let mut d = vec![0u8; 512];
        d[0..8].copy_from_slice(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
        d[30..32].copy_from_slice(&9u16.to_le_bytes()); // sector size = 1 << 9
        d[32..34].copy_from_slice(&6u16.to_le_bytes()); // mini sector size = 1 << 6
        d[68..72].copy_from_slice(&0xFFFF_FFFEu32.to_le_bytes()); // first DIFAT = EOC
        d
    }

    #[test]
    fn strict_and_lenient_open_reject_directory_entry_bombs_before_parsing() {
        let sector_size = 512usize;
        let entries_per_directory_sector = sector_size / 128;
        let directory_sector_count = MAX_CFB_DIRECTORY_ENTRIES / entries_per_directory_sector + 1;
        let physical_sector_count = directory_sector_count + 9;
        let mut data = minimal_header();
        data.resize((physical_sector_count + 1) * sector_size, 0);
        data[44..48].copy_from_slice(&9u32.to_le_bytes());
        data[48..52].copy_from_slice(&9u32.to_le_bytes());
        for fat_index in 0..9usize {
            data[76 + fat_index * 4..80 + fat_index * 4]
                .copy_from_slice(&(fat_index as u32).to_le_bytes());
            let fat_offset = (fat_index + 1) * sector_size;
            data[fat_offset..fat_offset + sector_size].fill(0xFF);
        }
        for index in 0..directory_sector_count {
            let sid = 9 + index;
            let next = if index + 1 == directory_sector_count {
                LenientCfbReader::END_OF_CHAIN
            } else {
                (sid + 1) as u32
            };
            let fat_sector = sid / (sector_size / 4);
            let fat_offset = (fat_sector + 1) * sector_size + (sid % (sector_size / 4)) * 4;
            data[fat_offset..fat_offset + 4].copy_from_slice(&next.to_le_bytes());
        }

        assert!(matches!(
            CfbReader::open(&data),
            Err(CfbError::DirectoryEntryLimitExceeded { limit, .. })
                if limit == MAX_CFB_DIRECTORY_ENTRIES
        ));
        assert!(matches!(
            LenientCfbReader::open(&data),
            Err(CfbError::DirectoryEntryLimitExceeded { limit, .. })
                if limit == MAX_CFB_DIRECTORY_ENTRIES
        ));
    }

    #[test]
    fn lenient_open_rejects_out_of_range_sector_size_power() {
        // power >= 64 는 `1usize << power` 가 shift overflow(debug 패닉 / release 마스킹).
        let mut d = minimal_header();
        d[30..32].copy_from_slice(&64u16.to_le_bytes());
        assert!(
            LenientCfbReader::open(&d).is_err(),
            "shift overflow 대신 Err 이어야 함"
        );

        // power 0·1 은 sector_size 가 1·2 라 DIFAT 순회의 `sector_size / 4 - 1` 이 언더플로.
        for bad in [0u16, 1u16] {
            let mut d = minimal_header();
            d[30..32].copy_from_slice(&bad.to_le_bytes());
            d[68..72].copy_from_slice(&0u32.to_le_bytes()); // DIFAT 체인 진입
            d[72..76].copy_from_slice(&1u32.to_le_bytes());
            assert!(
                LenientCfbReader::open(&d).is_err(),
                "sector_size_power={bad} 에서 언더플로 대신 Err 이어야 함"
            );
        }
    }

    #[test]
    fn lenient_open_rejects_out_of_range_mini_sector_size_power() {
        let mut d = minimal_header();
        d[32..34].copy_from_slice(&64u16.to_le_bytes());
        assert!(
            LenientCfbReader::open(&d).is_err(),
            "shift overflow 대신 Err 이어야 함"
        );
    }

    #[test]
    fn lenient_open_rejects_impossible_fat_count_before_allocating() {
        let mut d = minimal_header();
        d[44..48].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(
            LenientCfbReader::open(&d),
            Err(CfbError::OpenError(message)) if message.contains("FAT sectors")
        ));
    }

    #[test]
    fn sector_offsets_use_checked_arithmetic_and_physical_bounds() {
        assert_eq!(sector_range(1024, 0, 512), Some((512, 1024)));
        assert_eq!(sector_range(1024, 1, 512), None);
        assert_eq!(sector_range(1024, u32::MAX, 4096), None);
    }

    #[test]
    fn lenient_stream_read_stops_at_declared_size_not_chain_length() {
        let mut data = vec![0u8; 512 + 3 * 512];
        data[512] = 0xAB;
        let reader = LenientCfbReader {
            data: Arc::from(data),
            sector_size: 512,
            entries: vec![("Payload".to_string(), 0, 1, 2)],
            fat: vec![1, 2, LenientCfbReader::END_OF_CHAIN],
            mini_stream: Vec::new(),
            mini_fat: Vec::new(),
            mini_stream_cutoff: 0,
        };

        assert_eq!(reader.read_stream("Payload").unwrap(), vec![0xAB]);
    }

    #[test]
    fn lenient_open_survives_oversized_directory_entry_name_len() {
        // 디렉터리 섹터까지 도달하는 최소 컨테이너.
        // 레이아웃: [0]=헤더 512B, [512]=FAT 섹터, [1024]=디렉터리 섹터
        let mut d = minimal_header();
        d[44..48].copy_from_slice(&1u32.to_le_bytes()); // FAT 섹터 1개
        d[48..52].copy_from_slice(&1u32.to_le_bytes()); // 디렉터리 시작 = 섹터 1
        d[76..80].copy_from_slice(&0u32.to_le_bytes()); // DIFAT[0] = FAT 은 섹터 0
        d.resize(512 * 3, 0);

        // FAT(섹터 0): 엔트리 1 = END_OF_CHAIN → 디렉터리 체인은 한 섹터로 끝난다.
        d[512 + 4..512 + 8].copy_from_slice(&0xFFFF_FFFEu32.to_le_bytes());

        // 디렉터리(섹터 1)의 첫 엔트리 name_len 을 최대값으로 손상시킨다.
        // 잘라내지 않으면 dir_data(512B) 범위를 한참 넘겨 슬라이스해 패닉한다.
        d[1024 + 64..1024 + 66].copy_from_slice(&0xFFFFu16.to_le_bytes());

        let r = LenientCfbReader::open(&d);
        assert!(r.is_ok(), "손상된 name_len 에서 패닉 없이 열려야 함");
    }

    #[test]
    fn lenient_open_terminates_on_cyclic_difat_chain() {
        // DIFAT 확장 체인은 header 의 difat_sectors_count(공격자 통제 가능한 4바이트) 만큼
        // 순회하되, FAT 체인 순회(read_chain_static)와 달리 방문 집합이 없다. 두 DIFAT
        // 섹터가 서로를 가리키는 순환을 만들고 difat_sectors_count 를 u32::MAX 로 두면,
        // 실제 체인 길이(2)와 무관하게 최대 40억 회 넘게 순회해 사실상 멈추지 않는다 —
        // 단일 스레드 WASM 에서는 탭 전체가 응답 없음 상태가 된다.
        let mut d = minimal_header();
        d[44..48].copy_from_slice(&0u32.to_le_bytes()); // fat_sectors_count = 0
        d[68..72].copy_from_slice(&0u32.to_le_bytes()); // first_difat_sector = 섹터 0
        d[72..76].copy_from_slice(&u32::MAX.to_le_bytes()); // difat_sectors_count: 공격자 제어

        // 헤더(512B) 뒤에 DIFAT 섹터 2개(섹터 0, 섹터 1)를 배치.
        d.resize(512 + 512 * 2, 0);
        let entries_per = 512 / 4 - 1; // 127
                                       // 모든 FAT-포인터 엔트리는 FREE_SECT 로 채워 fat_sector_ids 가 자라지 않게 한다
                                       // (순환 자체와 무관한 메모리 팽창을 피하기 위함).
        for sector_idx in 0..2usize {
            let base = 512 + sector_idx * 512;
            for i in 0..entries_per {
                let eoff = base + i * 4;
                d[eoff..eoff + 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
            }
        }
        // 섹터 0 의 "다음 DIFAT" 포인터 = 섹터 1
        let next0 = 512 + entries_per * 4;
        d[next0..next0 + 4].copy_from_slice(&1u32.to_le_bytes());
        // 섹터 1 의 "다음 DIFAT" 포인터 = 섹터 0 (순환!)
        let next1 = 512 + 512 + entries_per * 4;
        d[next1..next1 + 4].copy_from_slice(&0u32.to_le_bytes());

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = LenientCfbReader::open(&d);
            let _ = tx.send(());
        });
        assert!(
            rx.recv_timeout(std::time::Duration::from_secs(3)).is_ok(),
            "순환 DIFAT 체인에서 방문 집합 없이 difat_sectors_count 만큼 순회해 반환하지 않음"
        );
    }

    #[test]
    fn lenient_open_deduplicates_fat_sector_id_from_difat() {
        // Header DIFAT과 추가 DIFAT가 같은 FAT sector 0을 가리키는 손상 CFB.
        // 물리 FAT은 한 섹터이므로 결과 fat도 512 / 4 엔트리여야 한다.
        let mut d = minimal_header();
        d[44..48].copy_from_slice(&1u32.to_le_bytes()); // FAT sector 수
        d[48..52].copy_from_slice(&0xFFFF_FFFEu32.to_le_bytes()); // directory = EOC
        d[68..72].copy_from_slice(&1u32.to_le_bytes()); // 추가 DIFAT = sector 1
        d[72..76].copy_from_slice(&1u32.to_le_bytes());
        d[76..80].copy_from_slice(&0u32.to_le_bytes()); // header FAT = sector 0
        d.resize(512 + 512 * 2, 0);

        let difat_off = 512 + 512;
        let entries_per = 512 / 4 - 1;
        for i in 0..entries_per {
            let off = difat_off + i * 4;
            d[off..off + 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        }
        d[difat_off..difat_off + 4].copy_from_slice(&0u32.to_le_bytes()); // duplicate FAT
        let next_difat = difat_off + entries_per * 4;
        d[next_difat..next_difat + 4].copy_from_slice(&0xFFFF_FFFEu32.to_le_bytes());

        let reader = LenientCfbReader::open(&d).expect("손상 CFB도 lenient reader가 열어야 함");
        assert_eq!(
            reader.fat.len(),
            512 / 4,
            "중복 FAT sector를 한 번만 읽어야 함"
        );
    }

    #[test]
    fn test_decompress_empty() {
        // 빈 deflate 스트림 (0x03, 0x00 = final empty block)
        let compressed = [0x03, 0x00];
        let result = decompress_stream(&compressed);
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn test_decompress_invalid_data() {
        let result = decompress_stream(&[0xFF, 0xFF, 0xFF]);
        assert!(result.is_err());
    }

    #[test]
    fn test_decompress_real_data() {
        // flate2로 직접 압축한 데이터 검증
        use flate2::write::DeflateEncoder;
        use flate2::Compression;
        use std::io::Write;

        let original = b"Hello, HWP World! This is a test string for compression.";
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let decompressed = decompress_stream(&compressed).unwrap();
        assert_eq!(decompressed, original);
    }

    #[test]
    fn test_limited_decompression_rejects_compact_oversized_output() {
        use flate2::write::DeflateEncoder;
        use flate2::Compression;
        use std::io::Write;

        let original = vec![b'A'; 4096];
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();
        assert!(compressed.len() < 1024);

        assert!(matches!(
            decompress_stream_limited(&compressed, 1024),
            Err(CfbError::LimitExceeded(1024))
        ));
        assert_eq!(
            decompress_stream_limited(&compressed, original.len()).unwrap(),
            original
        );
    }

    #[test]
    fn aggregate_remainder_limits_decompression_before_a_full_member_allocation() {
        use flate2::write::DeflateEncoder;
        use flate2::Compression;
        use std::io::Write;

        let original = vec![b'A'; 8];
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();
        let member_limit = crate::parser::limits::remaining_container_member_limit(
            MAX_CONTAINER_BYTES - 7,
            MAX_STRUCTURAL_BYTES,
        );

        assert_eq!(member_limit, 7);
        assert!(matches!(
            decompress_stream_limited(&compressed, member_limit),
            Err(CfbError::LimitExceeded(7))
        ));
    }

    #[test]
    fn test_compare_cfb_streams_cli_vs_browser() {
        use std::collections::BTreeMap;

        let cli_path = "samples/20250130-hongbo_saved.hwp";
        let browser_path = "samples/honbo-save.hwp";

        let cli_data = std::fs::read(cli_path)
            .unwrap_or_else(|e| panic!("CLI 파일 읽기 실패: {} - {}", cli_path, e));
        let browser_data = std::fs::read(browser_path)
            .unwrap_or_else(|e| panic!("Browser 파일 읽기 실패: {} - {}", browser_path, e));

        println!("\n{}", "=".repeat(60));
        println!("  CFB Stream Structure Comparison");
        println!(
            "  CLI-saved (works):   {} ({} bytes)",
            cli_path,
            cli_data.len()
        );
        println!(
            "  Browser-saved (bad): {} ({} bytes)",
            browser_path,
            browser_data.len()
        );
        println!("{}\n", "=".repeat(60));

        let cli_cfb = CfbReader::open(&cli_data).expect("CLI CFB 열기 실패");
        let browser_cfb = CfbReader::open(&browser_data).expect("Browser CFB 열기 실패");

        // Collect all entries with sizes
        let cli_entries: BTreeMap<String, (u64, bool)> = cli_cfb
            .list_all_entries()
            .into_iter()
            .map(|(path, size, is_stream)| (path, (size, is_stream)))
            .collect();

        let browser_entries: BTreeMap<String, (u64, bool)> = browser_cfb
            .list_all_entries()
            .into_iter()
            .map(|(path, size, is_stream)| (path, (size, is_stream)))
            .collect();

        // Print CLI streams
        println!("--- CLI-saved streams (works in Hancom) ---");
        println!("{:<45} {:>10} {:>10}", "Path", "Size", "Type");
        println!("{:-<67}", "");
        for (path, (size, is_stream)) in &cli_entries {
            let type_str = if *is_stream { "stream" } else { "storage" };
            println!("{:<45} {:>10} {:>10}", path, size, type_str);
        }

        println!("\n--- Browser-saved streams (corrupted in Hancom) ---");
        println!("{:<45} {:>10} {:>10}", "Path", "Size", "Type");
        println!("{:-<67}", "");
        for (path, (size, is_stream)) in &browser_entries {
            let type_str = if *is_stream { "stream" } else { "storage" };
            println!("{:<45} {:>10} {:>10}", path, size, type_str);
        }

        // Compare: find differences
        println!("\n--- DIFFERENCES ---");
        println!();

        // Streams only in CLI
        let cli_only: Vec<_> = cli_entries
            .keys()
            .filter(|k| !browser_entries.contains_key(*k))
            .collect();
        if !cli_only.is_empty() {
            println!("Streams ONLY in CLI-saved (missing from browser-saved):");
            for path in &cli_only {
                let (size, _) = cli_entries[*path];
                println!("  [MISSING] {:<40} (size: {})", path, size);
            }
            println!();
        }

        // Streams only in Browser
        let browser_only: Vec<_> = browser_entries
            .keys()
            .filter(|k| !cli_entries.contains_key(*k))
            .collect();
        if !browser_only.is_empty() {
            println!("Streams ONLY in Browser-saved (extra, not in CLI-saved):");
            for path in &browser_only {
                let (size, _) = browser_entries[*path];
                println!("  [EXTRA]   {:<40} (size: {})", path, size);
            }
            println!();
        }

        // Streams with different sizes
        println!("Streams with SIZE differences:");
        let mut size_diffs = 0;
        for (path, (cli_size, cli_is_stream)) in &cli_entries {
            if let Some((browser_size, _)) = browser_entries.get(path) {
                if cli_size != browser_size && *cli_is_stream {
                    let diff = *browser_size as i64 - *cli_size as i64;
                    let sign = if diff > 0 { "+" } else { "" };
                    println!(
                        "  {:<40} CLI: {:>8}  Browser: {:>8}  ({}{})",
                        path, cli_size, browser_size, sign, diff
                    );
                    size_diffs += 1;
                }
            }
        }
        if size_diffs == 0 {
            println!("  (none)");
        }

        // Specifically analyze BinData streams
        println!("\n--- BinData Stream Analysis ---");
        println!();
        let cli_bins: Vec<_> = cli_entries
            .keys()
            .filter(|k| k.starts_with("/BinData/"))
            .collect();
        let browser_bins: Vec<_> = browser_entries
            .keys()
            .filter(|k| k.starts_with("/BinData/"))
            .collect();

        println!("CLI-saved BinData streams ({} total):", cli_bins.len());
        for path in &cli_bins {
            let (size, _) = cli_entries[*path];
            println!("  {:<45} size: {}", path, size);
        }

        println!(
            "\nBrowser-saved BinData streams ({} total):",
            browser_bins.len()
        );
        for path in &browser_bins {
            let (size, _) = browser_entries[*path];
            println!("  {:<45} size: {}", path, size);
        }

        // Check naming pattern
        println!("\nBinData naming pattern check:");
        for path in cli_bins.iter().chain(browser_bins.iter()) {
            if let Some(name) = path.strip_prefix("/BinData/") {
                if name.starts_with("BIN") {
                    // Extract the numeric part
                    let num_part: String = name
                        .chars()
                        .skip(3)
                        .take_while(|c| c.is_ascii_digit())
                        .collect();
                    let ext_part: String = name.chars().skip(3 + num_part.len()).collect();
                    let source =
                        if cli_entries.contains_key(*path) && browser_entries.contains_key(*path) {
                            "BOTH"
                        } else if cli_entries.contains_key(*path) {
                            "CLI-ONLY"
                        } else {
                            "BROWSER-ONLY"
                        };
                    println!(
                        "  {} => prefix=BIN, num='{}' (digits={}), ext='{}' [{}]",
                        name,
                        num_part,
                        num_part.len(),
                        ext_part,
                        source
                    );
                }
            }
        }

        // Summary
        println!("\n--- SUMMARY ---");
        println!(
            "CLI-saved:     {} total entries ({} streams)",
            cli_entries.len(),
            cli_entries.values().filter(|(_, is)| *is).count()
        );
        println!(
            "Browser-saved: {} total entries ({} streams)",
            browser_entries.len(),
            browser_entries.values().filter(|(_, is)| *is).count()
        );
        println!("Only in CLI:     {}", cli_only.len());
        println!("Only in Browser: {}", browser_only.len());
        println!("Size differences: {}", size_diffs);

        // Helper functions for record parsing
        fn parse_records(data: &[u8]) -> Vec<(u32, u32, u32, usize)> {
            // Returns: (tag_id, level, size, offset)
            let mut records = Vec::new();
            let mut pos = 0;
            while pos + 4 <= data.len() {
                let header =
                    u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
                let tag_id = header & 0x3FF;
                let level = (header >> 10) & 0x3FF;
                let size_field = (header >> 20) & 0xFFF;
                let mut size = size_field as u32;
                let mut data_offset = pos + 4;
                if size_field == 0xFFF {
                    if pos + 8 > data.len() {
                        break;
                    }
                    size = u32::from_le_bytes([
                        data[pos + 4],
                        data[pos + 5],
                        data[pos + 6],
                        data[pos + 7],
                    ]);
                    data_offset = pos + 8;
                }
                records.push((tag_id, level, size, pos));
                pos = data_offset + size as usize;
            }
            records
        }

        fn tag_name(tag_id: u32) -> &'static str {
            match tag_id {
                66 => "PARA_HEADER",
                67 => "PARA_TEXT",
                68 => "PARA_CHAR_SHAPE",
                69 => "PARA_LINE_SEG",
                70 => "PARA_RANGE_TAG",
                71 => "CTRL_HEADER",
                72 => "LIST_HEADER",
                73 => "PAGE_DEF",
                74 => "FOOTNOTE_SHAPE",
                75 => "PAGE_BORDER_FILL",
                76 => "SHAPE_COMPONENT",
                77 => "TABLE",
                78 => "SHAPE_LINE",
                79 => "SHAPE_RECT",
                80 => "SHAPE_ELLIPSE",
                81 => "SHAPE_ARC",
                82 => "SHAPE_POLYGON",
                83 => "SHAPE_CURVE",
                84 => "SHAPE_OLE",
                85 => "SHAPE_PICTURE",
                86 => "SHAPE_CONTAINER",
                87 => "CTRL_DATA",
                88 => "EQEDIT",
                99 => "SHAPE_TEXTART",
                102 => "FORM_OBJECT",
                103 => "MEMO_SHAPE",
                104 => "MEMO_LIST",
                _ => "UNKNOWN",
            }
        }

        // Compare BodyText/Section0 records
        println!("\n--- BodyText/Section0 Record-level Comparison ---");

        let mut cli_cfb3 = CfbReader::open(&cli_data).unwrap();
        let mut browser_cfb3 = CfbReader::open(&browser_data).unwrap();
        let cli_section = cli_cfb3.read_body_text_section(0, true, false).unwrap();
        let browser_section = browser_cfb3.read_body_text_section(0, true, false).unwrap();

        println!(
            "CLI Section0 decompressed size:     {} bytes",
            cli_section.len()
        );
        println!(
            "Browser Section0 decompressed size: {} bytes",
            browser_section.len()
        );

        let cli_records = parse_records(&cli_section);
        let browser_records = parse_records(&browser_section);

        println!("\nCLI records: {} total", cli_records.len());
        println!("Browser records: {} total", browser_records.len());

        // Print all records side by side (only show differences and nearby context)
        let max_records = std::cmp::max(cli_records.len(), browser_records.len());
        println!(
            "\n{:<5} {:<30} {:>4} {:>6}  |  {:<30} {:>4} {:>6}  | Match",
            "#", "CLI Tag", "Lvl", "Size", "Browser Tag", "Lvl", "Size"
        );
        println!("{:-<120}", "");

        for i in 0..max_records {
            let cli_str = if i < cli_records.len() {
                let (tag, lvl, sz, _) = cli_records[i];
                format!(
                    "{:<30} {:>4} {:>6}",
                    format!("{} ({})", tag_name(tag), tag),
                    lvl,
                    sz
                )
            } else {
                format!("{:<30} {:>4} {:>6}", "---", "", "")
            };

            let browser_str = if i < browser_records.len() {
                let (tag, lvl, sz, _) = browser_records[i];
                format!(
                    "{:<30} {:>4} {:>6}",
                    format!("{} ({})", tag_name(tag), tag),
                    lvl,
                    sz
                )
            } else {
                format!("{:<30} {:>4} {:>6}", "---", "", "")
            };

            let match_str = if i < cli_records.len() && i < browser_records.len() {
                let (ct, cl, cs, co) = cli_records[i];
                let (bt, bl, bs, bo) = browser_records[i];
                if ct == bt && cl == bl && cs == bs {
                    let cli_data_start = if cs == 0xFFF { co + 8 } else { co + 4 };
                    let browser_data_start = if bs == 0xFFF { bo + 8 } else { bo + 4 };
                    let cli_slice = &cli_section[cli_data_start..cli_data_start + cs as usize];
                    let browser_slice =
                        &browser_section[browser_data_start..browser_data_start + bs as usize];
                    if cli_slice == browser_slice {
                        "OK"
                    } else {
                        "DATA DIFF"
                    }
                } else if ct == bt && cl == bl {
                    "SIZE DIFF"
                } else {
                    "MISMATCH"
                }
            } else {
                "MISSING"
            };

            // Only print non-OK records and some context
            if match_str != "OK" {
                println!("{:<5} {}  |  {}  | {}", i, cli_str, browser_str, match_str);
            }
        }

        // Hex dump of key differing records
        println!("\n--- Hex Dump of Key Differing Records ---");
        for idx in [19usize, 20, 21, 32, 33, 34, 225, 226, 227] {
            if idx >= cli_records.len() && idx >= browser_records.len() {
                continue;
            }
            println!("\n=== Record #{} ===", idx);
            if idx < cli_records.len() {
                let (tag, lvl, sz, off) = cli_records[idx];
                let data_start = if sz >= 0xFFF { off + 8 } else { off + 4 };
                let data_end = data_start + sz as usize;
                println!(
                    "CLI: tag={} ({}) level={} size={} offset={:#x}",
                    tag_name(tag),
                    tag,
                    lvl,
                    sz,
                    off
                );
                if data_end <= cli_section.len() {
                    let bytes = &cli_section[data_start..data_end];
                    let show_len = std::cmp::min(bytes.len(), 80);
                    print!("  hex: ");
                    for b in &bytes[..show_len] {
                        print!("{:02x} ", b);
                    }
                    if bytes.len() > show_len {
                        print!("...({} more bytes)", bytes.len() - show_len);
                    }
                    println!();
                }
            }
            if idx < browser_records.len() {
                let (tag, lvl, sz, off) = browser_records[idx];
                let data_start = if sz >= 0xFFF { off + 8 } else { off + 4 };
                let data_end = data_start + sz as usize;
                println!(
                    "Browser: tag={} ({}) level={} size={} offset={:#x}",
                    tag_name(tag),
                    tag,
                    lvl,
                    sz,
                    off
                );
                if data_end <= browser_section.len() {
                    let bytes = &browser_section[data_start..data_end];
                    let show_len = std::cmp::min(bytes.len(), 80);
                    print!("  hex: ");
                    for b in &bytes[..show_len] {
                        print!("{:02x} ", b);
                    }
                    if bytes.len() > show_len {
                        print!("...({} more bytes)", bytes.len() - show_len);
                    }
                    println!();
                }
            }
        }

        // Record count analysis
        println!("\n--- Record Count Analysis ---");
        println!("CLI:     {} records, {} CTRL_HEADER, {} SHAPE_COMPONENT, {} SHAPE_PICTURE, {} CTRL_DATA, {} LIST_HEADER",
            cli_records.len(),
            cli_records.iter().filter(|(t,_,_,_)| *t == 71).count(),
            cli_records.iter().filter(|(t,_,_,_)| *t == 76).count(),
            cli_records.iter().filter(|(t,_,_,_)| *t == 85).count(),
            cli_records.iter().filter(|(t,_,_,_)| *t == 87).count(),
            cli_records.iter().filter(|(t,_,_,_)| *t == 72).count());
        println!("Browser: {} records, {} CTRL_HEADER, {} SHAPE_COMPONENT, {} SHAPE_PICTURE, {} CTRL_DATA, {} LIST_HEADER",
            browser_records.len(),
            browser_records.iter().filter(|(t,_,_,_)| *t == 71).count(),
            browser_records.iter().filter(|(t,_,_,_)| *t == 76).count(),
            browser_records.iter().filter(|(t,_,_,_)| *t == 85).count(),
            browser_records.iter().filter(|(t,_,_,_)| *t == 87).count(),
            browser_records.iter().filter(|(t,_,_,_)| *t == 72).count());

        // CTRL_HEADER sizes
        println!("\n--- All CTRL_HEADER (71) sizes ---");
        let cli_ctrl: Vec<_> = cli_records
            .iter()
            .enumerate()
            .filter(|(_, (t, _, _, _))| *t == 71)
            .collect();
        let browser_ctrl: Vec<_> = browser_records
            .iter()
            .enumerate()
            .filter(|(_, (t, _, _, _))| *t == 71)
            .collect();
        println!(
            "CLI:     {:?}",
            cli_ctrl
                .iter()
                .map(|(i, (_, l, s, _))| format!("#{}: lvl={} sz={}", i, l, s))
                .collect::<Vec<_>>()
        );
        println!(
            "Browser: {:?}",
            browser_ctrl
                .iter()
                .map(|(i, (_, l, s, _))| format!("#{}: lvl={} sz={}", i, l, s))
                .collect::<Vec<_>>()
        );

        // SHAPE_COMPONENT sizes
        println!("\n--- All SHAPE_COMPONENT (76) sizes ---");
        let cli_shape: Vec<_> = cli_records
            .iter()
            .enumerate()
            .filter(|(_, (t, _, _, _))| *t == 76)
            .collect();
        let browser_shape: Vec<_> = browser_records
            .iter()
            .enumerate()
            .filter(|(_, (t, _, _, _))| *t == 76)
            .collect();
        println!(
            "CLI:     {:?}",
            cli_shape
                .iter()
                .map(|(i, (_, l, s, _))| format!("#{}: lvl={} sz={}", i, l, s))
                .collect::<Vec<_>>()
        );
        println!(
            "Browser: {:?}",
            browser_shape
                .iter()
                .map(|(i, (_, l, s, _))| format!("#{}: lvl={} sz={}", i, l, s))
                .collect::<Vec<_>>()
        );

        // Compare FileHeader bytes
        println!("\n--- FileHeader Comparison ---");
        let mut cli_cfb2 = CfbReader::open(&cli_data).unwrap();
        let mut browser_cfb2 = CfbReader::open(&browser_data).unwrap();

        let cli_header = cli_cfb2.read_file_header().unwrap();
        let browser_header = browser_cfb2.read_file_header().unwrap();

        println!("CLI FileHeader size: {} bytes", cli_header.len());
        println!("Browser FileHeader size: {} bytes", browser_header.len());

        if cli_header == browser_header {
            println!("FileHeaders are IDENTICAL.");
        } else {
            println!("FileHeaders DIFFER at these byte offsets:");
            let max_len = std::cmp::max(cli_header.len(), browser_header.len());
            let mut diff_count = 0;
            for i in 0..max_len {
                let cli_byte = cli_header.get(i).copied();
                let browser_byte = browser_header.get(i).copied();
                if cli_byte != browser_byte {
                    println!(
                        "  offset {:#06x}: CLI={:?} Browser={:?}",
                        i,
                        cli_byte.map(|b| format!("{:#04x}", b)),
                        browser_byte.map(|b| format!("{:#04x}", b))
                    );
                    diff_count += 1;
                    if diff_count > 20 {
                        println!("  ... (truncated, more differences exist)");
                        break;
                    }
                }
            }
        }
    }
}
