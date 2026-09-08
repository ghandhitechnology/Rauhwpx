import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const toolbar = readFileSync(join(rootDir, 'src/ui/toolbar.ts'), 'utf8');
const html = readFileSync(join(rootDir, 'index.html'), 'utf8');

function methodBody(name: string): string {
  const start = toolbar.indexOf(`private ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const rel = toolbar.slice(start + 1).search(/\n  private |\n  \/\*\*/);
  return rel === -1 ? toolbar.slice(start) : toolbar.slice(start, start + 1 + rel);
}

test('#6635 글자색은 선택은 mousedown에서 보존하고 명령은 click에서 연다', () => {
  const body = methodBody('setupColorPicker');
  assert.match(body, /btnTextColor\.addEventListener\('mousedown'/);
  assert.match(body, /btnTextColor\.addEventListener\('click'/);
  const mouse = body.indexOf("btnTextColor.addEventListener('mousedown'");
  const click = body.indexOf("btnTextColor.addEventListener('click'");
  const mouseBlock = body.slice(mouse, click);
  assert.match(mouseBlock, /preventDefault/);
  assert.doesNotMatch(mouseBlock, /colorPicker\.click/);
  assert.match(body.slice(click), /this\.colorPicker\.click/);
});

test('#6635 형광펜 팔레트 액션은 click으로 적용하고 color input을 button 밖에 둔다', () => {
  const body = methodBody('setupHighlightPicker');
  assert.match(body, /btnNone\.addEventListener\('click'/);
  assert.match(body, /btnOther\.addEventListener\('click'/);
  assert.match(body, /btnHighlight\.addEventListener\('click'/);
  assert.match(body, /hiddenPicker\.tabIndex = -1/);
  assert.match(body, /actRow\.appendChild\(hiddenPicker\)/);
  assert.doesNotMatch(body, /btnOther\.appendChild\(hiddenPicker\)/);
  assert.match(body, /event\.key !== 'Escape'/);
  assert.match(body, /this\.btnHighlight\.focus\(\)/);
  assert.match(body, /document\.addEventListener\('keydown',[\s\S]*?,\s*true\)/);
});

test('#6635 숨긴 글자색 input은 Tab 순서에서 제외한다', () => {
  assert.match(html, /id="text-color-picker"[^>]*tabindex="-1"/);
});
