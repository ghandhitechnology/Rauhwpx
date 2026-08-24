// pi 확장의 순수 로직 계약 테스트 — 팩토리(default export)는 WS/HTTP 를 쓰므로 건드리지 않는다.
// node 22.18+ / 26 은 .ts 를 그대로 임포트할 수 있고(타입 스트리핑), 이 모듈의 값 임포트는
// node 내장 모듈뿐이라 의존성 설치 없이 로드된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PATH_GUARDED_TOOLS,
  PLANNING_BLOCKED_TOOLS,
  decodeHubFrame,
  encodeToolCallFrame,
  escapesRoot,
  fetchToolDefinitions,
  formatErrorText,
  guardToolCall,
  hubSocketUrl,
  hubToolDefinitionsUrl,
  isPlanningRestricted,
  parseImageDims,
  prepareInsertImageArgs,
  readExtensionConfig,
  toParameterSchema,
  toToolContent,
} from '../pi/extension/rhwp.ts';

const ROOT = path.resolve('/tmp/rhwp-root');

function configFor(env = {}) {
  return readExtensionConfig({ RHWP_ROOT_DIR: ROOT, ...env }, '/nowhere');
}

test('환경 기본값은 mcp-stdio 와 같은 계약을 따른다', () => {
  const config = readExtensionConfig({}, '/work');
  assert.equal(config.hubHttp, 'http://127.0.0.1:5175');
  assert.equal(config.wsUrl, 'ws://127.0.0.1:5175/mcp');
  assert.equal(config.token, 'dev');
  assert.equal(config.sessionId, 'dev');
  assert.equal(config.agentName, 'pi');
  assert.equal(config.workflow, 'direct');
  assert.equal(config.phase, 'implementing');
  assert.equal(config.toolProfile, 'direct');
  assert.equal(config.permissionProfile, 'safe');
  assert.equal(config.capabilityEpoch, undefined);
  assert.equal(config.rootDir, '/work');
});

test('plan 워크플로는 phase 와 toolProfile 을 유도한다', () => {
  const planning = readExtensionConfig({ RHWP_AGENT_WORKFLOW: 'plan' }, '/work');
  assert.equal(planning.phase, 'planning');
  assert.equal(planning.toolProfile, 'planning');

  const implementing = readExtensionConfig(
    { RHWP_AGENT_WORKFLOW: 'plan', RHWP_AGENT_PHASE: 'implementing' },
    '/work',
  );
  assert.equal(implementing.toolProfile, 'implementing');

  const explicit = readExtensionConfig(
    { RHWP_AGENT_WORKFLOW: 'plan', RHWP_TOOL_PROFILE: 'direct' },
    '/work',
  );
  assert.equal(explicit.toolProfile, 'direct');
});

test('허브 URL 은 토큰/프로필/에폭을 인코딩한다', () => {
  const config = configFor({
    RHWP_HUB_HTTP: 'http://127.0.0.1:5175/',
    RHWP_AGENT_TOKEN: 'a b&c',
    RHWP_SESSION_ID: 'window a',
    RHWP_TOOL_PROFILE: 'planning',
  });
  assert.equal(
    hubToolDefinitionsUrl(config),
    'http://127.0.0.1:5175/pi/tool-definitions?token=a%20b%26c&sessionId=window%20a&profile=planning',
  );
  assert.equal(
    hubSocketUrl(config),
    'ws://127.0.0.1:5175/mcp?token=a%20b%26c&sessionId=window%20a&agent=pi&workflow=direct',
  );
  const withEpoch = configFor({ RHWP_CAPABILITY_EPOCH: '7', RHWP_AGENT_WORKFLOW: 'plan', RHWP_SESSION_ID: 'window-b' });
  assert.equal(
    hubSocketUrl(withEpoch),
    'ws://127.0.0.1:5175/mcp?token=dev&sessionId=window-b&agent=pi&workflow=plan&capabilityEpoch=7',
  );
});

test('tool-call 프레임은 v4 계약을 쓴다', () => {
  const plain = encodeToolCallFrame(3, 'get_structure', { sectionIdx: 0 }, configFor());
  assert.deepEqual(plain, {
    v: 4,
    type: 'tool-call',
    id: 3,
    tool: 'get_structure',
    args: { sectionIdx: 0 },
    workflow: 'direct',
  });
  const withEpoch = encodeToolCallFrame(1, 'insert_text', {}, configFor({
    RHWP_CAPABILITY_EPOCH: '4',
  }));
  assert.equal(withEpoch.capabilityEpoch, '4');
});

test('Pi user questions have no ordinary 180 second timeout', () => {
  const source = readFileSync(new URL('../pi/extension/rhwp.ts', import.meta.url), 'utf8');
  assert.match(source, /tool === 'ask_user_question'\s*\? null\s*:\s*setTimeout/);
});

test('허브 프레임 해석 — 성공/실패/프로토콜 오류/쓰레기', () => {
  const ok = decodeHubFrame(JSON.stringify({
    type: 'tool-result', id: 2, ok: true, result: { revision: 5 },
  }));
  assert.deepEqual(ok, {
    kind: 'tool-result', id: 2, ok: true, result: { revision: 5 },
    code: 'RPC_ERROR', message: 'unknown hub error',
  });

  const failed = decodeHubFrame(JSON.stringify({
    type: 'tool-result', id: 9, ok: false, error: { code: 'REVISION_MISMATCH', message: 'stale' },
  }));
  assert.equal(failed.kind, 'tool-result');
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'REVISION_MISMATCH');
  assert.equal(failed.message, 'stale');

  assert.deepEqual(decodeHubFrame('{"type":"protocol-error","message":"bad epoch"}'), {
    kind: 'protocol-error', message: 'bad epoch',
  });
  assert.deepEqual(decodeHubFrame('not json'), { kind: 'unparseable' });
  assert.equal(decodeHubFrame('{"type":"pong"}').kind, 'ignored');
});

test('결과 → content 변환은 이미지 블록을 앞에 둔다', () => {
  assert.deepEqual(toToolContent({ revision: 3 }), [
    { type: 'text', text: '{"revision":3}' },
  ]);

  const withImage = toToolContent({
    revision: 4,
    image: { data: 'AAA', mimeType: 'image/png' },
  });
  assert.deepEqual(withImage, [
    { type: 'image', data: 'AAA', mimeType: 'image/png' },
    { type: 'text', text: '{"revision":4}' },
  ]);

  const passthrough = toToolContent({
    mcpContent: [{ type: 'text', text: 'hi' }, { type: 'resource', uri: 'x' }],
  });
  assert.deepEqual(passthrough, [
    { type: 'text', text: 'hi' },
    { type: 'text', text: '{"type":"resource","uri":"x"}' },
  ]);
});

test('에러는 CODE: message 한 줄로 나간다', () => {
  const coded = Object.assign(new Error('stale revision'), { code: 'REVISION_MISMATCH' });
  assert.equal(formatErrorText(coded), 'REVISION_MISMATCH: stale revision');
  const missing = Object.assign(new Error('no such file'), { code: 'ENOENT', syscall: 'open' });
  assert.equal(formatErrorText(missing), 'FILE_NOT_FOUND: no such file');
  assert.equal(formatErrorText(new Error('boom')), 'RPC_ERROR: boom');
});

test('파라미터 스키마는 $schema 만 떼고 그대로 넘어간다', () => {
  // pi 는 parameters 를 provider 요청에 그대로 실으므로 군더더기 키가 남으면 안 된다.
  const schema = toParameterSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { paraIdx: { type: 'number' } },
    required: ['paraIdx'],
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: { paraIdx: { type: 'number' } },
    required: ['paraIdx'],
  });

  const empty = toParameterSchema(undefined);
  assert.equal(empty.type, 'object');
  assert.deepEqual(empty.properties, {});

  const viaTypebox = toParameterSchema({ type: 'object' }, (s) => ({ ...s, marked: true }));
  assert.equal(viaTypebox.marked, true);
});

// ─── 이미지 ───

function pngBuffer(width, height) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpgBuffer(width, height) {
  const buf = Buffer.alloc(20);
  buf[0] = 0xff; buf[1] = 0xd8;
  buf[2] = 0xff; buf[3] = 0xc0;
  buf.writeUInt16BE(0x0011, 4);
  buf[6] = 8;
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

test('이미지 헤더에서 픽셀 크기를 읽는다', () => {
  assert.deepEqual(parseImageDims(pngBuffer(120, 80), 'png'), { width: 120, height: 80 });
  assert.deepEqual(parseImageDims(jpgBuffer(640, 480), 'jpg'), { width: 640, height: 480 });

  const gif = Buffer.alloc(12);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(64, 6);
  gif.writeUInt16LE(32, 8);
  assert.deepEqual(parseImageDims(gif, 'gif'), { width: 64, height: 32 });

  const bmp = Buffer.alloc(30);
  bmp.write('BM', 0, 'ascii');
  bmp.writeInt32LE(200, 18);
  bmp.writeInt32LE(-100, 22);
  assert.deepEqual(parseImageDims(bmp, 'bmp'), { width: 200, height: 100 });

  assert.equal(parseImageDims(Buffer.alloc(4), 'png'), null);
  assert.equal(parseImageDims(pngBuffer(1, 1), 'webp'), null);
});

test('insert_image 는 로컬 파일을 읽어 base64 와 원본 크기로 바꾼다', async () => {
  const reads = [];
  const readFileImpl = async (filePath) => {
    reads.push(filePath);
    return pngBuffer(300, 150);
  };
  const args = await prepareInsertImageArgs(
    { imagePath: '/tmp/logo.PNG', paraIdx: 2, expectedRevision: 7 },
    readFileImpl,
  );
  assert.deepEqual(reads, ['/tmp/logo.PNG']);
  assert.equal(args.extension, 'png');
  assert.equal(args.naturalWidthPx, 300);
  assert.equal(args.naturalHeightPx, 150);
  assert.equal(args.paraIdx, 2);
  assert.equal(args.expectedRevision, 7);
  assert.equal(args.imagePath, undefined);
  assert.equal(args.imageBase64, pngBuffer(300, 150).toString('base64'));
});

test('insert_image 인자 오류는 INVALID_ARGS 로 즉시 실패한다', async () => {
  const never = async () => { throw new Error('should not read'); };
  await assert.rejects(
    () => prepareInsertImageArgs({}, never),
    (e) => e.code === 'INVALID_ARGS' && /imagePath or imageBase64/.test(e.message),
  );
  await assert.rejects(
    () => prepareInsertImageArgs({ imageBase64: 'AAAA' }, never),
    (e) => e.code === 'INVALID_ARGS' && /extension is required/.test(e.message),
  );
  await assert.rejects(
    () => prepareInsertImageArgs({ imagePath: '/tmp/a.webp' }, async () => pngBuffer(1, 1)),
    (e) => e.code === 'INVALID_ARGS' && /unsupported image type/.test(e.message),
  );
  await assert.rejects(
    () => prepareInsertImageArgs({ imagePath: '/tmp/a.png' }, async () => Buffer.alloc(0)),
    (e) => e.code === 'INVALID_ARGS' && /empty/.test(e.message),
  );
  await assert.rejects(
    () => prepareInsertImageArgs({ imagePath: '/tmp/a.png' }, async () => Buffer.alloc(40)),
    (e) => e.code === 'INVALID_ARGS' && /dimensions/.test(e.message),
  );
});

// ─── 단계/권한 가드 ───

test('경로 탈출 판정은 root 안팎을 가른다', () => {
  assert.equal(escapesRoot(ROOT, 'docs/a.hwp', ROOT), false);
  assert.equal(escapesRoot(ROOT, `${ROOT}/docs/a.hwp`, '/elsewhere'), false);
  assert.equal(escapesRoot(ROOT, '.', ROOT), false);
  assert.equal(escapesRoot(ROOT, '../secret', ROOT), true);
  assert.equal(escapesRoot(ROOT, '/etc/passwd', ROOT), true);
  assert.equal(escapesRoot('', '/etc/passwd', ROOT), false, 'root 가 없으면 검사하지 않는다');
});

test('계획 단계에서는 내장 bash/edit/write 를 막는다', () => {
  const planning = configFor({ RHWP_AGENT_WORKFLOW: 'plan' });
  assert.equal(isPlanningRestricted(planning.workflow, planning.phase), true);
  for (const toolName of PLANNING_BLOCKED_TOOLS) {
    const result = guardToolCall({ toolName, input: { path: 'a.txt' } }, planning, ROOT);
    assert.equal(result?.block, true, toolName);
  }
  assert.equal(guardToolCall({ toolName: 'read', input: { path: 'a.txt' } }, planning, ROOT),
    undefined);

  const implementing = configFor({
    RHWP_AGENT_WORKFLOW: 'plan', RHWP_AGENT_PHASE: 'implementing',
  });
  assert.equal(isPlanningRestricted(implementing.workflow, implementing.phase), false);
  assert.equal(guardToolCall({ toolName: 'write', input: { path: 'a.txt' } }, implementing, ROOT),
    undefined);
});

test('safe 프로필은 root 밖 경로만 막는다', () => {
  const safe = configFor();
  for (const toolName of PATH_GUARDED_TOOLS) {
    assert.equal(
      guardToolCall({ toolName, input: { path: '../../etc/passwd' } }, safe, ROOT)?.block,
      true,
      toolName,
    );
    assert.equal(guardToolCall({ toolName, input: { path: 'docs/a.hwp' } }, safe, ROOT), undefined);
  }
  assert.equal(guardToolCall({ toolName: 'grep', input: { path: '/etc' } }, safe, ROOT), undefined);

  const unrestricted = configFor({ RHWP_PERMISSION_PROFILE: 'unrestricted' });
  assert.equal(
    guardToolCall({ toolName: 'read', input: { path: '/etc/passwd' } }, unrestricted, ROOT),
    undefined,
  );
});

// ─── 도구 정의 조회 ───

test('도구 정의 조회는 이름 없는 항목을 버리고 실패 시 빈 배열이다', async () => {
  const config = configFor({ RHWP_TOOL_PROFILE: 'planning' });
  const seen = [];
  const definitions = await fetchToolDefinitions(config, async (url) => {
    seen.push(url);
    return [
      { name: 'get_structure', description: 'read', inputSchema: { type: 'object' } },
      { description: 'nameless' },
    ];
  });
  assert.deepEqual(seen, [hubToolDefinitionsUrl(config)]);
  assert.deepEqual(definitions.map((d) => d.name), ['get_structure']);

  const down = await fetchToolDefinitions(config, async () => {
    throw new Error('ECONNREFUSED');
  });
  assert.deepEqual(down, []);
  const garbage = await fetchToolDefinitions(config, async () => ({ nope: true }));
  assert.deepEqual(garbage, []);
});
