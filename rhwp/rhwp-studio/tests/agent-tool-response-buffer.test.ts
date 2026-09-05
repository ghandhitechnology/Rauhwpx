// 끊긴 사이에 끝난 tool-response 를 붙잡아 두는 버퍼와, 브리지가 그것을 물린 자리를 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// bridge.ts 는 오버레이 css 를 함께 들여온다 — node 테스트에서는 빈 모듈로 대체한다.
registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { AgentBridgeImpl, ToolResponseBuffer, providerTurnEndMatches } = await import('../src/agent/bridge.ts');
const { assertToolRequestActive } = await import('../src/agent/tool-executor.ts');
const bridgeSource = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');

test('ToolResponseBuffer: 담은 순서대로 흘려보내고 비운다', () => {
  const buffer = new ToolResponseBuffer();
  buffer.push({ id: 1 });
  buffer.push({ id: 2 });
  assert.equal(buffer.size, 2);
  assert.deepEqual(buffer.drain(), [{ id: 1 }, { id: 2 }]);
  assert.equal(buffer.size, 0);
  assert.deepEqual(buffer.drain(), []);
});

test('ToolResponseBuffer: 한계를 넘으면 가장 오래된 것부터 버린다', () => {
  const buffer = new ToolResponseBuffer(2);
  buffer.push({ id: 1 });
  buffer.push({ id: 2 });
  buffer.push({ id: 3 });
  assert.equal(buffer.size, 2);
  assert.deepEqual(buffer.drain(), [{ id: 2 }, { id: 3 }]);
});

test('ToolResponseBuffer: 보관 기한이 지난 프레임은 흘리지 않는다', () => {
  const buffer = new ToolResponseBuffer(8, 30_000);
  buffer.push({ id: 1 }, 0);
  buffer.push({ id: 2 }, 20_000);
  assert.deepEqual(buffer.drain(31_000), [{ id: 2 }]);
});

test('ToolResponseBuffer: clear 는 남은 프레임을 모두 버린다', () => {
  const buffer = new ToolResponseBuffer();
  buffer.push({ id: 1 });
  buffer.clear();
  assert.equal(buffer.size, 0);
});

test('a delayed old turn-end cannot settle a newer identified turn', () => {
  assert.equal(providerTurnEndMatches('turn-new', 'turn-old'), false);
  assert.equal(providerTurnEndMatches('turn-new', null), false);
  assert.equal(providerTurnEndMatches('turn-new', 'turn-new'), true);
  assert.equal(providerTurnEndMatches(null, null), true);
  assert.equal(providerTurnEndMatches(null, 'turn-replayed'), true);
});

test('turn cancellation releases the editing lease before deferred tools settle', async () => {
  let releaseDeferredTools = () => {};
  const deferredTools = new Promise<void>((resolve) => { releaseDeferredTools = resolve; });
  const responses: unknown[] = [];
  let lateMutations = 0;
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  Object.assign(bridge, {
    activeProviderTurnId: 'turn-active',
    turnRunning: true,
    editingAgent: 'pi',
    activeToolRequests: 0,
    activeToolRequestControllers: new Map(),
    editingLease: { active: false, agent: 'pi' },
    editingLeaseListeners: new Set(),
    pendingUserQuestionId: null,
    workflow: 'direct',
    phase: 'direct',
    capabilityEpoch: null,
    permissionProfile: 'safe',
    activeAgent: 'pi',
    turnHadError: false,
    pendingTurnOpen: false,
    listeners: new Set(),
    executor: {
      async execute(tool: string, _args: unknown, _agent: string, capability: any) {
        await deferredTools;
        if (tool === 'deferred_mutator') {
          assertToolRequestActive(capability);
          lateMutations += 1;
        }
        return { tool };
      },
    },
  });
  bridge.sendToolResponse = (frame: unknown) => { responses.push(frame); };

  for (const [id, tool] of [[1, 'deferred_mutator'], [2, 'deferred_result']] as const) {
    bridge.handleToolRequest({
      id,
      tool,
      args: {},
      agent: 'pi',
      workflow: 'direct',
      providerTurnId: 'turn-active',
      turnBound: true,
    });
  }
  assert.equal(bridge.getEditingLease().active, true);
  assert.equal(bridge.activeToolRequests, 2);

  bridge.handleAgentEvent({
    type: 'turn-end',
    agent: 'pi',
    turnId: 'turn-active',
    stopReason: 'interrupted',
  });
  assert.equal(bridge.getEditingLease().active, false);
  assert.equal(bridge.activeToolRequests, 0);
  assert.equal(bridge.activeToolRequestControllers.size, 0);

  releaseDeferredTools();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateMutations, 0);
  assert.deepEqual(responses, []);
  assert.equal(bridge.activeToolRequests, 0);
});

test('브리지는 전송 실패한 tool-response 를 버퍼에 넣고 재연결 때 흘려보낸다', () => {
  assert.match(bridgeSource, /private sendToolResponse\(frame: unknown\): void \{\s*if \(this\.sendJson\(frame\)\) return;\s*this\.toolResponses\.push\(frame\);/);
  assert.match(bridgeSource, /this\.setState\('connected'\);[\s\S]{0,200}this\.flushToolResponses\(\);/);
  assert.doesNotMatch(bridgeSource, /this\.sendJson\(\{ v: AGENT_PROTOCOL_VERSION, type: 'tool-response'/);
});

test('스튜디오 소켓 URL 은 페이지 인스턴스 id 를 함께 보낸다', () => {
  assert.match(bridgeSource, /&instance=\$\{encodeURIComponent\(STUDIO_INSTANCE_ID\)\}/);
  assert.match(bridgeSource, /const STUDIO_INSTANCE_ID = /);
});

function interruptBridgeFixture(execute: (...args: any[]) => Promise<unknown> = async () => ({})) {
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  const responses: any[] = [];
  Object.assign(bridge, {
    activeProviderTurnId: 'turn-active', turnRunning: true,
    activeToolRequests: 0, activeToolRequestControllers: new Map(),
    pendingUserQuestion: null, pendingQuestionCancellation: null,
    workflow: 'direct', phase: 'direct', activeAgent: 'codex',
    executor: { execute }, syncEditingLease: () => {},
    sendJson: () => true, sendToolResponse: (response: unknown) => { responses.push(response); },
  });
  const request = (id: number, turnId = 'turn-active') => bridge.handleToolRequest({
    id, tool: 'insert_text', args: {}, agent: 'codex', providerTurnId: turnId,
  });
  return { bridge, request, responses };
}

test('interrupt fences late requests from the same provider turn before its turn-end arrives', async () => {
  let executions = 0;
  const { bridge, request, responses } = interruptBridgeFixture(async () => { executions++; return {}; });
  bridge.interrupt();
  request(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executions, 0);
  assert.equal(responses[0].error.code, 'NO_ACTIVE_TURN');
  bridge.activeProviderTurnId = 'turn-next';
  request(2, 'turn-next');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executions, 1, 'the fence must not block the next provider turn');
});

test('idle interruption refuses a tool request that has not yet emitted its UI tool-call event', async () => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { bridge, request } = interruptBridgeFixture(async () => { await pending; return {}; });
  request(1);
  const controller = bridge.activeToolRequestControllers.get(1).controller;
  assert.equal(bridge.interruptIfIdle(), false);
  assert.equal(controller.signal.aborted, false);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(bridge.interruptIfIdle(), true);
});
