import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AGENT_PROTOCOL_VERSION, isStructuredPlan } from '../src/agent/types.ts';

const bridgeSource = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');

test('planning protocol uses v3 and validates the complete structured plan', () => {
  assert.equal(AGENT_PROTOCOL_VERSION, 3);
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
});

test('bridge exposes plan commands and emits every server lifecycle event', () => {
  for (const message of [
    'chat-workflow-set',
    'chat-plan-approve',
    'chat-plan-request-changes',
  ]) {
    assert.match(bridgeSource, new RegExp(`type: '${message}'`));
  }
  for (const event of [
    'workflow-changed',
    'plan-ready',
    'plan-approved',
    'plan-invalidated',
    'implementation-started',
  ]) {
    assert.match(bridgeSource, new RegExp(`case '${event}'`));
    assert.match(bridgeSource, new RegExp(`type: '${event}'`));
  }
});

test('bridge reconnect keeps explicit workflow and re-synchronizes server authority', () => {
  assert.match(bridgeSource, /workflow: pending\.workflow/);
  assert.match(bridgeSource, /this\.syncWorkflowState\(session, 'direct', 'direct'\)/);
  assert.match(bridgeSource, /this\.syncWorkflowState\(msg, 'direct', 'direct'\)/);
  assert.match(bridgeSource, /activeCapabilityEpoch: this\.capabilityEpoch/);
  assert.match(bridgeSource, /this\.workflow === 'direct' \|\| this\.phase === 'implementing'/);
});

test('new chat defaults direct while an explicit plan start is carried on the wire', () => {
  assert.match(bridgeSource, /workflow: AgentWorkflow = 'direct'/);
  assert.match(bridgeSource, /type: 'chat-start' as const,[\s\S]*?workflow,/);
  assert.match(bridgeSource, /this\.resetWorkflowState\(\);[\s\S]*?type: 'chat-stop'/);
});
