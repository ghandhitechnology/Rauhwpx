//! 전체 쪽 수는 현재 쪽 번호와 구분하고 HWP/HWPX 왕복에서도 유지한다.
use rhwp::model::{
    control::{AutoNumberType, Control},
    paragraph::Paragraph,
};
use rhwp::wasm_api::HwpDocument;

fn totals(paragraphs: &[Paragraph]) -> usize {
    paragraphs
        .iter()
        .flat_map(|p| &p.controls)
        .map(|control| match control {
            Control::AutoNumber(number) => {
                usize::from(number.number_type == AutoNumberType::TotalPage)
            }
            Control::Table(table) => table
                .cells
                .iter()
                .map(|cell| totals(&cell.paragraphs))
                .sum(),
            Control::Header(header) => totals(&header.paragraphs),
            Control::Footer(footer) => totals(&footer.paragraphs),
            _ => 0,
        })
        .sum()
}

fn count_totals(doc: &HwpDocument) -> usize {
    doc.document()
        .sections
        .iter()
        .map(|section| {
            totals(&section.paragraphs)
                + section
                    .section_def
                    .master_pages
                    .iter()
                    .map(|page| totals(&page.paragraphs))
                    .sum::<usize>()
        })
        .sum()
}

#[test]
fn english_exam_preserves_total_page_fields_in_both_formats() {
    let doc = HwpDocument::from_bytes(include_bytes!("../samples/exam_eng.hwp")).unwrap();
    assert_eq!(doc.page_count(), 8);
    let count = count_totals(&doc);
    assert!(
        count > 0,
        "원본의 전체 쪽 수 필드가 현재 쪽 번호로 바뀌면 안 된다"
    );
    for bytes in [
        doc.export_hwp_native().unwrap(),
        doc.export_hwpx_native().unwrap(),
    ] {
        let reopened = HwpDocument::from_bytes(&bytes).unwrap();
        assert_eq!(count_totals(&reopened), count);
        assert_eq!(reopened.page_count(), 8);
    }
}
