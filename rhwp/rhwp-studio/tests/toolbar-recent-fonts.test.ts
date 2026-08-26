import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/toolbar.ts', import.meta.url), 'utf8');

test('최근 글꼴 범주는 설정된 개수만 표시하고 비활성화 시 숨겨진다', () => {
  const entriesStart = source.indexOf('private getFontMenuEntries(');
  const entriesEnd = source.indexOf('private getFontMenuCategories(', entriesStart);
  const entriesMethod = source.slice(entriesStart, entriesEnd);
  const categoriesStart = source.indexOf('private getFontMenuCategories(');
  const categoriesEnd = source.indexOf('private uniqueFontMenuEntries(', categoriesStart);
  const categoriesMethod = source.slice(categoriesStart, categoriesEnd);

  assert.match(source, /\{ id: 'recent', label: '최근 글꼴' \}/);
  assert.match(entriesMethod, /fontSettings\.showRecentFonts\s*\? fontSettings\.recentFonts\s*\.slice\(0, fontSettings\.recentFontCount\)/);
  assert.match(entriesMethod, /case 'recent':\s*return recentFonts;/);
  assert.match(categoriesMethod, /category\.id !== 'recent'[\s\S]*fontSettings\.showRecentFonts && fontSettings\.recentFonts\.length > 0/);
});

test('성공한 직접 글꼴 선택만 MRU에 기록하고 대표 글꼴은 분리한다', () => {
  const changeStart = source.indexOf("this.fontName.addEventListener('change'");
  const changeEnd = source.indexOf('// 언어 선택 변경 시', changeStart);
  const changeHandler = source.slice(changeStart, changeEnd);
  const fontSetReturn = changeHandler.indexOf('if (fontSet)');
  const firstRecentWrite = changeHandler.indexOf('userSettings.recordRecentFont(name)');

  assert.ok(fontSetReturn >= 0 && firstRecentWrite > fontSetReturn);
  assert.match(changeHandler, /if \(fontSet\) \{\s*this\.applyFontSet\(fontSet\);\s*return;/);
  assert.match(changeHandler, /if \(fontId >= 0\) \{\s*this\.eventBus\.emit\('format-char', \{ fontId \}[\s\S]*userSettings\.recordRecentFont\(name\);/);
  assert.match(changeHandler, /this\.eventBus\.emit\('format-char', \{ fontIds: ids \}[\s\S]*userSettings\.recordRecentFont\(name\);/);
});

test('글꼴 설정 변경 이벤트가 드롭다운과 열린 메뉴를 다시 만든다', () => {
  assert.match(source, /eventBus\.on\('font-settings-changed', \(\) => \{\s*this\.refreshFontDropdown\(\);\s*\}\);/);
});
