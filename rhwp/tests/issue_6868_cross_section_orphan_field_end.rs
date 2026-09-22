//! 구역 경계를 넘는 누름틀의 종료 마커를 잇는다.
//!
//! 구역 하나를 파싱하는 동안에는 앞 구역에서 열린 필드를 볼 수 없어 종료 마커의
//! `begin_ctrl_id` 가 0 으로 남는다. 짝이 정말로 없는 마커는 0 으로 남아야 한다.
#![cfg(not(target_arch = "wasm32"))]

use rhwp::model::control::Control;
use rhwp::parser::hwpx::section::{link_orphan_field_ends_across_sections, parse_hwpx_section};

#[test]
fn issue6868_orphan_field_end_links_across_section_boundary() {
    const SEC0: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"
    xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">
  <hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="1799035886" type="CLICK_HERE" name="본문" fieldid="7"/></hp:ctrl><hp:t>앞구역</hp:t></hp:run></hp:p>
</hs:sec>"##;
    const SEC1: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"
    xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">
  <hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="1693948357" type="FORMULA" fieldid="8"/></hp:ctrl><hp:t>수식</hp:t></hp:run></hp:p>
  <hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>닫기</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="1693948357" fieldid="8"/></hp:ctrl></hp:run></hp:p>
  <hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>뒷구역</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="1799035886" fieldid="7"/></hp:ctrl></hp:run></hp:p>
</hs:sec>"##;

    let mut sections = vec![
        parse_hwpx_section(SEC0).unwrap(),
        parse_hwpx_section(SEC1).unwrap(),
    ];

    let cross_begin_ctrl_id = match sections[0].paragraphs[0].controls.first() {
        Some(Control::Field(field)) => field.ctrl_id,
        other => panic!("앞 구역 첫 문단이 fieldBegin 을 갖지 않는다: {other:?}"),
    };
    assert_ne!(cross_begin_ctrl_id, 0, "fieldBegin 의 control id");

    let across_before = sections[1].paragraphs[2]
        .orphan_field_ends
        .first()
        .expect("구역을 넘는 고아 fieldEnd");
    assert_eq!(across_before.begin_id_ref, 1_799_035_886);
    assert_eq!(
        across_before.begin_ctrl_id, 0,
        "구역 단위 파싱만으로는 앞 구역 fieldBegin 을 잇지 못한다"
    );

    link_orphan_field_ends_across_sections(&mut sections);

    let same_section = sections[1].paragraphs[1]
        .orphan_field_ends
        .first()
        .expect("둘째 구역 안에서 닫히는 고아 fieldEnd");
    assert_eq!(same_section.begin_id_ref, 1_693_948_357);
    assert_ne!(
        same_section.begin_ctrl_id, 0,
        "구역 안에서 닫히는 필드의 짝은 그대로 남는다"
    );

    let across = sections[1].paragraphs[2]
        .orphan_field_ends
        .first()
        .expect("구역을 넘는 고아 fieldEnd");
    assert_eq!(across.begin_id_ref, 1_799_035_886);
    assert_eq!(
        across.begin_ctrl_id, cross_begin_ctrl_id,
        "앞 구역 fieldBegin 의 control id 를 이어야 HWP5 저장기가 끝 표시를 낸다"
    );
}

#[test]
fn issue6868_hwp5_orphan_field_end_links_across_section_boundary() {
    use rhwp::model::control::Field;
    use rhwp::model::document::Section;
    use rhwp::model::paragraph::{OrphanFieldEnd, Paragraph};
    use rhwp::parser::body_text::link_orphan_field_ends_across_sections;

    fn opening_para(field_id: u32, ctrl_id: u32) -> Paragraph {
        let mut para = Paragraph::default();
        para.controls.push(Control::Field(Field {
            field_id,
            ctrl_id,
            ..Default::default()
        }));
        para
    }

    fn closing_para() -> Paragraph {
        let mut para = Paragraph::default();
        para.orphan_field_ends.push(OrphanFieldEnd {
            char_idx: 0,
            begin_id_ref: 0,
            field_id: 0,
            begin_ctrl_id: 0,
        });
        para
    }

    let mut sections = vec![Section::default(), Section::default()];
    sections[0]
        .paragraphs
        .push(opening_para(1_799_035_886, 627_272_811));
    sections[1].paragraphs.push(closing_para());
    sections[1].paragraphs.push(closing_para());

    link_orphan_field_ends_across_sections(&mut sections);

    let linked = &sections[1].paragraphs[0].orphan_field_ends[0];
    assert_eq!(linked.begin_id_ref, 1_799_035_886);
    assert_eq!(
        linked.begin_ctrl_id, 627_272_811,
        "앞 구역에서 열린 필드의 ctrl_id 를 이어야 HWPX 직렬화기가 마커를 낸다"
    );

    let unpaired = &sections[1].paragraphs[1].orphan_field_ends[0];
    assert_eq!(
        unpaired.begin_id_ref, 0,
        "짝이 없는 마커는 0 으로 남아 #5252 가드가 계속 버린다"
    );
}
