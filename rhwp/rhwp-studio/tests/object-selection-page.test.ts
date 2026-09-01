import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  clearObjectEditingPage,
  summarizeObjectSelection,
} from '../src/engine/object-selection-page.ts';

test('다중 개체 렌더 페이지는 기존 마지막 bbox를 보존하고 편집 focus는 첫 bbox를 쓴다', () => {
  const summary = summarizeObjectSelection([
    { pageIndex: 4, x: 10, y: 20, w: 30, h: 40 },
    { pageIndex: 5, x: 5, y: 15, w: 60, h: 10 },
  ]);

  assert.deepEqual(summary, {
    renderPageIndex: 5,
    editingPageIndex: 4,
    x: 5,
    y: 15,
    width: 60,
    height: 45,
  });
  assert.equal(summarizeObjectSelection([]), null);
});

test('개체 선택 렌더를 지우면 stale 편집 페이지도 null로 해제한다', () => {
  const events: Array<[string, number | null]> = [];
  clearObjectEditingPage({
    emit(event, pageIndex) {
      events.push([event, pageIndex]);
    },
  });

  assert.deepEqual(events, [['editing-page-changed', null]]);
});

test('그림 개체 선택 해제는 렌더 clear helper로 편집 페이지도 지운다', () => {
  const picture = readFileSync(
    new URL('../src/engine/input-handler-picture.ts', import.meta.url),
    'utf8',
  );
  const start = picture.indexOf('export function exitPictureObjectSelectionIfNeeded');
  const end = picture.indexOf('export function isShapeBorderClick', start);
  const exit = picture.slice(start, end);

  assert.match(exit, /clearPictureSelectionRender\.call\(this\)/);
  assert.doesNotMatch(exit, /this\.pictureObjectRenderer\?\.clear\(\)/);
});

test('표 개체 선택 해제 리스너는 렌더 clear helper로 편집 페이지도 지운다', () => {
  const inputHandler = readFileSync(
    new URL('../src/engine/input-handler.ts', import.meta.url),
    'utf8',
  );
  const start = inputHandler.indexOf("eventBus.on('table-object-selection-changed'");
  const end = inputHandler.indexOf('});', start);
  const listener = inputHandler.slice(start, end);

  assert.match(listener, /this\.clearTableObjectSelectionRender\(\)/);
  assert.doesNotMatch(listener, /this\.tableObjectRenderer\?\.clear\(\)/);
});
