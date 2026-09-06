//! Full-cycle cloud edit regressions found against `samples/exam_math.hwp`.
//!
//! The document has two details that make a leading-newline edit unsafe:
//! - section 2 ends with a text-empty paragraph that owns a picture control;
//! - its last-page master page is stored after the body stream with `ext_flags=0x0004`.
//!
//! A cloud agent must append a real paragraph, leaving the control-only paragraph intact,
//! and the HWP5 rebuild path must keep the trailing master page through export/reparse.

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::paragraph::Paragraph;

const SAMPLE: &str = "samples/exam_math.hwp";
const SECTION_INDEX: usize = 1;
const MARKER: &str = "RAUHWPX-FULL-CYCLE-10";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PictureSignature {
    bin_data_id: u16,
    common_instance_id: u32,
    picture_instance_id: u32,
    width: u32,
    height: u32,
}

fn load_sample() -> DocumentCore {
    let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE))
        .expect("read exam_math.hwp fixture");
    DocumentCore::from_bytes(&bytes).expect("parse exam_math.hwp fixture")
}

fn direct_picture_signature(paragraph: &Paragraph) -> PictureSignature {
    assert_eq!(
        paragraph.controls.len(),
        1,
        "fixture's final control-only paragraph must contain exactly one control"
    );
    let Control::Picture(picture) = &paragraph.controls[0] else {
        panic!("fixture's final control must be a picture")
    };
    PictureSignature {
        bin_data_id: picture.image_attr.bin_data_id,
        common_instance_id: picture.common.instance_id,
        picture_instance_id: picture.instance_id,
        width: picture.common.width,
        height: picture.common.height,
    }
}

fn assert_last_page_master_page_survives(core: &DocumentCore) {
    let master_pages = &core.document().sections[SECTION_INDEX]
        .section_def
        .master_pages;
    assert_eq!(
        master_pages.len(),
        2,
        "exam_math section 2 must retain its base and last-page master pages"
    );
    assert!(
        !master_pages[0].is_extension,
        "the first master page remains the base master page"
    );
    assert_eq!(
        master_pages[1].ext_flags, 0x0004,
        "the fixture exercises a trailing last-page record without legacy extension bit 0x0002"
    );
    assert!(
        master_pages[1].is_extension,
        "the trailing record location is authoritative even when ext_flags is 0x0004"
    );
}

#[test]
fn append_paragraph_preserves_control_only_paragraph_and_extension_master_page() {
    let mut core = load_sample();
    assert_last_page_master_page_survives(&core);

    let original_paragraph_count = core.document().sections[SECTION_INDEX].paragraphs.len();
    let original_last =
        &core.document().sections[SECTION_INDEX].paragraphs[original_paragraph_count - 1];
    assert!(
        original_last.text.trim().is_empty(),
        "fixture's final paragraph must be text-empty"
    );
    let original_picture = direct_picture_signature(original_last);

    core.insert_paragraph_native(SECTION_INDEX, original_paragraph_count)
        .expect("append a semantic paragraph after the control-only paragraph");
    core.insert_text_native(SECTION_INDEX, original_paragraph_count, 0, MARKER)
        .expect("insert marker into the new paragraph");

    let edited_paragraphs = &core.document().sections[SECTION_INDEX].paragraphs;
    assert_eq!(edited_paragraphs.len(), original_paragraph_count + 1);
    assert_eq!(
        direct_picture_signature(&edited_paragraphs[original_paragraph_count - 1]),
        original_picture,
        "appending a paragraph must not move or mutate the preceding picture control"
    );
    assert_eq!(edited_paragraphs[original_paragraph_count].text, MARKER);
    assert!(
        edited_paragraphs[original_paragraph_count]
            .controls
            .is_empty(),
        "the new marker paragraph must not inherit the preceding inline control"
    );

    let exported = core.export_hwp_native().expect("export edited HWP5");
    let reparsed = DocumentCore::from_bytes(&exported).expect("reparse edited HWP5");
    assert_last_page_master_page_survives(&reparsed);

    let reparsed_paragraphs = &reparsed.document().sections[SECTION_INDEX].paragraphs;
    assert_eq!(reparsed_paragraphs.len(), original_paragraph_count + 1);
    assert_eq!(
        direct_picture_signature(&reparsed_paragraphs[original_paragraph_count - 1]),
        original_picture,
        "the preceding picture control must survive HWP5 export/reparse in place"
    );
    assert_eq!(reparsed_paragraphs[original_paragraph_count].text, MARKER);
    assert!(
        reparsed_paragraphs[original_paragraph_count]
            .controls
            .is_empty(),
        "the reparsed marker paragraph must remain control-free"
    );
}
