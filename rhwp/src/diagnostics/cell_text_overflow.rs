//! 셀 글자 넘침 검출 — 표 테두리 위에 글자가 겹쳐 그려지거나 셀 클립에 글자가
//! 잘리는 회귀를 찾는 게이트.
//!
//! 페이지 렌더 트리를 훑어 표 셀 안 `TextRun` 의 글리프 잉크 상자를 두 기준으로 검사한다.
//! - `BorderCross`: 조상 표가 실제로 그린 테두리 선분(`Table` 의 `Line` 자식)이 잉크를
//!   가로지른다. 중첩 표 안의 글자는 바깥 표 테두리까지 모두 검사한다.
//! - `ClipCut`: 셀 클립(셀 bbox) 밖으로 잉크가 나가 글자가 잘린다.
//!
//! 글상자·묶음 개체처럼 셀과 독립된 좌표계를 가진 노드 아래의 글자는 제외한다.
//!
//! 잉크 상자는 폰트 파일 없이 결정론적으로 추정한다. 기준선 위로 글자 크기의 0.72,
//! 아래로는 글자 종류별 내림(라틴 내림 글자·괄호 0.2, 한글 0.07, 그 밖 0.02)을 잉크로
//! 본다. 위/아래첨자는 SVG/Canvas 출력과 같은 크기(0.7)와 기준선 이동을 적용하고,
//! 가로 범위는 앞뒤 공백을 뺀 실제 글자 경계로 잡는다.

use crate::document_core::DocumentCore;
use crate::renderer::layout::compute_char_positions;
use crate::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType, TextRunNode};

/// 테두리 선 두께·반올림 오차를 흡수하는 허용 오차(px).
const TOLERANCE_PX: f64 = 0.5;

/// 검출 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverflowKind {
    /// 표 테두리 선이 글자를 가로지른다.
    BorderCross,
    /// 셀 클립 밖으로 글자가 나가 잘린다.
    ClipCut,
}

/// 넘친 방향.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Top,
    Bottom,
    Left,
    Right,
}

/// 검출 하나.
#[derive(Debug, Clone)]
pub struct CellTextOverflow {
    pub page: u32,
    pub kind: OverflowKind,
    pub edge: Edge,
    /// 선/클립을 넘은 잉크 거리(px).
    pub amount: f64,
    pub text: String,
    /// 추정 잉크 상자.
    pub ink: BoundingBox,
    pub cell: BoundingBox,
    pub row: u16,
    pub col: u16,
    /// 표 중첩 깊이 (1 = 본문 표의 셀).
    pub depth: usize,
}

#[derive(Clone, Copy)]
struct Segment {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    half_width: f64,
}

struct CellFrame {
    bbox: BoundingBox,
    row: u16,
    col: u16,
    clip: bool,
    depth: usize,
}

struct Scan<'a> {
    page: u32,
    out: &'a mut Vec<CellTextOverflow>,
    /// 조상 표들의 테두리 선분 (바깥 → 안쪽).
    borders: Vec<Vec<Segment>>,
}

/// 문서 전체 페이지를 검사한다.
pub fn scan_document(core: &DocumentCore) -> Vec<CellTextOverflow> {
    let mut out = Vec::new();
    for page in 0..core.page_count() {
        if let Ok(tree) = core.build_page_render_tree(page) {
            out.extend(scan_page(&tree.root, page));
        }
    }
    out
}

/// 페이지 하나의 렌더 트리를 검사한다.
pub fn scan_page(root: &RenderNode, page: u32) -> Vec<CellTextOverflow> {
    let mut out = Vec::new();
    let mut scan = Scan {
        page,
        out: &mut out,
        borders: Vec::new(),
    };
    scan.node(root, None, 0);
    out
}

fn border_segments(table: &RenderNode) -> Vec<Segment> {
    table
        .children
        .iter()
        .filter(|child| child.visible && !child.editor_only)
        .filter_map(|child| match &child.node_type {
            RenderNodeType::Line(line) if line.style.width > 0.0 => Some(Segment {
                x1: line.x1.min(line.x2),
                y1: line.y1.min(line.y2),
                x2: line.x1.max(line.x2),
                y2: line.y1.max(line.y2),
                half_width: line.style.width / 2.0,
            }),
            _ => None,
        })
        .collect()
}

impl Scan<'_> {
    fn node(&mut self, node: &RenderNode, cell: Option<&CellFrame>, depth: usize) {
        if !node.visible {
            return;
        }
        match &node.node_type {
            RenderNodeType::Table(_) => {
                self.borders.push(border_segments(node));
                for child in &node.children {
                    self.node(child, cell, depth + 1);
                }
                self.borders.pop();
            }
            RenderNodeType::TableCell(tc) => {
                // 세로쓰기 셀은 잉크 추정 모델이 맞지 않으므로 검사하지 않는다.
                let frame = (tc.text_direction == 0).then_some(CellFrame {
                    bbox: node.bbox,
                    row: tc.row,
                    col: tc.col,
                    clip: tc.clip,
                    depth,
                });
                for child in &node.children {
                    self.node(child, frame.as_ref(), depth);
                }
            }
            // 셀과 별도 좌표계를 가진 개체: 글상자·묶음·도형 안의 글자는 셀 밖으로 나갈 수 있다.
            RenderNodeType::TextBox
            | RenderNodeType::Group(_)
            | RenderNodeType::Rectangle(_)
            | RenderNodeType::Ellipse(_)
            | RenderNodeType::Path(_) => {
                let saved = std::mem::take(&mut self.borders);
                for child in &node.children {
                    self.node(child, None, depth);
                }
                self.borders = saved;
            }
            RenderNodeType::TextRun(run) => {
                if let Some(frame) = cell {
                    if let Some(ink) = ink_box(node, run) {
                        self.check(run, ink, frame);
                    }
                }
            }
            _ => {
                for child in &node.children {
                    self.node(child, cell, depth);
                }
            }
        }
    }

    fn check(&mut self, run: &TextRunNode, ink: BoundingBox, frame: &CellFrame) {
        let c = frame.bbox;
        let (ink_l, ink_t) = (ink.x, ink.y);
        let (ink_r, ink_b) = (ink.x + ink.width, ink.y + ink.height);
        let page = self.page;
        let mut found: Vec<(OverflowKind, Edge, f64)> = Vec::new();

        // 셀 클립에 잘리는 글자. 클립 밖에 통째로 놓인 글자는 보이지 않으므로 다루지 않는다.
        let fully_hidden = ink_t >= c.y + c.height || ink_b <= c.y;
        if frame.clip && fully_hidden {
            return;
        }
        if frame.clip {
            let edges = [
                (Edge::Top, c.y - ink_t),
                (Edge::Bottom, ink_b - (c.y + c.height)),
                (Edge::Left, c.x - ink_l),
                (Edge::Right, ink_r - (c.x + c.width)),
            ];
            for (edge, amount) in edges {
                if amount > TOLERANCE_PX {
                    found.push((OverflowKind::ClipCut, edge, amount));
                }
            }
        }

        // 그려진 테두리 선이 잉크를 가로지르는지.
        let mut worst = [0.0f64; 4];
        for seg in self.borders.iter().flatten() {
            if (seg.y2 - seg.y1).abs() < 0.01 {
                let band_t = seg.y1 - seg.half_width;
                let band_b = seg.y1 + seg.half_width;
                let overlap_x = ink_r.min(seg.x2) - ink_l.max(seg.x1);
                if overlap_x <= TOLERANCE_PX
                    || band_b <= ink_t + TOLERANCE_PX
                    || band_t >= ink_b - TOLERANCE_PX
                {
                    continue;
                }
                // 선이 잉크 아래쪽 절반에 있으면 아래로, 위쪽 절반이면 위로 넘친 것이다.
                if seg.y1 >= (ink_t + ink_b) / 2.0 {
                    worst[1] = worst[1].max(ink_b - band_t);
                } else {
                    worst[0] = worst[0].max(band_b - ink_t);
                }
            } else if (seg.x2 - seg.x1).abs() < 0.01 {
                let band_l = seg.x1 - seg.half_width;
                let band_r = seg.x1 + seg.half_width;
                let overlap_y = ink_b.min(seg.y2) - ink_t.max(seg.y1);
                if overlap_y <= TOLERANCE_PX
                    || band_r <= ink_l + TOLERANCE_PX
                    || band_l >= ink_r - TOLERANCE_PX
                {
                    continue;
                }
                if seg.x1 >= (ink_l + ink_r) / 2.0 {
                    worst[3] = worst[3].max(ink_r - band_l);
                } else {
                    worst[2] = worst[2].max(band_r - ink_l);
                }
            }
        }
        for (edge, amount) in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right]
            .into_iter()
            .zip(worst)
        {
            if amount > 0.0 {
                found.push((OverflowKind::BorderCross, edge, amount));
            }
        }

        for (kind, edge, amount) in found {
            self.out.push(CellTextOverflow {
                page,
                kind,
                edge,
                amount,
                text: run.text.clone(),
                ink,
                cell: c,
                row: frame.row,
                col: frame.col,
                depth: frame.depth,
            });
        }
    }
}

/// 기준선 아래로 내려가는 잉크 비율(글자 크기 대비).
fn descent_ratio(c: char) -> f64 {
    match c {
        'g' | 'j' | 'p' | 'q' | 'y' | 'Q' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
        | '_' | '@' | '$' => 0.2,
        '\u{AC00}'..='\u{D7A3}' | '\u{3130}'..='\u{318F}' | '\u{1100}'..='\u{11FF}' => 0.07,
        _ => 0.02,
    }
}

fn ink_box(node: &RenderNode, run: &TextRunNode) -> Option<BoundingBox> {
    if node.bbox.width <= 0.0 || run.rotation != 0.0 || run.is_vertical {
        return None;
    }
    let text = run.display_text.as_deref().unwrap_or(&run.text);
    let is_ink = |c: char| !c.is_whitespace() && !c.is_control() && c != '\u{FFFC}';
    let chars: Vec<char> = text.chars().collect();
    let first = chars.iter().position(|&c| is_ink(c))?;
    let last = chars.iter().rposition(|&c| is_ink(c))?;
    // 가로: 앞뒤 공백(양쪽 정렬 줄 끝 공백 등)은 잉크가 아니다.
    let positions = compute_char_positions(text, &run.style);
    let left = node.bbox.x + positions.get(first).copied().unwrap_or(0.0);
    let right = node.bbox.x
        + positions
            .get(last + 1)
            .copied()
            .unwrap_or(node.bbox.width)
            .min(node.bbox.width);
    let size = if run.style.font_size > 0.0 {
        run.style.font_size
    } else {
        12.0
    };
    let baseline = node.bbox.y + run.baseline;
    let (size, baseline) = if run.style.superscript {
        (size * 0.7, baseline - size * 0.3)
    } else if run.style.subscript {
        (size * 0.7, baseline + size * 0.15)
    } else {
        (size, baseline)
    };
    let descent = chars[first..=last]
        .iter()
        .filter(|&&c| is_ink(c))
        .map(|&c| descent_ratio(c))
        .fold(0.0f64, f64::max);
    let top = baseline - size * 0.72;
    let bottom = baseline + size * descent;
    Some(BoundingBox::new(left, top, right - left, bottom - top))
}
