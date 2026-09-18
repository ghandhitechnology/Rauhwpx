import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function source(path: string): string {
  return readFileSync(join(rootDir, path), 'utf8');
}

function loadBytesBody(): string {
  const main = source('src/main.ts');
  const start = main.indexOf('async function loadBytes(');
  assert.notEqual(start, -1, 'loadBytes 를 찾지 못했다');
  const next = main.indexOf('\nasync function ', start + 1);
  const alt = main.indexOf('\nfunction ', start + 1);
  const end = [next, alt].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  return main.slice(start, end === undefined ? undefined : end);
}

test('문서 교체 신호는 공통 깔때기 loadBytes 가 낸다', () => {
  const body = loadBytesBody();
  assert.match(
    body,
    /eventBus\.emit\('document-swapped'\)/,
    "loadBytes 가 'document-swapped' 를 내야 모든 열기 경로가 같은 보장을 받는다",
  );
});

test('표 resize 캐시 정리는 깔때기 신호를 듣는다', () => {
  const inputHandler = source('src/engine/input-handler.ts');
  const start = inputHandler.indexOf("eventBus.on('document-swapped'");
  assert.notEqual(start, -1, "InputHandler 가 'document-swapped' 를 구독해야 한다");
  const block = inputHandler.slice(start, start + 400);
  assert.match(block, /clearTableResizeRuntimeCache\(\)/, '문서 교체에서 표 resize 캐시를 비워야 한다');
});

test('좁은 open-document-bytes 구독으로 되돌아가지 않는다', () => {
  const inputHandler = source('src/engine/input-handler.ts');
  const start = inputHandler.indexOf("eventBus.on('open-document-bytes'");
  assert.equal(start, -1, "InputHandler 는 open-document-bytes 를 구독하지 않는다");
});

test('깔때기를 우회하는 열기 경로가 없다', () => {
  const main = source('src/main.ts');
  const callers = main.match(/(?<!async function )\bloadBytes\(/g) ?? [];
  assert.ok(
    callers.length >= 3,
    `loadBytes 호출부가 ${callers.length}곳 — 깔때기가 여러 경로를 모은다는 전제가 유지되어야 한다`,
  );
});
