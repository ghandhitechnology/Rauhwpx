//! HWPX 개체 내부 좌표(`hp:offset`)와 문단 앵커(`hp:pos`) 왕복 회귀 가드.

use rhwp::model::control::Control;
use rhwp::model::document::Document;
use rhwp::model::paragraph::Paragraph;
use rhwp::model::shape::ShapeObject;
use rhwp::parser::hwpx::parse_hwpx;
use rhwp::serializer::hwpx::serialize_hwpx;
use std::io::Read;

#[derive(Debug, Default, PartialEq)]
struct ComponentOffsets {
    pictures: Vec<((i32, i32), (u32, u32))>,
    shapes: Vec<(i32, i32)>,
}

fn collect_offsets(doc: &Document) -> ComponentOffsets {
    let mut offsets = ComponentOffsets::default();
    for section in &doc.sections {
        visit_paragraphs(&section.paragraphs, &mut offsets);
    }
    offsets
}

fn visit_paragraphs(paragraphs: &[Paragraph], offsets: &mut ComponentOffsets) {
    for paragraph in paragraphs {
        for control in &paragraph.controls {
            match control {
                Control::Picture(picture) => offsets.pictures.push((
                    (picture.shape_attr.offset_x, picture.shape_attr.offset_y),
                    (
                        picture.common.horizontal_offset,
                        picture.common.vertical_offset,
                    ),
                )),
                Control::Table(table) => {
                    for cell in &table.cells {
                        visit_paragraphs(&cell.paragraphs, offsets);
                    }
                }
                Control::Shape(shape) => visit_shape(shape, offsets),
                _ => {}
            }
        }
    }
}

fn visit_shape(shape: &ShapeObject, offsets: &mut ComponentOffsets) {
    let component = shape.shape_attr();
    offsets
        .shapes
        .push((component.offset_x, component.offset_y));

    if let Some(text_box) = shape
        .drawing()
        .and_then(|drawing| drawing.text_box.as_ref())
    {
        visit_paragraphs(&text_box.paragraphs, offsets);
    }
    if let ShapeObject::Group(group) = shape {
        for child in &group.children {
            visit_shape(child, offsets);
        }
    }
    if let ShapeObject::Picture(picture) = shape {
        offsets.pictures.push((
            (picture.shape_attr.offset_x, picture.shape_attr.offset_y),
            (
                picture.common.horizontal_offset,
                picture.common.vertical_offset,
            ),
        ));
    }
}

fn roundtrip(path: &str) -> (ComponentOffsets, ComponentOffsets, Vec<u8>) {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("{path} 읽기: {error}"));
    let original = parse_hwpx(&bytes).unwrap_or_else(|error| panic!("{path} parse: {error}"));
    let saved =
        serialize_hwpx(&original).unwrap_or_else(|error| panic!("{path} serialize: {error}"));
    let reparsed = parse_hwpx(&saved).unwrap_or_else(|error| panic!("{path} reparse: {error}"));
    (
        collect_offsets(&original),
        collect_offsets(&reparsed),
        saved,
    )
}

fn section_xml(hwpx: &[u8]) -> String {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(hwpx)).expect("saved HWPX ZIP");
    let mut entry = archive
        .by_name("Contents/section0.xml")
        .expect("saved section0.xml");
    let mut xml = String::new();
    entry.read_to_string(&mut xml).expect("read section0.xml");
    xml
}

#[test]
fn rotated_table_picture_keeps_component_offset_distinct_from_anchor_position() {
    let (original, reparsed, _) = roundtrip("samples/hwpx/ta-pic-001-r.hwpx");

    assert!(
        original.pictures.contains(&((730, 3694), (555, 0))),
        "회전 셀 그림은 component offset과 anchor offset이 달라야 함: {original:?}"
    );
    assert_eq!(
        original, reparsed,
        "hp:offset은 hp:pos의 anchor offset과 독립적으로 보존되어야 함"
    );
}

#[test]
fn wrapped_negative_offsets_survive_shape_and_textbox_picture_roundtrip() {
    let (original, reparsed, saved) = roundtrip("samples/hwpx/hwpx-h-03.hwpx");

    assert!(
        original.shapes.contains(&(-22452, -621)),
        "음수 shape component offset 픽스처가 필요함: {original:?}"
    );
    assert!(
        original
            .pictures
            .iter()
            .any(|(component, _)| *component == (-310, 0)),
        "글상자 그림의 음수 component offset 픽스처가 필요함: {original:?}"
    );
    assert_eq!(
        original, reparsed,
        "공식 편집기의 unsigned 32-bit 음수 offset 표현을 보존해야 함"
    );

    let xml = section_xml(&saved);
    assert!(
        xml.contains(r#"<hp:offset x="4294944844" y="4294966675"/>"#),
        "shape의 음수 component offset은 한컴 호환 unsigned decimal이어야 함"
    );
    assert!(
        xml.contains(r#"<hp:offset x="4294966986" y="0"/>"#),
        "글상자 그림의 음수 component offset은 한컴 호환 unsigned decimal이어야 함"
    );
}
