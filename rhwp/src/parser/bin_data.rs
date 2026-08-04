//! BinData 스토리지 추출
//!
//! CFB 컨테이너의 BinData/ 스토리지에서 이미지 등 바이너리 데이터를 추출한다.
//! DocInfo의 BinData 목록과 매칭하여 실제 바이트 데이터를 제공한다.

use super::cfb_reader::CfbReader;

/// BinData 추출 에러
#[derive(Debug)]
pub enum BinDataError {
    ReadError(String),
}

impl std::fmt::Display for BinDataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BinDataError::ReadError(e) => write!(f, "BinData 읽기 오류: {}", e),
        }
    }
}

impl std::error::Error for BinDataError {}

/// BinData 콘텐츠 (실제 바이너리 데이터)
#[derive(Debug, Clone)]
pub struct BinDataContent {
    /// 스토리지 내 파일명 (예: "BIN0001.jpg")
    pub storage_name: String,
    /// 바이너리 데이터
    pub data: Vec<u8>,
}

/// CFB 컨테이너에서 모든 BinData 스트림 추출
///
/// BinData/ 스토리지 하위의 모든 스트림을 읽어 반환한다.
pub fn extract_all_bin_data(cfb_reader: &mut CfbReader) -> Vec<BinDataContent> {
    let names = cfb_reader.list_bin_data();
    let mut contents = Vec::new();

    for name in &names {
        if let Ok(data) = cfb_reader.read_bin_data(name) {
            contents.push(BinDataContent {
                storage_name: name.clone(),
                data,
            });
        }
    }

    contents
}

/// 특정 BinData ID에 해당하는 스토리지명 생성
///
/// DocInfo의 BinData 인덱스(0-based)를 BinData 스토리지명으로 변환.
/// HWP 규칙: BIN{XXXX}.{ext} (XXXX = ID+1, 4자리 0패딩)
pub fn bin_data_storage_name(bin_id: u16, extension: &str) -> String {
    format!("BIN{:04X}.{}", bin_id as u32 + 1, extension)
}

/// 특정 BinData 읽기
pub fn read_bin_data_by_name(
    cfb_reader: &mut CfbReader,
    storage_name: &str,
) -> Result<Vec<u8>, BinDataError> {
    cfb_reader
        .read_bin_data(storage_name)
        .map_err(|e| BinDataError::ReadError(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bin_data_storage_name() {
        assert_eq!(bin_data_storage_name(0, "jpg"), "BIN0001.jpg");
        assert_eq!(bin_data_storage_name(1, "png"), "BIN0002.png");
        assert_eq!(bin_data_storage_name(15, "bmp"), "BIN0010.bmp");
        assert_eq!(bin_data_storage_name(255, "gif"), "BIN0100.gif");
    }

    #[test]
    fn test_bin_data_content() {
        let content = BinDataContent {
            storage_name: "BIN0001.jpg".to_string(),
            data: vec![0xFF, 0xD8, 0xFF, 0xE0], // JPEG header
        };
        assert_eq!(content.storage_name, "BIN0001.jpg");
        assert_eq!(content.data.len(), 4);
    }
}
