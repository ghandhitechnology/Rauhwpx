mod clipboard;
mod document;
mod document_transfer;
mod footnote_ops;
mod foreign_paste;
mod formatting;
mod formatting_runs;
mod header_footer_ops;
mod html_import;
mod object_ops;
// [#6806] 그림 리사이즈 Undo 의 원본 변환 저널. PictureTransformCapture 타입이
// DocumentCore 필드로 쓰이므로 pub(crate).
pub(crate) mod picture_transform_journal;
mod table_ops;
mod text_editing;
