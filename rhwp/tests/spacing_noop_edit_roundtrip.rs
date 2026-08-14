//! 무변경 편집 + 반복 저장/재열기 간격 안정성 계약.
//!
//! 문단 간격(spacingBefore/After)과 줄 간격은 raw HWPUNIT, 해소 px, 1×/2×
//! 저장 배율을 오간다. 편집이 실제 값을 바꾸지 않았다면(삽입 후 삭제),
//! 저장·재열기를 반복해도 간격이 직렬화 정수 허용치 안에서 안정해야 한다.

use rhwp::wasm_api::HwpDocument;

/// 직렬화 정수 허용치 (1 HWPUNIT ≈ 0.013px, px 표현 오차 여유 포함)
const TOL_PX: f64 = 0.5;

fn load_bytes(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn open(bytes: &[u8], editable: bool) -> HwpDocument {
    let mut doc = HwpDocument::from_bytes(bytes).expect("파싱");
    if editable {
        doc.convert_to_editable_native().expect("편집 전환");
    }
    doc
}

fn spacing_triplet(json: &str, key: &str) -> f64 {
    let needle = format!("\"{key}\":");
    let start = json.find(&needle).map(|i| i + needle.len());
    let Some(start) = start else { return f64::NAN };
    let rest = &json[start..];
    let end = rest
        .find(|c: char| c != '-' && c != '.' && !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse().unwrap_or(f64::NAN)
}

fn capture_spacings(doc: &HwpDocument) -> Vec<(f64, f64, f64)> {
    let count = doc.get_paragraph_count_native(0).unwrap_or(0).min(10);
    (0..count)
        .filter_map(|pi| doc.get_para_properties_at_native(0, pi).ok())
        .map(|json| {
            (
                spacing_triplet(&json, "spacingBefore"),
                spacing_triplet(&json, "spacingAfter"),
                spacing_triplet(&json, "lineSpacing"),
            )
        })
        .collect()
}

fn assert_spacings_close(before: &[(f64, f64, f64)], after: &[(f64, f64, f64)], label: &str) {
    assert_eq!(before.len(), after.len(), "{label}: 문단 수 불일치");
    for (pi, (b, a)) in before.iter().zip(after.iter()).enumerate() {
        for (name, bv, av) in [
            ("spacingBefore", b.0, a.0),
            ("spacingAfter", b.1, a.1),
            ("lineSpacing", b.2, a.2),
        ] {
            if bv.is_nan() && av.is_nan() {
                continue;
            }
            assert!(
                (bv - av).abs() <= TOL_PX,
                "{label} 문단 {pi} {name}: {bv} → {av} (허용치 {TOL_PX}px 초과)"
            );
        }
    }
}

/// 무변경 편집(삽입 후 삭제) → 저장 → 재열기 2회 반복 후 간격 비교.
fn noop_edit_roundtrip(path: &str, save: fn(&mut HwpDocument) -> Vec<u8>) {
    let bytes = load_bytes(path);
    let editable = path.ends_with(".hwp");
    let mut doc = open(&bytes, editable);
    let baseline = capture_spacings(&doc);
    assert!(!baseline.is_empty(), "{path}: 문단 속성이 조회돼야 한다");

    // 무변경 편집
    doc.insert_text_native(0, 0, 0, "x").expect("삽입");
    doc.delete_text_native(0, 0, 0, 1).expect("삭제");
    assert_spacings_close(
        &baseline,
        &capture_spacings(&doc),
        &format!("{path} 편집 직후"),
    );

    // 반복 저장/재열기
    let mut current = doc;
    for cycle in 1..=2 {
        let out = save(&mut current);
        current = open(&out, false);
        assert_spacings_close(
            &baseline,
            &capture_spacings(&current),
            &format!("{path} 저장/재열기 {cycle}회차"),
        );
    }
}

fn save_hwpx(doc: &mut HwpDocument) -> Vec<u8> {
    doc.export_hwpx_native().expect("HWPX 직렬화")
}

fn save_hwp(doc: &mut HwpDocument) -> Vec<u8> {
    doc.export_hwp_with_adapter().expect("HWP 직렬화")
}

fn save_hml(doc: &mut HwpDocument) -> Vec<u8> {
    doc.export_hml_native().expect("HML 직렬화")
}

#[test]
fn hwp5_noop_edit_spacing_roundtrip() {
    noop_edit_roundtrip("samples/basic/english.hwp", save_hwp);
}

#[test]
fn hwpx_noop_edit_spacing_roundtrip() {
    noop_edit_roundtrip("samples/복학원서.hwpx", save_hwpx);
}

#[test]
fn hml_noop_edit_spacing_roundtrip() {
    noop_edit_roundtrip("samples/hml/aligns.hml", save_hml);
}

/// HWP3 계열(변형 배율 경로) 문서도 같은 계약을 지킨다 — HWPX 로 저장한다.
#[test]
fn hwp3_variant_noop_edit_spacing_roundtrip() {
    noop_edit_roundtrip("samples/hwp3-sample-hwp5.hwp", save_hwpx);
}
