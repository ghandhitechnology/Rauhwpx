import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHwpJsonModel, HWPJSON_PASTE_MAX_CHARS } from '../src/engine/office-html-sanitize.ts';

test('한글 클립보드 HTML 에서 [data-hwpjson] 모델을 꺼낸다', () => {
  const html =
    '<!--StartFragment--><p>본문</p><!--EndFragment-->' +
    '<!--[data-hwpjson]{"ro":{"hp":1},"sl":{}}-->';
  assert.equal(extractHwpJsonModel(html), '{"ro":{"hp":1},"sl":{}}');
});

test('한글이 아닌 HTML 에서는 null 을 준다', () => {
  assert.equal(extractHwpJsonModel('<p>워드</p>'), null);
  assert.equal(extractHwpJsonModel('<!--[data-hwpjson]-->'), null);
});

test('문서모델 추출은 절대 상한을 적용한다', () => {
  assert.equal(HWPJSON_PASTE_MAX_CHARS, 32_000_000);
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/engine/office-html-sanitize.ts'),
    'utf8',
  );
  assert.match(src, /raw\.length > HWPJSON_PASTE_MAX_CHARS/);
});
