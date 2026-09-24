//! [#6875] HWPX 문단 여백의 홀수 자리를 `unit="CHAR"` 로 보존한다.
//!
//! 업스트림 [edwardkim/rhwp#7319](https://github.com/edwardkim/rhwp/pull/7319).
//! `samples/issue5714/…vietnam_labor_report.hwp` 는 이 저장소에 없다.
//! Fixture 는 `samples/basic/Textmail.hwp` (홀수 여백 2, 홀수 간격 2).

#![cfg(not(target_arch = "wasm32"))]

use std::io::Read;
use std::path::Path;

use rhwp::document_core::DocumentCore;

const SAMPLE: &str = "samples/basic/Textmail.hwp";

fn read_sample() -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE)).expect("정식 원본")
}

fn exported_header(bytes: &[u8]) -> String {
    let doc = DocumentCore::from_bytes(bytes).expect("원본 파스");
    let hwpx = doc.export_hwpx_native().expect("HWPX 내보내기");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(hwpx)).expect("zip");
    let mut header = String::new();
    zip.by_name("Contents/header.xml")
        .expect("header.xml")
        .read_to_string(&mut header)
        .expect("read header");
    header
}

fn case_and_default_margins(header: &str) -> Vec<(String, i64, String, i64)> {
    let mut out = Vec::new();
    for para_pr in header.split("<hh:paraPr ").skip(1) {
        let Some(block) = para_pr.split("</hh:paraPr>").next() else {
            continue;
        };
        let Some(case) = block.split("<hp:case").nth(1).and_then(|rest| {
            rest.split_once('>')
                .and_then(|(_, body)| body.split("</hp:case>").next())
        }) else {
            continue;
        };
        let Some(default) = block
            .split("<hp:default>")
            .nth(1)
            .and_then(|rest| rest.split("</hp:default>").next())
        else {
            continue;
        };
        let parse = |body: &str| -> Vec<(String, i64, String)> {
            body.split("<hc:")
                .skip(1)
                .filter_map(|item| {
                    let name = item.split([' ', '/', '>']).next()?.to_string();
                    let value = item.split("value=\"").nth(1)?.split('"').next()?;
                    let unit = item.split("unit=\"").nth(1)?.split('"').next()?;
                    Some((name, value.parse::<i64>().ok()?, unit.to_string()))
                })
                .collect()
        };
        let defaults = parse(default);
        for (name, value, unit) in parse(case) {
            if let Some((_, def_value, _)) = defaults.iter().find(|(n, _, _)| *n == name) {
                out.push((name, value, unit, *def_value));
            }
        }
    }
    out
}

#[test]
fn odd_stored_margin_is_marked_with_the_char_unit() {
    let header = exported_header(&read_sample());
    let items = case_and_default_margins(&header);
    assert!(
        !items.is_empty(),
        "paraPr 의 hp:case 여백을 하나도 못 읽었다"
    );

    let odd: Vec<_> = items.iter().filter(|(_, _, _, d)| d % 2 != 0).collect();
    assert!(
        !odd.is_empty(),
        "이 표본에는 홀수 저장값이 있어야 한다 — fixture 가 바뀌었다 ({SAMPLE})"
    );

    for (name, value, unit, stored) in &items {
        let expected = if stored % 2 != 0 { "CHAR" } else { "HWPUNIT" };
        assert_eq!(
            unit, expected,
            "hc:{name} 저장값 {stored} → case {value} 의 단위가 {unit} 다. \
             한컴은 홀수 자리를 CHAR 로 표시한다"
        );
        let restored = value * 2 + i64::from(stored % 2 != 0);
        assert_eq!(
            restored, *stored,
            "hc:{name}: case {value} + 단위 {unit} 로 저장값을 복원할 수 없다"
        );
    }
}

#[test]
fn paragraph_margins_survive_the_hwpx_roundtrip_exactly() {
    let bytes = read_sample();
    let original = DocumentCore::from_bytes(&bytes).expect("원본 파스");
    let hwpx = original.export_hwpx_native().expect("HWPX 내보내기");
    let reparsed = DocumentCore::from_bytes(&hwpx).expect("HWPX 파스");

    let margins = |doc: &DocumentCore| -> Vec<(i32, i32, i32, i32, i32)> {
        doc.document()
            .doc_info
            .para_shapes
            .iter()
            .map(|ps| {
                (
                    ps.indent,
                    ps.margin_left,
                    ps.margin_right,
                    ps.spacing_before,
                    ps.spacing_after,
                )
            })
            .collect()
    };
    let before = margins(&original);
    let after = margins(&reparsed);
    assert_eq!(
        before.len(),
        after.len(),
        "문단 모양 수가 왕복에서 달라졌다 — {} → {}",
        before.len(),
        after.len()
    );

    let mismatch: Vec<_> = before
        .iter()
        .zip(&after)
        .enumerate()
        .filter(|(_, (a, b))| a != b)
        .map(|(index, (a, b))| format!("paraPr {index}: {a:?} → {b:?}"))
        .collect();
    assert!(
        mismatch.is_empty(),
        "왕복에서 문단 여백이 바뀌었다({}건). 홀수 저장값이 짝수로 내려앉는 결함이다.\n{}",
        mismatch.len(),
        mismatch
            .iter()
            .take(6)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
