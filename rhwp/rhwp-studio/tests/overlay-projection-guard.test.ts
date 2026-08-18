import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 오버레이 사영 회귀 가드 (저작 시점 소스 스캔).
//
// 1. pageLeft: 그리드 배치(줌 ≤ 0.5, 다중 페이지)·수평 팬에서는 페이지가 중앙에
//    있지 않다. 하이라이트/핸들 레이어가 `(contentWidth - pageWidth) / 2` 중앙
//    가정으로 돌아가면, 클릭(getPageLeftResolved 사용)은 맞는데 하이라이트만
//    엉뚱한 좌표에 그려지는 비대칭이 재발한다.
// 2. 사영 이벤트 동기 재배치: pending 오버레이가 사영 이벤트(zoom-changed 등)를
//    rAF 로 미루면 줌 애니메이션·사이드바 이동(프레임마다 좌표가 바뀜) 동안
//    항상 한 프레임 뒤에 그려져 하이라이트가 본문에서 분리되어 보인다.
// 3. 선택/캐럿 재배치 이벤트: pageLeft/offset 을 움직이는 레이아웃 이벤트에
//    구독하지 않으면 리사이즈·사이드바 변화 후 하이라이트가 옛 좌표에 남는다.

const studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (rel: string) => readFileSync(path.join(studioRoot, 'src', rel), 'utf8');

const PROJECTION_RENDERERS = [
  'engine/selection-renderer.ts',
  'engine/cell-selection-renderer.ts',
  'engine/table-object-renderer.ts',
  'engine/table-resize-renderer.ts',
];

test('하이라이트/핸들 레이어는 중앙 가정 대신 getPageLeftResolved 를 쓴다', () => {
  for (const rel of PROJECTION_RENDERERS) {
    const code = src(rel);
    assert.ok(
      code.includes('getPageLeftResolved'),
      `${rel}: pageLeft 는 virtualScroll.getPageLeftResolved 로 얻어야 한다`,
    );
    assert.ok(
      !/\(contentWidth\s*-\s*(pageDisplayWidth|pdw)\)\s*\/\s*2/.test(code),
      `${rel}: 중앙 정렬 가정 '(contentWidth - pageWidth) / 2' 이 되살아났다`,
    );
  }
});

test('pending 오버레이의 사영 이벤트는 동기(projectNow)로 재배치한다', () => {
  const code = src('agent/pending-overlay.ts');
  const wiring = /projectionEvents[\s\S]{0,200}projectNow\(\)/.test(code);
  assert.ok(wiring, 'projectionEvents 구독이 projectNow() 동기 경로를 거쳐야 한다');
  assert.ok(
    /private projectNow\(\)[\s\S]{0,400}geometryDirty[\s\S]{0,200}scheduleRender\(\)/.test(code),
    'projectNow 는 geometryDirty(비싼 wasm 프로브)일 때만 rAF 배치로 넘겨야 한다',
  );
});

test('캐럿/선택 재배치는 레이아웃 이동 이벤트 전부에 구독된다', () => {
  const code = src('engine/input-handler.ts');
  for (const event of ['zoom-changed', 'page-layout-changed', 'viewport-resize', 'viewport-inset-changed']) {
    assert.ok(
      code.includes(`eventBus.on('${event}', repositionOverlays)`),
      `input-handler 는 '${event}' 에 repositionOverlays 를 구독해야 한다`,
    );
  }
});
