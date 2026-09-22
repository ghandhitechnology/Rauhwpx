//! Hancom OWPML LineType2의 이름과 HWP5 선 코드 사이의 의미를 검증한다.
use rhwp::model::style::BorderLineType;
use rhwp::wasm_api::HwpDocument;
use std::io::{Cursor, Read};

fn assert_border_types(doc: &HwpDocument) {
    let fills = &doc.document().doc_info.border_fills;
    // borderFill ID는 1부터 시작한다. OWPML DOT=2(파선), DASH=3(점선).
    for (index, expected) in [
        (3, BorderLineType::Dot),
        (4, BorderLineType::Dash),
        (7, BorderLineType::DoubleWave),
    ] {
        for border in fills[index].borders {
            assert_eq!(border.line_type, expected, "borderFill {}", index + 1);
        }
    }
}

#[test]
fn hancom_hwpx_border_names_keep_their_hwp5_meaning() {
    let doc = HwpDocument::from_bytes(include_bytes!(
        "../samples/rendering-fidelity/01-table-border-styles.hwpx"
    ))
    .unwrap();
    assert_border_types(&doc);
    let hwp = doc.export_hwp_native().unwrap();
    assert_border_types(&HwpDocument::from_bytes(&hwp).unwrap());
    let hwpx = doc.export_hwpx_native().unwrap();
    assert_border_types(&HwpDocument::from_bytes(&hwpx).unwrap());
    let mut zip = zip::ZipArchive::new(Cursor::new(hwpx)).unwrap();
    let mut header = String::new();
    zip.by_name("Contents/header.xml")
        .unwrap()
        .read_to_string(&mut header)
        .unwrap();
    assert!(header.contains("type=\"DOUBLEWAVE\""));
    assert!(!header.contains("type=\"DOUBLE_WAVE\""));
}
