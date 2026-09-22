import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const keyboard = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/engine/input-handler-keyboard.ts'),
  'utf8',
);

function fnBody(name: string): string {
  const start = keyboard.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const rel = keyboard.slice(start + 1).search(/\nfunction |\nexport function /);
  return rel === -1 ? keyboard.slice(start) : keyboard.slice(start, start + 1 + rel);
}

test('문서모델 붙여넣기는 선택 삭제를 스냅샷 안에서 즉시 수행하고 실패면 throw 한다', () => {
  const body = fnBody('pasteHwpJsonModel');
  assert.match(body, /deleteSelectionImmediate\(wasm, selection\.start, selection\.end\)/);
  assert.doesNotMatch(body, /deleteSelection\(\{ deferRecord: true \}\)/);
  assert.match(body, /if \(!parsed\.ok\) throw/);
  assert.match(body, /HWPJSON_PASTE_MAX_CHARS/);
  assert.match(body, /parentParaIndex !== undefined\) return false/);
});

test('HTML 붙여넣기도 같은 원자 치환을 쓰고 실패 시 선택 범위를 남긴다', () => {
  const body = fnBody('pasteExternalHtml');
  assert.match(body, /deleteSelectionImmediate\(wasm, selection\.start, selection\.end\)/);
  assert.doesNotMatch(body, /deleteSelection\(\{ deferRecord: true \}\)/);
  assert.match(body, /if \(!parsed\.ok\) throw/);
  assert.match(body, /this\.cursor\.clearSelection\(\)/);
  const throwIdx = body.indexOf('if (!parsed.ok) throw');
  const clearIdx = body.indexOf('this.cursor.clearSelection()');
  assert.ok(clearIdx > throwIdx, '선택은 HTML 성공 후에만 지운다');
});
