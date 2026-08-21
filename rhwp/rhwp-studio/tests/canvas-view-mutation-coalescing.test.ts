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
const overlaySrc = readFileSync(new URL('../src/agent/pending-overlay.ts', import.meta.url), 'utf8');
const pendingSrc = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');
const revealSrc = readFileSync(new URL('../src/agent/typewriter-reveal.ts', import.meta.url), 'utf8');

test('document-changed 는 프레임당 한 번의 변이 재렌더로 합쳐진다', () => {
  assert.match(canvasViewSrc, /eventBus\.on\('document-changed', \(\) => this\.scheduleMutationRefresh\(\)\)/);
  assert.match(canvasViewSrc, /private scheduleMutationRefresh\(\): void/);
  assert.match(canvasViewSrc, /this\.mutationRefreshRafId = requestAnimationFrame\(/);
  // 전체 재렌더가 예약돼 있으면 단일 페이지 무효화는 그 안에 흡수된다.
  assert.match(canvasViewSrc, /if \(this\.mutationRefreshRafId !== null\) return;\s*\n\s*void this\.refreshInvalidatedPageForMutation/);
  // 문서 교체/정리 시 예약된 재렌더를 취소한다.
  assert.match(canvasViewSrc, /private reset\(\): void \{\s*\n\s*this\.cancelScheduledMutationRefresh\(\)/);
});

test('refreshPages 는 보이는 페이지 canvas 를 버리지 않고 제자리에서 다시 그린다', () => {
  const refreshPagesBody = canvasViewSrc.slice(
    canvasViewSrc.indexOf('refreshPages(): void {'),
    canvasViewSrc.indexOf('/** 텍스트 입력처럼 좁은 변경은'),
  );
  // 전체 해제(releaseAllRenderedPages)는 줌/백엔드 교체 경로에만 남는다.
  assert.doesNotMatch(refreshPagesBody, /releaseAllRenderedPages/);
  assert.match(refreshPagesBody, /renderCanvas\(pageIdx, canvas\)/);
  // 화면 밖 선렌더 페이지는 즉시 다시 그리지 않고 idle 프리페치로 미룬다.
  assert.match(refreshPagesBody, /schedulePrefetchPages\(/);
});

test('오버레이/pending 편집도 버스트를 합친다', () => {
  // 오버레이 렌더는 rAF 로 합쳐진다 (setOps 포함).
  assert.match(overlaySrc, /private scheduleRender\(\): void/);
  assert.match(overlaySrc, /this\.renderRafId = requestAnimationFrame\(/);
  // 다중 op 배치(replace_all/apply_edits/apply_list)는 항목마다가 아니라 배치 끝에
  // 한 번만 조판/이벤트/오버레이를 수행한다. (클론 횟수·복원 충실도 계약은
  // agent-pending-replace.test.ts 의 runAtomicBatch 동작 테스트가 지킨다.)
  assert.match(pendingSrc, /private beginBulk\(\): void/);
  assert.match(pendingSrc, /private endBulk\(\): void/);
  assert.match(pendingSrc, /runAtomicBatch<T>\(fn: \(\) => T\): T/);
  // 타자기 공개는 페이지 좌표 rect 를 캐시하고 문서 변이에서만 무효화한다.
  assert.match(revealSrc, /cachedRects: SelectionRect\[\] \| null/);
  assert.match(revealSrc, /item\.cachedRects = null/);
});
