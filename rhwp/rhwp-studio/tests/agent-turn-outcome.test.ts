// 턴 종료 결과 → 스테이징 처리 규칙의 회귀 고정 (P1.3).
// 성공하지 못한 종료(오류·인터럽트·max_tokens·재연결·사용자 중지)는 어느 권한
// 모드에서도 편집을 버리지 않고 'review' + 중단 표시로 보낸다. 자동 커밋은
// 명시적으로 성공한 unrestricted 턴뿐이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// bridge.ts 는 오버레이 css 를 함께 들여온다 — node 테스트에서는 빈 모듈로 대체한다.
registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { AgentBridgeImpl, turnEndDisposition } = await import('../src/agent/bridge.ts');
const { PendingEditManager } = await import('../src/agent/pending-edits.ts');

test('turnEndDisposition: 명시적 성공 종료만 프로필로 커밋 여부를 가른다', () => {
  for (const stopReason of ['end_turn', 'completed', 'success'] as const) {
    assert.deepEqual(turnEndDisposition({ stopReason }, 'safe', false),
      { succeeded: true, outcome: 'review' });
    assert.deepEqual(turnEndDisposition({ stopReason }, 'unrestricted', false),
      { succeeded: true, outcome: 'commit' });
  }
});

test('turnEndDisposition: 비성공 종료는 어느 모드에서도 review 다', () => {
  const stopped = [
    { stopReason: 'interrupted' },
    { stopReason: 'max_tokens' },
    { stopReason: 'failed', errorMessage: 'boom' },
    { stopReason: 'exited' },
    {}, // 재연결 등 이유를 알 수 없는 종료
    { stopReason: 'end_turn', errorMessage: 'late error' },
  ];
  for (const event of stopped) {
    for (const profile of ['safe', 'unrestricted'] as const) {
      assert.deepEqual(turnEndDisposition(event, profile, false),
        { succeeded: false, outcome: 'review' }, `${profile} ${JSON.stringify(event)}`);
    }
  }
  // 턴 중 프로바이더 오류가 찍혔으면 종료 이유가 completed 여도 성공이 아니다.
  assert.deepEqual(turnEndDisposition({ stopReason: 'completed' }, 'unrestricted', true),
    { succeeded: false, outcome: 'review' });
});

type EndTurnCall = { outcome: string; opts?: { turnStopped?: boolean } };

function bridgeFixture(permissionProfile: 'safe' | 'unrestricted') {
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  const endTurnCalls: EndTurnCall[] = [];
  Object.assign(bridge, {
    permissionProfile,
    pendingTurnOpen: false,
    turnRunning: false,
    turnHadError: false,
    activeProviderTurnId: null,
    activeToolRequests: 0,
    activeToolRequestControllers: new Map(),
    editingAgent: null,
    editingLease: { active: false, agent: null, waitingForUser: false },
    editingLeaseListeners: new Set(),
    pendingUserQuestionId: null,
    workflow: 'direct',
    phase: 'direct',
    latestPlan: null,
    planExecutionTurn: null,
    planReview: null,
    listeners: new Set(),
    pendingEdits: {
      beginTurn: () => {},
      endTurn: (outcome: string, opts?: { turnStopped?: boolean }) => {
        endTurnCalls.push({ outcome, opts });
      },
      getChangeSets: () => [],
    },
    executor: { beginTurn: () => {}, endTurn: () => {} },
  });
  return { bridge, endTurnCalls };
}

function runTurn(bridge: any, events: Array<Record<string, unknown>>) {
  bridge.handleAgentEvent({ type: 'turn-start', agent: 'claude', turnId: 'turn-1' });
  assert.equal(bridge.pendingTurnOpen, true, 'turn-start 가 pending 턴을 연다');
  for (const event of events) bridge.handleAgentEvent(event);
}

test('turn-end 매핑: 성공은 safe→review, unrestricted→commit', () => {
  const safe = bridgeFixture('safe');
  runTurn(safe.bridge, [{ type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'completed' }]);
  assert.deepEqual(safe.endTurnCalls, [{ outcome: 'review', opts: { turnStopped: false } }]);

  const free = bridgeFixture('unrestricted');
  runTurn(free.bridge, [{ type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'completed' }]);
  assert.deepEqual(free.endTurnCalls, [{ outcome: 'commit', opts: { turnStopped: false } }]);
});

test('turn-end 매핑: 중단·오류·실패는 어느 모드에서도 review + 중단 표시', () => {
  for (const permissionProfile of ['safe', 'unrestricted'] as const) {
    for (const event of [
      { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'interrupted' },
      { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'max_tokens' },
      { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'failed', errorMessage: 'boom' },
    ]) {
      const { bridge, endTurnCalls } = bridgeFixture(permissionProfile);
      runTurn(bridge, [event]);
      assert.deepEqual(endTurnCalls,
        [{ outcome: 'review', opts: { turnStopped: true } }],
        `${permissionProfile} ${event.stopReason}`);
    }
    // 턴 중 프로바이더 error 이벤트는 종료 이유가 completed 여도 비성공이다.
    const { bridge, endTurnCalls } = bridgeFixture(permissionProfile);
    runTurn(bridge, [
      { type: 'error', agent: 'claude', message: 'provider failure' },
      { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'completed' },
    ]);
    assert.deepEqual(endTurnCalls,
      [{ outcome: 'review', opts: { turnStopped: true } }],
      `${permissionProfile} mid-turn error`);
    // 도구 수준 실패(ok:false tool-result)는 턴을 더럽히지 않는다 — 에이전트가 이미 봤다.
    const tool = bridgeFixture(permissionProfile);
    runTurn(tool.bridge, [
      { type: 'tool-result', agent: 'claude', callId: 'c1', ok: false, resultPreview: 'permission denied' },
      { type: 'tool-result', agent: 'claude', callId: 'c1', ok: false, resultPreview: 'permission denied' },
      { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'end_turn' },
    ]);
    assert.deepEqual(tool.endTurnCalls, [{
      outcome: permissionProfile === 'safe' ? 'review' : 'commit',
      opts: { turnStopped: false },
    }], `${permissionProfile} tool-level failure`);
  }
});

test('결과 불명 종료(재연결·시작 실패)의 기본값도 review + 중단 표시다', () => {
  for (const permissionProfile of ['safe', 'unrestricted'] as const) {
    const { bridge, endTurnCalls } = bridgeFixture(permissionProfile);
    bridge.handleAgentEvent({ type: 'turn-start', agent: 'claude', turnId: 'turn-1' });
    bridge.endPendingTurn();
    assert.deepEqual(endTurnCalls,
      [{ outcome: 'review', opts: { turnStopped: true } }], permissionProfile);
    assert.equal(bridge.pendingTurnOpen, false);
  }
});

// ─── PendingEditManager.endTurn ─────────────────────────────
// 스텁 위에서 실제 메서드를 돌려 set 표시와 되돌림 경로를 본다.

function pendingFixture() {
  const pending = Object.create(PendingEditManager.prototype) as any;
  const set = {
    id: 'cs-1', agent: 'claude' as const, status: 'open' as const,
    ops: [{ id: 'op-1' }], createdAt: 0,
  };
  const calls = { approved: [] as string[], rejected: [] as string[] };
  Object.assign(pending, {
    open: set,
    sets: [set],
    listeners: new Set(),
    bulkDepth: 0,
    syncOverlay: () => {},
    approve: (id: string) => { calls.approved.push(id); return true; },
    reject: (id: string) => { calls.rejected.push(id); },
  });
  return { pending, set, calls };
}

test('endTurn: 비성공 종료는 set 을 검토 대기로 남기고 중단을 표시한다', () => {
  const { pending, set, calls } = pendingFixture();
  pending.endTurn('review', { turnStopped: true });
  assert.equal(set.status, 'awaiting-review');
  assert.equal(set.turnStopped, true);
  assert.deepEqual(calls.rejected, [], '중단된 턴은 절대 자동 거절하지 않는다');
  assert.deepEqual(calls.approved, []);
});

test('endTurn: 성공 commit 은 승인하고 중단 표시를 남기지 않는다', () => {
  const { pending, set, calls } = pendingFixture();
  pending.endTurn('commit');
  assert.deepEqual(calls.approved, ['cs-1']);
  assert.deepEqual(calls.rejected, []);
  assert.equal(set.turnStopped, undefined);
});

test('endTurn: commit 승인 실패만 되돌림으로 빠진다', () => {
  const { pending, calls } = pendingFixture();
  pending.approve = () => false;
  pending.endTurn('commit');
  assert.deepEqual(calls.rejected, ['cs-1']);
});
