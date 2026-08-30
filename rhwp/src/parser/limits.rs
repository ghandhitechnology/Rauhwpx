//! Shared parser input and container resource limits.

use super::ParseError;
use std::io::{self, Read};
use std::path::Path;

/// Raw bytes accepted from a remote or otherwise untrusted source.
pub const MAX_UNTRUSTED_INPUT_BYTES: usize = 128 * 1024 * 1024;

/// Raw bytes accepted after a native file picker approved one exact local file.
///
/// Callers must not treat this as a persistent permission or apply it to URLs,
/// drag payloads, clipboard data, or a different path selected later.
pub const MAX_LOCAL_FILE_INPUT_BYTES: usize = 512 * 1024 * 1024;

/// Maximum sum of declared streams or expanded ZIP members in one document.
pub const MAX_CONTAINER_BYTES: u64 = 512 * 1024 * 1024;

/// Maximum expanded size of XML and other structural document streams.
pub const MAX_STRUCTURAL_BYTES: usize = 256 * 1024 * 1024;

/// Maximum expanded size of one embedded binary stream.
pub const MAX_BINARY_BYTES: usize = 512 * 1024 * 1024;

/// Maximum expanded size of a document thumbnail.
pub const MAX_THUMBNAIL_BYTES: usize = 64 * 1024 * 1024;

/// Maximum number of members in an HWPX ZIP package.
pub const MAX_HWPX_ENTRIES: usize = 4096;

/// Maximum raw central-directory metadata accepted before the ZIP crate parses it.
///
/// Entry bodies have separate expanded limits. This cap prevents thousands of
/// maximum-size ZIP extra/comment fields from multiplying metadata allocations.
pub const MAX_HWPX_CENTRAL_DIRECTORY_BYTES: usize = 32 * 1024 * 1024;

/// Maximum number of directory entries in an HWP/OLE CFB container.
///
/// Directory records are parsed before stream byte budgets can be enforced.
/// Without a separate count limit, a small-stream container can multiply its
/// memory and traversal cost with hundreds of thousands of 128-byte records.
pub const MAX_CFB_DIRECTORY_ENTRIES: usize = 4096;

/// Maximum UTF-8 byte length of one HWPX member name.
///
/// ZIP permits 65,535-byte names. Keeping thousands of names of that size is a
/// separate allocation bomb even when every member has an empty body.
pub const MAX_HWPX_ENTRY_NAME_BYTES: usize = 4096;

/// Describes how the caller obtained the raw document bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputPolicy {
    /// Network, IPC, clipboard, drag, or any source without a fresh exact-file approval.
    Untrusted,
    /// A single exact local file approved through a native picker for this open attempt.
    LocalFileOnce,
}

impl InputPolicy {
    pub const fn max_input_bytes(self) -> usize {
        match self {
            Self::Untrusted => MAX_UNTRUSTED_INPUT_BYTES,
            Self::LocalFileOnce => MAX_LOCAL_FILE_INPUT_BYTES,
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Untrusted => "untrusted",
            Self::LocalFileOnce => "approved local file",
        }
    }
}

/// Read the one explicit path supplied to a native CLI operation.
///
/// The handle is opened before metadata is inspected, allocation is capped,
/// and `limit + 1` bytes are observed so file growth cannot bypass the check.
pub fn read_local_file_once(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    read_local_file_once_with_limit(path.as_ref(), MAX_LOCAL_FILE_INPUT_BYTES)
}

/// Testable implementation of [`read_local_file_once`]. The supplied limit is
/// always clamped to the parser's local-file ceiling.
#[doc(hidden)]
pub fn read_local_file_once_with_limit(path: &Path, max_bytes: usize) -> io::Result<Vec<u8>> {
    let max_bytes = max_bytes.min(MAX_LOCAL_FILE_INPUT_BYTES);
    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "input path is not a regular file",
        ));
    }
    if metadata.len() > max_bytes as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("input exceeds the {max_bytes} byte limit"),
        ));
    }

    let initial_capacity = usize::try_from(metadata.len())
        .unwrap_or(max_bytes)
        .min(max_bytes)
        .min(1024 * 1024);
    let mut bytes = Vec::with_capacity(initial_capacity);
    file.take((max_bytes as u64).saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("input exceeds the {max_bytes} byte limit"),
        ));
    }
    Ok(bytes)
}

pub(crate) fn validate_input_size(byte_len: usize, policy: InputPolicy) -> Result<(), ParseError> {
    let limit = policy.max_input_bytes();
    if byte_len > limit {
        return Err(ParseError::InputLimitExceeded {
            actual: byte_len,
            limit,
            source: policy.label(),
        });
    }
    Ok(())
}

/// Add an attacker-controlled length to a running package total.
pub(crate) fn add_to_container_total(
    total: &mut u64,
    amount: u64,
    context: &'static str,
) -> Result<(), ParseError> {
    let next = total
        .checked_add(amount)
        .ok_or(ParseError::ContainerLimitExceeded {
            actual: u64::MAX,
            limit: MAX_CONTAINER_BYTES,
            context,
        })?;
    if next > MAX_CONTAINER_BYTES {
        return Err(ParseError::ContainerLimitExceeded {
            actual: next,
            limit: MAX_CONTAINER_BYTES,
            context,
        });
    }
    *total = next;
    Ok(())
}

/// Clamp one member read to the bytes still available in the aggregate budget.
///
/// Callers must compute this before reading or decompressing attacker-controlled
/// data. A zero-byte result is intentional: bounded readers can still accept an
/// empty member, but they reject the first observed byte without retaining a
/// member-sized allocation.
pub(crate) fn remaining_container_member_limit(total: u64, member_limit: usize) -> usize {
    let remaining = MAX_CONTAINER_BYTES.saturating_sub(total);
    usize::try_from(remaining)
        .unwrap_or(usize::MAX)
        .min(member_limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn input_policies_have_distinct_boundaries_without_allocating_them() {
        assert!(validate_input_size(MAX_UNTRUSTED_INPUT_BYTES, InputPolicy::Untrusted).is_ok());
        assert!(
            validate_input_size(MAX_UNTRUSTED_INPUT_BYTES + 1, InputPolicy::Untrusted).is_err()
        );
        assert!(
            validate_input_size(MAX_LOCAL_FILE_INPUT_BYTES, InputPolicy::LocalFileOnce).is_ok()
        );
        assert!(
            validate_input_size(MAX_LOCAL_FILE_INPUT_BYTES + 1, InputPolicy::LocalFileOnce)
                .is_err()
        );
    }

    #[test]
    fn aggregate_budget_uses_checked_arithmetic() {
        let mut total = MAX_CONTAINER_BYTES - 1;
        add_to_container_total(&mut total, 1, "test").unwrap();
        assert_eq!(total, MAX_CONTAINER_BYTES);
        assert!(add_to_container_total(&mut total, 1, "test").is_err());

        let mut overflow = u64::MAX;
        assert!(add_to_container_total(&mut overflow, 1, "test").is_err());
    }

    #[test]
    fn nearly_exhausted_aggregate_clamps_structural_and_binary_members_before_allocation() {
        let nearly_full = MAX_CONTAINER_BYTES - 7;

        assert_eq!(
            remaining_container_member_limit(nearly_full, MAX_STRUCTURAL_BYTES),
            7
        );
        assert_eq!(
            remaining_container_member_limit(nearly_full, MAX_BINARY_BYTES),
            7
        );
        assert_eq!(
            remaining_container_member_limit(MAX_CONTAINER_BYTES, MAX_BINARY_BYTES),
            0
        );
        assert_eq!(
            remaining_container_member_limit(MAX_CONTAINER_BYTES + 1, MAX_BINARY_BYTES),
            0
        );
    }

    #[test]
    fn local_reader_accepts_the_boundary_and_rejects_one_byte_more() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "rhwp-parser-limit-{}-{nonce}.bin",
            std::process::id()
        ));
        std::fs::write(&path, [7u8; 17]).unwrap();

        assert_eq!(
            read_local_file_once_with_limit(&path, 17).unwrap().len(),
            17
        );
        let error = read_local_file_once_with_limit(&path, 16).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        std::fs::remove_file(path).unwrap();
    }
}
