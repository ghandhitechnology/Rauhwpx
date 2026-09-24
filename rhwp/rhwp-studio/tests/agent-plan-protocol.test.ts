import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AGENT_PROTOCOL_VERSION, isStructuredPlan } from '../src/agent/types.ts';

const bridgeSource = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');

test('planning and user-input protocol uses v5 and validates the complete structured plan', () => {
  assert.equal(AGENT_PROTOCOL_VERSION, 5);
  const plan = {
    planId: 'plan-1',
    title: '정리 계획',
    goal: '문서 정리',
    summary: '구조와 서식을 정리한다.',
    assumptions: ['내용은 유지'],
    decisions: ['제목 스타일 통일'],
    steps: [{ title: '검토', details: '문서 구조를 읽는다.', files: ['a.hwpx'] }],
    files: ['a.hwpx'],
    validation: ['페이지 렌더'],
    risks: ['줄바꿈 변경'],
    exclusions: ['내용 추가'],
    createdAt: '2026-08-07T00:00:00.000Z',
    epoch: 2,
  };
  assert.equal(isStructuredPlan(plan), true);
  assert.equal(isStructuredPlan({ ...plan, risks: undefined }), false);
  assert.equal(isStructuredPlan({ ...plan, steps: [{ title: '검토' }] }), false);
  const executing = {
    ...plan,
    revision: 2,
    previousPlanId: 'plan-0',
    changeSummary: '도입부를 간결하게 수정합니다.',
    documentRevision: 12,
    sources: [{ title: '참고자료', url: 'https://example.com/report', note: '문서 구성의 근거' }],
    steps: [{ id: 'step-1', title: '검토', details: '문서 구조를 읽는다.', target: '도입부', preview: '제안 문구' }],
    execution: { status: 'running', steps: [{ stepId: 'step-1', status: 'in-progress' }] },
  };
  assert.equal(isStructuredPlan(executing), true);
  for (const execution of [
    { status: 'running', steps: [] },
    { status: 'completed', steps: [{ stepId: 'missing', status: 'completed' }] },
    { status: 'running', steps: [{ stepId: 'step-1', status: 'unknown' }] },
    { status: ['running'], steps: [{ stepId: 'step-1', status: 'pending' }] },
  ]) assert.equal(isStructuredPlan({ ...executing, execution }), false);
  assert.equal(isStructuredPlan({ ...executing, revision: -1 }), false);
  assert.equal(isStructuredPlan({ ...executing, sources: [{ title: '자료', url: {} }] }), false);
  assert.equal(isStructuredPlan({ ...executing,
    steps: [...executing.steps, { ...executing.steps[0], id: 'step-2' }],
    execution: { status: 'running', steps: [executing.execution.steps[0], executing.execution.steps[0]] },
  }), false);
});

test('bridge exposes plan commands and emits every server lifecycle event', () => {
  for (const message of [
    'chat-workflow-set',
    'chat-plan-approve',
    'chat-plan-request-changes',
    'chat-document-saved',
    'chat-plan-execution-result',
  ]) {
    assert.match(bridgeSource, new RegExp(`type: '${message}'`));
  }
  for (const event of [
    'workflow-changed',
    'plan-ready',
    'plan-approved',
    'plan-invalidated',
    'implementation-started',
    'plan-progress',
  ]) {
    assert.match(bridgeSource, new RegExp(`case '${event}'`));
    assert.match(bridgeSource, new RegExp(`type: '${event}'`));
  }
});

test('bridge reconnect keeps explicit workflow and re-synchronizes server authority', () => {
  assert.match(bridgeSource, /type: 'chat-start',[\s\S]*\.\.\.pending/);
  assert.match(bridgeSource, /this\.syncWorkflowState\(session, this\.workflow, this\.phase\)/);
  assert.match(bridgeSource, /this\.syncWorkflowState\(msg, fallbackWorkflow, fallbackPhase\)/);
  assert.match(bridgeSource, /if \(this\.workflow === 'plan' \|\| this\.workflow === 'question' \|\| this\.workflowSwitchPending\)/);
  assert.match(bridgeSource, /activeCapabilityEpoch: this\.capabilityEpoch/);
  assert.match(bridgeSource, /this\.workflow === 'direct' \|\| this\.phase === 'implementing'/);
});

test('a failed replacement cannot dispatch into the disposed previous session', () => {
  assert.match(
    bridgeSource,
    /case 'chat-error': \{[\s\S]*const chatStartFailed = this\.pendingChatStart !== null;[\s\S]*if \(chatStartFailed\) \{[\s\S]*this\.activeAgent = null;[\s\S]*this\.turnRunning = false;/,
  );
  assert.match(
    bridgeSource,
    /if \(this\.pendingTurnOpen\) \{[\s\S]*this\.endPendingTurn\(\);[\s\S]*this\.activeAgent = null;/,
  );
  assert.match(
    bridgeSource,
    /this\.rememberPendingChatStart\(\);[\s\S]*const pending = this\.pendingChatStart;[\s\S]*type: 'chat-start',[\s\S]*\.\.\.pending/,
  );
});

test('connected first message records pendingChatStart so reconnect can retry the start', () => {
  const sendUserOffset = bridgeSource.indexOf('\n  sendUserMessage(');
  const sendUserSource = bridgeSource.slice(
    sendUserOffset,
    bridgeSource.indexOf('\n  private dispatchUserMessage(', sendUserOffset),
  );
  assert.match(sendUserSource, /this\.rememberPendingChatStart\(\);/);
  assert.match(sendUserSource, /this\.pendingChatStart = \{/);
  assert.match(sendUserSource, /if \(!this\.workflowSwitchPending\) this\.sendPendingChatStart\(\)/);
  assert.doesNotMatch(sendUserSource, /\} else \{\s*this\.pendingChatStart = \{/);
});

test('new chat defaults direct while an explicit plan start is carried on the wire', () => {
  assert.match(bridgeSource, /workflow: AgentWorkflow = 'direct'/);
  assert.match(bridgeSource, /type: 'chat-start',[\s\S]*?\.\.\.pending/);
  const startChatOffset = bridgeSource.indexOf('\n  startChat(\n');
  const startChatSource = bridgeSource.slice(
    startChatOffset,
    bridgeSource.indexOf('  stopChat(): void', startChatOffset),
  );
  assert.doesNotMatch(startChatSource, /this\.resetWorkflowState\(workflow\)/);
  assert.doesNotMatch(startChatSource, /this\.permissionProfile = permissionProfile/);
  assert.match(startChatSource, /permissionProfile,\s*\n\s*serviceTier: this\.serviceTier,\s*\n\s*workflow,/);
  assert.match(bridgeSource, /this\.resetWorkflowState\(\);[\s\S]*?type: 'chat-stop'/);
});
