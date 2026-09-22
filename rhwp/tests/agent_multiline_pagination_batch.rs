use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::page::ColumnDef;
use rhwp::model::paragraph::Paragraph;

fn blank() -> DocumentCore {
    let mut document = DocumentCore::new_empty();
    document.create_blank_document_native().unwrap();
    document
}

fn column_paragraph(count: u16) -> Paragraph {
    let mut paragraph = Paragraph::default();
    paragraph.controls.push(Control::ColumnDef(ColumnDef {
        column_count: count,
        same_width: false,
        widths: vec![10000, 29000],
        ..Default::default()
    }));
    paragraph
}

#[test]
fn body_batch_guard_accepts_default_and_explicit_single_columns() {
    let mut document = blank();
    assert!(document.can_batch_body_text_native(0));
    document.document_mut().sections[0]
        .paragraphs
        .push(column_paragraph(1));
    assert!(document.can_batch_body_text_native(0));
    assert!(!document.can_batch_body_text_native(1));
    assert!(!document.can_batch_body_text_native(usize::MAX));
}

#[test]
fn body_batch_guard_rejects_initial_and_later_multicolumn_definitions() {
    let mut document = blank();
    document.document_mut().sections[0]
        .paragraphs
        .insert(0, column_paragraph(2));
    assert!(!document.can_batch_body_text_native(0));
    document.document_mut().sections[0].paragraphs.remove(0);
    document.document_mut().sections[0]
        .paragraphs
        .push(column_paragraph(2));
    assert!(!document.can_batch_body_text_native(0));
    document.document_mut().sections[0]
        .paragraphs
        .push(column_paragraph(1));
    assert!(!document.can_batch_body_text_native(0));
}

#[test]
fn body_batch_guard_rejects_invalid_zero_columns_without_mutating_document() {
    let mut document = blank();
    document.document_mut().sections[0]
        .paragraphs
        .push(column_paragraph(0));
    let before = document.export_hwp_native().unwrap();
    assert!(!document.can_batch_body_text_native(0));
    assert_eq!(document.export_hwp_native().unwrap(), before);
}
