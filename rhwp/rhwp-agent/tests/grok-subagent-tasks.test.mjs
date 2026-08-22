// grok 서브에이전트 fleet: updates.jsonl 꼬리 추적과 stdout↔디스크 이중 소스 전환.
// 와이어 모양은 전부 라이브 캡처를 따른다 — /tmp/rhwp-probe3/grok/runA·C4·D·G.ndjson
// (stdout), tests/fixtures/grok-parent-updates.jsonl · grok-child1-updates.jsonl
// (디스크, runA 세션에서 그대로 복사). 핵심 사실: stdout 은 parent_tool_use_id 가
// 전부 null 이고 자식 본문이 루트 블록에 붙어 귀속이 불가능하다 — 스폰 이후의
// 본문/도구 이벤트는 디스크가 유일한 진실이다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createGrokSession, grokResultPreview } from '../agents/grok.mjs';
import { createGrokSessionTail, grokSessionsCwdKey } from '../agents/grok-session-tail.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PARENT_FIXTURE = readFileSync(path.join(FIXTURES, 'grok-parent-updates.jsonl'), 'utf8');
const CHILD_FIXTURE = readFileSync(path.join(FIXTURES, 'grok-child1-updates.jsonl'), 'utf8');
// runA 캡처의 실제 식별자들.
const FIXTURE_SESSION = 'EDB924E6-907F-4EA6-A1A9-F3934DC99227';
const FIXTURE_CHILD_1 = '01a01a89-544c-71f1-a661-8af179ec9ab8';
const FAKE_GROK_HOME = path.resolve('/home');
const FAKE_WORKSPACE = path.resolve('/ws');

function fakeUpdatePath(sessionId, cwdKey = grokSessionsCwdKey(FAKE_WORKSPACE)) {
  return path.join(FAKE_GROK_HOME, 'sessions', cwdKey, sessionId, 'updates.jsonl');
}

// ── grok-session-tail: 픽스처 파일 기반 단위 테스트 ────────────────

test('the tail resolves the percent-encoded session dir and delivers parent then child lines', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-grok-tail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  mkdirSync(ws, { recursive: true });
  const grokHome = path.join(root, 'home');
  const cwdDir = path.join(grokHome, 'sessions', grokSessionsCwdKey(ws));
  mkdirSync(path.join(cwdDir, FIXTURE_SESSION), { recursive: true });
  writeFileSync(path.join(cwdDir, FIXTURE_SESSION, 'updates.jsonl'), PARENT_FIXTURE);
  mkdirSync(path.join(cwdDir, FIXTURE_CHILD_1), { recursive: true });
  writeFileSync(path.join(cwdDir, FIXTURE_CHILD_1, 'updates.jsonl'), CHILD_FIXTURE);

  const seen = [];
  const tail = createGrokSessionTail({
    grokHome, cwd: ws, sessionId: FIXTURE_SESSION,
    onUpdate: (scope, update, meta) => seen.push({ scope, update, meta }),
  });
  tail.drain();

  const parents = seen.filter((entry) => entry.scope.kind === 'parent');
  const children = seen.filter((entry) => entry.scope.kind === 'child');
  assert.equal(parents.length, 21, 'runA 부모 파일의 21줄 전부');
  assert.equal(parents[0].update.sessionUpdate, 'user_message_chunk');
  assert.equal(
    parents.filter((entry) => entry.update.sessionUpdate === 'subagent_spawned').length,
    2,
  );
  // subagent_spawned 를 본 순간 자식 파일을 스스로 추적한다. 두 번째 자식의
  // 파일은 없다 — 조용히 견딘다.
  assert.equal(children.length, 4, 'child1 파일의 4줄 전부');
  assert.ok(children.every((entry) => entry.scope.subagentId === FIXTURE_CHILD_1));
  // 부모를 먼저 비운다 — 자식 라인은 항상 매핑(subagent_spawned) 뒤에 온다.
  assert.ok(seen.indexOf(children[0]) > seen.findIndex((entry) => entry.update.sessionUpdate === 'subagent_spawned'));
  // _meta.agentTimestampMs → meta.timestampMs.
  assert.ok(Number.isFinite(parents[0].meta.timestampMs));

  // 재-드레인은 오프셋 뒤라 아무것도 다시 전달하지 않는다.
  tail.drain();
  assert.equal(seen.length, 25);
  tail.stop();
});

test('the tail tolerates batched flushes, partial trailing lines and a late session dir', () => {
  const files = new Map();
  const fakeFs = {
    realpathSync: (p) => p,
    existsSync: (p) => files.has(p),
    readdirSync: (dir) => {
      if (files.has(dir)) { const e = new Error('ENOTDIR'); e.code = 'ENOTDIR'; throw e; }
      const prefix = `${dir}${path.sep}`;
      const names = new Set();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split(path.sep)[0]);
      }
      if (names.size === 0) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return [...names];
    },
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return Buffer.from(files.get(p));
    },
  };
  const line = (n, kind, extra = {}) => `${JSON.stringify({
    timestamp: 1787151600,
    method: n % 2 ? 'session/update' : '_x.ai/session/update',
    params: { sessionId: 'sess', update: { sessionUpdate: kind, ...extra }, _meta: { eventId: `sess-${n}`, agentTimestampMs: 1787151600000 + n } },
  })}\n`;
  const parentPath = fakeUpdatePath('sess');

  const seen = [];
  const tail = createGrokSessionTail({
    grokHome: FAKE_GROK_HOME, cwd: FAKE_WORKSPACE, sessionId: 'sess',
    onUpdate: (scope, update) => seen.push(`${scope.kind}:${update.sessionUpdate}`),
  }, { fs: fakeFs });

  tail.drain(); // 세션 디렉터리가 아직 없다 — 조용히 기다린다.
  assert.deepEqual(seen, []);

  const first = line(1, 'agent_message_chunk', { content: { type: 'text', text: 'a' } });
  const second = line(2, 'subagent_spawned', { subagent_id: 'kid-1' });
  files.set(parentPath, first + second.slice(0, 40)); // 두 번째 줄은 쓰다 말았다.
  tail.drain();
  assert.deepEqual(seen, ['parent:agent_message_chunk'], '개행 없는 꼬리는 완성될 때까지 보류한다');

  files.set(parentPath, first + second); // 잘린 줄이 마저 flush 됐다.
  files.set(fakeUpdatePath('kid-1'), line(3, 'agent_message_chunk', { content: { type: 'text', text: 'child' } }));
  tail.drain();
  assert.deepEqual(seen, [
    'parent:agent_message_chunk', 'parent:subagent_spawned', 'child:agent_message_chunk',
  ]);
  tail.stop();
});

test('the tail falls back to scanning when the cwd key does not match', () => {
  const mismatchedCwdKey = 'mismatched-cwd-key';
  const files = new Map([
    // grok 이 다른 정규화로 인코딩한 cwd 키 + 파일 항목(session_search.sqlite) 혼재.
    [path.join(FAKE_GROK_HOME, 'sessions', 'session_search.sqlite'), 'sqlite'],
    [fakeUpdatePath('ABC-DEF', mismatchedCwdKey),
      `${JSON.stringify({ timestamp: 1, method: 'session/update', params: { update: { sessionUpdate: 'turn_completed' } } })}\n`],
  ]);
  const fakeFs = {
    realpathSync: (p) => p,
    existsSync: (p) => files.has(p),
    readdirSync: (dir) => {
      if (files.has(dir)) { const e = new Error('ENOTDIR'); e.code = 'ENOTDIR'; throw e; }
      const prefix = `${dir}${path.sep}`;
      const names = new Set();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split(path.sep)[0]);
      }
      if (names.size === 0) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return [...names];
    },
    readFileSync: (p) => Buffer.from(files.get(p) ?? ''),
  };
  const seen = [];
  const tail = createGrokSessionTail({
    grokHome: FAKE_GROK_HOME, cwd: FAKE_WORKSPACE, sessionId: 'abc-def', // 대소문자도 다르다.
    onUpdate: (scope, update) => seen.push(update.sessionUpdate),
  }, { fs: fakeFs });
  tail.drain();
  assert.deepEqual(seen, ['turn_completed']);
  tail.stop();
});

test('the tail drains a child to EOF before delivering its subagent_finished', () => {
  // 스튜디오는 끝난 task 로 오는 본문을 버린다 — 같은 폴에 자식 본문과 종결이
  // 함께 도착하면 자식 대화가 task 종결보다 먼저 전달되어야 한다.
  const line = (kind, extra = {}) => `${JSON.stringify({
    timestamp: 1787151600,
    method: '_x.ai/session/update',
    params: { sessionId: 'sess', update: { sessionUpdate: kind, ...extra }, _meta: { agentTimestampMs: 1787151600000 } },
  })}\n`;
  const files = new Map([
    [fakeUpdatePath('sess'),
      line('subagent_spawned', { subagent_id: 'kid-1' })
      + line('subagent_finished', { subagent_id: 'kid-1', status: 'completed', output: '끝' })],
    [fakeUpdatePath('kid-1'),
      line('agent_message_chunk', { content: { type: 'text', text: '자식 결론' } })],
  ]);
  const fakeFs = {
    realpathSync: (p) => p,
    existsSync: (p) => files.has(p),
    readdirSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return Buffer.from(files.get(p));
    },
  };
  const seen = [];
  const tail = createGrokSessionTail({
    grokHome: FAKE_GROK_HOME, cwd: FAKE_WORKSPACE, sessionId: 'sess',
    onUpdate: (scope, update) => seen.push(`${scope.kind}:${update.sessionUpdate}`),
  }, { fs: fakeFs });
  tail.drain();
  assert.deepEqual(seen, [
    'parent:subagent_spawned',
    'child:agent_message_chunk',
    'parent:subagent_finished',
  ], '자식 본문이 subagent_finished 앞에 온다');
  tail.stop();
});

test('polling reads are positional and never re-read already-consumed bytes', () => {
  // O(파일 크기) 폴링 회귀 방지: 소비한 오프셋 뒤는 다시 읽지 않는다
  // (codex-rollout-watcher 의 readTailFrom 과 같은 위치 지정 읽기).
  const files = new Map();
  let bytesRead = 0;
  let fdSeq = 0;
  const fdPaths = new Map();
  const fakeFs = {
    realpathSync: (p) => p,
    existsSync: (p) => files.has(p),
    readdirSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    statSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { size: Buffer.byteLength(files.get(p)) };
    },
    openSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      fdPaths.set(++fdSeq, p);
      return fdSeq;
    },
    readSync: (fd, buf, off, len, pos) => {
      const src = Buffer.from(files.get(fdPaths.get(fd)));
      const read = src.copy(buf, off, pos, Math.min(src.length, pos + len));
      bytesRead += read;
      return read;
    },
    closeSync: () => {},
    readFileSync: () => { throw new Error('위치 지정 읽기가 있으면 전체 재독은 없어야 한다'); },
  };
  const parentPath = fakeUpdatePath('sess');
  const line = (text) => `${JSON.stringify({
    method: 'session/update',
    params: { sessionId: 'sess', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, _meta: { agentTimestampMs: 1787151600000 } },
  })}\n`;
  const bigLine = line('큰 본문 '.repeat(20_000)); // ~수백 KB — 재독하면 티가 난다.

  const seen = [];
  const tail = createGrokSessionTail({
    grokHome: FAKE_GROK_HOME, cwd: FAKE_WORKSPACE, sessionId: 'sess',
    onUpdate: (scope, update) => seen.push(update.content?.text?.length ?? 0),
  }, { fs: fakeFs });

  files.set(parentPath, bigLine);
  tail.drain();
  assert.equal(seen.length, 1);
  const afterFirst = bytesRead;

  // 잘린 꼬리는 오프셋을 움직이지 않고 다음 폴에서 이어 읽는다.
  const smallLine = line('마무리');
  files.set(parentPath, bigLine + smallLine.slice(0, 30));
  tail.drain();
  assert.equal(seen.length, 1, '개행 없는 꼬리는 보류한다');

  files.set(parentPath, bigLine + smallLine);
  tail.drain();
  assert.equal(seen.length, 2);
  assert.ok(
    bytesRead - afterFirst < Buffer.byteLength(smallLine) * 3,
    `증분만 읽어야 한다 — 추가로 읽은 바이트: ${bytesRead - afterFirst}`,
  );
  tail.stop();
});

// ── createGrokSession: stdout×디스크 이중 소스 라우팅 ──────────────

const baseOpts = {
  rootDir: '/tmp/rhwp',
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 6301,
  token: 'secret-token',
  sessionId: 'studio-thread-grok',
  model: 'grok-4.6',
  permissionProfile: 'safe',
  onEvent() {},
};

class FakeStream extends EventEmitter {}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode = null;
  signalCode = null;
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    queueMicrotask(() => {
      if (this.signalCode !== null || this.exitCode !== null) return;
      this.signalCode = signal;
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    });
    return true;
  }

  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  exit(code) {
    this.exitCode = code;
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

const INIT_LINE = {
  type: 'system', subtype: 'init',
  session_id: '11111111-2222-4333-8444-555555555555',
  model: 'grok-4.6',
  mcp_servers: [{ name: 'rhwp', status: 'connected' }],
  tools: [], slash_commands: [], skills: [],
};

// runA.ndjson:70 의 스폰 tool_use 모양 그대로 (background:true, id 는 call-<uuid>-<n>).
const SPAWN_BLOCK = {
  type: 'tool_use', id: 'call-aaaa-0', name: 'spawn_subagent',
  input: { description: '2쪽 정리', prompt: '2쪽을 정리해 줘.', subagent_type: 'doc-editor', background: true },
};
const RESULT = { type: 'result', subtype: 'success', is_error: false, result: 'done', stop_reason: 'end_turn' };

/** 가짜 꼬리 추적기 — 테스트가 디스크 라인을 직접 밀어 넣는다. */
function startFleetSession(t, extra = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-grok-fleet-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const spawns = [];
  const tails = [];
  let clock = 1_000;
  const opts = {
    ...baseOpts,
    isolatedHome: path.join(root, 'home'),
    grokHome: path.join(root, 'home', '.grok'),
    ...extra,
    onEvent: (event) => events.push(event),
  };
  const session = createGrokSession(opts, {
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
    createSessionTail(config) {
      const tail = {
        config,
        started: false,
        stopped: false,
        drains: 0,
        start() { this.started = true; },
        drain() { this.drains++; },
        stop() { this.stopped = true; },
        push(scope, update, meta = { timestampMs: clock + 1 }) { config.onUpdate(scope, update, meta); },
      };
      tails.push(tail);
      return tail;
    },
    now: () => clock,
  });
  return { session, events, spawns, tails, opts, setClock: (value) => { clock = value; } };
}

function types(events) {
  return events.map((event) => event.type);
}

test('a solo turn never touches the disk tail and keeps today\'s event sequence', (t) => {
  const { session, events, spawns, tails } = startFleetSession(t);
  session.sendUserMessage('probe');
  spawns[0].proc.emitJson(
    INIT_LINE,
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '확인했습니다.' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '확인했습니다.' }] } },
    RESULT,
  );
  assert.deepEqual(types(events), ['turn-start', 'session-info', 'text-delta', 'turn-end']);
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'grok', stopReason: 'completed', errorMessage: undefined,
  });
  assert.equal(tails.length, 0, '스폰 없는 턴은 디스크 IO 를 전혀 만들지 않는다');
  session.dispose();
});

test('a mid-message spawn switches sources: task-start, suppressed rows, deduped text', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, spawns, tails, opts } = startFleetSession(t);
  session.sendUserMessage('2쪽 정리해줘');
  const { proc } = spawns[0];

  proc.emitJson(
    INIT_LINE,
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '정리를 시작합니다. ' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '정리를 시작합니다. ' }, SPAWN_BLOCK] } },
  );

  const start = events.find((event) => event.type === 'task-start');
  assert.deepEqual(start, {
    type: 'task-start', agent: 'grok', taskId: 'call-aaaa-0', callId: 'call-aaaa-0',
    title: '2쪽 정리', role: 'doc-editor', taskKind: 'agent',
  });
  assert.equal(events.filter((event) => event.type === 'tool-call').length, 0, '스폰은 도구 행이 아니다');
  assert.equal(tails.length, 1);
  const tail = tails[0];
  assert.equal(tail.started, true);
  assert.deepEqual(
    { grokHome: tail.config.grokHome, cwd: tail.config.cwd, sessionId: tail.config.sessionId },
    { grokHome: opts.grokHome, cwd: baseOpts.rootDir, sessionId: INIT_LINE.session_id },
  );

  // 전환 뒤 stdout 은 오염 가능(자식 본문이 루트 블록에 붙는다) — 전부 버린다.
  proc.emitJson(
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '오염된 자식 텍스트' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '오염된 본문' }] } },
    // 스폰 tool_result 는 subagent_id 매핑에만 쓰고 화면에는 내지 않는다 (runA.ndjson:71).
    {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result', tool_use_id: 'call-aaaa-0', is_error: false,
          content: '{"type":"Text","text":"Subagent started in background.\\nsubagent_id: 01a01a89-544c-71f1-a661-8af179ec9ab8\\ntype: doc-editor"}',
        }],
      },
    },
  );
  assert.equal(events.filter((event) => event.type === 'tool-result').length, 0);

  // 디스크 부모 스트림: 이미 stdout 으로 낸 앞부분은 글자 수로 잘라 낸다.
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '정리를 시작합니다. 편집자를 붙였습니다.' },
  });
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'subagent_spawned', subagent_id: FIXTURE_CHILD_1,
    parent_session_id: INIT_LINE.session_id, child_session_id: FIXTURE_CHILD_1,
    subagent_type: 'doc-editor', description: '2쪽 정리', model: 'grok-4.6',
  });
  // 수거 도구도 화면에서 억제된다.
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'tool_call', toolCallId: 'call-bbbb-1', title: 'get_command_or_subagent_output',
    rawInput: { task_ids: [FIXTURE_CHILD_1], timeout_ms: 120000 },
    _meta: { 'x.ai/tool': { name: 'get_command_or_subagent_output', kind: 'background_task_action' } },
  });
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'tool_call_update', toolCallId: 'call-bbbb-1', status: 'completed',
    rawOutput: { type: 'TaskOutput' },
  });

  // 자식 스트림 — parentTaskId 로 귀속된다.
  tail.push({ kind: 'child', subagentId: FIXTURE_CHILD_1 }, {
    sessionUpdate: 'tool_call', toolCallId: 'call-cccc-0', title: 'mcp__rhwp__replace_range',
    rawInput: { paraIdx: 3 },
    _meta: { 'x.ai/tool': { name: 'mcp__rhwp__replace_range' } },
  });
  tail.push({ kind: 'child', subagentId: FIXTURE_CHILD_1 }, {
    sessionUpdate: 'tool_call_update', toolCallId: 'call-cccc-0', status: 'completed',
    rawOutput: { type: 'Text', text: '{"revision":9}' },
  });
  tail.push({ kind: 'child', subagentId: FIXTURE_CHILD_1 }, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '2쪽 정리 완료' },
  });

  const rootTexts = events.filter((event) => event.type === 'text-delta' && !event.parentTaskId).map((event) => event.text);
  assert.deepEqual(rootTexts, ['정리를 시작합니다. ', '편집자를 붙였습니다.'], '중복 없이 잔여분만');
  assert.equal(rootTexts.join('').includes('오염'), false);
  const call = events.find((event) => event.type === 'tool-call');
  assert.deepEqual(
    { tool: call.tool, callId: call.callId, parentTaskId: call.parentTaskId },
    { tool: 'replace_range', callId: 'call-cccc-0', parentTaskId: 'call-aaaa-0' },
  );
  const toolResult = events.find((event) => event.type === 'tool-result');
  assert.deepEqual(
    { ok: toolResult.ok, parentTaskId: toolResult.parentTaskId },
    { ok: true, parentTaskId: 'call-aaaa-0' },
  );
  const childText = events.find((event) => event.type === 'text-delta' && event.parentTaskId);
  assert.equal(childText.text, '2쪽 정리 완료');

  // subagent_finished → task-end (runA-parent-updates.jsonl:15 모양).
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'subagent_finished', subagent_id: FIXTURE_CHILD_1, child_session_id: FIXTURE_CHILD_1,
    status: 'completed', tool_calls: 1, turns: 1, duration_ms: 7229, tokens_used: 10613,
    output: '2쪽 정리 완료', will_wake: false,
  });
  const end = events.find((event) => event.type === 'task-end');
  assert.deepEqual(end, {
    type: 'task-end', agent: 'grok', taskId: 'call-aaaa-0', status: 'completed',
    summary: '2쪽 정리 완료', usage: { totalTokens: 10613, toolUses: 1, durationMs: 7229 },
  });

  // result 뒤에도 정착 유예를 지나야 턴이 닫힌다.
  proc.emitJson(RESULT);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0, '유예 전에는 닫지 않는다');
  t.mock.timers.tick(1_600);
  assert.deepEqual(
    events.filter((event) => event.type === 'turn-end'),
    [{ type: 'turn-end', agent: 'grok', stopReason: 'completed', errorMessage: undefined }],
  );
  assert.equal(tail.stopped, true);
  session.dispose();
});

test('tool rows already emitted from stdout are not replayed from disk', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, spawns, tails } = startFleetSession(t);
  session.sendUserMessage('go');
  const { proc } = spawns[0];

  proc.emitJson(
    INIT_LINE,
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call-t1-0', name: 'mcp__rhwp__get_structure', input: { sectionIdx: 0 } }] },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-t1-0', is_error: false, content: '{"revision":7}' }] },
    },
    { type: 'assistant', message: { content: [SPAWN_BLOCK] } },
  );
  const tail = tails[0];
  // 디스크는 턴 시작부터 전부 재생한다 — 전환 전에 낸 도구 행은 callId 로 걸러진다.
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'tool_call', toolCallId: 'call-t1-0', title: 'get_structure',
    rawInput: { sectionIdx: 0 }, _meta: { 'x.ai/tool': { name: 'mcp__rhwp__get_structure' } },
  });
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'tool_call_update', toolCallId: 'call-t1-0', status: 'completed',
    rawOutput: { type: 'Text', text: '{"revision":7}' },
  });
  assert.equal(events.filter((event) => event.type === 'tool-call').length, 1);
  assert.equal(events.filter((event) => event.type === 'tool-result').length, 1);

  // 전환 뒤 처음 보는 도구는 디스크에서 정상 방출된다 (use_tool 언랩 포함).
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'tool_call', toolCallId: 'call-t2-0', title: 'use_tool',
    rawInput: { tool_name: 'rhwp__get_text_range', tool_input: { paraIdx: 1 } },
    _meta: { 'x.ai/tool': { name: 'use_tool' } },
  });
  const late = events.filter((event) => event.type === 'tool-call').at(-1);
  assert.deepEqual(
    { tool: late.tool, argsJson: late.argsJson },
    { tool: 'get_text_range', argsJson: '{"paraIdx":1}' },
  );
  session.dispose();
});

test('a denied child tool keeps the array-shaped result readable and does not fail the task', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, spawns, tails } = startFleetSession(t);
  session.sendUserMessage('go');
  spawns[0].proc.emitJson(INIT_LINE, { type: 'assistant', message: { content: [SPAWN_BLOCK] } });
  const tail = tails[0];
  tail.push({ kind: 'parent' }, { sessionUpdate: 'subagent_spawned', subagent_id: 'kid-1', description: '2쪽 정리', subagent_type: 'doc-editor' });

  // runC4.ndjson:194 / run2 디스크 캡처의 거부 모양 그대로 — content 가 배열이다.
  tail.push({ kind: 'child', subagentId: 'kid-1' }, {
    sessionUpdate: 'tool_call', toolCallId: 'call-x-0', title: 'run_terminal_command',
    rawInput: { command: 'whoami' }, _meta: { 'x.ai/tool': { name: 'run_terminal_command' } },
  });
  tail.push({ kind: 'child', subagentId: 'kid-1' }, {
    sessionUpdate: 'tool_call_update', toolCallId: 'call-x-0', status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'Tool `run_terminal_command` was not executed: Denied by permission policy: deny rule on bash' } }],
  });
  const denied = events.find((event) => event.type === 'tool-result');
  assert.equal(denied.ok, false);
  assert.equal(denied.parentTaskId, 'call-aaaa-0');
  assert.match(denied.resultPreview, /Denied by permission policy: deny rule on bash/);
  assert.doesNotMatch(denied.resultPreview, /^\[\{/, '배열 원문이 아니라 사람이 읽을 문장');

  // 자식 안의 도구 실패는 스폰 실패가 아니다 — status 만 믿는다 (runD 확인).
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'subagent_finished', subagent_id: 'kid-1', status: 'completed',
    tool_calls: 1, turns: 1, duration_ms: 500, tokens_used: 100, output: '경로가 없었습니다', will_wake: false,
  });
  assert.equal(events.find((event) => event.type === 'task-end').status, 'completed');
  session.dispose();
});

test('a spawn rejected mid-text (unknown type) reverts to stdout and renders every root chunk once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, spawns, tails } = startFleetSession(t);
  session.sendUserMessage('go');
  const { proc } = spawns[0];
  proc.emitJson(
    INIT_LINE,
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '먼저 확인합니다. ' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '먼저 확인합니다. ' }, SPAWN_BLOCK] } },
    // 잠정 전환 구간의 stdout — 스폰이 무산되면 이 본문이 사라지면 안 된다.
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '스폰을 기다립니다. ' } } },
    // runE.ndjson:65 — is_error true 문자열 결과.
    {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result', tool_use_id: 'call-aaaa-0', is_error: true,
          content: '{"error":"tool_execution_failed","message":"Unknown subagent type: doc-editor. Available types: explore, general-purpose, plan"}',
        }],
      },
    },
    // 복원 뒤의 stdout 은 다시 실시간으로 흐른다.
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '직접 진행합니다.' } } },
    RESULT,
  );
  const end = events.find((event) => event.type === 'task-end');
  assert.equal(end.status, 'failed');
  assert.match(end.summary, /Unknown subagent type/);
  // 자식이 하나도 살지 못했다 — stdout 출처로 되돌리고 보류분을 정확히 한 번 흘린다.
  const rootTexts = events.filter((event) => event.type === 'text-delta' && !event.parentTaskId).map((event) => event.text);
  assert.deepEqual(rootTexts, ['먼저 확인합니다. ', '스폰을 기다립니다. ', '직접 진행합니다.']);
  assert.equal(tails[0].stopped, true, '복원이 디스크 꼬리를 멈춘다');
  t.mock.timers.tick(1_600);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  session.dispose();
});

test('a spawn whose disk file never appears reverts after the confirm timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, spawns, tails } = startFleetSession(t);
  session.sendUserMessage('go');
  const { proc } = spawns[0];
  proc.emitJson(
    INIT_LINE,
    { type: 'assistant', message: { content: [{ type: 'text', text: '시작합니다. ' }, SPAWN_BLOCK] } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '디스크 없이 이어진 본문' } } },
  );
  const rootTexts = () => events
    .filter((event) => event.type === 'text-delta' && !event.parentTaskId)
    .map((event) => event.text);
  assert.deepEqual(rootTexts(), ['시작합니다. '], '확인 전의 stdout 본문은 보류된다');

  // 스폰 결과도, 디스크 라인도 끝내 오지 않는다 — 유예가 지나면 stdout 으로 되돌린다.
  t.mock.timers.tick(10_000);
  assert.deepEqual(rootTexts(), ['시작합니다. ', '디스크 없이 이어진 본문'], '보류분이 정확히 한 번 흐른다');
  assert.equal(tails[0].stopped, true);

  proc.emitJson(RESULT);
  proc.exit(0);
  const sequence = types(events);
  const taskEndIdx = sequence.lastIndexOf('task-end');
  assert.notEqual(taskEndIdx, -1);
  assert.deepEqual(events[taskEndIdx], { type: 'task-end', agent: 'grok', taskId: 'call-aaaa-0', status: 'stopped' });
  assert.ok(taskEndIdx < sequence.lastIndexOf('turn-end'), '미확인 스폰은 종료 스윕이 닫는다');
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  session.dispose();
});

// 안전/계획 프로필은 이제 --no-subagents 로 도구 자체를 끄지만, CLI 가 어떤
// 이유로든 스폰을 취소하는 경로는 방어적으로 유지한다.
test('a dontAsk-cancelled spawn fails its task with a readable summary', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, spawns } = startFleetSession(t);
  session.sendUserMessage('go');
  spawns[0].proc.emitJson(
    INIT_LINE,
    { type: 'assistant', message: { content: [SPAWN_BLOCK] } },
    // 1.0.5 dontAsk 는 스폰 승인 프롬프트를 자동 취소한다 — 배열 모양 content
    // (라이브 확인: cancellationCategory=PermissionCancelled).
    {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result', tool_use_id: 'call-aaaa-0', is_error: true,
          content: [{ type: 'content', content: { type: 'text', text: 'User cancelled the execution for tool `spawn_subagent`' } }],
        }],
      },
    },
    RESULT,
  );
  const end = events.find((event) => event.type === 'task-end');
  assert.equal(end.status, 'failed');
  assert.match(end.summary, /User cancelled the execution/);
  t.mock.timers.tick(1_600);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  session.dispose();
});

test('a stdout-only collection turn suppresses the subagent meta tool rows', (t) => {
  // 배경 자식을 수거만 하는 재개 턴: 스폰이 없어 디스크 전환도 없다 — 수거/중단
  // 메타 도구가 TaskOutput 덩어리째 루트 도구 행으로 새면 안 된다.
  const { session, events, spawns, tails } = startFleetSession(t);
  session.sendUserMessage('collect');
  spawns[0].proc.emitJson(
    INIT_LINE,
    {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use', id: 'call-collect-0', name: 'get_command_or_subagent_output',
          input: { task_ids: [FIXTURE_CHILD_1], timeout_ms: 120000 },
        }],
      },
    },
    {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result', tool_use_id: 'call-collect-0', is_error: false,
          content: '{"type":"TaskOutput","tasks":[{"id":"01a01a89","output":"2쪽 정리 완료"}]}',
        }],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '자식 결과를 정리했습니다.' },
          { type: 'tool_use', id: 'call-kill-0', name: 'kill_command_or_subagent', input: { task_id: 'x' } },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-kill-0', is_error: false, content: 'killed' }] } },
    RESULT,
  );
  assert.equal(events.filter((event) => event.type === 'tool-call').length, 0, '메타 도구는 stdout 경로에서도 행이 아니다');
  assert.equal(events.filter((event) => event.type === 'tool-result').length, 0);
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    ['자식 결과를 정리했습니다.'],
  );
  assert.equal(tails.length, 0, '스폰 없는 턴은 디스크 전환을 만들지 않는다');
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'grok', stopReason: 'completed', errorMessage: undefined,
  });
  session.dispose();
});

test('dangling children are stopped before the turn ends on process exit', (t) => {
  const { session, events, spawns, tails } = startFleetSession(t);
  session.sendUserMessage('go');
  const { proc } = spawns[0];
  proc.emitJson(INIT_LINE, { type: 'assistant', message: { content: [SPAWN_BLOCK] } }, RESULT);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0, '미수거 자식이 턴을 붙든다');

  proc.exit(0);
  const tailEvents = types(events);
  const endIdx = tailEvents.lastIndexOf('task-end');
  const turnEndIdx = tailEvents.lastIndexOf('turn-end');
  assert.notEqual(endIdx, -1);
  assert.ok(endIdx < turnEndIdx, 'task-end(stopped) 가 turn-end 앞에 온다');
  assert.deepEqual(events[endIdx], { type: 'task-end', agent: 'grok', taskId: 'call-aaaa-0', status: 'stopped' });
  assert.equal(events[turnEndIdx].stopReason, 'completed', 'result 를 봤으므로 완료로 닫는다');
  assert.ok(tails[0].drains > 0, '종료 직전 마지막 드레인으로 늦은 flush 를 수확한다');
  assert.equal(tails[0].stopped, true);
  session.dispose();
});

test('interrupt sweeps open tasks before the interrupted turn-end', (t) => {
  const { session, events, spawns } = startFleetSession(t);
  session.sendUserMessage('go');
  spawns[0].proc.emitJson(INIT_LINE, { type: 'assistant', message: { content: [SPAWN_BLOCK] } });

  session.interrupt();
  const sequence = types(events);
  assert.ok(sequence.lastIndexOf('task-end') < sequence.lastIndexOf('turn-end'));
  assert.equal(events.find((event) => event.type === 'task-end').status, 'stopped');
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  assert.equal(events.at(-1).stopReason, 'interrupted');
  session.dispose();
});

test('a late subagent_finished after the result settles the held turn', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, spawns, tails } = startFleetSession(t);
  session.sendUserMessage('go');
  spawns[0].proc.emitJson(INIT_LINE, { type: 'assistant', message: { content: [SPAWN_BLOCK] } }, RESULT);
  const tail = tails[0];
  tail.push({ kind: 'parent' }, { sessionUpdate: 'subagent_spawned', subagent_id: 'kid-1', description: '2쪽 정리' });
  t.mock.timers.tick(5_000);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0, 'pending 이 남아 있으면 계속 연다');

  // will_wake 성 늦은 종료 — 도착하면 유예를 지나 닫힌다.
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'subagent_finished', subagent_id: 'kid-1', status: 'completed',
    tool_calls: 0, turns: 1, duration_ms: 9000, tokens_used: 42, output: '끝', will_wake: true,
  });
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0);
  t.mock.timers.tick(1_600);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  session.dispose();
});

test('a resumed turn skips disk lines stamped before this turn began', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, spawns, tails, setClock } = startFleetSession(t);

  // 턴 1: 보통 턴으로 완료 → -r 재개 경로를 연다.
  session.sendUserMessage('first');
  spawns[0].proc.emitJson(INIT_LINE, RESULT);
  spawns[0].proc.exit(0);

  setClock(50_000);
  session.sendUserMessage('second');
  assert.ok(spawns[1].argv.includes('-r'), '재개 턴이어야 한다');
  spawns[1].proc.emitJson(
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '이어서 ' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '이어서 ' }, SPAWN_BLOCK] } },
  );
  const tail = tails[0];
  // 재개된 updates.jsonl 은 이전 턴 기록을 앞에 그대로 담고 있다 — 타임스탬프로 거른다.
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '이전 턴의 본문입니다.' },
  }, { timestampMs: 10_000 });
  tail.push({ kind: 'parent' }, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '이어서 진행합니다.' },
  }, { timestampMs: 50_500 });

  const rootTexts = events.filter((event) => event.type === 'text-delta' && !event.parentTaskId).map((event) => event.text);
  assert.deepEqual(rootTexts, ['이어서 ', '진행합니다.'], '이전 턴 본문은 건너뛰고 이번 턴 잔여분만');
  session.dispose();
});

test('grokResultPreview accepts string, Text-object and denied-array shapes', () => {
  assert.equal(grokResultPreview('plain'), 'plain');
  assert.equal(grokResultPreview({ type: 'Text', text: 'wrapped' }), 'wrapped');
  assert.equal(
    grokResultPreview([{ type: 'content', content: { type: 'text', text: 'denied' } }]),
    'denied',
  );
  assert.equal(grokResultPreview({ type: 'Bash', exit_code: 0 }), '{"type":"Bash","exit_code":0}');
  assert.equal(grokResultPreview(null), 'null');
});
