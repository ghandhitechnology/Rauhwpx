import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/toolbar.ts', import.meta.url), 'utf8');

test('성공한 직접 글꼴 선택만 MRU에 기록하고 대표 글꼴은 분리한다', () => {
  const changeStart = source.indexOf("this.fontName.addEventListener('change'");
  const changeEnd = source.indexOf('// 언어 선택 변경 시', changeStart);
  const changeHandler = source.slice(changeStart, changeEnd);
  const fontSetReturn = changeHandler.indexOf('if (fontSet)');
  const firstRecentWrite = changeHandler.indexOf('userSettings.recordRecentFont(name)');

  assert.ok(fontSetReturn >= 0 && firstRecentWrite > fontSetReturn);
  assert.match(changeHandler, /if \(fontSet\) \{\s*this\.applyFontSet\(fontSet\);\s*return;/);
  assert.match(changeHandler, /if \(fontId >= 0\) \{\s*this\.eventBus\.emit\('format-char', \{ fontId \}[\s\S]*?userSettings\.recordRecentFont\(name\);/);
  assert.match(changeHandler, /this\.eventBus\.emit\('format-char', \{ fontIds: ids \}[\s\S]*?userSettings\.recordRecentFont\(name\);/);
});
