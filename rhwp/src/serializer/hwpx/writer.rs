//! HWPX ZIP 컨테이너 쓰기
//!
//! `parser::hwpx::reader`의 역방향. ZIP 내부 파일을 특정 순서와 압축 옵션으로 조립한다.
//!
//! 규칙:
//! - `mimetype`은 ZIP 최초 엔트리, STORED(무압축), extra field 없음 (OPC 규격)
//! - 그 외 파일은 DEFLATED
//! - mtime은 1980-01-01 00:00로 고정(결정적 출력)

use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipWriter};

use super::SerializeError;

/// HWPX ZIP 쓰기 래퍼
pub struct HwpxZipWriter {
    inner: ZipWriter<Cursor<Vec<u8>>>,
}

impl HwpxZipWriter {
    /// 새 인메모리 ZIP 라이터 생성
    pub fn new() -> Self {
        HwpxZipWriter {
            inner: ZipWriter::new(Cursor::new(Vec::new())),
        }
    }

    fn fixed_mtime() -> DateTime {
        // 1980-01-01 00:00:00 (ZIP epoch)
        DateTime::default()
    }

    /// STORED(무압축)로 엔트리를 추가한다. `mimetype`에 사용.
    pub fn write_stored(&mut self, name: &str, data: &[u8]) -> Result<(), SerializeError> {
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .last_modified_time(Self::fixed_mtime());
        self.inner
            .start_file(name, opts)
            .map_err(|e| SerializeError::ZipError(e.to_string()))?;
        self.inner
            .write_all(data)
            .map_err(|e| SerializeError::ZipError(e.to_string()))?;
        Ok(())
    }

    /// DEFLATED(압축)로 엔트리를 추가한다.
    pub fn write_deflated(&mut self, name: &str, data: &[u8]) -> Result<(), SerializeError> {
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(Self::fixed_mtime());
        self.inner
            .start_file(name, opts)
            .map_err(|e| SerializeError::ZipError(e.to_string()))?;
        self.inner
            .write_all(data)
            .map_err(|e| SerializeError::ZipError(e.to_string()))?;
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
