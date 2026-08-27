import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pendingSrc = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');
const overlaySrc = readFileSync(new URL('../src/agent/pending-overlay.ts', import.meta.url), 'utf8');
const overlayCss = readFileSync(new URL('../src/agent/pending-overlay.css', import.meta.url), 'utf8');
const revealSrc = readFileSync(new URL('../src/agent/typewriter-reveal.ts', import.meta.url), 'utf8');

test('replace overlay receives both sides without changing the pending operation model', () => {
  assert.match(pendingSrc, /kind: 'replace',[\s\S]*id: op\.id,[\s\S]*oldText: op\.deletedText,[\s\S]*newText: op\.text/);
  assert.match(overlaySrc, /computeExactTextDiff\(op\.oldText, op\.newText\)/);
  assert.match(overlaySrc, /rangeForNewScalarOffsets\(op\.range, op\.newText, hunk\.newStart, hunk\.newEnd\)/);
});

test('inspection observes pointer and caret state without intercepting editor input', () => {
  const pointerHandler = overlaySrc.slice(
    overlaySrc.indexOf('private onPointerMove'),
    overlaySrc.indexOf('private onPointerLeave'),
  );
  assert.match(pointerHandler, /this\.hitRegions\.find/);
  assert.doesNotMatch(pointerHandler, /preventDefault|stopPropagation/);
  assert.match(overlaySrc, /eventBus\.on\('cursor-rect-updated',[\s\S]*this\.inspectCaret\(\)/);
  assert.match(overlaySrc, /event\.key !== 'Escape'/);
});

test('typewriter reveal is bounded, one-shot, and reduced-motion safe', () => {
  // 청크 하나의 공개 시간은 상한이 있고, reduced-motion 은 공개 자체를 건너뛴다.
  assert.match(revealSrc, /const REVEAL_MAX_MS = 900/);
  assert.match(revealSrc, /this\.reduceMotion\?\.matches/);
  // 교체는 exact diff 의 추가 훙크만 덮는다. 원문 접두/접미는 다시 타자하지 않는다.
  assert.match(revealSrc, /computeExactTextDiff\(oldText, text\)/);
  assert.match(pendingSrc, /emit\('agent-text-inserted'[\s\S]*oldText: deletedText/);
  // 커버(z9)는 잉크(z6)·마커(z7)·앵커(z8) 위, 캐럿(z10) 아래에 선다.
  assert.match(overlayCss, /\.ag-reveal-cover[\s\S]*z-index: 9/);
  assert.match(overlayCss, /\.ag-typewriter-caret[\s\S]*z-index: 10/);
  // 앵커 등장 애니메이션은 노드 생성 시 1회만 재생된다 (노드는 렌더 간 재사용).
  assert.match(overlaySrc, /marker\.classList\.add\('ag-liquid-anchor-in'\)/);
  assert.match(overlaySrc, /animationend[\s\S]*ag-liquid-anchor-in/);
  assert.match(overlayCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
});

test('overlay reconciles DOM by key and reprojects without reprobing on view changes', () => {
  // 문서 변경 이벤트만 wasm rect 프로브를 다시 한다.
  assert.match(overlaySrc, /geometryEvents = \['document-changed', 'document-page-invalidated', 'document-view-changed'\]/);
  assert.match(overlaySrc, /projectionEvents = \['zoom-changed', 'viewport-resize', 'viewport-inset-changed', 'page-layout-changed'\]/);
  // 가상 스크롤 배치 확정(page-layout-changed) 시 재배치 — 배치 전 페이지는 그리지 않는다.
  assert.match(overlaySrc, /if \(rect\.pageIndex >= vs\.pageCount\) return null/);
  // DOM 은 key 재조정 — 매 렌더 전체 파괴/재생성 금지.
  assert.match(overlaySrc, /this\.nodePool\.get\(key\)/);
  assert.doesNotMatch(overlaySrc, /replaceChildren\(\)/);
});

test('exact replace colors are semantic green and red', () => {
  assert.match(overlayCss, /\.ag-exact-ink[\s\S]*--ag-pending-ink: 35, 122, 75/);
  assert.match(overlayCss, /\.ag-exact-anchor::before[\s\S]*background: #b23a48/);
});

test('agent ink and typewriter covers clamp forced line-end spaces', () => {
  const inkSrc = readFileSync(new URL('../src/agent/selection-ink.ts', import.meta.url), 'utf8');
  assert.match(inkSrc, /export function measureInkRange/);
  assert.match(inkSrc, /newlineOffsets\(text, startOff\)/);
  assert.match(inkSrc, /clampRectsToTextEnds/);
  assert.match(overlaySrc, /measureInkRange\(range,/);
  assert.doesNotMatch(
    overlaySrc,
    /if \(range\.endParaIdx <= range\.startParaIdx\) return \{ rects, enters: \[\] \}/,
  );
  assert.match(revealSrc, /measureInkRange\(r,/);
});
