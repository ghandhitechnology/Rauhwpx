import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterFontMenuEntries, fontMenuEmptyMessage } from '../src/ui/font-menu-filter.ts';

const source = readFileSync(new URL('../src/ui/toolbar.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles/style-bar.css', import.meta.url), 'utf8');

test('글꼴 메뉴는 현재 범주 목록을 검색어로 좁힌다', () => {
  const renderStart = source.indexOf('private renderFontMenu(');
  const renderEnd = source.indexOf('private getFontMenuEntries(', renderStart);
  const renderMethod = source.slice(renderStart, renderEnd);
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

  assert.match(source, /search\.placeholder = '글꼴 검색'/);
  assert.match(source, /search\.className = 'font-picker-search'/);
  assert.match(source, /search\.focus\(\)/);
  assert.match(renderMethod, /filterFontMenuEntries\(\s*this\.getFontMenuEntries\(this\.fontMenuCategory\),\s*this\.fontMenuQuery,/);
  assert.match(renderMethod, /fontMenuEmptyMessage\(this\.fontMenuQuery\)/);
  assert.match(source, /if \(event\.key !== 'Enter' \|\| event\.isComposing\) return;/);
  assert.match(styles, /\.font-picker-search \{/);
});

test('로컬 글꼴 재감지는 캐럿 글꼴이 아니라 문서 전체 글꼴 목록을 보존한다', () => {
  const refreshStart = source.indexOf('private refreshFontDropdown(): void');
  const refreshEnd = source.indexOf('/** 문서 로드 시 스타일 목록', refreshStart);
  const refreshMethod = source.slice(refreshStart, refreshEnd);

  assert.match(refreshMethod, /this\.initFontDropdown\(this\.fontMenuDocumentFonts\)/);
  assert.doesNotMatch(refreshMethod, /this\.initFontDropdown\(this\.lastFontFamilies\)/);
});
