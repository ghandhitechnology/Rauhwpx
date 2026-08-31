import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CaretLayoutReveal } from '../src/engine/caret-layout-reveal.ts';

test('쪽/단 나누기는 다음 layout 완료에 한 번만 캐럿 reveal을 예약한다', () => {
  for (const operationType of ['pageBreak', 'columnBreak', 'snapshot:pageBreak', 'snapshot:columnBreak']) {
    const reveal = new CaretLayoutReveal();
    reveal.requestFor(operationType);
    assert.equal(reveal.consume(), true, `${operationType}: layout 완료 뒤 reveal`);
    assert.equal(reveal.consume(), false, `${operationType}: 같은 완료 이벤트에서 재사용하지 않음`);
  }
});

test('일반 전체 편집은 지연 reveal을 예약하지 않는다', () => {
  const reveal = new CaretLayoutReveal();
  reveal.requestFor('insertText');
  reveal.requestFor('snapshot:pasteInternal');
  assert.equal(reveal.consume(), false);
});

test('경계 명령 뒤의 일반 명령은 아직 도착하지 않은 layout reveal 예약을 지우지 않는다', () => {
  const reveal = new CaretLayoutReveal();
  reveal.requestFor('pageBreak');
  reveal.requestFor('insertText');
  assert.equal(reveal.consume(), true);
  assert.equal(reveal.consume(), false);
});

test('문서 전환 경계에서는 아직 도착하지 않은 layout reveal 예약을 폐기한다', () => {
  const reveal = new CaretLayoutReveal();
  reveal.requestFor('pageBreak');
  reveal.clear();
  assert.equal(reveal.consume(), false);
});

test('InputHandler는 mutation layout 완료 이벤트만 소비하고 zoom/resize 전역 이벤트로는 reveal하지 않는다', () => {
  const inputHandler = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
  const canvasView = readFileSync(new URL('../src/view/canvas-view.ts', import.meta.url), 'utf8');

  assert.match(inputHandler, /from '\.\/caret-layout-reveal'/);
  assert.match(inputHandler, /eventBus\.on\('document-layout-refreshed'/);
  assert.match(inputHandler, /this\.caretLayoutReveal\.consume\(\)/);
  assert.match(inputHandler, /this\.caretLayoutReveal\.clear\(\)/);
  assert.match(inputHandler, /this\.caretLayoutReveal\.requestFor\(desc\.operationType\)/);
  assert.match(inputHandler, /this\.caretLayoutReveal\.requestFor\(this\.history\.peekRedoTop\(\)\?\.type/);
  assert.match(inputHandler, /this\.caretLayoutReveal\.requestFor\(this\.history\.peekUndoTop\(\)\?\.type/);
  assert.match(canvasView, /this\.eventBus\.emit\('document-layout-refreshed', \{ source: 'mutation' \}\)/);

  const mutationFn = canvasView.match(
    /private async refreshPagesForMutation\(\)[\s\S]*?this\.refreshPages\(\);\s*\/\/[\s\S]*?document-layout-refreshed/,
  );
  assert.ok(mutationFn, 'refreshPagesForMutation 성공 뒤에만 document-layout-refreshed를 보낸다');

  const layoutListener = inputHandler.match(
    /eventBus\.on\('page-layout-changed'[\s\S]{0,80}/,
  )?.[0] ?? '';
  assert.match(layoutListener, /repositionOverlays/);
  assert.doesNotMatch(layoutListener, /caretLayoutReveal/);
});
