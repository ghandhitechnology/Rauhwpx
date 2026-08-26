import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualScroll } from '../src/view/virtual-scroll.ts';

function pages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    width: 780 + index % 7,
    height: 880 + index % 31,
  })) as never;
}

function naiveVisible(scroll: VirtualScroll, top: number, height: number): number[] {
  const bottom = top + height;
  const visible: number[] = [];
  for (let page = 0; page < scroll.pageCount; page++) {
    const pageTop = scroll.getPageOffset(page);
    if (pageTop < bottom && pageTop + scroll.getPageHeight(page) > top) visible.push(page);
  }
  return visible;
}

function naivePageAtY(scroll: VirtualScroll, y: number): number {
  for (let page = scroll.pageCount - 1; page >= 0; page--) {
    if (y >= scroll.getPageOffset(page)) return page;
  }
  return 0;
}

test('large page sets avoid argument-limit failures and preserve logarithmic lookup semantics', () => {
  const scroll = new VirtualScroll();
  scroll.setPageDimensions(pages(200_000), 1, 1200);
  assert.equal(scroll.pageCount, 200_000);

  for (const y of [-10, 10, 10_000, scroll.getTotalHeight() / 2, scroll.getTotalHeight() + 10]) {
    assert.deepEqual(scroll.getVisiblePages(y, 900), naiveVisible(scroll, y, 900));
    assert.equal(scroll.getPageAtY(y), naivePageAtY(scroll, y));
  }
});

test('row-indexed lookup matches page scans for variable heights in single-column mode', () => {
  const scroll = new VirtualScroll();
  scroll.setPageDimensions(pages(2_000), 1, 1200);

  for (let query = 0; query < 200; query++) {
    const y = (query * 104_729) % (scroll.getTotalHeight() + 500);
    assert.deepEqual(scroll.getVisiblePages(y, 777), naiveVisible(scroll, y, 777));
    assert.equal(scroll.getPageAtY(y), naivePageAtY(scroll, y));
  }
});

test('grid page windows keep exact visibility and prefetch adjacent complete rows', () => {
  const source = Array.from({ length: 15 }, (_, index) => ({
    width: 800,
    height: index % 3 === 0 ? 1000 : 500,
  })) as never;
  const scroll = new VirtualScroll(10);
  scroll.setPageDimensions(source, 0.4, 2000);
  const columns = scroll.getColumns();
  assert.ok(columns > 1);

  const secondRow = columns;
  const y = scroll.getPageOffset(secondRow) + 250;
  const window = scroll.getPageWindow(y, 20);
  assert.deepEqual(window.visible, naiveVisible(scroll, y, 20));
  assert.equal(scroll.getRowFirstPageAtY(y), secondRow);
  assert.equal(scroll.getPageAtY(y), secondRow + columns - 1);

  const expectedPrefetch = [
    ...Array.from({ length: columns }, (_, index) => index),
    ...window.visible,
    ...Array.from(
      { length: Math.min(columns, source.length - secondRow - columns) },
      (_, index) => secondRow + columns + index,
    ),
  ];
  assert.deepEqual(window.prefetch, expectedPrefetch);
});
