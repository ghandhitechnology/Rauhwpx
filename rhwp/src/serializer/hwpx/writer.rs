//! HWPX ZIP 컨테이너 쓰기
//!
//! `parser::hwpx::reader`의 역방향. ZIP 내부 파일을 특정 순서와 압축 옵션으로 조립한다.
//!
//! 규칙:
//! - `mimetype`은 ZIP 최초 엔트리, STORED(무압축), extra field 없음 (OPC 규격)
//! - 그 외 파일은 DEFLATED
//! - mtime은 1980-01-01 00:00로 고정(결정적 출력)

use std::collections::HashSet;
use std::io::{self, Cursor, Seek, SeekFrom, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipWriter};

use super::SerializeError;

/// HWPX ZIP 쓰기 래퍼
pub struct HwpxZipWriter {
    inner: ZipWriter<BoundedCursor>,
    names: HashSet<String>,
    expanded_bytes: u64,
    max_expanded_bytes: u64,
    max_entries: usize,
}

struct BoundedCursor {
    inner: Cursor<Vec<u8>>,
    max_bytes: u64,
}

impl BoundedCursor {
    fn new(max_bytes: u64) -> Self {
        Self {
            inner: Cursor::new(Vec::new()),
            max_bytes,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.inner.into_inner()
    }
}

impl Write for BoundedCursor {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let end = self
            .inner
            .position()
            .checked_add(buffer.len() as u64)
            .ok_or_else(|| io::Error::other("HWPX output size overflow"))?;
        if end > self.max_bytes {
            return Err(io::Error::other(format!(
                "HWPX output exceeds {} byte limit",
                self.max_bytes
            )));
        }
        let end = usize::try_from(end)
            .map_err(|_| io::Error::other("HWPX output position exceeds address space"))?;
        if end > self.inner.get_ref().capacity() {
            let max_capacity = usize::try_from(self.max_bytes).unwrap_or(usize::MAX);
            let target_capacity = self
                .inner
                .get_ref()
                .capacity()
                .saturating_mul(2)
                .max(end)
                .min(max_capacity);
            let additional = target_capacity.saturating_sub(self.inner.get_ref().len());
            self.inner
                .get_mut()
                .try_reserve_exact(additional)
                .map_err(|error| {
                    io::Error::other(format!("HWPX output allocation failed: {error}"))
                })?;
        }
        self.inner.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl Seek for BoundedCursor {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let previous = self.inner.position();
        let next = self.inner.seek(position)?;
        if next > self.max_bytes {
            self.inner.set_position(previous);
            return Err(io::Error::other(format!(
                "HWPX output seek exceeds {} byte limit",
                self.max_bytes
            )));
        }
        Ok(next)
    }
}

impl HwpxZipWriter {
    /// 새 인메모리 ZIP 라이터 생성
    pub fn new() -> Self {
        Self::with_limits(
            crate::parser::limits::MAX_CONTAINER_BYTES,
            crate::parser::limits::MAX_CONTAINER_BYTES,
            crate::parser::limits::MAX_HWPX_ENTRIES,
        )
    }

    fn with_limits(max_output_bytes: u64, max_expanded_bytes: u64, max_entries: usize) -> Self {
        Self {
            inner: ZipWriter::new(BoundedCursor::new(max_output_bytes)),
            names: HashSet::new(),
            expanded_bytes: 0,
            max_expanded_bytes,
            max_entries,
        }
    }

    fn fixed_mtime() -> DateTime {
        // 1980-01-01 00:00:00 (ZIP epoch)
        DateTime::default()
    }

    fn validate_entry(&self, name: &str, data_len: usize) -> Result<u64, SerializeError> {
        if self.names.len() >= self.max_entries {
            return Err(SerializeError::ZipError(format!(
                "HWPX entry count exceeds {}",
                self.max_entries
            )));
        }
        if name.len() > crate::parser::limits::MAX_HWPX_ENTRY_NAME_BYTES
            || !crate::parser::hwpx::reader::safe_member_name(name)
        {
            return Err(SerializeError::ZipError(format!(
                "unsafe or oversized HWPX entry name: {name:?}"
            )));
        }
        if self.names.contains(name) {
            return Err(SerializeError::ZipError(format!(
                "duplicate HWPX entry: {name}"
            )));
        }
        let member_limit = crate::parser::hwpx::reader::member_limit(name);
        if data_len > member_limit {
            return Err(SerializeError::ZipError(format!(
                "HWPX entry {name} exceeds {member_limit} byte member limit"
            )));
        }
        let next = self
            .expanded_bytes
            .checked_add(data_len as u64)
            .ok_or_else(|| SerializeError::ZipError("HWPX expanded size overflow".to_string()))?;
        if next > self.max_expanded_bytes {
            return Err(SerializeError::ZipError(format!(
                "HWPX expanded data exceeds {} byte container limit",
                self.max_expanded_bytes
            )));
        }
        Ok(next)
    }

    /// Bytes that may still be materialized for a prospective entry.
    pub fn remaining_entry_limit(&self, name: &str) -> Result<usize, SerializeError> {
        self.validate_entry(name, 0)?;
        let remaining = self.max_expanded_bytes.saturating_sub(self.expanded_bytes);
        Ok(usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(crate::parser::hwpx::reader::member_limit(name)))
    }

    fn commit_entry(&mut self, name: &str, next_expanded_bytes: u64) {
        self.names.insert(name.to_string());
        self.expanded_bytes = next_expanded_bytes;
    }

    /// STORED(무압축)로 엔트리를 추가한다. `mimetype`에 사용.
    pub fn write_stored(&mut self, name: &str, data: &[u8]) -> Result<(), SerializeError> {
        let next_expanded_bytes = self.validate_entry(name, data.len())?;
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .last_modified_time(Self::fixed_mtime());
        self.inner
            .start_file(name, opts)
            .map_err(|e| SerializeError::ZipError(e.to_string()))?;
        self.inner
            .write_all(data)
            .map_err(|e| SerializeError::ZipError(e.to_string()))?;
        self.commit_entry(name, next_expanded_bytes);
        Ok(())
    }

    /// DEFLATED(압축)로 엔트리를 추가한다.
    pub fn write_deflated(&mut self, name: &str, data: &[u8]) -> Result<(), SerializeError> {
        let next_expanded_bytes = self.validate_entry(name, data.len())?;
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(Self::fixed_mtime());
        self.inner
            .start_file(name, opts)
            .map_err(|e| SerializeError::ZipError(e.to_string()))?;
        self.inner
            .write_all(data)
            .map_err(|e| SerializeError::ZipError(e.to_string()))?;
        self.commit_entry(name, next_expanded_bytes);
        Ok(())
    }

    /// ZIP을 마감하고 바이트를 반환한다.
    pub fn finish(mut self) -> Result<Vec<u8>, SerializeError> {
        let cursor = self
            .inner
            .finish()
            .map_err(|e| SerializeError::ZipError(e.to_string()))?;
        Ok(cursor.into_inner())
    }
}

impl Default for HwpxZipWriter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn expanded_budget_rejects_the_next_entry_before_writing_it() {
        let mut writer = HwpxZipWriter::with_limits(4096, 5, 8);
        writer.write_stored("mimetype", b"abc").unwrap();
        assert_eq!(writer.remaining_entry_limit("next.bin").unwrap(), 2);
        assert!(writer.write_deflated("next.bin", b"def").is_err());
    }

    #[test]
    fn bounded_output_sink_rejects_zip_overhead() {
        let mut writer = HwpxZipWriter::with_limits(16, 1024, 8);
        assert!(writer.write_stored("mimetype", b"x").is_err());
    }

    #[test]
    fn bounded_output_sink_grows_amortized_under_repeated_small_writes() {
        const WRITES: usize = 100_000;
        let mut output = BoundedCursor::new(WRITES as u64);
        for _ in 0..WRITES {
            output.write_all(b"x").unwrap();
        }
        assert_eq!(output.inner.position(), WRITES as u64);
        assert_eq!(output.into_inner().len(), WRITES);
    }

    #[test]
    fn entry_metadata_is_validated_before_payload_write() {
        let mut writer = HwpxZipWriter::with_limits(4096, 1024, 8);
        assert!(writer.write_stored("../escape", b"x").is_err());
        writer.write_stored("safe.bin", b"x").unwrap();
        assert!(writer.write_stored("safe.bin", b"y").is_err());
    }

    #[test]
    fn aggregate_rejection_bounds_lazy_materialization_of_the_later_resource() {
        #[derive(Debug)]
        struct LimitProbe(AtomicUsize);

        impl crate::model::bin_data::BinDataResolver for LimitProbe {
            fn resolve(&self, _key: &str) -> Vec<u8> {
                unreachable!("HWPX serialization must use bounded resolution")
            }

            fn resolve_limited(&self, _key: &str, max_bytes: usize) -> Option<Vec<u8>> {
                self.0.store(max_bytes, Ordering::SeqCst);
                (max_bytes >= 3).then(|| vec![1, 2, 3])
            }
        }

        let resolver = std::sync::Arc::new(LimitProbe(AtomicUsize::new(0)));
        let bytes =
            crate::model::bin_data::BinDataBytes::lazy(resolver.clone(), "second.bin".to_string());
        let mut writer = HwpxZipWriter::with_limits(4096, 5, 8);
        writer.write_stored("first.bin", b"1234").unwrap();

        assert!(super::super::write_bounded_binary_entry(
            &mut writer,
            "second.bin",
            &bytes,
            "BinData",
        )
        .is_err());
        assert_eq!(resolver.0.load(Ordering::SeqCst), 1);
    }
}
