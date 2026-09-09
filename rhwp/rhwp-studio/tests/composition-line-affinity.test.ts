// [Issue #6553] IME 조합 중인 글자가 soft-wrap 으로 다음 줄로 넘어가면, 조합 밑줄이
// 넘어가기 전 위치인 이전 줄 끝에 그려져 같은 글자가 두 곳에 보였다.
//
// 좌표는 devel 에서 실측한 값이다 — samples/143E433F503322BD33.hwp 구역 0 / 문단 1,
// wrap 경계 offset 22:
//   getCursorRect(0, 1, 22) = { x: 394.0, y: 125.8 }   (이전 줄 끝 — 줄 affinity 없는 exact 조회)
//   getCursorRect(0, 1, 23) = { x: 134.9, y: 147.1 }   (조합 중 캐럿)
//   getCursorRectOnLine(0, 1, 1, at_end=false) = { x: 121.6, y: 146.5 }  (글자가 놓인 줄의 시작)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveGlyphStartRect, isCompositionBoxRepresentable } from '../src/engine/line-start-affinity.ts';
import { balancedFrom, codeOnly, functionBodyFrom } from './support/source-guard.ts';
import type { CursorRect, LineInfo } from '../src/core/types.ts';

/** 이전 줄 끝 — 줄 affinity 없는 exact 조회 결과. */
const EXACT_PREV_LINE_END: CursorRect = { pageIndex: 0, x: 394.0, y: 125.8, height: 21.3 };
/** 조합 중 캐럿 — 글자가 실제로 놓인 다음 줄. */
const CARET_ON_NEXT_LINE: CursorRect = { pageIndex: 0, x: 134.9, y: 147.1, height: 21.3 };
/** 글자가 놓인 줄의 시작. */
const NEXT_LINE_START: CursorRect = { pageIndex: 0, x: 121.6, y: 146.5, height: 21.3 };

/** 소스 가드용 — 줄바꿈·연속 공백을 한 칸으로 눌러 서식 의존을 없앤다. */
const flatten = (src: string) => src.replace(/\s+/g, ' ');

const inputHandlerSource = () =>
  codeOnly(readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8'));

/** offset 22 가 두 번째 줄(lineIndex 1)의 시작인 문단. */
const WRAP_BOUNDARY_LINE: LineInfo = { lineIndex: 1, lineCount: 2, charStart: 22, charEnd: 45 };

function lookup(
  line: LineInfo | null,
  onLine: CursorRect | null,
): { calls: { lineInfoAt: number[]; rectAtLineStart: number[] } } & Parameters<typeof resolveGlyphStartRect>[2] {
  const calls = { lineInfoAt: [] as number[], rectAtLineStart: [] as number[] };
  return {
    calls,
    lineInfoAt(charOffset: number) {
      calls.lineInfoAt.push(charOffset);
      return line;
    },
    rectAtLineStart(lineIndex: number) {
      calls.rectAtLineStart.push(lineIndex);
      return onLine;
    },
  };
}

test('soft-wrap 경계 offset 은 글자가 놓인 줄의 시작으로 해석된다', () => {
  const deps = lookup(WRAP_BOUNDARY_LINE, NEXT_LINE_START);
  const resolved = resolveGlyphStartRect(22, EXACT_PREV_LINE_END, deps);

  assert.deepEqual(deps.calls.lineInfoAt, [22]);
  assert.deepEqual(deps.calls.rectAtLineStart, [1], '모호한 경계에서는 시각 줄을 명시해 다시 조회한다');
  assert.equal(resolved.x, NEXT_LINE_START.x);
  assert.equal(resolved.y, NEXT_LINE_START.y);
  assert.equal(resolved.pageIndex, NEXT_LINE_START.pageIndex);
  assert.notEqual(resolved.y, EXACT_PREV_LINE_END.y, '이전 줄에 남으면 안 된다');
});

test('경계에서 조합 밑줄 폭이 음수에서 실제 글자 폭으로 바뀐다', () => {
  // caret-renderer 의 showCompositionUnderline 은 폭이 0 이하면 밑줄을 숨긴다 —
  // 원점이 이전 줄 끝에 남으면 조합 중 밑줄이 통째로 사라졌다.
  const before = CARET_ON_NEXT_LINE.x - EXACT_PREV_LINE_END.x;
  assert.ok(before < 0, `수정 전 charWidth 는 음수였다: ${before}`);

  const resolved = resolveGlyphStartRect(22, EXACT_PREV_LINE_END, lookup(WRAP_BOUNDARY_LINE, NEXT_LINE_START));
  const after = CARET_ON_NEXT_LINE.x - resolved.x;
  assert.ok(after > 0, `수정 후 charWidth 는 양수여야 한다: ${after}`);
  assert.ok(after < CARET_ON_NEXT_LINE.height, `한 글자 폭이어야 한다: ${after}`);
});

test('줄 중간 offset 은 exact 를 그대로 쓰고 줄 조회를 추가하지 않는다', () => {
  const deps = lookup({ lineIndex: 1, lineCount: 2, charStart: 22, charEnd: 45 }, NEXT_LINE_START);
  const resolved = resolveGlyphStartRect(30, EXACT_PREV_LINE_END, deps);

  assert.deepEqual(resolved, EXACT_PREV_LINE_END);
  assert.deepEqual(deps.calls.rectAtLineStart, [], '모호하지 않으면 추가 질의를 하지 않는다');
});

test('첫 줄 시작은 앞줄이 없어 추가 질의 없이 exact 를 쓴다', () => {
  const deps = lookup({ lineIndex: 0, lineCount: 2, charStart: 0, charEnd: 22 }, NEXT_LINE_START);
  const resolved = resolveGlyphStartRect(0, EXACT_PREV_LINE_END, deps);

  assert.deepEqual(resolved, EXACT_PREV_LINE_END);
  assert.deepEqual(deps.calls.rectAtLineStart, []);
});

test('줄 시작 rect 를 조회할 수 없으면 exact 동작을 유지한다', () => {
  const resolved = resolveGlyphStartRect(22, EXACT_PREV_LINE_END, lookup(WRAP_BOUNDARY_LINE, null));
  assert.deepEqual(resolved, EXACT_PREV_LINE_END);
});

test('셀 밑줄 클램프용 cellBounds 는 줄 재조회 뒤에도 보존된다', () => {
  // getCursorRectOnLine 은 cellBounds 를 싣지 않는다. 잃어버리면 #1951 의 셀 밖 이탈이 되살아난다.
  const exactInCell: CursorRect = {
    ...EXACT_PREV_LINE_END,
    cellBounds: { x: 100, y: 120, w: 300, h: 60 },
  };
  const resolved = resolveGlyphStartRect(22, exactInCell, lookup(WRAP_BOUNDARY_LINE, NEXT_LINE_START));

  assert.deepEqual(resolved.cellBounds, exactInCell.cellBounds);
  assert.equal(resolved.x, NEXT_LINE_START.x);
});

test('compositionStartRect 는 exact 조회 뒤, 캐시에 넣기 전에 줄 affinity 를 적용한다', () => {
  const source = inputHandlerSource();
  const startRect = functionBodyFrom(source, 'private compositionStartRect(');

  const applied = startRect.indexOf('startRect = this.compositionOverlayStartRect(anchor, startRect);');
  const cached = startRect.indexOf('this.compositionAnchorRect = {');
  assert.ok(applied >= 0, '조합 밑줄 원점이 줄 affinity 를 거쳐야 한다');
  assert.ok(cached >= 0);
  assert.ok(applied < cached, '캐시에 넣기 전에 원점을 확정해야 한다 — 캐시된 값은 다시 보정되지 않는다');

  // 아래 가드들은 서식이 아니라 **의미**를 잠근다 — 줄바꿈·들여쓰기·연산자 간격이 바뀌어도
  // 통과해야 한다(무해한 재포맷에 깨지는 구조 정규식을 쓰지 않는다).
  const resolver = flatten(functionBodyFrom(source, 'private compositionOverlayStartRect('));
  assert.match(resolver, /resolveGlyphStartRect\(\s*anchor\.charOffset\s*,\s*exact\s*,/);
  assert.match(
    resolver,
    /isInHeaderFooter\(\)\s*\|\|\s*this\.cursor\.isInFootnote\(\)\s*\)\s*return exact;/,
    '머리말・꼬리말·각주는 getCursorRectOnLine 대상이 아니라 exact 를 유지한다',
  );
  assert.match(
    resolver,
    /anchor\.cellPath\?\.length\s*\?\?\s*0\s*\)\s*>\s*1\s*\)\s*return exact;/,
    '2단 이상 중첩 셀은 getCursorRectOnLine 이 문단을 지목할 수 없어 exact 를 유지한다',
  );
  assert.match(resolver, /this\.wasm\.getCursorRectOnLine\(/);
  assert.match(
    resolver,
    /getCursorRectOnLine\(\s*anchor\.sectionIndex\s*,\s*anchor\.paragraphIndex\s*,\s*lineIndex\s*,\s*false\s*,/,
    'cursor.ts getCursorRectOnVisualLine 과 같은 인자 순서(sectionIndex, paragraphIndex, lineIndex, atEnd)',
  );
});

// [Issue #6738] 줄 affinity 를 물을 수 없는 문맥(머리말/꼬리말·각주·2단계 이상 중첩 셀)에서는
// 조합 글자가 줄을 넘어가도 시작 좌표를 바로잡을 수 없다. 그 상태로 단일 밑줄을 그리면
// 폭이 음수가 되어 이전 줄 끝에 밑줄이 남거나, 판정을 y 로 하면 글꼴 크기가 섞인 줄에서 사라진다.

test('한 줄 안의 조합은 단일 사각형으로 그릴 수 있다고 판정한다', () => {
  const start: CursorRect = { pageIndex: 0, x: 121.6, y: 146.5, height: 13.3 };
  assert.equal(isCompositionBoxRepresentable(start, CARET_ON_NEXT_LINE), true);
  // 폭 0(막 시작한 조합)도 그릴 수 있다.
  assert.equal(isCompositionBoxRepresentable(CARET_ON_NEXT_LINE, CARET_ON_NEXT_LINE), true);
});

test('줄을 넘어간 조합은 그릴 수 없다고 판정한다', () => {
  // 실측: 이전 줄 끝 x=394.0 > 캐럿 x=134.9 → 폭이 음수가 되는 바로 그 상태
  assert.equal(isCompositionBoxRepresentable(EXACT_PREV_LINE_END, CARET_ON_NEXT_LINE), false);
});

test('쪽을 넘어간 조합은 그릴 수 없다고 판정한다', () => {
  const prevPage: CursorRect = { ...CARET_ON_NEXT_LINE, pageIndex: 0, x: 100 };
  const nextPage: CursorRect = { ...CARET_ON_NEXT_LINE, pageIndex: 1, x: 121.6 };
  assert.equal(isCompositionBoxRepresentable(prevPage, nextPage), false);
});

test('그릴 수 없는 조합은 밑줄 대신 일반 캐럿으로 물러난다', () => {
  const updateCaret = functionBodyFrom(inputHandlerSource(), 'private updateCaret(');

  const guard = updateCaret.indexOf('isCompositionBoxRepresentable(startRect, caretRect)');
  const show = updateCaret.indexOf('this.caret.showCompositionUnderline(');
  assert.ok(guard >= 0 && show > guard, '밑줄을 긋기 전에 판정해야 한다');

  // 블록을 괄호 짝으로 잘라 **무엇을 하는지**만 본다 — 문 사이 서식에 걸리지 않는다.
  const shown = balancedFrom(updateCaret, 'if (startRect && isCompositionBoxRepresentable', '{');
  assert.match(shown, /this\.caret\.showCompositionUnderline\(\s*startRect\s*,\s*caretRect\s*,/);
  assert.doesNotMatch(shown, /hideComposition/);

  const fallback = balancedFrom(updateCaret.slice(updateCaret.indexOf(shown) + shown.length), 'else', '{');
  assert.match(fallback, /this\.caret\.hideComposition\(\)/, '그릴 수 없으면 밑줄을 접어야 한다');
  assert.match(fallback, /this\.caret\.update\(\s*caretRect\s*,/, '조회 실패와 같은 경로로 일반 캐럿을 보여야 한다');
  assert.doesNotMatch(fallback, /showCompositionUnderline/, '그릴 수 없는데 밑줄을 그리면 안 된다');
});

test('caret-renderer 의 같은 줄 판정은 y 가 아니라 isCompositionBoxRepresentable 이 소유한다', () => {
  // 같은 줄이라도 글꼴 크기가 섞이면 캐럿 y 가 run 마다 다르다(baseline 기준). y 차이로
  // 판정하면 그 줄의 조합 밑줄이 사라진다. 판정은 한 곳(line-start-affinity)만 소유한다.
  const source = codeOnly(readFileSync(new URL('../src/engine/caret-renderer.ts', import.meta.url), 'utf8'));
  const underline = functionBodyFrom(source, 'showCompositionUnderline(');
  assert.match(underline, /isCompositionBoxRepresentable\(\s*startRect\s*,\s*endRect\s*\)/);
  assert.doesNotMatch(underline, /startRect\.y\s*-\s*endRect\.y/, 'y 기반 같은 줄 판정을 두면 안 된다');
  assert.match(underline, /rawWidth\s*>\s*0/, '폭 0 이하는 여전히 숨긴다');
});

test('줄 정보를 조회할 수 없으면 exact 동작을 유지한다', () => {
  // lineInfoAt 이 던지지 않고 null 로 실패를 알리는 계약. 예외가 새면 호출부 바깥 catch 가
  // 조합 밑줄을 통째로 접어, exact 로 물러나는 것보다 나쁜 결과가 된다.
  const deps = lookup(null, NEXT_LINE_START);
  const resolved = resolveGlyphStartRect(22, EXACT_PREV_LINE_END, deps);

  assert.deepEqual(resolved, EXACT_PREV_LINE_END);
  assert.deepEqual(deps.calls.rectAtLineStart, [], '줄을 모르면 줄 조회로 넘어가지 않는다');
});

test('줄이 다른 쪽에 있으면 셀 bbox 를 이어 쓰지 않는다', () => {
  // cellBounds 는 그 rect 가 놓인 쪽의 셀 bbox 다. 쪽이 바뀌었는데 들고 가면
  // showCompositionUnderline 이 다른 쪽 bbox 로 좌표를 가둔다.
  const exactInCell: CursorRect = {
    ...EXACT_PREV_LINE_END,
    cellBounds: { x: 100, y: 120, w: 300, h: 60 },
    cellOverflowed: true,
  };
  const onNextPage: CursorRect = { ...NEXT_LINE_START, pageIndex: 1 };
  const resolved = resolveGlyphStartRect(22, exactInCell, lookup(WRAP_BOUNDARY_LINE, onNextPage));

  assert.equal(resolved.pageIndex, 1);
  assert.equal(resolved.cellBounds, undefined);
  assert.equal(resolved.cellOverflowed, undefined);
});

test('소스 가드는 서식이 아니라 의미를 잠근다', () => {
  const reformatted = `
private compositionOverlayStartRect(a: X, exact: Y): Y {
  if (
    this.cursor.isInHeaderFooter()
    || this.cursor.isInFootnote()
  ) return exact;
  if ((anchor.cellPath?.length ?? 0) > 1) return exact;
  return resolveGlyphStartRect(
    anchor.charOffset,
    exact,
    { rectAtLineStart: () => this.wasm.getCursorRectOnLine() },
  );
}`;
  const flat = flatten(functionBodyFrom(reformatted, 'private compositionOverlayStartRect('));

  assert.match(flat, /resolveGlyphStartRect\(\s*anchor\.charOffset\s*,\s*exact\s*,/);
  assert.match(flat, /isInHeaderFooter\(\)\s*\|\|\s*this\.cursor\.isInFootnote\(\)\s*\)\s*return exact;/);
  assert.match(flat, /anchor\.cellPath\?\.length\s*\?\?\s*0\s*\)\s*>\s*1\s*\)\s*return exact;/);
});
