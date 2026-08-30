//! 외부 입력 변환 파이프라인 JSON 중간 표현 (Neumann 작업 1단계, Task #660).
//!
//! Claude Code Skill이 PDF/이미지/MD/DOCX를 분석하여 생성하는 `ingest_schema_v1.json` 을 읽어
//! Rust 측에서 [`Document`](crate::model::document::Document) IR로 변환하는 경로의 입력 단계다.
//!
//! 사용 예:
//! ```ignore
//! let bytes = std::fs::read("ingest.json").unwrap();
//! let ingest = rhwp::parser::ingest::parse_ingest_bytes(&bytes).unwrap();
//! ```

pub mod schema;

pub use schema::*;

use crate::error::HwpError;
use crate::parser::limits::{InputPolicy, MAX_STRUCTURAL_BYTES};

fn validate_ingest_size(byte_len: usize, policy: InputPolicy) -> Result<(), HwpError> {
    let limit = policy.max_input_bytes().min(MAX_STRUCTURAL_BYTES);
    if byte_len > limit {
        return Err(HwpError::InvalidFile(format!(
            "ingest JSON is {byte_len} bytes and exceeds the {limit} byte limit"
        )));
    }
    Ok(())
}

/// JSON 바이트로부터 [`IngestDocument`]를 파싱한다.
pub fn parse_ingest_bytes(bytes: &[u8]) -> Result<IngestDocument, HwpError> {
    parse_ingest_bytes_with_policy(bytes, InputPolicy::Untrusted)
}

/// Parse one ingest file supplied by an explicit native CLI path.
pub fn parse_ingest_bytes_from_local_file(bytes: &[u8]) -> Result<IngestDocument, HwpError> {
    parse_ingest_bytes_with_policy(bytes, InputPolicy::LocalFileOnce)
}

pub fn parse_ingest_bytes_with_policy(
    bytes: &[u8],
    policy: InputPolicy,
) -> Result<IngestDocument, HwpError> {
    validate_ingest_size(bytes.len(), policy)?;
    serde_json::from_slice::<IngestDocument>(bytes)
        .map_err(|e| HwpError::InvalidFile(format!("ingest JSON 파싱 실패: {e}")))
}

/// 문자열로부터 [`IngestDocument`]를 파싱한다.
pub fn parse_ingest_str(s: &str) -> Result<IngestDocument, HwpError> {
    parse_ingest_bytes(s.as_bytes())
}

#[cfg(test)]
mod resource_limit_tests {
    use super::*;
    use crate::parser::limits::{MAX_STRUCTURAL_BYTES, MAX_UNTRUSTED_INPUT_BYTES};

    #[test]
    fn ingest_policy_boundaries_do_not_require_large_allocations_to_test() {
        assert!(validate_ingest_size(MAX_UNTRUSTED_INPUT_BYTES, InputPolicy::Untrusted).is_ok());
        assert!(
            validate_ingest_size(MAX_UNTRUSTED_INPUT_BYTES + 1, InputPolicy::Untrusted).is_err()
        );
        assert!(validate_ingest_size(MAX_STRUCTURAL_BYTES, InputPolicy::LocalFileOnce).is_ok());
        assert!(
            validate_ingest_size(MAX_STRUCTURAL_BYTES + 1, InputPolicy::LocalFileOnce).is_err()
        );
    }
}
