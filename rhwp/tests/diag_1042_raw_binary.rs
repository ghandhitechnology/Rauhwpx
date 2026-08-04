//! 5 파일 (변환기 + 2010/2018/2022/2024) 의 BodyText raw bytes 의
//! HWPTAG_PARA_HEADER (66) / HWPTAG_PARA_LINE_SEG (69) record 분포 비교

const TAG_PARA_HEADER: u32 = 66;
const TAG_PARA_TEXT: u32 = 67;
const TAG_PARA_CHAR_SHAPE: u32 = 68;
const TAG_PARA_LINE_SEG: u32 = 69;

/// HWPTAG record header decode: (tag_id, level, size, header_extended)
fn decode_record(data: &[u8], offset: usize) -> Option<(u32, u32, u32, usize)> {
    if offset + 4 > data.len() {
        return None;
    }
    let hdr = u32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]);
    let tag_id = hdr & 0x3FF;
    let level = (hdr >> 10) & 0x3FF;
    let size_raw = (hdr >> 20) & 0xFFF;
    if size_raw == 0xFFF {
        if offset + 8 > data.len() {
            return None;
        }
        let ext_size = u32::from_le_bytes([
            data[offset + 4],
            data[offset + 5],
            data[offset + 6],
            data[offset + 7],
        ]);
        Some((tag_id, level, ext_size, 8))
    } else {
        Some((tag_id, level, size_raw, 4))
    }
}

fn analyze_section(name: &str, raw: &[u8]) {
    let mut offset = 0;
    let mut para_count = 0;
    let mut para_text_count = 0;
    let mut para_char_shape_count = 0;
    let mut para_line_seg_count = 0;
    // PARA_HEADER 직후 다음 PARA_HEADER 까지 사이의 records 분석
    let mut current_para_records: Vec<u32> = Vec::new();
    let mut paras_without_line_seg = 0;
    let mut paras_with_line_seg = 0;

    let flush_para = |records: &[u32], without: &mut i32, with: &mut i32| {
        if !records.is_empty() {
            if records.contains(&TAG_PARA_LINE_SEG) {
                *with += 1;
            } else {
                *without += 1;
            }
        }
    };

    while let Some((tag_id, _level, size, hdr_len)) = decode_record(raw, offset) {
        if tag_id == TAG_PARA_HEADER {
            // flush previous paragraph
            if !current_para_records.is_empty() {
                if current_para_records.contains(&TAG_PARA_LINE_SEG) {
                    paras_with_line_seg += 1;
                } else {
                    paras_without_line_seg += 1;
                }
            }
            para_count += 1;
            current_para_records.clear();
        } else {
            current_para_records.push(tag_id);
            if tag_id == TAG_PARA_TEXT {
                para_text_count += 1;
            }
            if tag_id == TAG_PARA_CHAR_SHAPE {
                para_char_shape_count += 1;
            }
            if tag_id == TAG_PARA_LINE_SEG {
                para_line_seg_count += 1;
            }
        }
        offset += hdr_len + size as usize;
        if offset >= raw.len() {
            break;
        }
    }
    // last paragraph flush
    if !current_para_records.is_empty() {
        if current_para_records.contains(&TAG_PARA_LINE_SEG) {
            paras_with_line_seg += 1;
        } else {
            paras_without_line_seg += 1;
        }
    }
    let _ = flush_para;

    eprintln!("  {} (size {} bytes):", name, raw.len());
    eprintln!(
        "    PARA_HEADER count: {}, PARA_TEXT: {}, PARA_CHAR_SHAPE: {}, PARA_LINE_SEG: {}",
        para_count, para_text_count, para_char_shape_count, para_line_seg_count
    );
    eprintln!(
        "    paras with PARA_LINE_SEG: {}, without: {}",
        paras_with_line_seg, paras_without_line_seg
    );
}

#[test]
fn diag_5files_raw_record_distribution() {
    let files = [
        ("변환기", "samples/hwp3-sample16-hwp5.hwp"),
        ("2010", "samples/hwp3-sample16-hwp5-2010.hwp"),
        ("2018", "samples/hwp3-sample16-hwp5-2018.hwp"),
        ("2022", "samples/hwp3-sample16-hwp5-2022.hwp"),
        ("2024", "samples/hwp3-sample16-hwp5-2024.hwp"),
    ];
    for (label, path) in &files {
        let bytes = std::fs::read(path).expect("read");
        let doc = rhwp::parser::parse_hwp(&bytes).expect("parse");
        eprintln!(
            "\n=== {} ({}): {} sections ===",
            label,
            path,
            doc.sections.len()
        );
        for (si, section) in doc.sections.iter().enumerate() {
            let raw = section.raw_stream.as_ref();
            if let Some(raw) = raw {
                analyze_section(&format!("section {}", si), raw);
            } else {
                eprintln!("  section {}: raw_stream is None", si);
            }
        }
    }
}
