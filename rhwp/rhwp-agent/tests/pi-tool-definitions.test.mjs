import assert from 'node:assert/strict';
import test from 'node:test';

import { handlePiToolDefinitions, piToolDefinitions, shapeToJsonSchema } from '../pi/tool-schema.mjs';
import { filterToolDefinitions } from '../tools.mjs';

const TOKEN = 'test-token';

function urlFor(query) {
  return new URL(`http://127.0.0.1:5175/pi/tool-definitions${query}`);
}

/** 스키마 어디에도 $ref/definitions 가 남으면 안 된다 — pi 가 그대로 프로바이더에 넘긴다. */
function findRefs(node, path = '$') {
  if (Array.isArray(node)) return node.flatMap((item, i) => findRefs(item, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  const found = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' || key === 'definitions' || key === '$schema') found.push(`${path}.${key}`);
    found.push(...findRefs(value, `${path}.${key}`));
  }
  return found;
}

test('every tool the profile exposes becomes a JSON-schema definition', () => {
  const expected = filterToolDefinitions('direct');
  const converted = piToolDefinitions('direct');

  assert.equal(converted.length, expected.length);
  assert.deepEqual(converted.map((tool) => tool.name), expected.map((tool) => tool.name));
  for (const tool of converted) {
    assert.ok(tool.description.length > 0, `${tool.name} 에 설명이 있어야 한다`);
    assert.ok(tool.category.length > 0, `${tool.name} 에 분류가 있어야 한다`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.inputSchema.properties, 'object');
    assert.deepEqual(findRefs(tool.inputSchema), [], `${tool.name} 스키마에 $ref/$schema 가 없어야 한다`);
  }
});

test('write tool schemas keep required fields and nested cell parameters', () => {
  const insertText = piToolDefinitions('direct').find((tool) => tool.name === 'insert_text');
  assert.ok(insertText);
  assert.ok(insertText.inputSchema.required.includes('expectedRevision'));
  assert.ok(insertText.inputSchema.required.includes('text'));
  // cell 은 재사용 서브스키마다 — 인라인으로 펼쳐져 있어야 한다.
  assert.equal(insertText.inputSchema.properties.cell.type, 'object');
  assert.equal(insertText.inputSchema.properties.cell.properties.cellIdx.type, 'integer');
});

test('profiles decide which tools are exposed, including read_product_skill', () => {
  const direct = piToolDefinitions('direct').map((tool) => tool.name);
  const planning = piToolDefinitions('planning').map((tool) => tool.name);

  assert.ok(direct.includes('read_product_skill'));
  assert.ok(direct.includes('insert_text'));
  assert.ok(!planning.includes('insert_text'), '계획 단계에서는 쓰기 도구가 빠진다');
  assert.ok(planning.includes('present_implementation_plan'));
  assert.ok(planning.includes('get_structure'));
});

test('an empty shape still converts to an object schema', () => {
  assert.deepEqual(shapeToJsonSchema({}), {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
});

test('the endpoint rejects a wrong token and answers with the profile array', () => {
  assert.deepEqual(
    handlePiToolDefinitions({ url: urlFor('?token=nope&profile=direct'), token: TOKEN }),
    { status: 401, body: { code: 'UNAUTHORIZED', message: 'invalid token' } },
  );
  assert.equal(handlePiToolDefinitions({ url: urlFor('?profile=direct'), token: TOKEN }).status, 401);

  const ok = handlePiToolDefinitions({ url: urlFor(`?token=${TOKEN}&profile=planning`), token: TOKEN });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.map((tool) => tool.name), piToolDefinitions('planning').map((tool) => tool.name));

  // profile 이 없으면 direct 로 본다.
  const fallback = handlePiToolDefinitions({ url: urlFor(`?token=${TOKEN}`), token: TOKEN });
  assert.deepEqual(fallback.body.map((tool) => tool.name), piToolDefinitions('direct').map((tool) => tool.name));
});
