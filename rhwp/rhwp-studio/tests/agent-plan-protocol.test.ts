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
});
