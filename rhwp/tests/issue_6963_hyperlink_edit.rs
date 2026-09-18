//! #6963 웹 링크의 주소·범위·표시 문자열·저장 왕복 계약.
#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::hyperlink::HyperlinkTarget;
use rhwp::document_core::DocumentCore;
use rhwp::model::control::{Control, FieldType};
use rhwp::model::hyperlink::{command_uri, web_command};

fn blank(text: &str) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    core.insert_text_native(0, 0, 0, text).unwrap();
    core
}

fn roundtrips(core: &DocumentCore) -> Vec<DocumentCore> {
    [
        core.export_hwp_native().unwrap(),
        core.export_hwpx_native().unwrap(),
    ]
    .iter()
    .map(|bytes| DocumentCore::from_bytes(bytes).unwrap())
    .collect()
}

fn first_table_target(core: &DocumentCore) -> HyperlinkTarget {
    for (pi, p) in core.document().sections[0].paragraphs.iter().enumerate() {
        for (ci, c) in p.controls.iter().enumerate() {
            if matches!(c, Control::Table(_)) {
                return HyperlinkTarget {
                    section: 0,
                    para: pi,
                    cell_path: vec![(ci, 0, 0)],
                };
            }
        }
    }
    panic!("표 컨트롤이 없습니다");
}

fn first_textbox_target(core: &DocumentCore) -> HyperlinkTarget {
    for (pi, p) in core.document().sections[0].paragraphs.iter().enumerate() {
        for (ci, c) in p.controls.iter().enumerate() {
            if let Control::Shape(shape) = c {
                if shape.drawing().and_then(|d| d.text_box.as_ref()).is_some() {
                    return HyperlinkTarget {
                        section: 0,
                        para: pi,
                        cell_path: vec![(ci, 0, 0)],
                    };
                }
            }
        }
    }
    panic!("글상자 컨트롤이 없습니다");
}

#[test]
fn command_codec_preserves_unicode_query_fragment_and_escaped_delimiters() {
    let uri = "https://example.com/한글?q=가;나&x=%20#MN::문서:";
    let command = web_command(uri).unwrap();
    assert_eq!(command_uri(&command), uri);
    assert!(command.contains(r"https\://"));
    assert!(command.contains(r"가\;나"));
    assert!(command.contains(r"\#MN\:\:"));
    assert_eq!(command_uri(r"a\\b\;c;1;0;0;"), r"a\b;c");
    assert_eq!(
        command_uri("mailto:person@example.com;1;0;0;"),
        "mailto:person@example.com"
    );
    for invalid in [
        "",
        "javascript:alert(1)",
        "file:///tmp/a",
        "https://",
        "https:///a",
        "https://a\nb",
        " https://example.com",
        "https://user@example.com",
    ] {
        assert!(web_command(invalid).is_err(), "{invalid:?}");
    }
    assert!(web_command(&format!("https://example.com/{}", "가".repeat(65536))).is_err());
}

#[test]
fn selected_unicode_text_survives_insert_update_remove_and_both_formats() {
    let mut core = blank("앞😀한글\t링크 뒤");
    let original = core.document().sections[0].paragraphs[0].text.clone();
    let id = core
        .insert_hyperlink_native(
            &HyperlinkTarget::body(0, 0),
            1,
            7,
            "https://example.com/한글?a=1;2#위치",
        )
        .unwrap();
    for reopened in roundtrips(&core) {
        let links = reopened
            .hyperlinks_native(&HyperlinkTarget::body(0, 0))
            .unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!((links[0].start, links[0].end), (1, 7));
        assert_eq!(links[0].text, "😀한글\t링크");
        assert_eq!(links[0].uri, "https://example.com/한글?a=1;2#위치");
        assert_eq!(reopened.document().sections[0].paragraphs[0].text, original);
    }
    core.update_hyperlink_native(
        &HyperlinkTarget::body(0, 0),
        id,
        "http://example.org/?q=새주소#b",
    )
    .unwrap();
    for mut reopened in roundtrips(&core) {
        assert_eq!(
            reopened
                .hyperlinks_native(&HyperlinkTarget::body(0, 0))
                .unwrap()[0]
                .uri,
            "http://example.org/?q=새주소#b"
        );
        reopened
            .remove_hyperlink_native(&HyperlinkTarget::body(0, 0), id)
            .unwrap();
        for removed in roundtrips(&reopened) {
            assert!(removed
                .hyperlinks_native(&HyperlinkTarget::body(0, 0))
                .unwrap()
                .is_empty());
            assert_eq!(removed.document().sections[0].paragraphs[0].text, original);
        }
    }
}

#[test]
fn adjacent_links_keep_ranges_when_first_middle_or_last_is_removed() {
    for remove in 0..3 {
        let mut core = blank("가나다라마바");
        let mut ids = Vec::new();
        for i in 0..3 {
            ids.push(
                core.insert_hyperlink_native(
                    &HyperlinkTarget::body(0, 0),
                    i * 2,
                    i * 2 + 2,
                    &format!("https://example.com/{i}"),
                )
                .unwrap(),
            );
        }
        for mut reopened in roundtrips(&core) {
            reopened
                .remove_hyperlink_native(&HyperlinkTarget::body(0, 0), ids[remove])
                .unwrap();
            for result in roundtrips(&reopened) {
                let links = result
                    .hyperlinks_native(&HyperlinkTarget::body(0, 0))
                    .unwrap();
                assert_eq!(links.len(), 2);
                for (link, i) in links.iter().zip((0..3).filter(|i| *i != remove)) {
                    assert_eq!((link.start, link.end), (i * 2, i * 2 + 2));
                    assert_eq!(link.uri, format!("https://example.com/{i}"));
                }
                assert_eq!(
                    result.document().sections[0].paragraphs[0].text,
                    "가나다라마바"
                );
            }
        }
    }
}

#[test]
fn failures_and_same_address_do_not_mutate_document_or_events() {
    let mut core = blank("테스트 문서");
    let id = core
        .insert_hyperlink_native(&HyperlinkTarget::body(0, 0), 1, 3, "https://example.com")
        .unwrap();
    let before = format!("{:?}", core.document());
    let events = core.serialize_event_log();
    assert!(!core
        .update_hyperlink_native(&HyperlinkTarget::body(0, 0), id, "https://example.com")
        .unwrap());
    for (start, end) in [(0, 99), (1, 1), (3, 2), (0, 2)] {
        assert!(core
            .insert_hyperlink_native(
                &HyperlinkTarget::body(0, 0),
                start,
                end,
                "https://example.org"
            )
            .is_err());
    }
    assert!(core
        .update_hyperlink_native(&HyperlinkTarget::body(0, 0), id, "javascript:bad")
        .is_err());
    assert!(core
        .remove_hyperlink_native(&HyperlinkTarget::body(0, 0), id + 100)
        .is_err());
    assert!(core
        .insert_hyperlink_native(&HyperlinkTarget::body(999, 0), 0, 1, "https://example.org")
        .is_err());
    assert_eq!(format!("{:?}", core.document()), before);
    assert_eq!(core.serialize_event_log(), events);
}

#[test]
fn snapshot_restore_undoes_link_metadata_and_style_boundaries_stay_visible() {
    use rhwp::model::paragraph::CharShapeRef;
    let mut core = blank("앞😀링크뒤");
    let p = &mut core.document_mut().sections[0].paragraphs[0];
    p.char_shapes = vec![
        CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        },
        CharShapeRef {
            start_pos: p.char_offsets[2],
            char_shape_id: 1,
        },
    ];
    let styles = core.get_char_shape_runs_native(0, 0, 0, 5).unwrap();
    let before = core.save_snapshot_native();
    let id = core
        .insert_hyperlink_native(&HyperlinkTarget::body(0, 0), 1, 4, "https://example.com")
        .unwrap();
    assert_eq!(core.get_char_shape_runs_native(0, 0, 0, 5).unwrap(), styles);
    let after = core.save_snapshot_native();
    core.restore_snapshot_native(before).unwrap();
    assert!(core
        .hyperlinks_native(&HyperlinkTarget::body(0, 0))
        .unwrap()
        .is_empty());
    core.restore_snapshot_native(after).unwrap();
    assert_eq!(
        core.hyperlinks_native(&HyperlinkTarget::body(0, 0))
            .unwrap()[0]
            .field_id,
        id
    );
    core.remove_hyperlink_native(&HyperlinkTarget::body(0, 0), id)
        .unwrap();
    assert_eq!(core.get_char_shape_runs_native(0, 0, 0, 5).unwrap(), styles);
}

#[test]
fn snapshot_undo_restores_deleted_link_string_and_address() {
    let mut core = blank("앞링크뒤");
    let target = HyperlinkTarget::body(0, 0);
    let id = core
        .insert_hyperlink_native(&target, 1, 3, "https://example.com/undo")
        .unwrap();
    let snap = core.save_snapshot_native();
    core.delete_text_native(0, 0, 1, 2).unwrap();
    core.remove_hyperlink_native(&target, id).unwrap();
    assert!(core.hyperlinks_native(&target).unwrap().is_empty());
    core.restore_snapshot_native(snap).unwrap();
    let links = core.hyperlinks_native(&target).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].text, "링크");
    assert_eq!(links[0].uri, "https://example.com/undo");
    assert_eq!(core.document().sections[0].paragraphs[0].text, "앞링크뒤");
}

#[test]
fn unsupported_object_paragraph_is_rejected_without_mutation() {
    let mut core = blank("본문");
    core.document_mut().sections[0].paragraphs[0]
        .controls
        .push(Control::Picture(Default::default()));
    let before = format!("{:?}", core.document());
    assert!(core
        .insert_hyperlink_native(&HyperlinkTarget::body(0, 0), 0, 2, "https://example.com")
        .is_err());
    assert_eq!(format!("{:?}", core.document()), before);
}

#[test]
fn new_ids_include_fields_in_footnotes_and_reject_overflow() {
    use rhwp::model::control::Field;
    use rhwp::model::paragraph::Paragraph;
    let mut core = blank("본문");
    let mut note = rhwp::model::footnote::Footnote::default();
    note.paragraphs.push(Paragraph {
        controls: vec![Control::Field(Field {
            field_id: 5000,
            ..Default::default()
        })],
        ..Default::default()
    });
    core.document_mut().sections[0].paragraphs.push(Paragraph {
        controls: vec![Control::Footnote(Box::new(note))],
        ..Default::default()
    });
    let id = core
        .insert_hyperlink_native(&HyperlinkTarget::body(0, 0), 0, 1, "https://example.com")
        .unwrap();
    assert!(id > 5000);
    let Control::Field(field) = core.document_mut().sections[0].paragraphs[0]
        .controls
        .last_mut()
        .unwrap()
    else {
        panic!()
    };
    field.field_id = u32::MAX;
    let before = format!("{:?}", core.document());
    assert!(core
        .insert_hyperlink_native(&HyperlinkTarget::body(0, 0), 1, 2, "https://example.com")
        .is_err());
    assert_eq!(format!("{:?}", core.document()), before);
}

#[test]
fn text_edits_before_and_inside_link_preserve_saved_range() {
    let target = HyperlinkTarget::body(0, 0);
    let mut core = blank("앞링크뒤");
    let id = core
        .insert_hyperlink_native(&target, 1, 3, "https://example.com")
        .unwrap();
    core.insert_text_native(0, 0, 0, "😀").unwrap();
    core.insert_text_native(0, 0, 3, "새").unwrap();
    for reopened in roundtrips(&core) {
        let link = &reopened.hyperlinks_native(&target).unwrap()[0];
        assert_eq!((link.start, link.end, link.text.as_str()), (2, 5, "링새크"));
    }
    core.delete_text_native(0, 0, 2, 3).unwrap();
    core.remove_hyperlink_native(&target, id).unwrap();
    for reopened in roundtrips(&core) {
        assert!(reopened.hyperlinks_native(&target).unwrap().is_empty());
        assert_eq!(reopened.document().sections[0].paragraphs[0].text, "😀앞뒤");
    }
}

#[test]
fn unknown_schemes_survive_neighbor_edit_and_bad_nested_paths_fail_atomically() {
    let target = HyperlinkTarget::body(0, 0);
    let mut core = blank("메일 웹주소");
    let mail_id = core
        .insert_hyperlink_native(&target, 0, 2, "https://example.com")
        .unwrap();
    let Control::Field(field) = core.document_mut().sections[0].paragraphs[0]
        .controls
        .last_mut()
        .unwrap()
    else {
        panic!()
    };
    field.command = "mailto:user@example.com;1;0;0;".into();
    let web_id = core
        .insert_hyperlink_native(&target, 3, 6, "https://example.org")
        .unwrap();
    assert!(core
        .update_hyperlink_native(&target, mail_id, "https://example.net")
        .is_err());
    core.update_hyperlink_native(&target, web_id, "https://example.org/new")
        .unwrap();
    let before = format!("{:?}", core.document());
    let bad = HyperlinkTarget {
        cell_path: vec![(999, 0, 0)],
        ..target.clone()
    };
    assert!(core.remove_hyperlink_native(&bad, web_id).is_err());
    assert_eq!(format!("{:?}", core.document()), before);
    for reopened in roundtrips(&core) {
        let links = reopened.hyperlinks_native(&target).unwrap();
        assert_eq!(links[0].uri, "mailto:user@example.com");
        assert_eq!(links[1].uri, "https://example.org/new");
    }
}

#[test]
fn replace_display_text_keeps_adjacent_fields_and_roundtrips() {
    let mut core = blank("앞가나다뒤");
    let target = HyperlinkTarget::body(0, 0);
    let ids: Vec<_> = (1..4)
        .map(|i| {
            core.insert_hyperlink_native(&target, i, i + 1, "https://example.com")
                .unwrap()
        })
        .collect();
    for text in ["새로운😀문자열", "짧", "다시 늘림"] {
        assert!(core
            .replace_hyperlink_text_native(&target, ids[1], text)
            .unwrap());
        let expected = core.hyperlinks_native(&target).unwrap();
        assert_eq!(expected[0].text, "가");
        assert_eq!(expected[1].text, text);
        assert_eq!(expected[2].text, "다");
        assert_eq!(expected[0].end, expected[1].start);
        assert_eq!(expected[1].end, expected[2].start);
        assert_eq!(expected.iter().map(|l| l.field_id).collect::<Vec<_>>(), ids);
        assert!(!core
            .replace_hyperlink_text_native(&target, ids[1], text)
            .unwrap());
        for reopened in roundtrips(&core) {
            assert_eq!(reopened.hyperlinks_native(&target).unwrap(), expected);
        }
    }
    let before = core.hyperlinks_native(&target).unwrap();
    for invalid in ["", " ", "두\n줄", "탭\t"] {
        assert!(core
            .replace_hyperlink_text_native(&target, ids[1], invalid)
            .is_err());
        assert_eq!(core.hyperlinks_native(&target).unwrap(), before);
    }
}

#[test]
fn typing_after_link_keeps_original_format_and_excludes_new_text() {
    let mut core = blank("가나다");
    let target = HyperlinkTarget::body(0, 0);
    let original_shape = core.document().sections[0].paragraphs[0].char_shape_id_at(0);
    core.insert_hyperlink_native(&target, 0, 3, "https://www.hancom.com")
        .unwrap();
    core.apply_char_format_native(
        0,
        0,
        0,
        3,
        r##"{"textColor":"#0000ff","underlineType":"Bottom","underlineColor":"#0000ff"}"##,
    )
    .unwrap();
    core.apply_char_format_native(
        0,
        0,
        0,
        3,
        r##"{"textColor":"#800080","underlineColor":"#800080"}"##,
    )
    .unwrap();
    let reopened = roundtrips(&core);
    for mut candidate in std::iter::once(core).chain(reopened) {
        candidate
            .replace_body_text_local_native(0, 0, 3, 0, "ㄱ")
            .unwrap();
        candidate
            .replace_body_text_local_native(0, 0, 3, 1, "가")
            .unwrap();
        candidate.insert_text_native(0, 0, 4, "나😀").unwrap();
        let reopened = roundtrips(&candidate);
        for result in std::iter::once(candidate).chain(reopened) {
            let link = &result.hyperlinks_native(&target).unwrap()[0];
            assert_eq!((link.start, link.end, link.text.as_str()), (0, 3, "가나다"));
            let para = &result.document().sections[0].paragraphs[0];
            assert_eq!(para.text, "가나다가나😀");
            assert_eq!(para.char_shape_id_at(3), original_shape);
            assert_eq!(para.char_shape_id_at(5), original_shape);
        }
    }
}

#[test]
fn typing_inside_link_still_extends_its_range() {
    let mut core = blank("가나다");
    let target = HyperlinkTarget::body(0, 0);
    core.insert_hyperlink_native(&target, 0, 3, "https://www.hancom.com")
        .unwrap();
    core.insert_text_native(0, 0, 1, "😀").unwrap();
    let reopened = roundtrips(&core);
    for result in std::iter::once(core).chain(reopened) {
        let link = &result.hyperlinks_native(&target).unwrap()[0];
        assert_eq!(
            (link.start, link.end, link.text.as_str()),
            (0, 4, "가😀나다")
        );
    }
}

#[test]
fn typing_at_link_start_stays_outside_link() {
    for (text, start, adjacent) in [
        ("링크뒤", 0, false),
        ("앞링크뒤", 1, false),
        ("앞링크뒤", 1, true),
    ] {
        let mut core = blank(text);
        let target = HyperlinkTarget::body(0, 0);
        let original_shape = core.document().sections[0].paragraphs[0].char_shape_id_at(start);
        if adjacent {
            core.insert_hyperlink_native(&target, 0, 1, "https://example.org")
                .unwrap();
            core.apply_char_format_native(
                0,
                0,
                0,
                1,
                r##"{"textColor":"#551a8b","underlineType":"Bottom"}"##,
            )
            .unwrap();
        }
        let id = core
            .insert_hyperlink_native(&target, start, start + 2, "https://example.com")
            .unwrap();
        core.apply_char_format_native(
            0,
            0,
            start,
            start + 2,
            r##"{"textColor":"#0000ff","underlineType":"Bottom","underlineColor":"#0000ff","bold":true}"##,
        )
        .unwrap();
        let link_shape = core.document().sections[0].paragraphs[0].char_shape_id_at(start);
        core.insert_text_native(0, 0, start, "X").unwrap();
        let reopened = roundtrips(&core);
        for (format, result) in ["memory", "hwp", "hwpx"]
            .into_iter()
            .zip(std::iter::once(core).chain(reopened))
        {
            let links = result.hyperlinks_native(&target).unwrap();
            let link = links.iter().find(|link| link.field_id == id).unwrap();
            assert_eq!(
                (link.start, link.end, link.text.as_str()),
                (start + 1, start + 3, "링크"),
                "{text} {adjacent} {format}"
            );
            assert_eq!(
                result.document().sections[0].paragraphs[0].char_shape_id_at(start + 1),
                link_shape
            );
            assert_eq!(
                result.document().sections[0].paragraphs[0].char_shape_id_at(start),
                original_shape,
                "{text} {adjacent} {format}: {:?}",
                result.document().sections[0].paragraphs[0].char_shapes
            );
            if adjacent {
                assert_eq!(
                    (links[0].start, links[0].end, links[0].text.as_str()),
                    (0, 1, "앞")
                );
            }
        }
    }
}

fn format_at(core: &DocumentCore, index: usize) -> serde_json::Value {
    serde_json::from_str(&core.get_char_properties_at_native(0, 0, index).unwrap()).unwrap()
}
fn mixed_format_link() -> (DocumentCore, u32) {
    let mut core = blank("앞가😀나다뒤");
    core.apply_char_format_native(
        0,
        0,
        1,
        3,
        r##"{"textColor":"#ff0000","underlineType":"Bottom","underlineColor":"#ff0000"}"##,
    )
    .unwrap();
    core.apply_char_format_native(
        0,
        0,
        3,
        5,
        r##"{"textColor":"#008000","underlineType":"None","underlineColor":"#008000"}"##,
    )
    .unwrap();
    let id = core
        .insert_hyperlink_native(
            &HyperlinkTarget::body(0, 0),
            1,
            5,
            "https://example.com/한글#링크",
        )
        .unwrap();
    core.apply_char_format_native(
        0,
        0,
        1,
        5,
        r##"{"textColor":"#800080","underlineType":"Bottom","underlineColor":"#800080","italic":true}"##,
    )
    .unwrap();
    (core, id)
}
fn assert_restored_mixed(core: &DocumentCore) {
    for i in 1..5 {
        let p = format_at(core, i);
        assert_eq!(p["textColor"], if i < 3 { "#ff0000" } else { "#008000" });
        assert_eq!(p["underline"], i < 3);
        assert_eq!(
            p["underlineColor"],
            if i < 3 { "#ff0000" } else { "#008000" }
        );
        assert_eq!(
            p["italic"], true,
            "링크 적용 후 바꾼 기울임을 되돌리지 않는다"
        );
    }
    for i in [0, 5] {
        assert_eq!(format_at(core, i)["textColor"], "#000000");
    }
}

#[test]
fn unlink_restores_mixed_original_colors_after_hwp_hwpx_and_cross_format_roundtrips() {
    let (core, id) = mixed_format_link();
    let mut variants = roundtrips(&core);
    for once in roundtrips(&core) {
        variants.extend(roundtrips(&once));
    }
    variants.push(core);
    for mut reopened in variants {
        reopened
            .remove_hyperlink_with_format_native(&HyperlinkTarget::body(0, 0), id, true)
            .unwrap();
        assert_restored_mixed(&reopened);
        assert!(rhwp::model::hyperlink_format::encode(reopened.document()).is_none());
        for saved in roundtrips(&reopened) {
            assert_restored_mixed(&saved);
        }
    }
}

#[test]
fn original_format_follows_unicode_insertion_deletion_and_label_replacement() {
    let (mut core, id) = mixed_format_link();
    core.insert_text_native(0, 0, 2, "X").unwrap();
    core.delete_text_native(0, 0, 3, 1).unwrap();
    for mut reopened in roundtrips(&core) {
        reopened
            .remove_hyperlink_with_format_native(&HyperlinkTarget::body(0, 0), id, true)
            .unwrap();
        assert_restored_mixed(&reopened);
    }
    core.replace_hyperlink_text_native(&HyperlinkTarget::body(0, 0), id, "새😀표시")
        .unwrap();
    core.update_hyperlink_native(
        &HyperlinkTarget::body(0, 0),
        id,
        "https://example.org/changed",
    )
    .unwrap();
    for mut reopened in roundtrips(&core) {
        reopened
            .remove_hyperlink_with_format_native(&HyperlinkTarget::body(0, 0), id, true)
            .unwrap();
        for i in 1..5 {
            assert_eq!(format_at(&reopened, i)["textColor"], "#ff0000");
            assert_eq!(format_at(&reopened, i)["underline"], true);
        }
    }
}

#[test]
fn missing_or_stale_original_format_does_not_guess_black_on_unlink() {
    let (mut core, id) = mixed_format_link();
    let payload = rhwp::model::hyperlink_format::encode(core.document()).unwrap();
    let p = &mut core.document_mut().sections[0].paragraphs[0];
    for c in &mut p.controls {
        if let Control::Field(f) = c {
            f.hyperlink_format = None;
        }
    }
    core.replace_hyperlink_text_native(&HyperlinkTarget::body(0, 0), id, "다른문자")
        .unwrap();
    rhwp::model::hyperlink_format::decode(core.document_mut(), &payload);
    assert!(rhwp::model::hyperlink_format::encode(core.document()).is_none());
    for mut reopened in roundtrips(&core) {
        reopened
            .remove_hyperlink_with_format_native(&HyperlinkTarget::body(0, 0), id, true)
            .unwrap();
        assert_eq!(format_at(&reopened, 1)["textColor"], "#800080");
        assert_eq!(format_at(&reopened, 1)["underline"], true);
    }
}

#[test]
fn original_format_survives_prefix_insertion_and_split_before_link() {
    let (mut core, id) = mixed_format_link();
    core.insert_text_native(0, 0, 1, "X").unwrap();
    core.split_paragraph_native(0, 0, 1, None).unwrap();
    for mut reopened in roundtrips(&core) {
        let target = HyperlinkTarget::body(0, 1);
        let link = reopened.hyperlinks_native(&target).unwrap().remove(0);
        assert_eq!((link.start, link.end), (1, 5));
        reopened
            .remove_hyperlink_with_format_native(&target, id, true)
            .unwrap();
        let p: serde_json::Value =
            serde_json::from_str(&reopened.get_char_properties_at_native(0, 1, 1).unwrap())
                .unwrap();
        assert_eq!(p["textColor"], "#ff0000");
    }
}

#[test]
fn insert_edit_unlink_in_table_cell_roundtrips() {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    core.create_table_native(0, 0, 0, 1, 1).unwrap();
    let target = first_table_target(&core);
    core.insert_text_in_cell_by_path(target.section, target.para, &target.cell_path, 0, "셀링크")
        .unwrap();
    let id = core
        .insert_hyperlink_native(&target, 0, 3, "https://example.com/cell")
        .unwrap();
    for reopened in roundtrips(&core) {
        let links = reopened.hyperlinks_native(&target).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].text, "셀링크");
        assert_eq!(links[0].uri, "https://example.com/cell");
    }
    core.update_hyperlink_native(&target, id, "https://example.org/cell")
        .unwrap();
    core.replace_hyperlink_text_native(&target, id, "표안")
        .unwrap();
    for reopened in roundtrips(&core) {
        let link = &reopened.hyperlinks_native(&target).unwrap()[0];
        assert_eq!(link.text, "표안");
        assert_eq!(link.uri, "https://example.org/cell");
    }
    core.remove_hyperlink_native(&target, id).unwrap();
    for reopened in roundtrips(&core) {
        assert!(reopened.hyperlinks_native(&target).unwrap().is_empty());
    }
}

#[test]
fn insert_edit_unlink_in_textbox_roundtrips() {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    core.create_shape_control_native(
        0,
        0,
        0,
        9000,
        6750,
        0,
        0,
        false,
        "InFrontOfText",
        "textbox",
        false,
        false,
        &[],
    )
    .unwrap();
    let target = first_textbox_target(&core);
    core.insert_text_in_cell_by_path(
        target.section,
        target.para,
        &target.cell_path,
        0,
        "상자링크",
    )
    .unwrap();
    let existing = "상자링크".to_string();
    let end = existing.chars().count();
    let id = core
        .insert_hyperlink_native(&target, 0, end, "https://example.com/box")
        .unwrap();
    for reopened in roundtrips(&core) {
        let link = &reopened.hyperlinks_native(&target).unwrap()[0];
        assert_eq!(link.text, existing);
        assert_eq!(link.uri, "https://example.com/box");
    }
    core.update_hyperlink_native(&target, id, "http://example.org/box")
        .unwrap();
    core.remove_hyperlink_native(&target, id).unwrap();
    for reopened in roundtrips(&core) {
        assert!(reopened.hyperlinks_native(&target).unwrap().is_empty());
        let (ctrl, _, para_idx) = target.cell_path[0];
        let host = &reopened.document().sections[0].paragraphs[target.para];
        let text = match &host.controls[ctrl] {
            Control::Shape(shape) => shape
                .drawing()
                .and_then(|d| d.text_box.as_ref())
                .and_then(|tb| tb.paragraphs.get(para_idx))
                .map(|p| p.text.clone())
                .expect("글상자 문단"),
            _ => panic!("글상자가 아닙니다"),
        };
        assert_eq!(text, existing);
    }
}

#[test]
fn uri_update_clears_raw_parameters_xml() {
    let mut core = blank("링크");
    let target = HyperlinkTarget::body(0, 0);
    let id = core
        .insert_hyperlink_native(&target, 0, 2, "https://example.com")
        .unwrap();
    {
        let Control::Field(field) = core.document_mut().sections[0].paragraphs[0]
            .controls
            .iter_mut()
            .find(|c| matches!(c, Control::Field(f) if f.field_type == FieldType::Hyperlink))
            .unwrap()
        else {
            panic!()
        };
        field.raw_parameters_xml = Some("<hp:parameters></hp:parameters>".into());
    }
    assert!(core
        .update_hyperlink_native(&target, id, "https://example.org")
        .unwrap());
    let Control::Field(field) = core.document().sections[0].paragraphs[0]
        .controls
        .iter()
        .find(|c| matches!(c, Control::Field(f) if f.field_type == FieldType::Hyperlink))
        .unwrap()
    else {
        panic!()
    };
    assert!(field.raw_parameters_xml.is_none());
    assert_eq!(command_uri(&field.command), "https://example.org");
}
