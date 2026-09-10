//! Port of edwardkim/rhwp #6885.
#![cfg(not(target_arch = "wasm32"))]

use rhwp::parser::cfb_reader::LenientCfbReader;
use std::io::{Cursor, Write};

const CAP: usize = 64 * 1024 * 1024;
const BODY: &[u8] = b"body-text-section-payload";
const VIEW: &[u8] = b"view-text-section-payload-that-is-longer";

fn small_cfb(streams: &[(&str, &[u8])]) -> Vec<u8> {
    let mut cfb =
        cfb::CompoundFile::create_with_version(cfb::Version::V3, Cursor::new(Vec::new())).unwrap();
    for &(path, contents) in streams {
        let parent = std::path::Path::new(path).parent().unwrap();
        if parent != std::path::Path::new("/") && !parent.as_os_str().is_empty() {
            cfb.create_storage_all(parent).unwrap();
        }
        cfb.create_stream(path)
            .unwrap()
            .write_all(contents)
            .unwrap();
    }
    cfb.into_inner().into_inner()
}

fn cfb_with_view_text_section_listed_before_body_text() -> Vec<u8> {
    small_cfb(&[("/ViewText/Section0", VIEW), ("/BodyText/Section0", BODY)])
}

fn directory_offset(bytes: &[u8]) -> usize {
    assert_eq!(u16::from_le_bytes(bytes[30..32].try_into().unwrap()), 9);
    let sid = u32::from_le_bytes(bytes[48..52].try_into().unwrap()) as usize;
    (sid + 1) * 512
}

fn set_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

#[test]
fn lenient_cfb_resolves_same_named_streams_by_path() {
    let data = cfb_with_view_text_section_listed_before_body_text();
    let lenient = LenientCfbReader::open(&data).expect("lenient open");

    let same_named = lenient
        .list_entries()
        .iter()
        .filter(|(name, _, _, _)| name == "Section0")
        .count();
    assert_eq!(
        same_named, 2,
        "표본에 이름이 Section0 인 스트림이 둘이어야 이 테스트가 의미가 있다"
    );

    let body = lenient
        .read_stream_limited("/BodyText/Section0", CAP)
        .expect("/BodyText/Section0 를 읽을 수 있어야 한다");
    let view = lenient
        .read_stream_limited("/ViewText/Section0", CAP)
        .expect("/ViewText/Section0 를 읽을 수 있어야 한다");

    assert_ne!(
        body.len(),
        view.len(),
        "두 경로가 같은 스트림으로 풀렸다 — 이름만 비교하고 있다"
    );
    assert_eq!(body, BODY, "/BodyText/Section0 가 ViewText 쪽으로 풀렸다");
    assert_eq!(view, VIEW, "/ViewText/Section0 내용이 다르다");
}

#[test]
fn lenient_body_text_section_reads_bodytext_storage() {
    let data = cfb_with_view_text_section_listed_before_body_text();
    let lenient = LenientCfbReader::open(&data).expect("lenient open");

    let raw = lenient
        .read_body_text_section_raw_limited(0, CAP)
        .expect("BodyText Section0 raw");
    assert_eq!(raw, BODY, "본문 섹션 읽기가 ViewText 스트림을 집었다");
}

fn small_header_cfb() -> Vec<u8> {
    small_cfb(&[("/FileHeader", b"valid header")])
}

#[test]
fn lenient_cfb_invalid_named_slot_falls_back_to_valid_stream() {
    for invalid_type in [0, 255] {
        let mut bytes = small_header_cfb();
        let dir = directory_offset(&bytes);
        let valid_id = u32::from_le_bytes(bytes[dir + 76..dir + 80].try_into().unwrap());
        assert_eq!(valid_id, 1);
        let entry = bytes[dir + 128..dir + 256].to_vec();
        bytes[dir + 256..dir + 384].copy_from_slice(&entry);
        bytes[dir + 256 + 66] = invalid_type;
        set_u32(&mut bytes, dir + 76, 2);

        let reader = LenientCfbReader::open(&bytes).unwrap();
        assert_eq!(reader.read_file_header().unwrap(), b"valid header");
    }
}

#[test]
fn lenient_cfb_broken_child_link_recovers_only_unique_names() {
    let mut bytes = small_header_cfb();
    let dir = directory_offset(&bytes);
    set_u32(&mut bytes, dir + 76, 10_000);
    let reader = LenientCfbReader::open(&bytes).unwrap();
    assert_eq!(reader.read_file_header().unwrap(), b"valid header");

    let mut bytes = cfb_with_view_text_section_listed_before_body_text();
    let dir = directory_offset(&bytes);
    set_u32(&mut bytes, dir + 76, 10_000);
    let reader = LenientCfbReader::open(&bytes).unwrap();
    assert!(!reader.has_stream("/BodyText/Section0"));
    assert!(reader
        .read_stream_limited("/BodyText/Section0", CAP)
        .is_err());
}

#[test]
fn lenient_cfb_stream_cannot_be_used_as_parent_storage() {
    let mut bytes = small_cfb(&[("/BodyText/Section0", b"body"), ("/Section0", b"other")]);
    let dir = directory_offset(&bytes);
    assert_eq!(bytes[dir + 128 + 66], 1);
    bytes[dir + 128 + 66] = 2;
    let reader = LenientCfbReader::open(&bytes).unwrap();
    assert!(reader
        .read_stream_limited("/BodyText/Section0", CAP)
        .is_err());
}

#[test]
fn lenient_cfb_cyclic_sibling_link_terminates_and_recovers_unique_name() {
    let mut bytes = small_header_cfb();
    let dir = directory_offset(&bytes);
    let entry = bytes[dir + 128..dir + 256].to_vec();
    bytes[dir + 256..dir + 384].copy_from_slice(&entry);
    bytes[dir + 256 + 66] = 0;
    bytes[dir + 256] = b'X';
    set_u32(&mut bytes, dir + 256 + 68, 2);
    set_u32(&mut bytes, dir + 256 + 72, 2);
    set_u32(&mut bytes, dir + 76, 2);
    let reader = LenientCfbReader::open(&bytes).unwrap();
    assert_eq!(reader.read_file_header().unwrap(), b"valid header");
}
