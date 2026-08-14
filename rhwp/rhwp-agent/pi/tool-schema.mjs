// pi 확장이 읽어 갈 도구 정의를 만든다 — zod 스키마를 그대로 JSON Schema 로 바꾼다.
// pi 는 MCP 서버가 아니라 확장으로 도구를 등록하므로, 스키마를 HTTP 로 넘겨준다.
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { filterToolDefinitions } from '../tools.mjs';

/**
 * @typedef {Object} PiToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {string} category
 * @property {object} inputSchema JSON Schema (draft-07, $ref 없이 펼친 형태)
 */

/**
 * zod 셰이프를 JSON Schema 로 바꾼다.
 * - `$refStrategy: 'none'` — 재사용 서브스키마(cell 등)를 인라인으로 펼친다.
 *   pi 는 스키마를 프로바이더에 그대로 넘기므로 $ref/definitions 가 남으면 못 쓴다.
 * - `$schema` 키는 떼어낸다 — OpenAI 호환 엔드포인트가 싫어한다.
 *
 * @param {Record<string, import('zod').ZodTypeAny>} shape
 */
export function shapeToJsonSchema(shape) {
  const schema = zodToJsonSchema(z.object(shape ?? {}), {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });
  const { $schema: _omitSchema, definitions: _omitDefs, ...rest } = schema ?? {};
  if (rest.type !== 'object') return { type: 'object', properties: {}, ...rest };
  if (!rest.properties) rest.properties = {};
  return rest;
}

/**
 * 프로파일이 노출하는 모든 도구를 pi 확장이 등록할 수 있는 모양으로 만든다.
 *
 * @param {string|undefined} profile tools.mjs 의 프로파일 이름 또는 허용 목록
 * @returns {PiToolDefinition[]}
 */
export function piToolDefinitions(profile) {
  return filterToolDefinitions(profile).map((definition) => ({
    name: definition.name,
    description: definition.description,
    category: definition.category,
    inputSchema: shapeToJsonSchema(definition.shape),
  }));
}

/**
 * `GET /pi/tool-definitions?token=…&profile=…` 응답을 만든다.
 * 서버는 이 결과를 그대로 흘려보낸다 — 토큰 검사도 여기서 한다.
 *
 * @param {{ url: URL, token: string }} request
 * @returns {{ status: number, body: object|Array }}
 */
export function handlePiToolDefinitions({ url, token }) {
  if (url.searchParams.get('token') !== token) {
    return { status: 401, body: { code: 'UNAUTHORIZED', message: 'invalid token' } };
  }
  const profile = url.searchParams.get('profile') ?? 'direct';
  return { status: 200, body: piToolDefinitions(profile) };
}
