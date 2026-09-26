use serde::Serialize;

use crate::model::shape::TextWrap;
use crate::paint::layer_tree::{LayerNode, LayerNodeKind};
use crate::paint::paint_op::PaintOp;
use crate::renderer::render_tree::{BoundingBox, RenderLayerInfo};

/// Logical replay planes for PageLayerTree direct paint backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaintReplayPlane {
    Background,
    BehindText,
    Flow,
    InFrontOfText,
}

impl PaintReplayPlane {
    pub const ORDERED: [Self; 4] = [
        Self::Background,
        Self::BehindText,
        Self::Flow,
        Self::InFrontOfText,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Background => "background",
            Self::BehindText => "behindText",
            Self::Flow => "flow",
            Self::InFrontOfText => "inFrontOfText",
        }
    }
}

pub fn paint_op_replay_plane(op: &PaintOp) -> PaintReplayPlane {
    paint_op_replay_plane_with_layer(op, None)
}

pub fn paint_op_replay_plane_with_layer(
    op: &PaintOp,
    layer: Option<RenderLayerInfo>,
) -> PaintReplayPlane {
    if matches!(op, PaintOp::PageBackground { .. }) {
        return PaintReplayPlane::Background;
    }
    if layer.and_then(|layer| layer.text_wrap).is_some() {
        return render_layer_replay_plane(layer);
    }

    let plane = match op {
        PaintOp::Image { image, .. } => match image.text_wrap {
            Some(TextWrap::BehindText) => PaintReplayPlane::BehindText,
            Some(TextWrap::InFrontOfText) => PaintReplayPlane::InFrontOfText,
            _ => PaintReplayPlane::Flow,
        },
        _ => PaintReplayPlane::Flow,
    };
    cap_master_page_plane(plane, layer)
}

pub fn render_layer_replay_plane(layer: Option<RenderLayerInfo>) -> PaintReplayPlane {
    let plane = match layer.and_then(|layer| layer.text_wrap) {
        Some(TextWrap::BehindText) => PaintReplayPlane::BehindText,
        Some(TextWrap::InFrontOfText) => PaintReplayPlane::InFrontOfText,
        _ => PaintReplayPlane::Flow,
    };
    cap_master_page_plane(plane, layer)
}

/// 바탕쪽 유래 op 의 replay plane 상한 (#2318).
///
/// 한컴 의미론: 바탕쪽 개체의 text_wrap 은 바탕쪽 **내부** 개체 간 순서에만
/// 적용되고, 바탕쪽 전체는 항상 본문 뒤에 깔린다. SVG 의 `node_z_plane` 계약
/// (페이지 배경 → 바탕쪽 → BehindText → Flow → InFrontOfText, #1167)과 동일
/// 의미를 plane 재생 backend(web_canvas/skia/canvaskit)에 적용한다.
/// BehindText plane 내에서 바탕쪽 그룹은 트리 순서상 본문 개체보다 먼저
/// 재생되므로 더 깊게 깔린다.
fn cap_master_page_plane(
    plane: PaintReplayPlane,
    layer: Option<RenderLayerInfo>,
) -> PaintReplayPlane {
    if plane != PaintReplayPlane::Background && layer.is_some_and(|layer| layer.master_page) {
        PaintReplayPlane::BehindText
    } else {
        plane
    }
}

pub(crate) fn layer_node_has_replay_plane(node: &LayerNode, target: PaintReplayPlane) -> bool {
    layer_node_has_replay_plane_with_layer(node, target, None)
}

fn layer_node_has_replay_plane_with_layer(
    node: &LayerNode,
    target: PaintReplayPlane,
    inherited_layer: Option<RenderLayerInfo>,
) -> bool {
    let active_layer = node.layer.or(inherited_layer);
    match &node.kind {
        LayerNodeKind::Group { children, .. } => children
            .iter()
            .any(|child| layer_node_has_replay_plane_with_layer(child, target, active_layer)),
        LayerNodeKind::ClipRect { child, .. } => {
            layer_node_has_replay_plane_with_layer(child, target, active_layer)
        }
        LayerNodeKind::Leaf { ops } => ops
            .iter()
            .any(|op| paint_op_replay_plane_with_layer(op, active_layer) == target),
    }
}

/// 본문 plane 의 정적 op(Image/RawSvg) 를 동적 op 와 다른 canvas 로 나눠 합성해도
/// 원래 그리기 순서가 보존되는지 판정한다.
///
/// Studio 는 정적 op 를 동적 canvas 아래 layer 에 깐다. 그래서 정적 op 보다 **먼저**
/// 그려지는 동적 op 가 그 영역과 겹치면(그림 아래의 흰 채우기, 그림에 덮이는 글자 등)
/// 분리 합성에서는 동적 op 가 위로 올라와 그림을 가린다. 그런 페이지는 분리하면 안 된다.
/// 정적 op 뒤에 그려지는 동적 op 는 분리해도 위에 있으므로 영향이 없다.
pub fn flow_static_split_preserves_order(root: &LayerNode) -> bool {
    // 경계만 맞닿은 이웃(같은 줄의 글자와 글자처럼 취급 그림)은 겹침으로 보지 않는다.
    const OVERLAP_EPS: f64 = 0.5;
    fn overlaps(a: &BoundingBox, b: &BoundingBox) -> bool {
        let w = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
        let h = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
        w > OVERLAP_EPS && h > OVERLAP_EPS
    }
    fn visit(
        node: &LayerNode,
        inherited_layer: Option<RenderLayerInfo>,
        painted: &mut Vec<BoundingBox>,
    ) -> bool {
        let active_layer = node.layer.or(inherited_layer);
        match &node.kind {
            LayerNodeKind::Group { children, .. } => children
                .iter()
                .all(|child| visit(child, active_layer, painted)),
            LayerNodeKind::ClipRect { child, .. } => visit(child, active_layer, painted),
            LayerNodeKind::Leaf { ops } => {
                for op in ops {
                    if paint_op_replay_plane_with_layer(op, active_layer) != PaintReplayPlane::Flow
                    {
                        continue;
                    }
                    let bounds = op.bounds();
                    if matches!(op, PaintOp::Image { .. } | PaintOp::RawSvg { .. }) {
                        if painted.iter().any(|prior| overlaps(prior, &bounds)) {
                            return false;
                        }
                    } else if bounds.width > 0.0 && bounds.height > 0.0 && paints_ink(op) {
                        painted.push(bounds);
                    }
                }
                true
            }
        }
    }
    visit(root, None, &mut Vec::new())
}

/// 글자가 없는 run(빈 run·공백만 있는 run)은 형광펜이 없으면 아무것도 칠하지 않는다.
/// 이런 run 의 bbox 는 줄 높이 전체라 인라인 그림과 겹치기 쉬워 따로 거른다.
fn paints_ink(op: &PaintOp) -> bool {
    let PaintOp::TextRun { run, .. } = op else {
        return true;
    };
    let shade = run.style.shade_color & 0x00FF_FFFF;
    run.char_overlap.is_some()
        || (shade != 0x00FF_FFFF && shade != 0)
        || run.display_or_text().chars().any(|ch| !ch.is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::{CacheHint, GroupKind, LayerNode};
    use crate::renderer::render_tree::{
        BoundingBox, ImageNode, PageBackgroundNode, RectangleNode, RenderLayerInfo,
    };
    use crate::renderer::ShapeStyle;

    fn bbox() -> BoundingBox {
        BoundingBox::new(0.0, 0.0, 10.0, 10.0)
    }

    fn image_with_wrap(wrap: Option<TextWrap>) -> PaintOp {
        let mut image = ImageNode::new(1, Some(vec![1, 2, 3]));
        image.text_wrap = wrap;
        PaintOp::image(bbox(), image, None)
    }

    #[test]
    fn ordered_planes_match_hwp_z_order_contract() {
        assert_eq!(
            PaintReplayPlane::ORDERED.map(PaintReplayPlane::as_str),
            ["background", "behindText", "flow", "inFrontOfText"]
        );
    }

    #[test]
    fn page_background_replays_on_background_plane() {
        let op = PaintOp::page_background(
            bbox(),
            PageBackgroundNode {
                background_color: None,
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: None,
            },
        );

        assert_eq!(paint_op_replay_plane(&op), PaintReplayPlane::Background);
    }

    #[test]
    fn behind_text_image_replays_before_flow() {
        let op = image_with_wrap(Some(TextWrap::BehindText));

        assert_eq!(paint_op_replay_plane(&op), PaintReplayPlane::BehindText);
    }

    #[test]
    fn in_front_of_text_image_replays_after_flow() {
        let op = image_with_wrap(Some(TextWrap::InFrontOfText));

        assert_eq!(paint_op_replay_plane(&op), PaintReplayPlane::InFrontOfText);
    }

    #[test]
    fn non_layered_ops_replay_on_flow_plane() {
        let plain_image = image_with_wrap(None);
        let top_and_bottom_image = image_with_wrap(Some(TextWrap::TopAndBottom));
        let vector =
            PaintOp::rectangle(bbox(), RectangleNode::new(0.0, ShapeStyle::default(), None));

        assert_eq!(paint_op_replay_plane(&plain_image), PaintReplayPlane::Flow);
        assert_eq!(
            paint_op_replay_plane(&top_and_bottom_image),
            PaintReplayPlane::Flow
        );
        assert_eq!(paint_op_replay_plane(&vector), PaintReplayPlane::Flow);
    }

    #[test]
    fn render_layer_metadata_overrides_non_image_paint_ops() {
        let vector =
            PaintOp::rectangle(bbox(), RectangleNode::new(0.0, ShapeStyle::default(), None));
        let behind_layer = RenderLayerInfo::new(Some(TextWrap::BehindText), 1, 1);
        let front_layer = RenderLayerInfo::new(Some(TextWrap::InFrontOfText), 2, 2);

        assert_eq!(
            paint_op_replay_plane_with_layer(&vector, Some(behind_layer)),
            PaintReplayPlane::BehindText
        );
        assert_eq!(
            paint_op_replay_plane_with_layer(&vector, Some(front_layer)),
            PaintReplayPlane::InFrontOfText
        );
    }

    #[test]
    fn layer_node_replay_plane_scan_descends_groups() {
        let child = LayerNode::leaf(
            bbox(),
            None,
            vec![image_with_wrap(Some(TextWrap::InFrontOfText))],
        );
        let group = LayerNode::group(
            bbox(),
            None,
            vec![child],
            CacheHint::None,
            GroupKind::Generic,
        );

        assert!(layer_node_has_replay_plane(
            &group,
            PaintReplayPlane::InFrontOfText
        ));
        assert!(!layer_node_has_replay_plane(
            &group,
            PaintReplayPlane::BehindText
        ));
    }

    #[test]
    fn layer_node_replay_plane_scan_honors_inherited_layer_metadata() {
        let child = LayerNode::leaf(
            bbox(),
            None,
            vec![PaintOp::rectangle(
                bbox(),
                RectangleNode::new(0.0, ShapeStyle::default(), None),
            )],
        );
        let group = LayerNode::group(
            bbox(),
            None,
            vec![child],
            CacheHint::None,
            GroupKind::Generic,
        )
        .with_layer(Some(RenderLayerInfo::new(Some(TextWrap::BehindText), 1, 1)));

        assert!(layer_node_has_replay_plane(
            &group,
            PaintReplayPlane::BehindText
        ));
        assert!(!layer_node_has_replay_plane(&group, PaintReplayPlane::Flow));
    }
}
