import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 숨은 textarea 는 IME 가 소유한다. 조합이 살아 있을 수 있는 동안 value 를
// 프로그램적으로 바꾸면 (예: compositionend 커밋 직후 value = '') 브라우저가
// 진행 중인 다음 음절의 조합을 파기한다 — 렌더링이 타자 속도를 못 따라갈 때
// 글자가 씹히는 원인. 타이핑 경로는 consumed prefix 카운터만 전진시키고,
// value 초기화는 resetTextareaBuffer(클릭/블러/비활성화 등 안전 지점) 한 곳으로
// 모은다.

const textSource = readFileSync(
  new URL('../src/engine/input-handler-text.ts', import.meta.url), 'utf8');
const handlerSource = readFileSync(
  new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');

test('조합 커밋은 value 를 비우지 않고 consumed prefix 만 전진시킨다', () => {
  const start = textSource.indexOf('export function onCompositionEnd');
  const end = textSource.indexOf('export function onInput', start);
  const source = textSource.slice(start, end);
  assert.match(source, /this\.consumeTextareaValue\(\);/);
  assert.match(source, /this\.unconsumedTextareaValue\(\)/,
    '커밋 fallback 텍스트는 미반영 슬라이스에서 읽어야 한다');
});
