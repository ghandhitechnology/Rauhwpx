import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// IME 경계에서 DOM의 UTF-16 문자열을 WASM의 Unicode scalar offset/count 계약으로
// 변환하는 가드. astral 문자가 있어도 조합 표시, 커서, 삭제가 같은 축을 써야 한다.

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(rootDir, 'src/engine/input-handler-text.ts'), 'utf8');

test('IME 조합 길이는 charCount(scalar)로 계산한다', () => {
  assert.match(src, /this\.compositionLength = charCount\(preedit\)/,
    'transient preedit 길이도 WASM 커서와 같은 scalar 축이어야 함');
  assert.doesNotMatch(src, /this\.compositionLength = text\.length/,
    'UTF-16 length 를 삭제 count 로 쓰면 조합 중 astral 문자에서 뒤 문자를 잡아먹는다');
});

test('iOS 조합 폴백 길이도 charCount(scalar)로 계산한다', () => {
  assert.match(src, /this\._iosLength = charCount\(text\)/,
    '_iosLength 도 deleteTextAt 의 삭제 count 로 쓰이므로 scalar 여야 함');
  assert.doesNotMatch(src, /this\._iosLength = text\.length/,
    'iOS 폴백도 동일한 over-delete 결함을 갖는다');
});

test('삭제 count 로 전달되는 길이 변수에 UTF-16 length 가 남아있지 않다', () => {
  // raw text mutation에 들어갈 수 있는 길이 상태는 모두 scalar여야 한다.
  const offenders = [...src.matchAll(/this\.(compositionLength|_iosLength) = ([^;]+);/g)]
    .filter((m) => /\.length\b/.test(m[2]) && !/charCount\(/.test(m[2]));
  assert.deepEqual(offenders.map((m) => m[0]), [],
    '삭제 count 변수에 UTF-16 length 대입이 남아있음');
});
