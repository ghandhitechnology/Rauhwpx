import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCanvasKitRenderMode,
  resolveCanvasKitRenderModeRequest,
  resolveCanvasKitSurfaceRequest,
  resolveRenderBackend,
  resolveRenderBackendRequest,
  resolveRenderProfile,
} from '../src/view/render-backend.ts';
import {
  canvasKitImageCacheKey,
  canvasKitImageFillModeTiles,
  canvasKitImageFillModeStretches,
  canvasKitImagePlacement,
  canvasKitImageSourceRect,
  HWPUNIT_PER_PIXEL,
} from '../src/view/canvaskit/image-replay.ts';
import {
  CANVASKIT_REPLAY_PLANES,
  layerPaintOpReplayPlane,
  renderLayerReplayPlane,
} from '../src/view/canvaskit/replay-plane.ts';
import { isExpectedCanvasKitUnsupportedOp } from '../src/view/canvaskit/diagnostics.ts';
import type { LayerInfo, LayerPaintOp } from '../src/core/types.ts';
import { glyphOutlinePayloadResourceKey, glyphOutlinePayloadStatus } from '../src/view/glyph-outline-payload-status.ts';
import { collectVectorRawSvgDataUrls } from '../src/view/raw-svg-prefetch.ts';

test('render backend resolver keeps Canvas2D as the compatibility default and accepts explicit aliases', () => {
  assert.equal(resolveRenderBackend(''), 'canvas2d');
  assert.equal(resolveRenderBackend('?renderer=auto'), 'auto');
  assert.equal(resolveRenderBackend('?renderer=canvas'), 'canvas2d');
  assert.equal(resolveRenderBackend('?renderer=canvas2d'), 'canvas2d');
  assert.equal(resolveRenderBackend('?renderer=canvaskit'), 'canvaskit');
  assert.equal(resolveRenderBackend('?renderer=skia'), 'canvaskit');
});

test('render backend resolver reports invalid explicit values and keeps URL opt-ins ephemeral', () => {
  const originalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => 'canvaskit',
    setItem: () => undefined,
  };
  try {
    assert.equal(resolveRenderBackend(''), 'canvas2d');
    assert.deepEqual(resolveRenderBackendRequest(''), {
      backend: 'canvas2d',
      source: 'default',
    });
    assert.deepEqual(resolveRenderBackendRequest('?renderer=auto'), {
      backend: 'auto',
      source: 'url',
      requested: 'auto',
    });
    assert.deepEqual(resolveRenderBackendRequest('?renderer=canvaskit'), {
      backend: 'canvaskit',
      source: 'url',
      requested: 'canvaskit',
    });
    assert.deepEqual(resolveRenderBackendRequest('?renderer=unknown'), {
      backend: 'canvas2d',
      source: 'url',
      requested: 'unknown',
      unsupportedReason: 'unsupportedRenderBackend',
    });
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = originalStorage;
  }
});

test('CanvasKit readiness classification keeps new diagnostic suffixes unexpected', () => {
  for (const expected of [
    'glyphOutline:unsupportedColorGlyph',
    'imageEffect:grayScale',
    'textRun:verticalText',
  ]) {
    assert.equal(isExpectedCanvasKitUnsupportedOp(expected), true, expected);
  }
  for (const unexpected of [
    'glyphOutline:replayInvariant',
    'imageEffect:futureEffect',
    'textRun:newCoverageGap',
    'renderPage',
    'unknown',
  ]) {
    assert.equal(isExpectedCanvasKitUnsupportedOp(unexpected), false, unexpected);
  }
});

test('CanvasKit mode resolver exposes default and conservative compat direct modes', () => {
  assert.equal(resolveCanvasKitRenderMode(''), 'default');
  assert.equal(resolveCanvasKitRenderMode('?canvaskitMode=compat'), 'compat');
  assert.equal(resolveCanvasKitRenderMode('?skiaMode=compatibility'), 'compat');
  assert.equal(resolveCanvasKitRenderMode('?canvaskitMode=overlay'), 'default');
  assert.deepEqual(resolveCanvasKitRenderModeRequest('?canvaskitMode=compat'), {
    mode: 'compat',
    source: 'url',
    requested: 'compat',
  });
  assert.deepEqual(resolveCanvasKitRenderModeRequest('?canvaskitMode=overlay'), {
    mode: 'default',
    source: 'url',
    requested: 'overlay',
    unsupportedReason: 'unsupportedCanvasKitMode',
  });
});

test('CanvasKit mode request reports storage selection and lets URL override it', () => {
  const originalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => key === 'rhwp.canvaskitMode' ? 'compat' : null,
    setItem: () => undefined,
  };
  try {
    assert.deepEqual(resolveCanvasKitRenderModeRequest(''), {
      mode: 'compat',
      source: 'storage',
      requested: 'compat',
    });
    assert.deepEqual(resolveCanvasKitRenderModeRequest('?canvaskitMode=default'), {
      mode: 'default',
      source: 'url',
      requested: 'default',
    });
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = originalStorage;
  }
});

test('CanvasKit surface resolver records unsupported requests without throwing', () => {
  assert.deepEqual(resolveCanvasKitSurfaceRequest('?canvaskitSurface=webgpu'), {
    preference: 'webgpu',
    requested: 'webgpu',
  });
  assert.deepEqual(resolveCanvasKitSurfaceRequest('?canvaskitSurface=cpu'), {
    preference: 'software',
    requested: 'cpu',
  });
  assert.deepEqual(resolveCanvasKitSurfaceRequest('?canvaskitSurface=metal'), {
    preference: 'auto',
    requested: 'metal',
    unsupportedReason: 'unsupportedSurfaceBackend',
  });
});

test('render profile resolver keeps screen as the stable browser default', () => {
  assert.equal(resolveRenderProfile(''), 'screen');
  assert.equal(resolveRenderProfile('?renderProfile=fast-preview'), 'fastPreview');
  assert.equal(resolveRenderProfile('?profile=print'), 'print');
  assert.equal(resolveRenderProfile('?profile=highQuality'), 'highQuality');
});

test('CanvasKit replay planes match native Skia direct z-order contract', () => {
  assert.deepEqual(
    [...CANVASKIT_REPLAY_PLANES],
    ['background', 'behindText', 'flow', 'inFrontOfText'],
  );
});

test('CanvasKit replay plane helper classifies PageLayerTree ops by wrap', () => {
  const bbox = { x: 0, y: 0, width: 10, height: 10 };
  const cases: Array<[LayerPaintOp, string]> = [
    [{ type: 'pageBackground', bbox }, 'background'],
    [{ type: 'image', bbox, wrap: 'behindText' }, 'behindText'],
    [{ type: 'image', bbox, wrap: 'inFrontOfText' }, 'inFrontOfText'],
    [{ type: 'image', bbox, wrap: 'topAndBottom' }, 'flow'],
    [{ type: 'image', bbox }, 'flow'],
    [{ type: 'textRun', bbox, text: 'flow' }, 'flow'],
    [{ type: 'rectangle', bbox, style: { fillColor: '#ff0000' } }, 'flow'],
  ];

  for (const [op, expected] of cases) {
    assert.equal(layerPaintOpReplayPlane(op), expected, op.type);
  }
});

test('CanvasKit replay plane helper lets LayerNode metadata override non-image ops', () => {
  const bbox = { x: 0, y: 0, width: 10, height: 10 };
  const rect: LayerPaintOp = { type: 'rectangle', bbox, style: { fillColor: '#ff0000' } };
  const behind: LayerInfo = { textWrap: 'behindText', zOrder: 1, stableIndex: 1 };
  const front: LayerInfo = { textWrap: 'inFrontOfText', zOrder: 2, stableIndex: 2 };
  const flow: LayerInfo = { textWrap: 'topAndBottom', zOrder: 3, stableIndex: 3 };

  assert.equal(renderLayerReplayPlane(behind), 'behindText');
  assert.equal(renderLayerReplayPlane(front), 'inFrontOfText');
  assert.equal(renderLayerReplayPlane(flow), 'flow');
  assert.equal(layerPaintOpReplayPlane(rect, behind), 'behindText');
  assert.equal(layerPaintOpReplayPlane(rect, front), 'inFrontOfText');
});

test('CanvasKit replay plane caps master-page layers at behindText (#2318)', () => {
  // 한컴 의미론: 바탕쪽 개체의 textWrap 은 바탕쪽 내부 순서에만 적용되고
  // 바탕쪽 전체는 본문 뒤에 깔린다. masterPage provenance 가 있으면
  // front/flow 분류를 behindText 로 상한 고정한다 (rust cap_master_page_plane 동일 계약).
  const bbox = { x: 0, y: 0, width: 10, height: 10 };
  const rect: LayerPaintOp = { type: 'rectangle', bbox, style: { fillColor: '#ff0000' } };
  const image: LayerPaintOp = { type: 'image', bbox, wrap: 'inFrontOfText' };
  const pageBg: LayerPaintOp = { type: 'pageBackground', bbox };

  const masterFront: LayerInfo = {
    textWrap: 'inFrontOfText', zOrder: 1, stableIndex: 1, masterPage: true,
  };
  const masterPlain: LayerInfo = { textWrap: null, zOrder: 0, stableIndex: 0, masterPage: true };
  const masterBehind: LayerInfo = {
    textWrap: 'behindText', zOrder: 1, stableIndex: 1, masterPage: true,
  };

  // 바탕쪽 글상자(글 앞으로) → behindText 로 cap (shortcut.hwp 재현 형상)
  assert.equal(renderLayerReplayPlane(masterFront), 'behindText');
  assert.equal(layerPaintOpReplayPlane(rect, masterFront), 'behindText');
  assert.equal(layerPaintOpReplayPlane(image, masterFront), 'behindText');
  // 바탕쪽 텍스트(layer 상속, wrap 없음) → flow 가 아니라 behindText
  assert.equal(layerPaintOpReplayPlane(rect, masterPlain), 'behindText');
  // 이미 behindText 인 바탕쪽 개체는 그대로
  assert.equal(renderLayerReplayPlane(masterBehind), 'behindText');
  // pageBackground 는 cap 대상 아님
  assert.equal(layerPaintOpReplayPlane(pageBg, masterFront), 'background');
  // masterPage 미표시 layer 는 기존 분류 유지
  const bodyFront: LayerInfo = { textWrap: 'inFrontOfText', zOrder: 1, stableIndex: 1 };
  assert.equal(renderLayerReplayPlane(bodyFront), 'inFrontOfText');
});

test('순수 RawSvg 프리페치는 PageLayerTree bbox 계약으로 SVG URL을 만든다', () => {
  const urls: string[] = [];
  collectVectorRawSvgDataUrls({
    root: {
      kind: 'leaf',
      ops: [{
        type: 'rawSvg',
        bbox: { x: 12.5, y: 34.25, width: 56.75, height: 78.5 },
        svg: '<g class="hwp-ooxml-chart"><path d="M0 0"/></g>',
      }],
    },
  }, urls);

  assert.equal(urls.length, 1);
  assert.match(urls[0], /^data:image\/svg\+xml;base64,/);
  const encoded = urls[0].slice(urls[0].indexOf(',') + 1);
  const svg = Buffer.from(encoded, 'base64').toString('utf8');
  assert.equal(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
      + 'width="56.750" height="78.500" viewBox="12.500 34.250 56.750 78.500">\n'
      + '<g class="hwp-ooxml-chart"><path d="M0 0"/></g>\n</svg>',
  );

  collectVectorRawSvgDataUrls({
    type: 'rawSvg',
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    svg: '<image href="data:image/png;base64,AA=="/>',
  }, urls);
  assert.equal(urls.length, 1, '내부 raster data URL이 있는 rawSvg는 별도 프리페치하지 않는다');
});

test('CanvasKit image replay cache key includes payload fingerprint with repeated image refs', () => {
  const first = canvasKitImageCacheKey({ imageRef: 7, mime: 'image/png', base64: 'AAAA' });
  const second = canvasKitImageCacheKey({ imageRef: 7, mime: 'image/png', base64: 'BBBB' });
  assert.notEqual(first, second);
  assert.ok((first ?? '').startsWith('ref:7|image/png:4:'));
});

test('CanvasKit image crop source follows the same HWPUNIT crop scale as SVG replay', () => {
  const crop = canvasKitImageSourceRect(2320, 354, { left: 0, top: 0, right: 102366, bottom: 26580 });
  assert.ok(crop);
  assert.equal(crop.x, 0);
  assert.equal(crop.y, 0);
  assert.ok(Math.abs(crop.width - (102366 / HWPUNIT_PER_PIXEL)) < 0.01);
  assert.equal(crop.height, 354);
  assert.equal(canvasKitImageSourceRect(2320, 354, { left: 0, top: 0, right: 174000, bottom: 26580 }), null);
});

test('CanvasKit image crop source honors issue2817 imgDim coordinates', () => {
  assert.equal(
    canvasKitImageSourceRect(
      192,
      108,
      { left: 0, top: 0, right: 144000, bottom: 81000 },
      [144000, 81000],
    ),
    null,
  );
});

test('CanvasKit image placement follows layer fill-mode anchors', () => {
  const bbox = { x: 10, y: 20, width: 100, height: 80 };
  assert.deepEqual(canvasKitImagePlacement('center', bbox, 40, 20), { x: 40, y: 50 });
  assert.deepEqual(canvasKitImagePlacement('rightBottom', bbox, 40, 20), { x: 70, y: 80 });
  assert.deepEqual(canvasKitImagePlacement('leftTop', bbox, 40, 20), { x: 10, y: 20 });
});

test('CanvasKit image fill-mode tiling detection stays explicit', () => {
  for (const mode of ['tileAll', 'tileHorzTop', 'tileHorzBottom', 'tileVertLeft', 'tileVertRight']) {
    assert.equal(canvasKitImageFillModeTiles(mode), true);
  }
  for (const mode of [undefined, 'fitToSize', 'none', 'center', 'leftTop', 'rightBottom']) {
    assert.equal(canvasKitImageFillModeTiles(mode), false);
  }
});

test('CanvasKit image TOTAL fill stretches like fitToSize', () => {
  for (const mode of [undefined, 'fitToSize', 'total']) {
    assert.equal(canvasKitImageFillModeStretches(mode), true);
  }
  for (const mode of ['none', 'center', 'leftTop', 'tileAll']) {
    assert.equal(canvasKitImageFillModeStretches(mode), false);
  }
});

test('GlyphOutline advanced payload gates reject richer payloads by default', () => {
  assert.deepEqual(
    glyphOutlinePayloadStatus({
      type: 'glyphOutline',
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      payloadKind: 'colorLayers',
      colorLayers: {
        colorFormat: 'colrV1',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        paintGraph: {
          rootNodeId: 0,
          nodes: [{
            nodeId: 0,
            kind: 'solidPath',
            solidPath: {
              commands: [{ type: 'moveTo', x: 0, y: 0 }],
              fill: { rgba: [0, 0, 0, 1] },
              fillRule: 'nonzero',
            },
            sourceRangeUtf8: { start: 0, end: 1 },
            glyphRange: { start: 0, end: 1 },
            sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV1' },
          }],
        },
      },
    }).reason,
    'unsupportedColorGlyph',
  );
  assert.equal(
    glyphOutlinePayloadStatus({
      type: 'glyphOutline',
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      payloadKind: 'bitmapGlyph',
      bitmapGlyph: {
        imageRef: 1,
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: { x: 0, y: 0, width: 10, height: 10 },
        scalingPolicy: 'sourceExact',
        filtering: 'linear',
      },
    }).reason,
    'unsupportedBitmapGlyph',
  );
  assert.equal(
    glyphOutlinePayloadStatus({
      type: 'glyphOutline',
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      payloadKind: 'svgGlyph',
      svgGlyph: {
        svgRef: 1,
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        viewBox: { x: 0, y: 0, width: 10, height: 10 },
        staticSanitized: true,
        scriptAllowed: false,
        animationAllowed: false,
        externalResourcesAllowed: false,
        interactivityAllowed: false,
      },
    }).reason,
    'unsupportedSvgGlyph',
  );
});

test('GlyphOutline payload resource keys keep payload families and palettes disjoint', () => {
  const colorBase = {
    type: 'glyphOutline' as const,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    payloadKind: 'colorLayers' as const,
    colorLayers: {
      colorFormat: 'colrV1',
      sourceRangeUtf8: { start: 0, end: 1 },
      glyphRange: { start: 0, end: 1 },
      sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV1' },
      paletteRef: { id: 'document-palette', index: 0, cpalDigest: 'a'.repeat(64) },
      paintGraph: {
        rootNodeId: 0,
        nodes: [{
          nodeId: 0,
          kind: 'solidPath',
          solidPath: {
            commands: [{ type: 'moveTo', x: 0, y: 0 }],
            fill: { rgba: [0, 0, 0, 1] },
            fillRule: 'nonzero',
          },
          sourceRangeUtf8: { start: 0, end: 1 },
          glyphRange: { start: 0, end: 1 },
          sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV1' },
        }],
      },
    },
  };
  const colorKey = glyphOutlinePayloadResourceKey(colorBase);
  const alternatePaletteKey = glyphOutlinePayloadResourceKey({
    ...colorBase,
    colorLayers: {
      ...colorBase.colorLayers,
      paletteRef: { id: 'document-palette', index: 1, cpalDigest: 'b'.repeat(64) },
    },
  });
  const bitmapKey = glyphOutlinePayloadResourceKey({
    type: 'glyphOutline',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    payloadKind: 'bitmapGlyph',
    bitmapGlyph: {
      imageRef: 7,
      sourceRangeUtf8: { start: 0, end: 1 },
      glyphRange: { start: 0, end: 1 },
      placement: { x: 0.1234, y: 0.5678, width: 10.9876, height: 10.5432 },
      scalingPolicy: 'sourceExact',
      filtering: 'linear',
    },
  });
  const svgKey = glyphOutlinePayloadResourceKey({
    type: 'glyphOutline',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    payloadKind: 'svgGlyph',
    svgGlyph: {
      svgRef: 7,
      sourceRangeUtf8: { start: 0, end: 1 },
      glyphRange: { start: 0, end: 1 },
      viewBox: { x: 0.1234, y: 0.5678, width: 10.9876, height: 10.5432 },
      staticSanitized: true,
      scriptAllowed: false,
      animationAllowed: false,
      externalResourcesAllowed: false,
      interactivityAllowed: false,
    },
  });

  assert.ok(colorKey?.includes('palette:id:document-palette:index:0:digest:'));
  assert.notEqual(colorKey, alternatePaletteKey);
  assert.ok(bitmapKey?.startsWith('glyphPayload:bitmapGlyph:imageRef:7'));
  assert.ok(bitmapKey?.includes('placement:0.123,0.568,10.988,10.543'));
  assert.ok(svgKey?.startsWith('glyphPayload:svgGlyph:svgRef:7'));
  assert.ok(svgKey?.includes('viewBox:0.123,0.568,10.988,10.543'));
  assert.notEqual(colorKey, bitmapKey);
  assert.notEqual(colorKey, svgKey);
  assert.notEqual(bitmapKey, svgKey);
});

test('GlyphOutline payload resource keys are suppressed for incomplete payloads', () => {
  assert.equal(glyphOutlinePayloadResourceKey({
    type: 'glyphOutline',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    payloadKind: 'bitmapGlyph',
    bitmapGlyph: {
      imageRef: 7,
      sourceRangeUtf8: { start: 0, end: 1 },
      glyphRange: { start: 0, end: 1 },
      scalingPolicy: 'backendDefault',
      filtering: 'linear',
    },
  }), null);
  assert.equal(glyphOutlinePayloadResourceKey({
    type: 'glyphOutline',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    payloadKind: 'svgGlyph',
    svgGlyph: {
      svgRef: 7,
      sourceRangeUtf8: { start: 0, end: 1 },
      glyphRange: { start: 0, end: 1 },
      viewBox: { x: 0, y: 0, width: 10, height: 10 },
      staticSanitized: false,
      scriptAllowed: false,
      animationAllowed: false,
      externalResourcesAllowed: false,
      interactivityAllowed: false,
    },
  }), null);
});

test('GlyphOutline COLRv1 gate reports unsupported graph node kind exactly', () => {
  const status = glyphOutlinePayloadStatus({
    type: 'glyphOutline',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    payloadKind: 'colorLayers',
    colorLayers: {
      colorFormat: 'colrV1',
      paintGraph: {
        rootNodeId: 0,
        nodes: [{ nodeId: 0, kind: 'composite' }],
      },
    },
  }, { allowColrv1Stage1ColorGraph: true });
  assert.equal(status.reason, 'unsupportedColorGlyph');
  assert.equal(status.detail, 'colrV1Node:composite');
});

test('GlyphOutline COLRv1 gradient graph subset can pass the explicit gate', () => {
  const commands = [{ type: 'moveTo', x: 0, y: 0 }, { type: 'lineTo', x: 10, y: 0 }, { type: 'closePath' }];
  const stops = [
    { offset: 0, color: { rgba: [1, 0, 0, 1] } },
    { offset: 1, color: { rgba: [0, 0, 1, 1] } },
  ];
  const cases = [
    {
      kind: 'linearGradientPath',
      field: 'linearGradientPath',
      value: { commands, gradient: { x0: 0, y0: 0, x1: 10, y1: 10, stops }, fillRule: 'nonzero' },
    },
    {
      kind: 'radialGradientPath',
      field: 'radialGradientPath',
      value: { commands, gradient: { cx: 5, cy: 5, radius: 5, stops }, fillRule: 'nonzero' },
    },
    {
      kind: 'sweepGradientPath',
      field: 'sweepGradientPath',
      value: { commands, gradient: { cx: 5, cy: 5, startAngleDegrees: 0, endAngleDegrees: 360, stops }, fillRule: 'nonzero' },
    },
  ];
  for (const entry of cases) {
    const status = glyphOutlinePayloadStatus({
      type: 'glyphOutline',
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      payloadKind: 'colorLayers',
      colorLayers: {
        colorFormat: 'colrV1',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV1' },
        paintGraph: {
          rootNodeId: 0,
          nodes: [{
            nodeId: 0,
            kind: entry.kind,
            [entry.field]: entry.value,
            sourceRangeUtf8: { start: 0, end: 1 },
            glyphRange: { start: 0, end: 1 },
            sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV1' },
          }],
        },
      },
    }, { allowColrv1Stage1ColorGraph: true });
    assert.equal(status.supported, true, entry.kind);
  }
});
