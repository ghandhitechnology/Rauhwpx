//! 그림 속성/삽입/삭제 + 표 생성 + 셀 bbox 관련 native 메서드 — 도메인별 분할 (#1904).
//!
//! 종전 단일 파일(9,845줄, 7개 도메인 응집)을 도메인 모듈로 분할. 함수 이동만 —
//! 로직/외부 인터페이스 무변경 (impl DocumentCore 분산, 메서드 경로 동일).

mod common;
mod connector;
mod equation;
mod note;
mod picture;
mod shape;
mod table;

use crate::model::control::Control;
use crate::model::document::Section;

/// 도형 최소 크기 (HWPUNIT).
/// 0으로 내려가면 Rectangle은 x_coords=[0,0,0,0]이 되고,
/// Group은 current/original 스케일이 0이 되어 자식이 전부 사라진다.
/// table_ops의 MIN_CELL_SIZE와 동일한 기준을 사용한다.
pub(crate) const MIN_SHAPE_SIZE: u32 = 200;

/// 페이지 레이어 순서에 참여하는 최상위 개체 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LayerOrderKind {
    Shape,
    Picture,
    Table,
    Equation,
}

/// 구역 안 최상위 floating 개체의 공통 레이어 정렬 항목.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LayerOrderEntry {
    pub z_order: i32,
    pub para_idx: usize,
    pub control_idx: usize,
    pub kind: LayerOrderKind,
}

pub(super) fn layer_order_entries(section: &Section) -> Vec<LayerOrderEntry> {
    section
        .paragraphs
        .iter()
        .enumerate()
        .flat_map(|(para_idx, para)| {
            para.controls
                .iter()
                .enumerate()
                .filter_map(move |(control_idx, control)| match control {
                    Control::Shape(shape) => Some(LayerOrderEntry {
                        z_order: shape.z_order(),
                        para_idx,
                        control_idx,
                        kind: LayerOrderKind::Shape,
                    }),
                    Control::Picture(picture) => Some(LayerOrderEntry {
                        z_order: picture.common.z_order,
                        para_idx,
                        control_idx,
                        kind: LayerOrderKind::Picture,
                    }),
                    Control::Table(table) if !table.common.treat_as_char => Some(LayerOrderEntry {
                        z_order: table.common.z_order,
                        para_idx,
                        control_idx,
                        kind: LayerOrderKind::Table,
                    }),
                    Control::Equation(equation) if !equation.common.treat_as_char => {
                        Some(LayerOrderEntry {
                            z_order: equation.common.z_order,
                            para_idx,
                            control_idx,
                            kind: LayerOrderKind::Equation,
                        })
                    }
                    _ => None,
                })
        })
        .collect()
}

pub(super) fn max_layer_z_order(section: &Section) -> i32 {
    layer_order_entries(section)
        .into_iter()
        .map(|entry| entry.z_order)
        .max()
        .unwrap_or(-1)
}

pub(super) fn max_control_layer_z_order(controls: &[Control]) -> i32 {
    controls
        .iter()
        .filter_map(|control| match control {
            Control::Shape(shape) => Some(shape.z_order()),
            Control::Picture(picture) => Some(picture.common.z_order),
            Control::Table(table) if !table.common.treat_as_char => Some(table.common.z_order),
            Control::Equation(equation) if !equation.common.treat_as_char => {
                Some(equation.common.z_order)
            }
            _ => None,
        })
        .max()
        .unwrap_or(-1)
}

pub(super) fn set_layer_z_order(
    section: &mut Section,
    entry: LayerOrderEntry,
    z_order: i32,
) -> bool {
    let Some(control) = section
        .paragraphs
        .get_mut(entry.para_idx)
        .and_then(|para| para.controls.get_mut(entry.control_idx))
    else {
        return false;
    };
    match (entry.kind, control) {
        (LayerOrderKind::Shape, Control::Shape(shape)) => {
            shape.common_mut().z_order = z_order;
            true
        }
        (LayerOrderKind::Picture, Control::Picture(picture)) => {
            picture.common.z_order = z_order;
            true
        }
        (LayerOrderKind::Table, Control::Table(table)) if !table.common.treat_as_char => {
            table.common.z_order = z_order;
            true
        }
        (LayerOrderKind::Equation, Control::Equation(equation))
            if !equation.common.treat_as_char =>
        {
            equation.common.z_order = z_order;
            true
        }
        _ => false,
    }
}
