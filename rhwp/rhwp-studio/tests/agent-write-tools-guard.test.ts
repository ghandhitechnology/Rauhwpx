import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 스튜디오의 plan-mode 쓰기 게이트(DOCUMENT_WRITE_TOOLS)와 허브의
// document-write 분류(tools.mjs)가 어긋나면, 허브/스튜디오 phase skew 구간에서
// 누락된 쓰기 도구가 스튜디오 측 게이트를 우회한다. 두 목록의 드리프트를
// 저작 시점에 차단하는 소스 가드.

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const executorSrc = readFileSync(join(rootDir, 'src/agent/tool-executor.ts'), 'utf8');
const toolsSrc = readFileSync(join(rootDir, '../rhwp-agent/tools.mjs'), 'utf8');

function studioWriteTools(): Set<string> {
  const m = executorSrc.match(
    /export const DOCUMENT_WRITE_TOOLS[^=]*=\s*new Set\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(m, 'DOCUMENT_WRITE_TOOLS 상수를 파싱하지 못함');
  return new Set([...m![1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]));
}

function hubDocumentWriteTools(): Set<string> {
  return new Set(
    [...toolsSrc.matchAll(/^\s*([a-z0-9_]+):\s*'document-write',/gm)].map((x) => x[1]),
  );
}

test('DOCUMENT_WRITE_TOOLS가 허브의 document-write 분류와 일치한다', () => {
  const studio = studioWriteTools();
  const hub = hubDocumentWriteTools();
  assert.ok(hub.size > 0, 'tools.mjs에서 document-write 분류를 하나도 찾지 못함');

  const missingInStudio = [...hub].filter((t) => !studio.has(t));
  const extraInStudio = [...studio].filter((t) => !hub.has(t));
  assert.deepEqual(missingInStudio, [], `스튜디오 게이트에 누락된 쓰기 도구: ${missingInStudio}`);
  assert.deepEqual(extraInStudio, [], `허브 분류에 없는 도구가 스튜디오 게이트에 존재: ${extraInStudio}`);
});

// apply_edits 허용 목록도 같은 방식으로 가드한다 — 허브의 BATCHABLE_EDIT_TOOL_NAMES
// (스키마 enum + 설명 생성)와 스튜디오의 BATCHABLE_EDIT_TOOLS(dispatch 게이트)가
// 어긋나면 허브 검증을 통과한 항목이 스튜디오에서 거부되거나 그 반대가 된다.
function parseNameList(src: string, pattern: RegExp, label: string): Set<string> {
  const m = src.match(pattern);
  assert.ok(m, `${label} 상수를 파싱하지 못함`);
  return new Set([...m![1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]));
}

test('apply_edits 허용 목록이 허브와 스튜디오에서 일치한다', () => {
  const studio = parseNameList(
    executorSrc,
    /const BATCHABLE_EDIT_TOOLS[^=]*=\s*new Set\(\[([\s\S]*?)\]\);/,
    'BATCHABLE_EDIT_TOOLS',
  );
  const hub = parseNameList(
    toolsSrc,
    /export const BATCHABLE_EDIT_TOOL_NAMES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/,
    'BATCHABLE_EDIT_TOOL_NAMES',
  );
  assert.ok(hub.size > 0, 'tools.mjs에서 배치 허용 목록을 찾지 못함');
  assert.deepEqual([...hub].sort(), [...studio].sort(), '허브/스튜디오 배치 허용 목록 불일치');
});
