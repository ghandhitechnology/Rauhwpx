//! Rauhwpx 공문/품의 서식팩 — HWPX 전용 저장과 표 기하 스냅샷.
//!
//! 에이전트 채움은 열린 문서의 `set_field_value_by_name` 경로를 쓴다.
//! 이 모듈은 서식 식별과 바이너리 HWP 쓰기 거절만 맡는다.

use std::path::Path;

use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::paragraph::Paragraph;
use crate::model::table::Table;

pub const PACK_ID: &str = "rauhwpx-office";
pub const BRAND_GONGMUN: &str = "Rauhwpx 공문 서식";
pub const BRAND_PUMUI: &str = "Rauhwpx 품의 서식";

pub const REFUSE_BINARY_HWP: &str =
    "이 서식은 HWPX로만 저장할 수 있습니다. 바이너리 HWP 경로는 거부합니다.";

const PACK_FILENAMES: &[&str] = &["공문.hwpx", "품의.hwpx"];

/// 경로가 서식팩 파일이거나 출력 확장자가 바이너리 HWP 인지 본다.
pub fn is_form_pack_path(path: &Path) -> bool {
    let in_pack_dir = path.components().any(|c| c.as_os_str() == "form-pack");
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    in_pack_dir || PACK_FILENAMES.iter().any(|known| name.eq_ignore_ascii_case(known))
}

pub fn output_would_write_binary_hwp(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("hwp"))
}

pub fn document_has_pack_marker(doc: &Document) -> bool {
    document_text_contains(doc, BRAND_GONGMUN) || document_text_contains(doc, BRAND_PUMUI)
}

pub fn is_form_pack_source(path: &Path, doc: &Document) -> bool {
    is_form_pack_path(path) || document_has_pack_marker(doc)
}

/// 서식팩 문서를 바이너리 HWP 로 쓰려 하면 거절 메시지를 반환한다.
pub fn refuse_binary_hwp_export(source: &Path, output: &Path, doc: &Document) -> Option<&'static str> {
    if is_form_pack_source(source, doc) && output_would_write_binary_hwp(output) {
        Some(REFUSE_BINARY_HWP)
    } else {
        None
    }
}

pub fn default_filled_hwpx_path(source: &Path) -> std::path::PathBuf {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());
    source
        .parent()
        .map(|dir| dir.join(format!("{stem}_filled.hwpx")))
        .unwrap_or_else(|| std::path::PathBuf::from(format!("{stem}_filled.hwpx")))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableGeometry {
    pub rows: u16,
    pub cols: u16,
    pub width: u32,
    pub height: u32,
    pub cells: Vec<CellGeometry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellGeometry {
    pub row: u16,
    pub col: u16,
    pub row_span: u16,
    pub col_span: u16,
    pub width: u32,
    pub height: u32,
    pub nested: Vec<TableGeometry>,
}

/// 본문·셀 안의 표 크기·격자. 값 채움 전후가 같아야 표가 제자리에 남은 것이다.
pub fn snapshot_table_geometry(doc: &Document) -> Vec<TableGeometry> {
    let mut out = Vec::new();
    for section in &doc.sections {
        for para in &section.paragraphs {
            collect_tables_from_paragraph(para, &mut out);
        }
    }
    out
}

fn collect_tables_from_paragraph(para: &Paragraph, out: &mut Vec<TableGeometry>) {
    for control in &para.controls {
        if let Control::Table(table) = control {
            out.push(geometry_of(table));
        }
    }
}

fn geometry_of(table: &Table) -> TableGeometry {
    TableGeometry {
        rows: table.row_count,
        cols: table.col_count,
        width: table.common.width,
        height: table.common.height,
        cells: table
            .cells
            .iter()
            .map(|cell| {
                let mut nested = Vec::new();
                for para in &cell.paragraphs {
                    collect_tables_from_paragraph(para, &mut nested);
                }
                CellGeometry {
                    row: cell.row,
                    col: cell.col,
                    row_span: cell.row_span,
                    col_span: cell.col_span,
                    width: cell.width,
                    height: cell.height,
                    nested,
                }
            })
            .collect(),
    }
}

fn document_text_contains(doc: &Document, needle: &str) -> bool {
    doc.sections.iter().any(|section| {
        section
            .paragraphs
            .iter()
            .any(|para| paragraph_contains(para, needle))
    })
}

fn paragraph_contains(para: &Paragraph, needle: &str) -> bool {
    if para.text.contains(needle) {
        return true;
    }
    para.controls.iter().any(|control| match control {
        Control::Table(table) => table.cells.iter().any(|cell| {
            cell.paragraphs
                .iter()
                .any(|inner| paragraph_contains(inner, needle))
        }),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn binary_hwp_extension_is_detected() {
        assert!(output_would_write_binary_hwp(Path::new("out.hwp")));
        assert!(output_would_write_binary_hwp(Path::new("OUT.HWP")));
        assert!(!output_would_write_binary_hwp(Path::new("out.hwpx")));
        assert!(!output_would_write_binary_hwp(Path::new("out.hml")));
    }

    #[test]
    fn form_pack_dir_and_filenames_are_detected() {
        assert!(is_form_pack_path(Path::new("rhwp/form-pack/품의.hwpx")));
        assert!(is_form_pack_path(Path::new("공문.hwpx")));
        assert!(!is_form_pack_path(Path::new("samples/field-01.hwp")));
    }
}
