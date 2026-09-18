import test from 'node:test';
import assert from 'node:assert/strict';

import { filterFontMenuEntries, fontMenuEmptyMessage } from '../src/ui/font-menu-filter.ts';

test('글꼴 메뉴는 현재 범주 목록을 검색어로 좁힌다', () => {
  const fonts = [
    { value: '맑은 고딕', label: '맑은 고딕' },
    { value: 'NanumGothic', label: '나눔고딕' },
    { value: '__fontset__본문', label: '◆ 본문' },
  ];

  assert.deepEqual(
    filterFontMenuEntries(fonts, ' 고딕 ').map((entry) => entry.value),
    ['맑은 고딕', 'NanumGothic'],
  );
  assert.deepEqual(
    filterFontMenuEntries(fonts, 'NANUM').map((entry) => entry.value),
    ['NanumGothic'],
  );
  assert.deepEqual(
    filterFontMenuEntries(fonts, '본문').map((entry) => entry.value),
    ['__fontset__본문'],
  );
  assert.equal(filterFontMenuEntries(fonts, '   ').length, 3);
  assert.equal(filterFontMenuEntries(fonts, '없는글꼴').length, 0);
  assert.equal(fontMenuEmptyMessage('고딕'), '검색 결과가 없습니다.');
  assert.equal(fontMenuEmptyMessage('  '), '표시할 글꼴이 없습니다.');
});
