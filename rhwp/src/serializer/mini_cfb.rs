//! 최소 CFB (Compound File Binary) v3 빌더
//!
//! `cfb` 크레이트의 `CompoundFile::create()`가 `SystemTime::now()`를 호출하여
//! `wasm32-unknown-unknown` 타겟에서 panic이 발생하므로,
//! SystemTime을 사용하지 않는 자체 CFB 빌더를 구현한다.
//!
//! CFB v3 사양:
//! - 섹터 크기: 512바이트
//! - 미니 섹터 크기: 64바이트
//! - 미니 스트림 컷오프: 4096바이트 (표준값)

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::OnceLock;

const SECTOR_SIZE: usize = 512;
const MINI_SECTOR_SIZE: usize = 64;
const MINI_STREAM_CUTOFF: usize = 4096;
const DIR_ENTRY_SIZE: usize = 128;
const ENTRIES_PER_DIR_SECTOR: usize = SECTOR_SIZE / DIR_ENTRY_SIZE; // 4
const FAT_ENTRIES_PER_SECTOR: usize = SECTOR_SIZE / 4; // 128
const HEADER_DIFAT_COUNT: usize = 109;
// DIFAT 섹터는 128 엔트리 중 마지막 1개를 다음 DIFAT 섹터 체인 포인터로 쓰므로
// FAT 섹터 포인터는 섹터당 127개만 담는다.
const DIFAT_ENTRIES_PER_SECTOR: usize = FAT_ENTRIES_PER_SECTOR - 1; // 127

const ENDOFCHAIN: u32 = 0xFFFFFFFE;
const FREESECT: u32 = 0xFFFFFFFF;
const FATSECT: u32 = 0xFFFFFFFD;
const DIFSECT: u32 = 0xFFFFFFFC;
const NOSTREAM: u32 = 0xFFFFFFFF;

fn sectors_for(bytes: usize, sector_size: usize) -> Result<usize, String> {
    if bytes == 0 {
        return Ok(0);
    }
    bytes
        .checked_add(sector_size - 1)
        .map(|rounded| rounded / sector_size)
        .ok_or_else(|| "CFB sector count overflow".to_string())
}

fn try_filled_vec<T: Clone>(len: usize, value: T, label: &str) -> Result<Vec<T>, String> {
    let mut values = Vec::new();
    values
        .try_reserve_exact(len)
        .map_err(|error| format!("{label} allocation failed: {error}"))?;
    values.resize(len, value);
    Ok(values)
}

/// CFB 시그니처 (Magic Number)
const CFB_SIGNATURE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

pub(crate) enum CfbStreamData<'a> {
    Borrowed(&'a [u8]),
    Owned(Vec<u8>),
    Shared(std::sync::Arc<[u8]>),
}

impl CfbStreamData<'_> {
    pub(crate) fn len(&self) -> usize {
        self.as_ref().len()
    }

    fn is_empty(&self) -> bool {
        self.as_ref().is_empty()
    }
}

impl AsRef<[u8]> for CfbStreamData<'_> {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Borrowed(bytes) => bytes,
            Self::Owned(bytes) => bytes,
            Self::Shared(bytes) => bytes,
        }
    }
}

struct DirEntry<'a> {
    name: String,
    obj_type: u8,
    data: CfbStreamData<'a>,
    parent: usize,
    children: Vec<usize>,
    left: u32,
    right: u32,
    child: u32,
    color: u8,
    start_sector: u32,
    is_mini: bool,
}

impl DirEntry<'_> {
    fn new(name: &str, obj_type: u8, parent: usize) -> Self {
        DirEntry {
            name: name.to_string(),
            obj_type,
            data: CfbStreamData::Owned(Vec::new()),
            parent,
            children: Vec::new(),
            left: NOSTREAM,
            right: NOSTREAM,
            child: NOSTREAM,
            color: 1,
            // Storage(1)는 start_sector=0 (MS-CFB 스펙: "SHOULD be set to all zeroes")
            // Root(5), Stream(2)은 ENDOFCHAIN → 나중에 실제 값으로 교체
            start_sector: if obj_type == 1 { 0 } else { ENDOFCHAIN },
            is_mini: false,
        }
    }
}

/// 명명된 스트림 목록으로 CFB v3 바이너리를 생성한다.
///
/// # 인자
/// - `named_streams`: `(경로, 데이터)` 쌍. 경로는 `/FileHeader`, `/BodyText/Section0` 형식.
///
/// # 반환
/// CFB v3 바이너리 바이트.
pub fn build_cfb(named_streams: &[(&str, &[u8])]) -> Result<Vec<u8>, String> {
    if named_streams.len() > crate::parser::limits::MAX_CFB_DIRECTORY_ENTRIES {
        return Err(format!(
            "CFB stream count exceeds limit: {} > {}",
            named_streams.len(),
            crate::parser::limits::MAX_CFB_DIRECTORY_ENTRIES
        ));
    }
    for (path, _) in named_streams {
        validate_cfb_path(path)?;
    }
    let borrowed_streams = named_streams
        .iter()
        .map(|(path, data)| ((*path).to_string(), CfbStreamData::Borrowed(*data)))
        .collect();
    build_cfb_streams_with_limit(
        borrowed_streams,
        crate::parser::limits::MAX_CONTAINER_BYTES as usize,
    )
}

/// Build a bounded CFB while taking ownership of stream payloads. The HWP
/// serializer uses this path so mini-CFB assembly does not clone every large
/// payload before allocating the final container.
pub(crate) fn build_cfb_owned_with_limit(
    named_streams: Vec<(String, Vec<u8>)>,
    max_output_bytes: usize,
) -> Result<Vec<u8>, String> {
    build_cfb_streams_with_limit(
        named_streams
            .into_iter()
            .map(|(path, data)| (path, CfbStreamData::Owned(data)))
            .collect(),
        max_output_bytes,
    )
}

/// Validate the exact directory tree, including implicit storage entries,
/// before a caller materializes any stream payloads.
pub(crate) fn validate_cfb_stream_paths(paths: Vec<String>) -> Result<(), String> {
    let empty: &[u8] = &[];
    build_entries(
        paths
            .into_iter()
            .map(|path| (path, CfbStreamData::Borrowed(empty)))
            .collect(),
    )
    .map(|_| ())
}

pub(crate) fn build_cfb_streams_with_limit(
    named_streams: Vec<(String, CfbStreamData<'_>)>,
    max_output_bytes: usize,
) -> Result<Vec<u8>, String> {
    // Every CFB contains all payload bytes plus sector/directory overhead. This
    // cheap lower bound rejects an impossible output before path-tree or
    // mini-stream allocations begin.
    let payload_bytes = named_streams.iter().try_fold(0usize, |total, (_, data)| {
        total
            .checked_add(data.len())
            .ok_or_else(|| "CFB payload size overflow".to_string())
    })?;
    if payload_bytes > max_output_bytes {
        return Err(format!(
            "CFB output exceeds byte limit: payload {payload_bytes} > {max_output_bytes}"
        ));
    }

    // 1. 엔트리 목록 구축
    let mut entries = build_entries(named_streams)?;

    // 2. 디렉토리 트리 구축
    build_tree(&mut entries, 0);

    // 3. Compute the exact layout before allocating mini-stream/FAT/output
    // buffers. A low output limit must fail before any payload-sized clone.
    let mut mini_sector_count = 0usize;
    for entry in entries.iter_mut() {
        if entry.obj_type == 2 && !entry.data.is_empty() && entry.data.len() < MINI_STREAM_CUTOFF {
            entry.is_mini = true;
            entry.start_sector = u32::try_from(mini_sector_count)
                .map_err(|_| "CFB mini-sector index overflow".to_string())?;
            let num_mini = sectors_for(entry.data.len(), MINI_SECTOR_SIZE)?;
            mini_sector_count = mini_sector_count
                .checked_add(num_mini)
                .ok_or_else(|| "CFB mini-stream size overflow".to_string())?;
        }
    }
    let mini_stream_size = mini_sector_count
        .checked_mul(MINI_SECTOR_SIZE)
        .ok_or_else(|| "CFB mini-stream size overflow".to_string())?;

    // 4. 정규 섹터 할당
    let dir_sectors = sectors_for(entries.len(), ENTRIES_PER_DIR_SECTOR)?;
    let mut next_sector = dir_sectors;

    // 큰 스트림 (>= 4096 바이트) → 정규 섹터
    for entry in entries.iter_mut() {
        if entry.obj_type == 2 && !entry.data.is_empty() && !entry.is_mini {
            entry.start_sector =
                u32::try_from(next_sector).map_err(|_| "CFB sector index overflow".to_string())?;
            let num = sectors_for(entry.data.len(), SECTOR_SIZE)?;
            next_sector = next_sector
                .checked_add(num)
                .ok_or_else(|| "CFB sector count overflow".to_string())?;
        }
    }

    // Root Entry 미니 스트림 컨테이너 → 정규 섹터
    if mini_stream_size > 0 {
        entries[0].start_sector =
            u32::try_from(next_sector).map_err(|_| "CFB sector index overflow".to_string())?;
        let num = sectors_for(mini_stream_size, SECTOR_SIZE)?;
        next_sector = next_sector
            .checked_add(num)
            .ok_or_else(|| "CFB sector count overflow".to_string())?;
    }

    // 미니 FAT 섹터
    let mini_fat_start;
    let mini_fat_sector_count;
    if mini_sector_count > 0 {
        mini_fat_start = u32::try_from(next_sector)
            .map_err(|_| "CFB mini-FAT sector index overflow".to_string())?;
        mini_fat_sector_count =
            u32::try_from(sectors_for(mini_sector_count, FAT_ENTRIES_PER_SECTOR)?)
                .map_err(|_| "CFB mini-FAT sector count overflow".to_string())?;
        next_sector = next_sector
            .checked_add(mini_fat_sector_count as usize)
            .ok_or_else(|| "CFB sector count overflow".to_string())?;
    } else {
        mini_fat_start = ENDOFCHAIN;
        mini_fat_sector_count = 0;
    }

    // FAT/DIFAT 섹터 수 계산 (고정점 반복)
    //
    // CFB v3 헤더는 FAT 섹터 포인터를 최대 109개만 담는다. FAT 섹터가 109개를
    // 초과하면(출력 > 약 7.14MB = 109 × 128 × 512 byte) 나머지 포인터는
    // DIFAT(이중 간접 FAT) 섹터에 기록해야 한다. FAT 섹터와 DIFAT 섹터 자체도
    // 섹터를 차지하여 total_sectors를 늘리고, 이는 다시 fat_count(→difat_count)를
    // 늘릴 수 있으므로 두 값을 함께 고정점 반복으로 수렴시킨다.
    let non_meta_sectors = u32::try_from(next_sector)
        .map_err(|_| "CFB non-metadata sector count overflow".to_string())?;
    let mut fat_count = 1u32;
    let mut difat_count = 0u32;
    loop {
        let total = non_meta_sectors
            .checked_add(fat_count)
            .and_then(|count| count.checked_add(difat_count))
            .ok_or_else(|| "CFB sector count overflow".to_string())?;
        let needed_fat = u32::try_from(sectors_for(total as usize, FAT_ENTRIES_PER_SECTOR)?)
            .map_err(|_| "CFB FAT sector count overflow".to_string())?;
        let needed_difat = if needed_fat as usize > HEADER_DIFAT_COUNT {
            u32::try_from(sectors_for(
                needed_fat as usize - HEADER_DIFAT_COUNT,
                DIFAT_ENTRIES_PER_SECTOR,
            )?)
            .map_err(|_| "CFB DIFAT sector count overflow".to_string())?
        } else {
            0
        };
        if needed_fat <= fat_count && needed_difat <= difat_count {
            break;
        }
        // 섹터 수는 단조 증가만 하므로 max로 수렴을 보장한다.
        fat_count = needed_fat.max(fat_count);
        difat_count = needed_difat.max(difat_count);
    }

    let fat_start = non_meta_sectors;
    let difat_start = fat_start
        .checked_add(fat_count)
        .ok_or_else(|| "CFB FAT sector index overflow".to_string())?;
    let total_sectors = difat_start
        .checked_add(difat_count)
        .ok_or_else(|| "CFB sector count overflow".to_string())?;

    let file_size = (total_sectors as usize)
        .checked_mul(SECTOR_SIZE)
        .and_then(|bytes| bytes.checked_add(512))
        .ok_or_else(|| "CFB output size overflow".to_string())?;
    if file_size > max_output_bytes {
        return Err(format!(
            "CFB output exceeds byte limit: {file_size} > {max_output_bytes}"
        ));
    }

    // The exact layout fits. Allocate and populate the mini stream and mini
    // FAT only now, then allocate the regular FAT and final output.
    let mut mini_stream = try_filled_vec(mini_stream_size, 0u8, "CFB mini stream")?;
    let mut mini_fat = try_filled_vec(mini_sector_count, FREESECT, "CFB mini FAT")?;
    for entry in entries.iter().filter(|entry| entry.is_mini) {
        let start_mini = entry.start_sector as usize;
        let num_mini = sectors_for(entry.data.len(), MINI_SECTOR_SIZE)?;
        for i in 0..num_mini {
            mini_fat[start_mini + i] = if i + 1 < num_mini {
                u32::try_from(start_mini + i + 1)
                    .map_err(|_| "CFB mini-sector index overflow".to_string())?
            } else {
                ENDOFCHAIN
            };
        }
        let offset = start_mini
            .checked_mul(MINI_SECTOR_SIZE)
            .ok_or_else(|| "CFB mini-stream offset overflow".to_string())?;
        mini_stream[offset..offset + entry.data.len()].copy_from_slice(entry.data.as_ref());
    }
    if !mini_stream.is_empty() {
        entries[0].data = CfbStreamData::Owned(mini_stream);
    }

    // 5. FAT 구축
    let mut fat = try_filled_vec(total_sectors as usize, FREESECT, "CFB FAT")?;

    // 디렉토리 체인
    for i in 0..dir_sectors {
        fat[i] = if i + 1 < dir_sectors {
            (i + 1) as u32
        } else {
            ENDOFCHAIN
        };
    }

    // 큰 스트림 체인
    for entry in entries.iter() {
        if entry.obj_type == 2 && !entry.data.is_empty() && !entry.is_mini {
            let start = entry.start_sector as usize;
            let num = (entry.data.len() + SECTOR_SIZE - 1) / SECTOR_SIZE;
            for i in 0..num {
                fat[start + i] = if i + 1 < num {
                    (start + i + 1) as u32
                } else {
                    ENDOFCHAIN
                };
            }
        }
    }

    // Root Entry (미니 스트림 컨테이너) 체인
    if entries[0].start_sector != ENDOFCHAIN && !entries[0].data.is_empty() {
        let start = entries[0].start_sector as usize;
        let num = (entries[0].data.len() + SECTOR_SIZE - 1) / SECTOR_SIZE;
        for i in 0..num {
            fat[start + i] = if i + 1 < num {
                (start + i + 1) as u32
            } else {
                ENDOFCHAIN
            };
        }
    }

    // 미니 FAT 체인
    if mini_fat_start != ENDOFCHAIN {
        let start = mini_fat_start as usize;
        for i in 0..mini_fat_sector_count as usize {
            fat[start + i] = if i + 1 < mini_fat_sector_count as usize {
                (start + i + 1) as u32
            } else {
                ENDOFCHAIN
            };
        }
    }

    // FAT 섹터 마커
    for i in 0..fat_count as usize {
        fat[fat_start as usize + i] = FATSECT;
    }

    // DIFAT 섹터 마커
    for i in 0..difat_count as usize {
        fat[difat_start as usize + i] = DIFSECT;
    }

    // 6. 바이너리 조립
    let mut output = try_filled_vec(file_size, 0u8, "CFB output")?;

    // 헤더 작성
    write_header(
        &mut output,
        fat_count,
        fat_start,
        mini_fat_start,
        mini_fat_sector_count,
        difat_start,
        difat_count,
    );

    // 디렉토리 엔트리 작성
    for (i, entry) in entries.iter().enumerate() {
        let sector_idx = i / ENTRIES_PER_DIR_SECTOR;
        let entry_in_sector = i % ENTRIES_PER_DIR_SECTOR;
        let offset = 512 + sector_idx * SECTOR_SIZE + entry_in_sector * DIR_ENTRY_SIZE;
        write_dir_entry(&mut output, offset, entry);
    }

    // 큰 스트림 데이터 작성
    for entry in &entries {
        if entry.obj_type == 2 && !entry.data.is_empty() && !entry.is_mini {
            let start_offset = 512 + entry.start_sector as usize * SECTOR_SIZE;
            output[start_offset..start_offset + entry.data.len()]
                .copy_from_slice(entry.data.as_ref());
        }
    }

    // Root Entry 데이터 (미니 스트림 컨테이너) 작성
    if entries[0].start_sector != ENDOFCHAIN && !entries[0].data.is_empty() {
        let start_offset = 512 + entries[0].start_sector as usize * SECTOR_SIZE;
        output[start_offset..start_offset + entries[0].data.len()]
            .copy_from_slice(entries[0].data.as_ref());
    }

    // 미니 FAT 작성
    if mini_fat_start != ENDOFCHAIN {
        for (i, &mf) in mini_fat.iter().enumerate() {
            let sector_idx = i / FAT_ENTRIES_PER_SECTOR;
            let entry_in_sector = i % FAT_ENTRIES_PER_SECTOR;
            let offset =
                512 + (mini_fat_start as usize + sector_idx) * SECTOR_SIZE + entry_in_sector * 4;
            output[offset..offset + 4].copy_from_slice(&mf.to_le_bytes());
        }
    }

    // FAT 작성
    for (i, &fat_entry) in fat.iter().enumerate() {
        let fat_sector_idx = i / FAT_ENTRIES_PER_SECTOR;
        let entry_in_sector = i % FAT_ENTRIES_PER_SECTOR;
        let offset =
            512 + (fat_start as usize + fat_sector_idx) * SECTOR_SIZE + entry_in_sector * 4;
        output[offset..offset + 4].copy_from_slice(&fat_entry.to_le_bytes());
    }

    // DIFAT 섹터 작성
    // 헤더가 담는 109개를 제외한 나머지 FAT 섹터 포인터를 DIFAT 섹터에 기록한다.
    // 각 DIFAT 섹터: 엔트리 0..127 = FAT 섹터 SID, 엔트리 127 = 다음 DIFAT 섹터 체인.
    for d in 0..difat_count as usize {
        let sector_base = 512 + (difat_start as usize + d) * SECTOR_SIZE;
        for j in 0..DIFAT_ENTRIES_PER_SECTOR {
            let fat_idx = HEADER_DIFAT_COUNT + d * DIFAT_ENTRIES_PER_SECTOR + j;
            let value = if (fat_idx as u32) < fat_count {
                fat_start + fat_idx as u32
            } else {
                FREESECT
            };
            let off = sector_base + j * 4;
            output[off..off + 4].copy_from_slice(&value.to_le_bytes());
        }
        // 마지막 엔트리(127번): 다음 DIFAT 섹터 체인 (마지막 섹터면 ENDOFCHAIN)
        let next = if d + 1 < difat_count as usize {
            difat_start + (d as u32) + 1
        } else {
            ENDOFCHAIN
        };
        let off = sector_base + DIFAT_ENTRIES_PER_SECTOR * 4;
        output[off..off + 4].copy_from_slice(&next.to_le_bytes());
    }

    Ok(output)
}

pub(crate) fn validate_cfb_path(path: &str) -> Result<(), String> {
    if path.len() > crate::parser::limits::MAX_CFB_PATH_BYTES {
        return Err(format!("CFB path exceeds byte limit: {}", path.len()));
    }
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return Err(format!("invalid empty CFB path component: {path}"));
    }
    if let Some(part) = parts.iter().find(|part| {
        matches!(**part, "." | "..")
            || part
                .chars()
                .any(|character| matches!(character, '\\' | '\0' | ':' | '!'))
    }) {
        return Err(format!(
            "invalid cross-platform CFB path component: {part:?}"
        ));
    }
    if let Some(part) = parts.iter().find(|part| part.encode_utf16().count() > 31) {
        return Err(format!(
            "CFB path component exceeds 31 UTF-16 code units: {part}"
        ));
    }
    Ok(())
}

/// 경로 목록에서 엔트리 목록을 구축한다.
fn build_entries(
    named_streams: Vec<(String, CfbStreamData<'_>)>,
) -> Result<Vec<DirEntry<'_>>, String> {
    let mut entries = Vec::new();

    // Root Entry
    entries.push(DirEntry::new("Root Entry", 5, 0));

    for (path, data) in named_streams {
        validate_cfb_path(&path)?;
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let mut parent_idx = 0;

        for (i, part) in parts.iter().enumerate() {
            let is_last = i == parts.len() - 1;

            let existing = entries.iter().position(|entry| {
                entry.parent == parent_idx
                    && cfb_compare_names(&entry.name, part) == Ordering::Equal
            });

            if let Some(idx) = existing {
                if is_last {
                    return Err(format!("duplicate CFB stream path: {path}"));
                }
                if entries[idx].obj_type != 1 {
                    return Err(format!("CFB stream/storage path conflict: {path}"));
                }
                parent_idx = idx;
            } else {
                let new_idx = entries.len();
                if new_idx >= crate::parser::limits::MAX_CFB_DIRECTORY_ENTRIES {
                    return Err(format!(
                        "CFB directory entry count exceeds limit: {}",
                        crate::parser::limits::MAX_CFB_DIRECTORY_ENTRIES
                    ));
                }
                let obj_type = if is_last { 2 } else { 1 };
                let entry = DirEntry::new(part, obj_type, parent_idx);
                entries[parent_idx].children.push(new_idx);
                entries.push(entry);
                parent_idx = new_idx;
            }
        }
        entries[parent_idx].data = data;
    }

    Ok(entries)
}

// Exceptional one-to-one uppercase mappings used by cfb 0.14/MS-CFB name
// comparison. Rust's full `to_uppercase` expands characters such as ß to SS;
// CFB uses simple uppercase and must keep those as one character.
const CFB_SIMPLE_UPPERCASE_EXCEPTIONS: &[(char, char)] = &[
    ('ß', 'ß'),
    ('ŉ', 'ŉ'),
    ('ƛ', 'ƛ'),
    ('ǰ', 'ǰ'),
    ('ɤ', 'ɤ'),
    ('ΐ', 'ΐ'),
    ('ΰ', 'ΰ'),
    ('և', 'և'),
    ('ᲊ', 'ᲊ'),
    ('ẖ', 'ẖ'),
    ('ẗ', 'ẗ'),
    ('ẘ', 'ẘ'),
    ('ẙ', 'ẙ'),
    ('ẚ', 'ẚ'),
    ('ὐ', 'ὐ'),
    ('ὒ', 'ὒ'),
    ('ὔ', 'ὔ'),
    ('ὖ', 'ὖ'),
    ('ᾀ', 'ᾈ'),
    ('ᾁ', 'ᾉ'),
    ('ᾂ', 'ᾊ'),
    ('ᾃ', 'ᾋ'),
    ('ᾄ', 'ᾌ'),
    ('ᾅ', 'ᾍ'),
    ('ᾆ', 'ᾎ'),
    ('ᾇ', 'ᾏ'),
    ('ᾈ', 'ᾈ'),
    ('ᾉ', 'ᾉ'),
    ('ᾊ', 'ᾊ'),
    ('ᾋ', 'ᾋ'),
    ('ᾌ', 'ᾌ'),
    ('ᾍ', 'ᾍ'),
    ('ᾎ', 'ᾎ'),
    ('ᾏ', 'ᾏ'),
    ('ᾐ', 'ᾘ'),
    ('ᾑ', 'ᾙ'),
    ('ᾒ', 'ᾚ'),
    ('ᾓ', 'ᾛ'),
    ('ᾔ', 'ᾜ'),
    ('ᾕ', 'ᾝ'),
    ('ᾖ', 'ᾞ'),
    ('ᾗ', 'ᾟ'),
    ('ᾘ', 'ᾘ'),
    ('ᾙ', 'ᾙ'),
    ('ᾚ', 'ᾚ'),
    ('ᾛ', 'ᾛ'),
    ('ᾜ', 'ᾜ'),
    ('ᾝ', 'ᾝ'),
    ('ᾞ', 'ᾞ'),
    ('ᾟ', 'ᾟ'),
    ('ᾠ', 'ᾨ'),
    ('ᾡ', 'ᾩ'),
    ('ᾢ', 'ᾪ'),
    ('ᾣ', 'ᾫ'),
    ('ᾤ', 'ᾬ'),
    ('ᾥ', 'ᾭ'),
    ('ᾦ', 'ᾮ'),
    ('ᾧ', 'ᾯ'),
    ('ᾨ', 'ᾨ'),
    ('ᾩ', 'ᾩ'),
    ('ᾪ', 'ᾪ'),
    ('ᾫ', 'ᾫ'),
    ('ᾬ', 'ᾬ'),
    ('ᾭ', 'ᾭ'),
    ('ᾮ', 'ᾮ'),
    ('ᾯ', 'ᾯ'),
    ('ᾲ', 'ᾲ'),
    ('ᾳ', 'ᾼ'),
    ('ᾴ', 'ᾴ'),
    ('ᾶ', 'ᾶ'),
    ('ᾷ', 'ᾷ'),
    ('ᾼ', 'ᾼ'),
    ('ῂ', 'ῂ'),
    ('ῃ', 'ῌ'),
    ('ῄ', 'ῄ'),
    ('ῆ', 'ῆ'),
    ('ῇ', 'ῇ'),
    ('ῌ', 'ῌ'),
    ('ῒ', 'ῒ'),
    ('ΐ', 'ΐ'),
    ('ῖ', 'ῖ'),
    ('ῗ', 'ῗ'),
    ('ῢ', 'ῢ'),
    ('ΰ', 'ΰ'),
    ('ῤ', 'ῤ'),
    ('ῦ', 'ῦ'),
    ('ῧ', 'ῧ'),
    ('ῲ', 'ῲ'),
    ('ῳ', 'ῼ'),
    ('ῴ', 'ῴ'),
    ('ῶ', 'ῶ'),
    ('ῷ', 'ῷ'),
    ('ῼ', 'ῼ'),
    ('ꟍ', 'ꟍ'),
    ('ꟛ', 'ꟛ'),
    ('ﬀ', 'ﬀ'),
    ('ﬁ', 'ﬁ'),
    ('ﬂ', 'ﬂ'),
    ('ﬃ', 'ﬃ'),
    ('ﬄ', 'ﬄ'),
    ('ﬅ', 'ﬅ'),
    ('ﬆ', 'ﬆ'),
    ('ﬓ', 'ﬓ'),
    ('ﬔ', 'ﬔ'),
    ('ﬕ', 'ﬕ'),
    ('ﬖ', 'ﬖ'),
    ('ﬗ', 'ﬗ'),
    ('𐵰', '𐵰'),
    ('𐵱', '𐵱'),
    ('𐵲', '𐵲'),
    ('𐵳', '𐵳'),
    ('𐵴', '𐵴'),
    ('𐵵', '𐵵'),
    ('𐵶', '𐵶'),
    ('𐵷', '𐵷'),
    ('𐵸', '𐵸'),
    ('𐵹', '𐵹'),
    ('𐵺', '𐵺'),
    ('𐵻', '𐵻'),
    ('𐵼', '𐵼'),
    ('𐵽', '𐵽'),
    ('𐵾', '𐵾'),
    ('𐵿', '𐵿'),
    ('𐶀', '𐶀'),
    ('𐶁', '𐶁'),
    ('𐶂', '𐶂'),
    ('𐶃', '𐶃'),
    ('𐶄', '𐶄'),
    ('𐶅', '𐶅'),
];

fn cfb_uppercase_char(character: char) -> char {
    static EXCEPTIONS: OnceLock<HashMap<char, char>> = OnceLock::new();
    EXCEPTIONS
        .get_or_init(|| CFB_SIMPLE_UPPERCASE_EXCEPTIONS.iter().copied().collect())
        .get(&character)
        .copied()
        .or_else(|| character.to_uppercase().next())
        .unwrap_or_default()
}

fn cfb_compare_names(left: &str, right: &str) -> Ordering {
    if left.is_ascii() && right.is_ascii() {
        return left.len().cmp(&right.len()).then_with(|| {
            left.bytes()
                .map(|byte| byte.to_ascii_uppercase())
                .cmp(right.bytes().map(|byte| byte.to_ascii_uppercase()))
        });
    }
    left.encode_utf16()
        .count()
        .cmp(&right.encode_utf16().count())
        .then_with(|| {
            left.chars()
                .map(cfb_uppercase_char)
                .cmp(right.chars().map(cfb_uppercase_char))
        })
}

/// Collision key for a full CFB path. Each component carries its original
/// UTF-16 length because length participates in MS-CFB comparison before case
/// mapping (notably, `ß` and `ss` are distinct).
pub(crate) fn cfb_path_key(path: &str) -> Vec<u16> {
    let components = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    let mut key = Vec::new();
    let component_count = components.len() as u32;
    key.extend_from_slice(&[component_count as u16, (component_count >> 16) as u16]);
    for component in components {
        let original_len = component.encode_utf16().count() as u32;
        key.extend_from_slice(&[original_len as u16, (original_len >> 16) as u16]);
        let mut mapped = Vec::new();
        for character in component.chars().map(cfb_uppercase_char) {
            let mut encoded = [0u16; 2];
            mapped.extend_from_slice(character.encode_utf16(&mut encoded));
        }
        let mapped_len = mapped.len() as u32;
        key.extend_from_slice(&[mapped_len as u16, (mapped_len >> 16) as u16]);
        key.extend_from_slice(&mapped);
    }
    key
}

/// 각 스토리지의 자식을 정렬된 균형 이진 트리로 구축한다.
fn build_tree(entries: &mut Vec<DirEntry<'_>>, idx: usize) {
    // A valid 4,096-byte CFB path can contain roughly 2,048 one-character
    // storage components. Keep hierarchy traversal iterative so serializing a
    // caller-built or preserved path cannot consume one call frame per level.
    let mut pending = vec![idx];
    while let Some(idx) = pending.pop() {
        let children = entries[idx].children.clone();
        if children.is_empty() {
            entries[idx].child = NOSTREAM;
            continue;
        }

        // CFB 사양에 따라 이름 비교: 길이 우선, 같은 길이면 대소문자 무시
        let mut sorted = children.clone();
        sorted.sort_by(|&a, &b| cfb_compare_names(&entries[a].name, &entries[b].name));

        let root = build_balanced_tree(entries, &sorted);
        color_balanced_tree(entries, root);
        entries[idx].child = root;

        for child_idx in children {
            if entries[child_idx].obj_type == 1 {
                pending.push(child_idx);
            }
        }
    }
}

/// 정렬된 인덱스 배열로 균형 이진 트리를 구축한다.
fn build_balanced_tree(entries: &mut Vec<DirEntry<'_>>, sorted: &[usize]) -> u32 {
    if sorted.is_empty() {
        return NOSTREAM;
    }
    let mid = sorted.len() / 2;
    let root = sorted[mid] as u32;

    let left = build_balanced_tree(entries, &sorted[..mid]);
    let right = if mid + 1 < sorted.len() {
        build_balanced_tree(entries, &sorted[mid + 1..])
    } else {
        NOSTREAM
    };

    entries[root as usize].left = left;
    entries[root as usize].right = right;
    root
}

/// Color the height-balanced sibling tree as a valid red-black tree.
///
/// Median construction yields leaf depths differing by at most one. Coloring
/// only nodes on the deepest level red equalizes black height, keeps every red
/// node a leaf with a black parent, and leaves the sibling-tree root black.
fn color_balanced_tree(entries: &mut [DirEntry<'_>], root: u32) {
    if root == NOSTREAM {
        return;
    }
    let max_depth = tree_max_depth(entries, root, 0);
    color_tree_depth(entries, root, 0, max_depth);
    entries[root as usize].color = 1;
}

fn tree_max_depth(entries: &[DirEntry<'_>], node: u32, depth: usize) -> usize {
    if node == NOSTREAM {
        return depth.saturating_sub(1);
    }
    let entry = &entries[node as usize];
    tree_max_depth(entries, entry.left, depth + 1)
        .max(tree_max_depth(entries, entry.right, depth + 1))
        .max(depth)
}

fn color_tree_depth(entries: &mut [DirEntry<'_>], node: u32, depth: usize, max_depth: usize) {
    if node == NOSTREAM {
        return;
    }
    let idx = node as usize;
    entries[idx].color = u8::from(depth != max_depth || depth == 0);
    let left = entries[idx].left;
    let right = entries[idx].right;
    color_tree_depth(entries, left, depth + 1, max_depth);
    color_tree_depth(entries, right, depth + 1, max_depth);
}

/// CFB v3 헤더 (512바이트) 작성
fn write_header(
    output: &mut [u8],
    fat_count: u32,
    fat_start: u32,
    mini_fat_start: u32,
    mini_fat_sector_count: u32,
    difat_start: u32,
    difat_count: u32,
) {
    // 시그니처
    output[0..8].copy_from_slice(&CFB_SIGNATURE);

    // CLSID (16바이트 zero) — 이미 0

    // Minor version: 0x003E
    output[24..26].copy_from_slice(&0x003Eu16.to_le_bytes());
    // Major version: 0x0003 (v3)
    output[26..28].copy_from_slice(&0x0003u16.to_le_bytes());
    // Byte order: 0xFFFE (little-endian)
    output[28..30].copy_from_slice(&0xFFFEu16.to_le_bytes());
    // Sector shift: 9 (512 bytes)
    output[30..32].copy_from_slice(&9u16.to_le_bytes());
    // Mini sector shift: 6 (64 bytes)
    output[32..34].copy_from_slice(&6u16.to_le_bytes());

    // Reserved (6 bytes) — 이미 0

    // Total directory sectors: 0 (v3에서는 미사용)
    // output[40..44] — 이미 0

    // Total FAT sectors
    output[44..48].copy_from_slice(&fat_count.to_le_bytes());

    // First directory sector SID: 0 (항상 섹터 0부터)
    output[48..52].copy_from_slice(&0u32.to_le_bytes());

    // Transaction signature: 0
    // output[52..56] — 이미 0

    // Mini stream cutoff: 4096 (표준값)
    output[56..60].copy_from_slice(&(MINI_STREAM_CUTOFF as u32).to_le_bytes());

    // First mini FAT sector
    output[60..64].copy_from_slice(&mini_fat_start.to_le_bytes());
    // Total mini FAT sectors
    output[64..68].copy_from_slice(&mini_fat_sector_count.to_le_bytes());

    // First DIFAT sector: DIFAT 섹터가 있으면 그 시작 SID, 없으면 ENDOFCHAIN
    let first_difat = if difat_count > 0 {
        difat_start
    } else {
        ENDOFCHAIN
    };
    output[68..72].copy_from_slice(&first_difat.to_le_bytes());
    // Total DIFAT sectors
    output[72..76].copy_from_slice(&difat_count.to_le_bytes());

    // 헤더 내 DIFAT 배열 (선두 109개 FAT 섹터 포인터, 각 4바이트, 바이트 오프셋 76부터)
    // FAT 섹터가 109개를 초과하는 나머지는 DIFAT 섹터에 기록된다.
    let header_difat_offset = 76;
    for i in 0..HEADER_DIFAT_COUNT {
        let offset = header_difat_offset + i * 4;
        if (i as u32) < fat_count {
            let sid = fat_start + i as u32;
            output[offset..offset + 4].copy_from_slice(&sid.to_le_bytes());
        } else {
            output[offset..offset + 4].copy_from_slice(&FREESECT.to_le_bytes());
        }
    }
}

/// 디렉토리 엔트리 (128바이트) 작성
fn write_dir_entry(output: &mut [u8], offset: usize, entry: &DirEntry<'_>) {
    let buf = &mut output[offset..offset + DIR_ENTRY_SIZE];

    // 이름 (UTF-16LE, null 종료, 최대 32 UTF-16 코드 유닛)
    let name_utf16: Vec<u16> = entry.name.encode_utf16().collect();
    let name_len = name_utf16.len().min(31); // 최대 31자 + null
    for i in 0..name_len {
        let pos = i * 2;
        buf[pos..pos + 2].copy_from_slice(&name_utf16[i].to_le_bytes());
    }
    // null 종료
    let null_pos = name_len * 2;
    buf[null_pos..null_pos + 2].copy_from_slice(&0u16.to_le_bytes());

    // 이름 길이 (바이트, null 포함)
    let name_byte_len = ((name_len + 1) * 2) as u16;
    buf[64..66].copy_from_slice(&name_byte_len.to_le_bytes());

    // Object type
    buf[66] = entry.obj_type;

    // Color flag: 0 = red, 1 = black.
    buf[67] = entry.color;

    // Left sibling
    buf[68..72].copy_from_slice(&entry.left.to_le_bytes());
    // Right sibling
    buf[72..76].copy_from_slice(&entry.right.to_le_bytes());
    // Child
    buf[76..80].copy_from_slice(&entry.child.to_le_bytes());

    // CLSID (16 bytes) — 이미 0
    // State bits — 이미 0

    // Creation/Modified time (FILETIME, 8 bytes each)
    // Root Entry(5)와 Storage(1)에 고정 타임스탬프 설정
    // WASM에서 SystemTime::now()를 사용할 수 없으므로 고정값 사용
    // 2024-01-01 00:00:00 UTC ≈ 0x01DA5E8B_80000000
    if entry.obj_type == 5 || entry.obj_type == 1 {
        let filetime: u64 = 0x01DA_5E8B_8000_0000;
        let ft_bytes = filetime.to_le_bytes();
        buf[100..108].copy_from_slice(&ft_bytes); // Creation time
        buf[108..116].copy_from_slice(&ft_bytes); // Modified time
    }

    // Start sector
    buf[116..120].copy_from_slice(&entry.start_sector.to_le_bytes());

    // Stream size (lower 32 bits)
    // type 2 (스트림): 원본 데이터 크기
    // type 5 (루트): 미니 스트림 컨테이너 크기
    let size = if entry.obj_type == 2 || entry.obj_type == 5 {
        entry.data.len() as u32
    } else {
        0
    };
    buf[120..124].copy_from_slice(&size.to_le_bytes());

    // Stream size (upper 32 bits, v3: must be 0)
    // buf[124..128] — 이미 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_internal_buffer_request_returns_error_instead_of_panicking() {
        let error = try_filled_vec(usize::MAX, 0u8, "test buffer")
            .expect_err("capacity overflow must be reported");
        assert!(error.contains("allocation failed"), "{error}");
    }

    #[test]
    fn test_build_cfb_signature() {
        let streams = vec![("/TestStream", b"Hello" as &[u8])];
        let bytes = build_cfb(&streams).unwrap();

        assert!(bytes.len() >= 512);
        assert_eq!(&bytes[0..8], &CFB_SIGNATURE);
    }

    #[test]
    fn test_build_cfb_empty() {
        let streams: Vec<(&str, &[u8])> = Vec::new();
        let bytes = build_cfb(&streams).unwrap();

        assert_eq!(&bytes[0..8], &CFB_SIGNATURE);
    }

    #[test]
    fn test_build_cfb_readable_by_cfb_crate() {
        let fh = vec![0xAAu8; 256];
        let di = vec![0xBBu8; 100];
        let streams = vec![("/FileHeader", fh.as_slice()), ("/DocInfo", di.as_slice())];
        let bytes = build_cfb(&streams).unwrap();

        // cfb 크레이트로 읽기
        let cursor = std::io::Cursor::new(&bytes);
        let mut cfb = cfb::CompoundFile::open(cursor).unwrap();

        let mut fh_read = Vec::new();
        std::io::Read::read_to_end(&mut cfb.open_stream("/FileHeader").unwrap(), &mut fh_read)
            .unwrap();
        assert_eq!(fh_read.len(), 256);
        assert!(fh_read.iter().all(|&b| b == 0xAA));

        let mut di_read = Vec::new();
        std::io::Read::read_to_end(&mut cfb.open_stream("/DocInfo").unwrap(), &mut di_read)
            .unwrap();
        assert_eq!(di_read.len(), 100);
        assert!(di_read.iter().all(|&b| b == 0xBB));
    }

    #[test]
    fn test_build_cfb_with_storages() {
        let d1 = vec![0x01u8; 256];
        let d2 = vec![0x02u8; 500];
        let d3 = vec![0x03u8; 2000];
        let d4 = vec![0x04u8; 1500];
        let streams = vec![
            ("/FileHeader", d1.as_slice()),
            ("/DocInfo", d2.as_slice()),
            ("/BodyText/Section0", d3.as_slice()),
            ("/BodyText/Section1", d4.as_slice()),
        ];
        let bytes = build_cfb(&streams).unwrap();

        let cursor = std::io::Cursor::new(&bytes);
        let mut cfb = cfb::CompoundFile::open(cursor).unwrap();

        let mut s0 = Vec::new();
        std::io::Read::read_to_end(&mut cfb.open_stream("/BodyText/Section0").unwrap(), &mut s0)
            .unwrap();
        assert_eq!(s0.len(), 2000);
        assert!(s0.iter().all(|&b| b == 0x03));

        let mut s1 = Vec::new();
        std::io::Read::read_to_end(&mut cfb.open_stream("/BodyText/Section1").unwrap(), &mut s1)
            .unwrap();
        assert_eq!(s1.len(), 1500);
        assert!(s1.iter().all(|&b| b == 0x04));
    }

    #[test]
    fn test_build_cfb_large_stream() {
        // 10KB 스트림 (다중 섹터, >= 4096이므로 정규 섹터)
        let data = vec![0x55u8; 10240];
        let streams = vec![("/BigStream", data.as_slice())];
        let bytes = build_cfb(&streams).unwrap();

        let cursor = std::io::Cursor::new(&bytes);
        let mut cfb = cfb::CompoundFile::open(cursor).unwrap();

        let mut read_data = Vec::new();
        std::io::Read::read_to_end(&mut cfb.open_stream("/BigStream").unwrap(), &mut read_data)
            .unwrap();
        assert_eq!(read_data, data);
    }

    #[test]
    fn test_build_cfb_mixed_sizes() {
        // 미니 스트림(< 4096)과 정규 스트림(>= 4096) 혼합
        let small = vec![0x11u8; 100];
        let large = vec![0x22u8; 5000];
        let streams = vec![("/Small", small.as_slice()), ("/Large", large.as_slice())];
        let bytes = build_cfb(&streams).unwrap();

        let cursor = std::io::Cursor::new(&bytes);
        let mut cfb = cfb::CompoundFile::open(cursor).unwrap();

        let mut s_read = Vec::new();
        std::io::Read::read_to_end(&mut cfb.open_stream("/Small").unwrap(), &mut s_read).unwrap();
        assert_eq!(s_read, small);

        let mut l_read = Vec::new();
        std::io::Read::read_to_end(&mut cfb.open_stream("/Large").unwrap(), &mut l_read).unwrap();
        assert_eq!(l_read, large);
    }

    #[test]
    fn rejects_directory_names_that_would_truncate_or_collide() {
        let long = format!("/{}", "a".repeat(32));
        assert!(build_cfb(&[(long.as_str(), b"x")])
            .unwrap_err()
            .contains("31 UTF-16"));
        assert!(build_cfb(&[("/DocInfo", b"a"), ("/docinfo", b"b")])
            .unwrap_err()
            .contains("duplicate"));
        assert!(
            build_cfb(&[("/BodyText", b"a"), ("/BodyText/Section0", b"b")])
                .unwrap_err()
                .contains("stream/storage")
        );
        for path in [
            "/BodyText/.",
            "/BodyText/..",
            "/BodyText\\Section0",
            "/Body:Text/Section0",
            "/Body!Text/Section0",
            "/Body\0Text/Section0",
        ] {
            assert!(
                build_cfb(&[(path, b"x")])
                    .unwrap_err()
                    .contains("cross-platform"),
                "unsafe path was accepted: {path:?}"
            );
        }
    }

    #[test]
    fn cfb_simple_uppercase_does_not_expand_sharp_s() {
        assert_ne!(cfb_path_key("/ß"), cfb_path_key("/ss"));
        assert_eq!(cfb_path_key("/é"), cfb_path_key("/É"));

        let bytes = build_cfb(&[("/ß", b"sharp"), ("/ss", b"double")])
            .expect("MS-CFB treats sharp-s and two ASCII letters as distinct names");
        let mut compound = cfb::CompoundFile::open(std::io::Cursor::new(bytes)).unwrap();
        let mut sharp = Vec::new();
        std::io::Read::read_to_end(&mut compound.open_stream("/ß").unwrap(), &mut sharp).unwrap();
        let mut double = Vec::new();
        std::io::Read::read_to_end(&mut compound.open_stream("/ss").unwrap(), &mut double).unwrap();
        assert_eq!(sharp, b"sharp");
        assert_eq!(double, b"double");
    }

    #[test]
    fn deepest_allowed_cfb_path_builds_without_recursive_storage_walk() {
        let component_count = crate::parser::limits::MAX_CFB_PATH_BYTES / 2;
        let path = format!("/{}", vec!["a"; component_count].join("/"));
        assert_eq!(path.len(), crate::parser::limits::MAX_CFB_PATH_BYTES);

        let bytes = build_cfb(&[(path.as_str(), b"x")])
            .expect("the deepest byte-limited path must serialize iteratively");
        let mut compound = cfb::CompoundFile::open(std::io::Cursor::new(bytes))
            .expect("deep serialized CFB must remain valid");
        let mut payload = Vec::new();
        std::io::Read::read_to_end(&mut compound.open_stream(&path).unwrap(), &mut payload)
            .unwrap();
        assert_eq!(payload, b"x");
    }

    #[test]
    fn owned_builder_checks_the_final_padded_container_size() {
        let streams = vec![("/DocInfo".to_string(), vec![1, 2, 3])];
        let exact = build_cfb_owned_with_limit(streams.clone(), usize::MAX)
            .expect("tiny CFB")
            .len();
        assert!(build_cfb_owned_with_limit(streams.clone(), exact - 1)
            .unwrap_err()
            .contains("output exceeds"));
        assert_eq!(
            build_cfb_owned_with_limit(streams, exact)
                .expect("exact output budget")
                .len(),
            exact
        );
    }

    #[test]
    fn sibling_directories_are_valid_red_black_trees() {
        fn black_height(entries: &[DirEntry<'_>], node: u32, parent_red: bool) -> usize {
            if node == NOSTREAM {
                return 1;
            }
            let entry = &entries[node as usize];
            let red = entry.color == 0;
            assert!(!(parent_red && red), "red directory node has a red child");
            let left = black_height(entries, entry.left, red);
            let right = black_height(entries, entry.right, red);
            assert_eq!(left, right, "directory tree black-height mismatch");
            left + usize::from(!red)
        }

        for count in 1..=64 {
            let names: Vec<String> = (0..count).map(|i| format!("/Stream{i:02}")).collect();
            let streams: Vec<(String, CfbStreamData<'static>)> = names
                .iter()
                .map(|name| (name.clone(), CfbStreamData::Owned(b"x".to_vec())))
                .collect();
            let mut entries = build_entries(streams).expect("valid names");
            build_tree(&mut entries, 0);
            let root = entries[0].child;
            assert_eq!(entries[root as usize].color, 1, "root must be black");
            black_height(&entries, root, false);
        }
    }

    #[test]
    fn test_build_cfb_difat_over_threshold() {
        // 회귀(#1227): FAT 섹터가 109개를 초과하면(헤더 DIFAT 슬롯 109개 한계 →
        // 출력 ≈ 109×128×512 = 7,143,424 byte ≈ 7.14MB 초과) DIFAT 섹터가 필요하다.
        // 과거 mini_cfb는 DIFAT 미작성으로 109개 초과분 FAT 섹터 위치가 유실되어
        // FAT 체인이 단절, cfb 크레이트가 "next_id invalid"로 열기에 실패했다.
        //
        // 임계값 바로 위(약 7.2MB)로 최소화해 CI 메모리/시간 부담을 줄인다. 이보다
        // 작으면 FAT 섹터가 109개 이하라 DIFAT 경로를 타지 않으므로 더 줄일 수 없다.
        // 결정적 패턴을 써서 별도 대용량 기대 버퍼 없이 검증하고, 입력은 즉시 해제한다.
        let n = 7_200_000usize;
        let big: Vec<u8> = (0..n).map(|i| (i % 251) as u8).collect();
        let bytes = {
            let streams = vec![("/BinData/BIN0001", big.as_slice())];
            build_cfb(&streams).unwrap()
        };
        drop(big); // 입력 버퍼 즉시 해제 — 동시 보유 메모리 절감

        // 헤더에 DIFAT 섹터가 기록되었는지 확인
        let first_difat = u32::from_le_bytes(bytes[68..72].try_into().unwrap());
        let num_difat = u32::from_le_bytes(bytes[72..76].try_into().unwrap());
        assert!(num_difat > 0, "출력이 7.14MB를 넘는데 DIFAT 섹터가 0개");
        assert_ne!(
            first_difat, ENDOFCHAIN,
            "DIFAT가 필요한데 first_difat가 ENDOFCHAIN"
        );

        // cfb 크레이트로 라운드트립 검증 (FAT 체인이 온전해야 열림)
        let cursor = std::io::Cursor::new(&bytes);
        let mut cfb = cfb::CompoundFile::open(cursor).unwrap();
        let mut read_data = Vec::new();
        std::io::Read::read_to_end(
            &mut cfb.open_stream("/BinData/BIN0001").unwrap(),
            &mut read_data,
        )
        .unwrap();
        // 길이 + 결정적 패턴 일치로 검증 (별도 대용량 기대 버퍼 보유 없음)
        assert_eq!(read_data.len(), n);
        assert!(
            read_data
                .iter()
                .enumerate()
                .all(|(i, &b)| b == (i % 251) as u8),
            "라운드트립 데이터가 원본 패턴과 불일치"
        );
    }
}
