/**
 * 에이전트 편집 버스트 중 렌더 파이프라인 합치기 계약.
 *
 * 문서 변이 이벤트가 짧은 간격으로 몰릴 때(에이전트 툴 호출 버스트/벌크 교체)
 * 이벤트마다 전체 canvas 를 부수고 다시 그리면 그래픽이 많은 문서에서 화면이
 * 멈춘다. 이 계약은 (1) 변이 재렌더가 프레임당 한 번으로 합쳐지고, (2) 보이는
 * 페이지는 canvas 를 유지한 채 제자리에서 다시 그려지며, (3) 오버레이 렌더도
 * 프레임 단위로 합쳐지는 구조를 고정한다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const canvasViewSrc = readFileSync(new URL('../src/view/canvas-view.ts', import.meta.url), 'utf8');
test('refreshPages 는 보이는 페이지 canvas 를 버리지 않고 제자리에서 다시 그린다', () => {
  const refreshPagesBody = canvasViewSrc.slice(
    canvasViewSrc.indexOf('refreshPages(): void {'),
    canvasViewSrc.indexOf('private refreshInvalidatedPageNow('),
  );
  // 전체 해제(releaseAllRenderedPages)는 줌/백엔드 교체 경로에만 남는다.
  assert.doesNotMatch(refreshPagesBody, /releaseAllRenderedPages/);
  assert.match(refreshPagesBody, /renderCanvas\(pageIdx, canvas\)/);
  // 화면 밖 선렌더 페이지는 즉시 다시 그리지 않고 idle 프리페치로 미룬다.
  assert.match(refreshPagesBody, /schedulePrefetchPages\(/);
});
