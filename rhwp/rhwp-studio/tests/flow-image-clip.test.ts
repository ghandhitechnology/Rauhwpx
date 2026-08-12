import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectFlowImagePaintOps,
  composeImageFilter,
  planFlowImageClip,
  rotatedFrameExtent,
  visibleFlowImageBbox,
} from '../src/view/flow-image-clip.ts';

const image = (bbox: { x: number; y: number; width: number; height: number }) => ({
  type: 'image',
  bbox,
  mime: 'image/png',
  base64: 'AA==',
});

type Bbox = { x: number; y: number; width: number; height: number };

// planFlowImageClip 입력용 최소 FlowImagePaintOp.
const paintOp = (bbox: Bbox, rotation: number, clip: Bbox | null) => ({
  bbox,
  mime: 'image/png',
  base64: 'AA==',
  crop: null,
  originalSizeHu: null,
  rotation,
  horzFlip: false,
  vertFlip: false,
  filter: null,
  clip,
});

const closeTo = (actual: number, expected: number, message: string) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} !== ${expected}`);
};

test('flow image collector keeps the nested table-cell clip', () => {
  const tree = {
    kind: 'clipRect',
    clip: { x: 0, y: 0, width: 120, height: 80 },
    child: {
      kind: 'clipRect',
      clip: { x: 20, y: 10, width: 40, height: 30 },
      child: {
        kind: 'leaf',
        ops: [
          image({ x: 25, y: 15, width: 20, height: 10 }),
          image({ x: 70, y: 15, width: 20, height: 10 }),
        ],
      },
    },
  };

  const images = collectFlowImagePaintOps(tree, (op) => op.type === 'image');

  assert.equal(images.length, 2);
  assert.deepEqual(images[0].clip, { x: 20, y: 10, width: 40, height: 30 });
  assert.deepEqual(visibleFlowImageBbox(images[0]), { x: 25, y: 15, width: 20, height: 10 });
  assert.equal(visibleFlowImageBbox(images[1]), null);
});

test('flow image collector leaves unclipped images unchanged', () => {
  const images = collectFlowImagePaintOps(
    { kind: 'leaf', ops: [image({ x: 3, y: 4, width: 5, height: 6 })] },
    (op) => op.type === 'image',
  );

  assert.equal(images.length, 1);
  assert.equal(images[0].clip, null);
  assert.deepEqual(visibleFlowImageBbox(images[0]), { x: 3, y: 4, width: 5, height: 6 });
});

// composeImageFilter 효과별 CSS filter 문자열 pin (PR #2523 검토 후속 권고).
// web_canvas.rs::compose_image_filter 와 동일 산출 계약 — 문자열이 바뀌면
// WASM canvas 경로와 DOM flow-image 경로의 그림 효과가 갈라진다.

test('composeImageFilter pins effect-only outputs', () => {
  assert.equal(composeImageFilter({}), null);
  assert.equal(composeImageFilter({ effect: 'realPic' }), null);
  assert.equal(composeImageFilter({ effect: 'grayScale' }), 'grayscale(100%)');
  assert.equal(composeImageFilter({ effect: 'pattern8x8' }), 'grayscale(100%)');
  assert.equal(
    composeImageFilter({ effect: 'blackWhite' }),
    'grayscale(100%) contrast(1000%)',
  );
});

test('composeImageFilter pins brightness/contrast scaling', () => {
  assert.equal(composeImageFilter({ brightness: 20 }), 'brightness(1.2000)');
  assert.equal(composeImageFilter({ brightness: -20 }), 'brightness(0.8000)');
  assert.equal(composeImageFilter({ contrast: -30 }), 'contrast(0.7000)');
  assert.equal(composeImageFilter({ contrast: 50 }), 'contrast(1.5000)');
  assert.equal(
    composeImageFilter({ effect: 'grayScale', brightness: 10, contrast: -10 }),
    'grayscale(100%) brightness(1.1000) contrast(0.9000)',
  );
});

test('composeImageFilter ignores baked watermark and non-finite inputs', () => {
  // baked 픽셀은 효과가 이미 적용돼 있으므로 filter 를 걸지 않는다.
  assert.equal(
    composeImageFilter({ effect: 'blackWhite', brightness: 40, bakedWatermark: true }),
    null,
  );
  // 비유한/비문자 입력은 기본값(효과 없음, 0)으로 정규화.
  assert.equal(composeImageFilter({ brightness: Number.NaN, contrast: Infinity }), null);
  assert.equal(composeImageFilter({ effect: 123 }), null);
});

// 회전 그림 clip 계획 — PR #17 회귀.
// 회전한 프레임을 자기 미회전 bbox 로 자르면 모서리가 깎여 canvas/PDF 경로와 갈라진다.

test('rotatedFrameExtent 는 bbox 중심을 유지한 회전 후 AABB 를 낸다', () => {
  const bbox = { x: 10, y: 20, width: 40, height: 20 };

  assert.deepEqual(rotatedFrameExtent(bbox, 0), bbox);

  const quarter = rotatedFrameExtent(bbox, 90);
  closeTo(quarter.width, 20, '90도 폭');
  closeTo(quarter.height, 40, '90도 높이');
  closeTo(quarter.x + quarter.width / 2, 30, '90도 중심 x');
  closeTo(quarter.y + quarter.height / 2, 30, '90도 중심 y');

  const diagonal = rotatedFrameExtent(bbox, 45);
  const expected = (40 + 20) * Math.SQRT1_2;
  closeTo(diagonal.width, expected, '45도 폭');
  closeTo(diagonal.height, expected, '45도 높이');
  closeTo(diagonal.x + diagonal.width / 2, 30, '45도 중심 x');

  // -45도와 315도는 같은 AABB.
  const negative = rotatedFrameExtent(bbox, -45);
  const wrapped = rotatedFrameExtent(bbox, 315);
  closeTo(negative.width, wrapped.width, '-45/315 폭');
  closeTo(negative.height, wrapped.height, '-45/315 높이');
});

test('회전 그림이 clip 안에 온전히 들어가면 wrapper 를 두지 않는다', () => {
  // body clipRect 는 기본적으로 항상 붙으므로 clip !== null 이 일반적인 경우다.
  const plan = planFlowImageClip(
    paintOp({ x: 100, y: 100, width: 40, height: 20 }, 45, {
      x: 0,
      y: 0,
      width: 600,
      height: 800,
    }),
  );

  assert.ok(plan);
  assert.equal(plan.needsWrapper, false);
  // host 는 미회전 bbox 가 아니라 회전 후 AABB 여야 한다(모서리 보존).
  closeTo(plan.host.width, (40 + 20) * Math.SQRT1_2, 'host 폭');
  assert.ok(plan.host.width > 40, 'host 가 미회전 bbox 폭보다 크다');
});

test('회전 그림은 clip 이 실제로 깎을 때만 회전 AABB∩clip 으로 잘린다', () => {
  const bbox = { x: 100, y: 100, width: 40, height: 20 };
  const extent = rotatedFrameExtent(bbox, 45);
  const clip = { x: 110, y: 0, width: 600, height: 800 };
  const plan = planFlowImageClip(paintOp(bbox, 45, clip));

  assert.ok(plan);
  assert.equal(plan.needsWrapper, true);
  assert.equal(plan.host.x, 110);
  closeTo(plan.host.width, extent.x + extent.width - 110, 'host 폭 = 회전 AABB 우측 - clip 좌측');
  // 오른쪽으로는 미회전 bbox(140) 를 넘어 회전 AABB 끝까지 살아 있어야 한다.
  assert.ok(plan.host.x + plan.host.width > 140, '회전으로 튀어나온 부분이 남는다');
  assert.equal(plan.host.y, extent.y);
  closeTo(plan.host.height, extent.height, 'host 높이');
});

test('회전 AABB 가 clip 과 전혀 겹치지 않으면 그리지 않는다', () => {
  const plan = planFlowImageClip(
    paintOp({ x: 100, y: 100, width: 40, height: 20 }, 45, {
      x: 0,
      y: 0,
      width: 50,
      height: 800,
    }),
  );

  assert.equal(plan, null);
});

test('미회전 bbox 는 clip 밖이어도 회전으로 겹치면 그린다', () => {
  const bbox = { x: 100, y: 100, width: 40, height: 20 };
  // 미회전 bbox 좌측(100)보다 clip 우측(99.5)이 앞서므로 미회전 교차는 없지만,
  // 45도 회전 AABB 는 x≈98.79 부터 시작해 clip 과 겹친다.
  const clip = { x: 0, y: 0, width: 99.5, height: 800 };
  assert.equal(visibleFlowImageBbox(paintOp(bbox, 45, clip)), null);

  const plan = planFlowImageClip(paintOp(bbox, 45, clip));
  assert.ok(plan);
  assert.equal(plan.needsWrapper, true);
  assert.equal(plan.host.x, rotatedFrameExtent(bbox, 45).x);
  closeTo(plan.host.x + plan.host.width, 99.5, 'host 우측 = clip 우측');
});

test('회전이 없으면 기존 wrapper 판정을 그대로 유지한다', () => {
  const bbox = { x: 10, y: 10, width: 40, height: 20 };

  // clip 없음 — wrapper 없음.
  const unclipped = planFlowImageClip(paintOp(bbox, 0, null));
  assert.ok(unclipped);
  assert.equal(unclipped.needsWrapper, false);
  assert.deepEqual(unclipped.host, bbox);

  // clip 이 그림을 덮기만 함 — wrapper 없음.
  const loose = planFlowImageClip(paintOp(bbox, 0, { x: 0, y: 0, width: 200, height: 200 }));
  assert.ok(loose);
  assert.equal(loose.needsWrapper, false);
  assert.deepEqual(loose.host, bbox);

  // clip 이 실제로 깎음 — wrapper 는 교차 영역 크기.
  const tight = planFlowImageClip(paintOp(bbox, 0, { x: 20, y: 0, width: 200, height: 200 }));
  assert.ok(tight);
  assert.equal(tight.needsWrapper, true);
  assert.deepEqual(tight.host, { x: 20, y: 10, width: 30, height: 20 });

  // clip 밖 — 그리지 않음.
  assert.equal(
    planFlowImageClip(paintOp(bbox, 0, { x: 300, y: 0, width: 50, height: 50 })),
    null,
  );
});

test('비유한 회전각은 0도로 낮춰 처리한다', () => {
  const bbox = { x: 10, y: 10, width: 40, height: 20 };
  const clip = { x: 0, y: 0, width: 200, height: 200 };

  for (const rotation of [Number.NaN, Infinity, -Infinity]) {
    const plan = planFlowImageClip(paintOp(bbox, rotation, clip));
    assert.ok(plan, `rotation=${rotation}`);
    assert.equal(plan.needsWrapper, false);
    assert.deepEqual(plan.host, bbox);
  }

  const extent = rotatedFrameExtent(bbox, Number.NaN);
  assert.deepEqual(extent, bbox);
});
