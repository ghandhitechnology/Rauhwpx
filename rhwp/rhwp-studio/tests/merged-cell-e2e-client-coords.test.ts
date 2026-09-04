import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const colDrag = readFileSync(
  new URL('../e2e/merged-cell-boundary-drag.test.mjs', import.meta.url),
  'utf8',
);
const rowDrag = readFileSync(
  new URL('../e2e/merged-cell-row-boundary-drag.test.mjs', import.meta.url),
  'utf8',
);

// 페이지 로컬 bbox 를 화면 좌표로 바꿀 때 pageLeft/pageOffset/zoom 이 빠지면
// 페이지가 가운데 정렬이거나 줌 ≠ 1 일 때 프로브가 경계를 놓친다.
// table-border-hover-resize-issue4117.test.mjs 와 같은 변환을 고정한다.

for (const [name, source] of [
  ['merged-cell-boundary-drag', colDrag],
  ['merged-cell-row-boundary-drag', rowDrag],
]) {
  test(`${name} e2e 는 pageLeft·pageOffset·zoom 으로 화면 좌표를 만든다`, () => {
    assert.match(source, /getPageLeftResolved\(0,\s*sc\.clientWidth\)/);
    assert.match(source, /getPageOffset\(0\)/);
    assert.match(source, /viewportManager\.getZoom\(\)/);
    assert.match(source, /rect\.left \+ pageLeft \+ x \* zoom/);
    assert.match(source, /rect\.top \+ pageOffset \+ y \* zoom/);
    assert.doesNotMatch(
      source,
      /rect\.left \+ (row2c0|c02full)\.x/,
      '페이지 로컬 x 를 바로 clientX 로 쓰면 안 된다',
    );
  });
}
