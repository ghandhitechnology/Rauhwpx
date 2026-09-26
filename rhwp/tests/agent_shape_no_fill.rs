//! 에이전트 insert_shape 는 채우기 없는 도형을 fillType "none" 으로 만든다. 종류만 바꾸고
//! 생성 기본값인 흰 단색이 남으면 렌더러가 그 면을 칠하고 HWPX 저장도 흰 브러시를 내보내,
//! 글 앞 도형이 뒤의 글을 가린다.

use rhwp::document_core::DocumentCore;
use serde_json::Value;

fn shape_props(core: &DocumentCore, para: usize, ctrl: usize) -> Value {
    serde_json::from_str(
        &core
            .get_shape_properties_native(0, para, ctrl)
            .expect("shape props"),
    )
    .expect("shape props JSON")
}

fn first_shape(core: &DocumentCore) -> (usize, usize) {
    for (para, paragraph) in core.document().sections[0].paragraphs.iter().enumerate() {
        for (ctrl, control) in paragraph.controls.iter().enumerate() {
            if matches!(control, rhwp::model::control::Control::Shape(_)) {
                return (para, ctrl);
            }
        }
    }
    panic!("no shape in section 0");
}

#[test]
fn fill_type_none_drops_the_default_white_fill() {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let created: Value = serde_json::from_str(
        &core
            .create_shape_control_native(
                0,
                0,
                0,
                9000,
                4000,
                0,
                0,
                false,
                "InFrontOfText",
                "rectangle",
                false,
                false,
                &[],
            )
            .unwrap(),
    )
    .unwrap();
    let para = created["paraIdx"].as_u64().unwrap() as usize;
    let ctrl = created["controlIdx"].as_u64().unwrap() as usize;
    assert_eq!(shape_props(&core, para, ctrl)["fillType"], "solid");

    core.set_shape_properties_native(0, para, ctrl, r#"{"fillType":"none"}"#)
        .unwrap();
    let props = shape_props(&core, para, ctrl);
    assert_eq!(props["fillType"], "none");
    assert!(
        props.get("fillBgColor").is_none(),
        "white solid fill left behind: {props}"
    );

    // 저장 후 다시 읽어도 채우기가 없다
    let bytes = core.export_hwpx_native().expect("export hwpx");
    let reloaded = DocumentCore::from_bytes(&bytes).expect("reload hwpx");
    let (para, ctrl) = first_shape(&reloaded);
    let props = shape_props(&reloaded, para, ctrl);
    assert_eq!(props["fillType"], "none");
    assert!(
        props.get("fillBgColor").is_none(),
        "fill came back after save: {props}"
    );
}
