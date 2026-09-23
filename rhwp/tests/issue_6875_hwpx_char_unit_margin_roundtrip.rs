//! [#6875] HWPX 문단 여백의 홀수 자리를 `unit="CHAR"` 로 보존한다.
//!
//! `paraPr` 여백은 `<hp:switch>` 아래 `hp:default`(저장값)와 HwpUnitChar `hp:case`
//! (저장값의 절반) 두 벌로 적힌다. 저장값이 홀수면 한컴은 case 쪽에 `unit="CHAR"` 를
//! 붙여 최하위 비트를 남긴다. 직렬화기가 단위를 `HWPUNIT` 으로 고정하고 `x / 2` 만
//! 적으면 한/글이 case 를 우선 읽어 문단 간격이 줄어든다 (코퍼스 07939: 558 → 545쪽).
//!
//! 업스트림 [edwardkim/rhwp#7319](https://github.com/edwardkim/rhwp/pull/7319).
//! 선호 fixture `samples/issue5714/…vietnam_labor_report.hwp` 는 이 저장소에 없다.
//! `samples/basic/Textmail.hwp` 는 파스된 `ParaShape` 에 홀수 여백 2개와 홀수 간격
//! 2개를 가진 저장소 실물이다.

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

/// `hp:case` 안의 `<hc:*>` 를 (이름, 값, 단위)로, 같은 `paraPr` 의 `hp:default` 값과 함께.
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

/// 저장값이 홀수인 자리에만 `unit="CHAR"` 가 붙는다.
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

/// HWPX 로 쓰고 다시 읽으면 문단 여백·간격이 정확히 돌아온다.
///
/// 한컴이 읽는 case 표기와는 별개로, Rauhwpx 자신의 왕복이 단위 표기 변경으로
/// 깨지지 않는지 잠근다.
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
