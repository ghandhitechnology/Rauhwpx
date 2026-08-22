// codex 하니스의 서브에이전트 배선 검증.
// 스트림 사실관계는 라이브 캡처(codex-cli 0.147.0, /tmp/rhwp-probe3/codex/runA2.ndjson)를
// 그대로 따른다: collab_tool_call 은 wait 호출에만 나오고(tool 은 항상 "wait",
// receiver_thread_ids/agents_states 는 항상 비어 있음) spawn_agent 는 스트림에 아무것도
// 남기지 않는다. 그래서 fleet 카드는 롤아웃 워처가 만들고, 이 파일은 그 배선만 본다.
import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCodexArgv, createCodexSession } from '../agents/codex.mjs';

/** e2e 용 가짜 codex CLI — 아래 안전장치 테스트가 이 파일을 직접 돌린다. */
const FAKE_CODEX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'rhwp-studio', 'e2e', 'fake-codex-fleet.mjs',
);

class FakeStream extends EventEmitter {
  chunks = [];

  write(chunk, callback) {
    this.chunks.push(String(chunk));
    callback?.();
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(String(chunk));
  }
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStream();
  exitCode = null;
  signalCode = null;

  kill(signal) {
    queueMicrotask(() => {
      this.signalCode = signal ?? 'SIGTERM';
      this.emit('exit', null, this.signalCode);
    });
    return true;
  }

  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  exit(code = 0) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

/** 워처를 대역으로 갈아 끼워 codex.mjs 쪽 배선(시작/정리 시점)만 본다. */
function fakeWatcher(log, events) {
  return (options) => {
    const watcher = {
      options,
      started: null,
      finalized: 0,
      stopped: 0,
      start(threadId) {
        watcher.started = threadId;
        log.push({ call: 'start', threadId });
      },
      pollOnce() {},
      finalize() {
        watcher.finalized += 1;
        log.push({ call: 'finalize' });
        // 실제 워처처럼 남은 카드를 정리한다 — 순서 검증에 쓴다.
        options.emit({ type: 'task-end', agent: 'codex', taskId: 'child-1', status: 'stopped' });
      },
      stop() {
        watcher.stopped += 1;
        log.push({ call: 'stop' });
      },
      debugState: () => ({}),
    };
    log.push({ call: 'create', codexHome: options.codexHome });
    events.watchers.push(watcher);
    return watcher;
  };
}

function startSession(events, extraOpts = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-session-'));
  const log = [];
  const state = { watchers: [] };
  let child;
  const session = createCodexSession(
    {
      rootDir: home,
      codexHome: path.join(home, '.codex'),
      mcpScriptPath: '/tmp/mcp-stdio.mjs',
      hubPort: 5175,
      token: 'token',
      model: 'test-model',
      onEvent: (event) => events.push(event),
      ...extraOpts,
    },
    {
      spawnProcess() { child = new FakeProcess(); return child; },
      terminateProcess(proc) { proc.kill('SIGTERM'); },
      createRolloutWatcher: fakeWatcher(log, state),
    },
  );
  return {
    session,
    log,
    watchers: state.watchers,
    child: () => child,
    home,
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

test('collab_tool_call 은 fleet 카드가 아니라 루트 도구 한 줄로 그린다', () => {
  const events = [];
  const h = startSession(events);
  try {
    h.session.sendUserMessage('go');
    // runA2.ndjson 4~5 행과 같은 모양.
    h.child().emitJson(
      { type: 'thread.started', thread_id: 'root-thread' },
      {
        type: 'item.started',
        item: {
          id: 'item_1', type: 'collab_tool_call', tool: 'wait', sender_thread_id: 'root-thread',
          receiver_thread_ids: [], prompt: null, agents_states: {}, status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1', type: 'collab_tool_call', tool: 'wait', sender_thread_id: 'root-thread',
          receiver_thread_ids: [], prompt: null, agents_states: {}, status: 'completed',
        },
      },
    );

    assert.deepEqual(events.filter((e) => e.type.startsWith('task-')), []);
    const call = events.find((e) => e.type === 'tool-call');
    assert.deepEqual(call, {
      type: 'tool-call', agent: 'codex', callId: 'item_1', tool: 'wait_agents', argsJson: '{}',
    });
    const result = events.find((e) => e.type === 'tool-result');
    assert.equal(result.callId, 'item_1');
    assert.equal(result.ok, true);
  } finally {
    h.cleanup();
  }
});

test('thread.started 에서 롤아웃 워처를 CODEX_HOME 과 함께 시작한다', () => {
  const events = [];
  const h = startSession(events);
  try {
    h.session.sendUserMessage('go');
    assert.equal(h.watchers.length, 1);
    assert.equal(h.watchers[0].options.codexHome, path.join(h.home, '.codex'));
    assert.equal(h.watchers[0].started, null);

    h.child().emitJson({ type: 'thread.started', thread_id: 'root-thread' });
    assert.equal(h.watchers[0].started, 'root-thread');
  } finally {
    h.cleanup();
  }
});

test('프로세스 종료 시 turn-end 보다 먼저 워처를 정리해 열린 카드를 닫는다', () => {
  const events = [];
  const h = startSession(events);
  try {
    h.session.sendUserMessage('go');
    h.child().emitJson(
      { type: 'thread.started', thread_id: 'root-thread' },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    );
    h.child().exit(0);

    const endIdx = events.findIndex((e) => e.type === 'task-end');
    const turnEndIdx = events.findIndex((e) => e.type === 'turn-end');
    assert.ok(endIdx !== -1, 'task-end 가 있어야 한다');
    assert.ok(endIdx < turnEndIdx, 'task-end 는 turn-end 보다 먼저 나가야 한다');
    assert.equal(events[turnEndIdx].stopReason, 'completed');
    assert.equal(h.watchers[0].finalized, 1);
  } finally {
    h.cleanup();
  }
});

test('턴마다 새 워처를 만들고 이전 워처는 정리한다', () => {
  const events = [];
  const h = startSession(events);
  try {
    h.session.sendUserMessage('첫 턴');
    h.child().emitJson({ type: 'thread.started', thread_id: 'root-thread' });
    h.child().exit(0);
    h.session.sendUserMessage('두 번째 턴');
    assert.equal(h.watchers.length, 2);
    assert.equal(h.watchers[0].finalized, 1);
    assert.equal(h.watchers[1].finalized, 0);
  } finally {
    h.cleanup();
  }
});

test('남아 있던 워처는 다음 턴의 turn-start 보다 먼저 정리한다', () => {
  const events = [];
  const h = startSession(events);
  try {
    // exit 이 오지 않은 채(프로세스가 매달렸다) 다음 턴이 들어오는 예외 경로.
    h.session.sendUserMessage('첫 턴');
    h.child().emitJson({ type: 'thread.started', thread_id: 'root-thread' });
    assert.equal(h.watchers[0].finalized, 0);

    const before = events.length;
    h.session.sendUserMessage('두 번째 턴');
    const emitted = events.slice(before);
    const endIdx = emitted.findIndex((e) => e.type === 'task-end');
    const startIdx = emitted.findIndex((e) => e.type === 'turn-start');
    assert.equal(h.watchers[0].finalized, 1);
    assert.ok(endIdx !== -1, '남은 카드를 닫는 task-end 가 있어야 한다');
    assert.ok(endIdx < startIdx, '워처 정리는 새 턴이 열리기 전에 끝나야 한다');
  } finally {
    h.cleanup();
  }
});

test('spawn error 도 exit 과 같이 turn-end 앞에서 워처를 정리한다', () => {
  const events = [];
  const h = startSession(events);
  try {
    h.session.sendUserMessage('go');
    h.child().emitJson({ type: 'thread.started', thread_id: 'root-thread' });
    h.child().emit('error', new Error('spawn ENOENT'));

    const endIdx = events.findIndex((e) => e.type === 'task-end');
    const turnEndIdx = events.findIndex((e) => e.type === 'turn-end');
    assert.equal(h.watchers[0].finalized, 1);
    assert.ok(endIdx !== -1, 'task-end 가 있어야 한다');
    assert.ok(endIdx < turnEndIdx, 'task-end 는 turn-end 보다 먼저 나가야 한다');
    assert.equal(events[turnEndIdx].stopReason, 'exited');
  } finally {
    h.cleanup();
  }
});

test('interrupt 는 워처를 정리하고, dispose 는 폴링만 멈춘다', () => {
  const events = [];
  const h = startSession(events);
  try {
    h.session.sendUserMessage('go');
    h.session.interrupt();
    assert.equal(h.watchers[0].finalized, 1);

    const h2 = startSession(events);
    h2.session.sendUserMessage('go');
    h2.session.dispose();
    assert.equal(h2.watchers[0].finalized, 0);
    assert.equal(h2.watchers[0].stopped, 1);
    h2.cleanup();
  } finally {
    h.cleanup();
  }
});

test('multi_agent 는 exec 와 exec resume 모두에서 항상 켠다', () => {
  const opts = {
    rootDir: '/tmp/rhwp', mcpScriptPath: '/tmp/mcp-stdio.mjs', hubPort: 5175, token: 't',
  };
  for (const threadId of [null, 'thread-1']) {
    const argv = buildCodexArgv(opts, threadId);
    const index = argv.indexOf('multi_agent');
    assert.notEqual(index, -1);
    assert.equal(argv[index - 1], '--enable');
    assert.equal(argv.filter((a) => a === 'multi_agent').length, 1);
  }
});

test('시스템 브리프는 codex 용 병렬 작업 규율을 담는다', () => {
  const events = [];
  const h = startSession(events);
  try {
    h.session.sendUserMessage('문서를 나눠서 고쳐줘');
    const prompt = h.child().stdin.chunks.join('');
    assert.match(prompt, /spawn_agent/);
    assert.match(prompt, /wait_agent/);
    assert.match(prompt, /every agent you explicitly created with spawn_agent/);
    assert.match(prompt, /Never call wait_agent for an MCP-managed background job/);
    assert.match(prompt, /delegate_copy_layout/);
    assert.doesNotMatch(prompt, /spawn_subagent/);
  } finally {
    h.cleanup();
  }
});

/* ── 가짜 CLI 안전장치 ────────────────────────────────────────
 * 허브는 기동할 때마다 `codex --version` 으로 설치 여부를 프로브한다. 그때 stdin 은
 * /dev/null 이라 곧바로 EOF 가 오는데, 예전 가짜는 그 EOF 만으로 시나리오를 시작하고
 * CODEX_HOME 이 없으면 홈 디렉터리로 떨어져 사용자의 진짜 ~/.codex/sessions 에 가짜
 * 롤아웃을 쌓았다. 아래 두 테스트가 그 경로를 막는다.
 */

/** 가짜 CLI 를 한 번 돌리고 (exitCode, stdout) 을 돌려준다. */
function runFakeCodex(args, { env = {}, stdin = null, killAfterMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [FAKE_CODEX, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: '', ...env },
    });
    let stdout = '';
    let timer = null;
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (killAfterMs && !timer) timer = setTimeout(() => proc.kill('SIGKILL'), killAfterMs);
    });
    proc.stderr.resume();
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout });
    });
    if (stdin === null) proc.stdin.end();
    else proc.stdin.end(stdin);
  });
}

test('가짜 codex CLI: --version 은 버전 한 줄만 찍고 홈을 건드리지 않는다', async () => {
  if (!existsSync(FAKE_CODEX)) return; // studio 없이 돌리는 배포판
  const home = mkdtempSync(path.join(os.tmpdir(), 'rhwp-fake-codex-home-'));
  try {
    const { code, stdout } = await runFakeCodex(['--version'], { env: { HOME: home } });
    assert.equal(code, 0);
    assert.match(stdout, /^codex/);
    assert.doesNotMatch(stdout, /thread\.started/);
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('가짜 codex CLI: 프롬프트 없는 stdin EOF 로는 시나리오를 돌리지 않는다', async () => {
  if (!existsSync(FAKE_CODEX)) return;
  const home = mkdtempSync(path.join(os.tmpdir(), 'rhwp-fake-codex-home-'));
  const codexHome = path.join(home, '.codex');
  try {
    const { code, stdout } = await runFakeCodex(['exec', '--json'], {
      env: { HOME: home, CODEX_HOME: codexHome },
    });
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(existsSync(path.join(codexHome, 'sessions')), false);
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('가짜 codex CLI: 진짜 exec 호출은 CODEX_HOME 아래에만 롤아웃을 쓴다', async () => {
  if (!existsSync(FAKE_CODEX)) return;
  const home = mkdtempSync(path.join(os.tmpdir(), 'rhwp-fake-codex-home-'));
  const codexHome = path.join(home, 'isolated-codex');
  try {
    const { stdout } = await runFakeCodex(['exec', '--json', '-'], {
      env: { HOME: home, CODEX_HOME: codexHome },
      stdin: '문서를 나눠서 고쳐줘',
      killAfterMs: 300,
    });
    assert.match(stdout, /thread\.started/);
    assert.ok(existsSync(path.join(codexHome, 'sessions')));
    assert.deepEqual(readdirSync(home), ['isolated-codex']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
