import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/ui/agent-sidebar/index.ts', import.meta.url),
  'utf8',
);

test('changes drawer exposes synchronized accessible state', () => {
  assert.match(source, /reviewColumn\.setAttribute\('aria-labelledby', 'ag-review-column-title'\)/);
  assert.match(source, /reviewColumnTitle\.id = 'ag-review-column-title'/);
  assert.match(source, /environmentChanges\.setAttribute\('aria-expanded', changesActive \? 'true' : 'false'\)/);
  assert.match(source, /reviewColumn\.setAttribute\('aria-hidden', changesActive \? 'false' : 'true'\)/);
  assert.match(source, /reviewColumn\.inert = !changesActive/);
  assert.match(source, /reviewResize\.setAttribute\('role', 'separator'\)/);
  assert.match(source, /reviewResize\.setAttribute\('aria-orientation', 'vertical'\)/);
  assert.match(source, /reviewResize\.setAttribute\('aria-hidden', detailActive \? 'false' : 'true'\)/);
  assert.match(source, /reviewResize\.tabIndex = detailActive \? 0 : -1/);
  assert.match(source, /reviewResize\.inert = !detailActive/);
  assert.match(source, /else applyReviewWidth\(rect\.right - e\.clientX\)/);
  assert.match(source, /else applyReviewWidth\(reviewWidth - delta, \{ persist: true \}\)/);
  assert.match(source, /window\.addEventListener\('pointermove', onColumnResizePointerMove, true\)/);
  assert.match(source, /window\.addEventListener\('pointerup', endColumnResize, true\)/);
  assert.match(source, /window\.removeEventListener\('pointermove', onColumnResizePointerMove, true\)/);
  assert.doesNotMatch(source, /handle\.addEventListener\('pointermove', onColumnResizePointerMove\)/);
  assert.match(source, /reviewColumnClose\.setAttribute\('aria-label', '검토 닫기'\)/);
  assert.match(source, /reviewColumnClose\.addEventListener\('click', \(\) => \{[\s\S]*?setReviewColCollapsed\(true\);[\s\S]*?environmentToggle\.focus\(\)/);
  assert.match(source, /if \(root\.classList\.contains\('ag-detail-drawer-open'\)\) \{/);
});

test('the same review node returns to its inline sidebar position after focus mode', () => {
  assert.match(source, /chatPage\.append\(header, connBanner, messages, review, planSurface, questionController\.root, composer\)/);
  assert.match(source, /reviewColumn\.appendChild\(review\)/);
  assert.match(source, /planColumn\.appendChild\(planSurface\)/);
  assert.match(source, /chatPage\.append\(review, planSurface, questionController\.root, composer\)/);
  assert.doesNotMatch(source, /chatPage\.insertBefore\(review, composerUtilities\)/);
});
