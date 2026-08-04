//! Issue #1058: 한컴편집기 신규 각주 추가 시 본문 다단계 목록 + 글머리표 부작용 회귀 가드.
//!
//! 본 task 는 작업지시자 통찰 "정답지와 저장 버전과 차이를 통해 추론" 패턴으로
//! 4 단계 정정:
//!
//! 1. **PARA_HEADER instance_id (HWPX `<hp:p id>`)** — 다단계 목록 "1.1.1.1.1.1" 부작용 해소
//!    (src/parser/hwpx/section.rs, raw_header_extra)
//! 2. **ParaShape line_spacing_v2 (UINT32, 5.0.2.5)** — 각주 추가 시 줄간격 160% 부작용 해소
//!    (src/parser/hwpx/header.rs::parse_para_shape)
//! 3. **Style lang_id (INT16) + trailing 2 byte** — 각주 추가 시 왼쪽 여백 60.0pt 부작용 해소
//!    (src/model/style.rs, src/parser/doc_info.rs, src/serializer/doc_info.rs,
//!    src/parser/hwpx/header.rs::parse_style)
//! 4. **HWPX `<hh:bullet>` 파싱 추가** — 일반 문단 자동 글머리표 부작용 해소
//!    (src/parser/hwpx/header.rs, parse_bullet_hwpx)
//!
//! 추가 정정: TextBox LIST_HEADER 13 byte (글상자 paragraph 한컴 contract).
//!
//! 참조: `hwplib::ForTextBox::listHeader` + HWP5 spec 표 47/58/65.
//!
//! 작업지시자 한컴 한글 2020 시각 판정 4 라운드 통과:
//! - 다단계 목록 부여 없음 (Stage 9)
//! - 각주 본문 정상 스타일 (Stage 12)
//! - 일반 문단 글머리표 없음 (Stage 14)
//! - 부작용 없음 (Stage 15)

use std::fs;
use std::path::Path;

fn load(rel: &str) -> rhwp::wasm_api::HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", rel, e));
    rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse")
}

/// CFB stream BodyText/Section0 의 LIST_HEADER 레코드 모두 추출 (tag=72).
fn collect_list_header_sizes(hwp_bytes: &[u8]) -> Vec<(u16, usize)> {
    use std::io::Read;
    let cursor = std::io::Cursor::new(hwp_bytes);
    let mut comp = cfb::CompoundFile::open(cursor).expect("cfb open");
    let mut fh = comp.open_stream("/FileHeader").expect("FileHeader");
    let mut fh_data = Vec::new();
    fh.read_to_end(&mut fh_data).expect("read FileHeader");
    let is_compressed = fh_data.get(36).map(|b| (b & 0x01) != 0).unwrap_or(false);
    drop(fh);

    let mut sec0 = comp.open_stream("/BodyText/Section0").expect("Section0");
    let mut raw = Vec::new();
    sec0.read_to_end(&mut raw).expect("read Section0");

    let data = if is_compressed {
        let mut decoder = flate2::read::DeflateDecoder::new(&raw[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).expect("inflate");
        decompressed
    } else {
        raw
    };

    let mut out = Vec::new();
    let mut pos = 0;
    while pos + 4 <= data.len() {
        let hdr = u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let tag = (hdr & 0x3FF) as u16;
        let level = ((hdr >> 10) & 0x3FF) as u16;
        let mut size = ((hdr >> 20) & 0xFFF) as usize;
        pos += 4;
        if size == 0xFFF && pos + 4 <= data.len() {
            size = u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                as usize;
            pos += 4;
        }
        if tag == 72 {
            out.push((level, size));
        }
        pos += size;
    }
    out
}

/// HWPX 출처 footnote-tbox-01.hwpx 의 글상자 LIST_HEADER 가 33 byte 한컴 정합.
#[test]
fn issue_1058_textbox_list_header_size_33() {
    let mut doc = load("samples/hwpx/footnote-tbox-01.hwpx");
    let hwp_bytes = doc.export_hwp_with_adapter().expect("export");
    let lh_sizes = collect_list_header_sizes(&hwp_bytes);

    // 글상자 LIST_HEADER size=33 가 적어도 1개 존재해야 함 (본 sample 글상자 1개)
    let has_textbox_lh = lh_sizes.iter().any(|(_, sz)| *sz == 33);
    assert!(
        has_textbox_lh,
        "글상자 LIST_HEADER size=33 (한컴 contract) 가 적어도 1개 존재해야 함. \
         actual sizes: {:?}",
        lh_sizes
    );
}

/// HWP 출처 라운드트립 회귀 부재 — table-in-tbox.hwp 의 글상자 LIST_HEADER 33 유지.
#[test]
fn issue_1058_hwp_textbox_roundtrip() {
    let mut doc = load("samples/table-in-tbox.hwp");
    let hwp_bytes = doc.export_hwp_with_adapter().expect("export");
    let lh_sizes = collect_list_header_sizes(&hwp_bytes);

    // HWP 출처는 raw_list_header_extra 보존으로 size 정합
    let has_textbox_lh = lh_sizes.iter().any(|(_, sz)| *sz == 33);
    assert!(
        has_textbox_lh,
        "HWP 출처 table-in-tbox 의 글상자 LIST_HEADER 33 보존. actual sizes: {:?}",
        lh_sizes
    );
}

/// Task #1050 회귀 가드 양립 — footnote LIST_HEADER size=16 (글상자 33 과 별개).
#[test]
fn issue_1058_footnote_list_header_size_16_preserved() {
    let mut doc = load("samples/hwpx/footnote-tbox-01.hwpx");
    let hwp_bytes = doc.export_hwp_with_adapter().expect("export");
    let lh_sizes = collect_list_header_sizes(&hwp_bytes);

    // footnote LIST_HEADER size=16 가 적어도 2개 존재 (글상자 안 + 본문 각주)
    let footnote_lh_count = lh_sizes.iter().filter(|(_, sz)| *sz == 16).count();
    assert!(
        footnote_lh_count >= 2,
        "footnote LIST_HEADER size=16 적어도 2개 (Task #1050 정합). actual sizes: {:?}",
        lh_sizes
    );
}

/// 글상자 LIST_HEADER 의 정확한 raw byte 매핑 — hwplib::ForTextBox::listHeader 정합.
#[test]
fn issue_1058_textbox_list_header_byte_contract() {
    let mut doc = load("samples/hwpx/footnote-tbox-01.hwpx");
    let hwp_bytes = doc.export_hwp_with_adapter().expect("export");

    // CFB 직접 읽어 LIST_HEADER tag=72 size=33 payload 추출
    use std::io::Read;
    let cursor = std::io::Cursor::new(&hwp_bytes);
    let mut comp = cfb::CompoundFile::open(cursor).expect("cfb open");
    let mut fh = comp.open_stream("/FileHeader").expect("FileHeader");
    let mut fh_data = Vec::new();
    fh.read_to_end(&mut fh_data).expect("read FileHeader");
    let is_compressed = fh_data.get(36).map(|b| (b & 0x01) != 0).unwrap_or(false);
    drop(fh);

    let mut sec0 = comp.open_stream("/BodyText/Section0").expect("Section0");
    let mut raw = Vec::new();
    sec0.read_to_end(&mut raw).expect("read Section0");
    let data = if is_compressed {
        let mut decoder = flate2::read::DeflateDecoder::new(&raw[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).expect("inflate");
        decompressed
    } else {
        raw
    };

    let mut pos = 0;
    let mut found = None;
    while pos + 4 <= data.len() {
        let hdr = u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let tag = hdr & 0x3FF;
        let mut size = ((hdr >> 20) & 0xFFF) as usize;
        pos += 4;
        if size == 0xFFF && pos + 4 <= data.len() {
            size = u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                as usize;
            pos += 4;
        }
        if tag == 72 && size == 33 {
            found = Some(data[pos..pos + size].to_vec());
            break;
        }
        pos += size;
    }

    let payload = found.expect("글상자 LIST_HEADER (size=33) 찾기");

    // hwplib::ForTextBox::listHeader 정합 체크:
    // offset 20..28: zero 8 byte
    assert_eq!(
        &payload[20..28],
        &[0u8; 8],
        "TextBox LIST_HEADER offset 20-27: zero 8 byte padding"
    );
    // offset 28..32: editableAtFormMode = 0 (false)
    let editable = i32::from_le_bytes([payload[28], payload[29], payload[30], payload[31]]);
    assert_eq!(
        editable, 0,
        "TextBox LIST_HEADER offset 28-31: editableAtFormMode = 0"
    );
    // offset 32: fieldName flag = 0 (no fieldName)
    assert_eq!(
        payload[32], 0,
        "TextBox LIST_HEADER offset 32: fieldName flag = 0"
    );
}

/// HWPX `<hp:p id>` → HWP PARA_HEADER instance_id 매핑 (다단계 목록 부작용 정정).
#[test]
fn issue_1058_paragraph_instance_id_mapped() {
    let doc = load("samples/hwpx/footnote-01.hwpx");
    let document = doc.document();
    // HWPX paragraph 중 id="2147483648" (=0x80000000) 인 것이 존재해야 함
    let mut has_msb = false;
    for sec in &document.sections {
        for p in &sec.paragraphs {
            if p.raw_header_extra.len() >= 10 {
                let iid = u32::from_le_bytes([
                    p.raw_header_extra[6],
                    p.raw_header_extra[7],
                    p.raw_header_extra[8],
                    p.raw_header_extra[9],
                ]);
                if iid & 0x80000000 != 0 {
                    has_msb = true;
                }
            }
        }
    }
    assert!(
        has_msb,
        "HWPX `<hp:p id>` 의 MSB set (예: 2147483648) paragraph 가 raw_header_extra 에 보존되어야 함"
    );
}

/// ParaShape line_spacing_v2 (UINT32, 5.0.2.5) 보정 — 각주 줄간격 160% 부작용 정정.
#[test]
fn issue_1058_para_shape_line_spacing_v2_synced() {
    let doc = load("samples/hwpx/footnote-01.hwpx");
    let document = doc.document();
    // 모든 ParaShape 의 line_spacing_v2 가 line_spacing 과 동기화되어야 함 (0 인 경우 제외)
    for (i, ps) in document.doc_info.para_shapes.iter().enumerate() {
        if ps.line_spacing != 0 {
            assert_ne!(
                ps.line_spacing_v2, 0,
                "ps[{}]: line_spacing={} 이면 line_spacing_v2 도 보정되어야 함",
                i, ps.line_spacing
            );
        }
    }
}

/// Style record 의 lang_id (INT16) 필드 — 각주 왼쪽 여백 60.0pt 부작용 정정.
#[test]
fn issue_1058_style_lang_id_preserved() {
    let doc = load("samples/hwpx/footnote-01.hwpx");
    let document = doc.document();
    // HWPX 의 langID="1042" (한국어) 가 모든 Style 에 보존
    for (i, st) in document.doc_info.styles.iter().enumerate() {
        assert_eq!(
            st.lang_id, 1042,
            "style[{}] ({}): HWPX langID=1042 매핑 필요 (Task #1058 본질)",
            i, st.local_name
        );
    }
}

/// HWPX `<hh:bullet>` 파싱 — 일반 문단 글머리표 부작용 정정.
#[test]
fn issue_1058_bullet_records_preserved() {
    let doc = load("samples/hwpx/footnote-01.hwpx");
    let document = doc.document();
    // HWPX <hh:bullets itemCnt="4"> → IR bullets 4 개 보존
    assert_eq!(
        document.doc_info.bullets.len(),
        4,
        "HWPX <hh:bullet> 4개가 IR.bullets 에 보존되어야 함. \
         누락 시 한컴이 default 글머리표를 본문 paragraph 에 부여 (글머리표 부작용)"
    );
    // 첫 bullet 의 char = '❏'
    let first = &document.doc_info.bullets[0];
    assert_ne!(
        first.bullet_char as u32, 0,
        "bullet[0].bullet_char 가 HWPX char 속성에서 매핑되어야 함"
    );
}

/// 직렬화 후 BULLET record 4개 작성 단언 (한컴 정답지 정합).
#[test]
fn issue_1058_serialized_bullet_count() {
    let mut doc = load("samples/hwpx/footnote-01.hwpx");
    let hwp_bytes = doc.export_hwp_with_adapter().expect("export");

    // DocInfo stream 의 BULLET tag (24) 개수 카운트
    use std::io::Read;
    let cursor = std::io::Cursor::new(&hwp_bytes);
    let mut comp = cfb::CompoundFile::open(cursor).expect("cfb open");
    let mut fh = comp.open_stream("/FileHeader").expect("FileHeader");
    let mut fh_data = Vec::new();
    fh.read_to_end(&mut fh_data).expect("read FileHeader");
    let is_compressed = fh_data.get(36).map(|b| (b & 0x01) != 0).unwrap_or(false);
    drop(fh);

    let mut docinfo = comp.open_stream("/DocInfo").expect("DocInfo");
    let mut raw = Vec::new();
    docinfo.read_to_end(&mut raw).expect("read DocInfo");
    let data = if is_compressed {
        let mut decoder = flate2::read::DeflateDecoder::new(&raw[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).expect("inflate");
        decompressed
    } else {
        raw
    };

    let mut pos = 0;
    let mut bullet_count = 0;
    while pos + 4 <= data.len() {
        let hdr = u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let tag = hdr & 0x3FF;
        let mut size = ((hdr >> 20) & 0xFFF) as usize;
        pos += 4;
        if size == 0xFFF && pos + 4 <= data.len() {
            size = u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                as usize;
            pos += 4;
        }
        if tag == 24 {
            bullet_count += 1;
        }
        pos += size;
    }
    assert_eq!(
        bullet_count, 4,
        "DocInfo BULLET (tag=24) record 4개 작성 필요 (한컴 정답지 footnote-01.hwp 정합). \
         누락 시 한컴이 default 글머리표 부여"
    );
}

/// [Task #1058 reopen Round 5] 신규 각주 inner_para contract 정합 (정답지 비교).
///
/// 정답지 samples/footnote-01.hwp 의 각주 inner_para 패턴:
///   - text = "  플라스틱 액체란" (2 placeholder spaces + 본문)
///   - char_offsets = [0, 8, 9, 10, ...] (AutoNumber 8 cu 차지 jump)
///   - char_count = 18 (10 chars + 8 AutoNumber)
///   - style_id = 11, controls = [AutoNumber], control_mask bit 18 set
///
/// 신규 각주 (`insert_footnote_native` 직후 빈 본문) contract:
///   - text = "  " (placeholder ×2)
///   - char_offsets = [0, 8]
///   - char_count = 10 (2 + 8)
///   - style_id = 11, controls = [AutoNumber], control_mask bit 18 set
///
/// 누락 시 한컴이 각주 번호 "2)" 표시 안 함 (saved/222footnote-01.hwp 결함).
#[test]
fn issue_1058_new_footnote_inner_para_contract() {
    use rhwp::model::control::Control;
    let mut doc = load("samples/footnote-01.hwp");
    // 본문 paragraph 0 의 char_offset=0 에 신규 각주 삽입 (native API).
    doc.insert_footnote_native(0, 0, 0)
        .expect("insert_footnote_native");

    // 신규 footnote 찾기 — section 0 의 첫 paragraph (para_idx=0) 에 삽입된 footnote.
    let document = doc.document();
    let inner = {
        let para = &document.sections[0].paragraphs[0];
        let mut found: Option<&rhwp::model::paragraph::Paragraph> = None;
        for ctrl in &para.controls {
            if let Control::Footnote(fn_) = ctrl {
                found = fn_.paragraphs.first();
                break;
            }
        }
        found.expect("paragraph 0 에 신규 footnote inner_para 존재해야 함")
    };

    // 정답지 패턴 단언
    assert_eq!(inner.text, "  ", "inner_para text = 2 placeholder spaces");
    assert_eq!(
        inner.char_offsets,
        vec![0u32, 8u32],
        "char_offsets = [0, 8] (AutoNumber 8 cu 차지)"
    );
    assert_eq!(
        inner.char_count, 10,
        "char_count = 10 (2 placeholder + 8 AutoNumber)"
    );
    assert_eq!(inner.style_id, 11, "style_id = 11 (각주 style)");
    assert_eq!(inner.controls.len(), 1, "controls = [AutoNumber] 1 개");
    assert!(
        matches!(inner.controls[0], Control::AutoNumber(_)),
        "controls[0] = AutoNumber"
    );
    assert_ne!(
        inner.control_mask & (1u32 << 0x12),
        0,
        "control_mask bit 18 (AutoNumber) set"
    );
}
