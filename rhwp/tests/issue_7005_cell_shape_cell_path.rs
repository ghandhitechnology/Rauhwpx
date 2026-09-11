#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::DocumentCore;

const SAMPLE: &str = "samples/21_언어_기출_편집가능본.hwp";

fn page0_controls() -> Vec<serde_json::Value> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let core = DocumentCore::from_bytes(&std::fs::read(p).expect("표본 로드")).expect("파싱");
    let json = core
        .get_page_control_layout_native(0)
        .expect("0쪽 레이아웃");
    let v: serde_json::Value = serde_json::from_str(&json).expect("레이아웃 JSON");
    v["controls"].as_array().expect("controls 배열").clone()
}

fn in_cell(controls: &[serde_json::Value], ty: &str) -> Vec<serde_json::Value> {
    controls
        .iter()
        .filter(|c| c["type"] == ty && !c["cellIdx"].is_null())
        .cloned()
        .collect()
}

#[test]
fn cell_shapes_carry_cell_path() {
    let controls = page0_controls();
    let shapes = in_cell(&controls, "shape");
    assert!(
        shapes.len() >= 2,
        "표본 전제: 1쪽에 칸 안 도형이 둘 이상 (실측 {})",
        shapes.len()
    );

    for s in &shapes {
        let path = s["cellPath"].as_array().unwrap_or_else(|| {
            panic!("칸 안 도형에 cellPath 가 없다 — studio 가 본문 API 로 떨어진다: {s}")
        });
        assert_eq!(path.len(), 1, "평평한 3필드는 1단계 경로다: {s}");
        assert_eq!(path[0]["controlIndex"], s["outerTableControlIdx"], "{s}");
        assert_eq!(path[0]["cellIndex"], s["cellIdx"], "{s}");
        assert_eq!(path[0]["cellParaIndex"], s["cellParaIdx"], "{s}");
    }
}

#[test]
fn cell_shapes_are_distinguishable_by_cell_path() {
    let controls = page0_controls();
    let shapes = in_cell(&controls, "shape");
    let ident: Vec<String> = shapes
        .iter()
        .map(|s| {
            format!(
                "{}/{}/{}/{}",
                s["secIdx"], s["paraIdx"], s["controlIdx"], s["cellPath"]
            )
        })
        .collect();
    let mut uniq = ident.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(
        uniq.len(),
        ident.len(),
        "칸 안 도형들이 선택 동일성 판정에서 구분되지 않는다: {ident:?}"
    );

    let bare: Vec<String> = shapes
        .iter()
        .map(|s| format!("{}/{}/{}", s["secIdx"], s["paraIdx"], s["controlIdx"]))
        .collect();
    let mut bare_uniq = bare.clone();
    bare_uniq.sort();
    bare_uniq.dedup();
    assert!(
        bare_uniq.len() < bare.len(),
        "표본 전제: cellPath 없이는 두 도형이 같은 좌표로 겹쳐야 판정이 의미를 갖는다: {bare:?}"
    );
}

#[test]
fn body_shapes_keep_no_cell_fields() {
    let controls = page0_controls();
    let body: Vec<_> = controls
        .iter()
        .filter(|c| (c["type"] == "shape" || c["type"] == "line") && c["cellIdx"].is_null())
        .collect();
    assert!(
        !body.is_empty(),
        "표본 전제: 1쪽에 본문 직속 도형/직선이 있어야 대조가 선다"
    );
    for c in body {
        assert!(
            c["cellPath"].is_null(),
            "본문 도형에 cellPath 가 붙었다: {c}"
        );
        assert!(c["outerTableControlIdx"].is_null(), "{c}");
    }
}
