import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const toolbar = readFileSync(new URL('../src/ui/toolbar.ts', import.meta.url), 'utf8');

test('툴바 줄 간격 직접입력/증가버튼은 format:line-spacing-increase 커맨드와 동일하게 500%로 clamp한다', () => {
  assert.match(toolbar, /const clamped = Math\.min\(500, num\);/);
  assert.match(toolbar, /const next = Math\.max\(5, Math\.min\(500, \(Number\(this\.lsSelect\.value\) \|\| 160\) \+ delta\)\);/);
  assert.match(toolbar, /this\.onKeyboardActivate\(this\.btnLsUp, \(\) => this\.adjustLineSpacing\(5\)\);/);
});
