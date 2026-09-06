import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { humanizerPromptBlock, isBuildPhase } from '../humanizer.mjs';
import { PlanningState, buildApprovedPlanPrompt } from '../planning-state.mjs';
import { SkillRegistry } from '../skills.mjs';

test('작문 규율은 문서 쓰기가 열린 단계에서만 붙는다', () => {
  assert.equal(isBuildPhase('direct'), true);
  assert.equal(isBuildPhase('implementing'), true);
  assert.equal(isBuildPhase('switching'), true);
  assert.equal(isBuildPhase('planning'), false);
  assert.equal(isBuildPhase('awaiting-approval'), false);
  assert.equal(humanizerPromptBlock('planning'), '');
  assert.match(humanizerPromptBlock('direct'), /<korean_writing_discipline>/);
});

test('both languages preserve meaning without mechanical writing quotas', () => {
  for (const language of ['ko', 'en']) {
    for (const personalProfile of [false, true]) {
      const block = humanizerPromptBlock('implementing', { language, personalProfile });
      assert.match(block, /Preserve facts, figures/);
      assert.match(block, /negation, uncertainty, and causality/);
      assert.match(block, /does not apply to your chat replies/);
      assert.match(block, /Honour an explicit length limit/);
      assert.match(block, /The user's scope determines how much to change/);
      assert.doesNotMatch(block, /S1|S2|S3|\d+%|per ~\d+|five-word|thirty-word/);
      assert.match(block, /Do not score it for AI tells/);
      if (personalProfile) assert.match(block, /Ignore numeric style targets in older profiles/);
    }
  }
});

test('language-specific guidance follows idiom and register', () => {
  const korean = humanizerPromptBlock('direct');
  assert.match(korean, /존댓말과 반말을 섞거나/);
  assert.match(korean, /금지어 목록처럼 기계적으로 지우지 않는다/);
  const english = humanizerPromptBlock('direct', { language: 'en' });
  assert.match(english, /<english_writing_discipline>/);
  assert.match(english, /regional spelling/);
  assert.match(english, /Do not alternate short and long sentences/);
  assert.equal(humanizerPromptBlock('planning', { language: 'en' }), '');
});

test('promptContext 는 단계에 따라 규율을 켜고 끈다', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-humanizer-'));
  const registry = await new SkillRegistry({ bundledRoot: path.join(root, 'bundled'), userRoot: path.join(root, 'user') }).init();
  const build = await registry.promptContext('표를 요약해 줘', undefined, { phase: 'implementing' });
  const planning = await registry.promptContext('표를 요약해 줘', undefined, { phase: 'planning' });
  assert.match(build, /<korean_writing_discipline>/);
  assert.doesNotMatch(planning, /<korean_writing_discipline>/);
  // 기본값은 바로 실행 채팅이므로 규율이 켜져 있어야 한다.
  assert.match(await registry.promptContext('표를 요약해 줘'), /<korean_writing_discipline>/);
  await fs.rm(root, { recursive: true, force: true });
});

test('승인된 계획 프롬프트도 규율을 함께 전달한다', () => {
  const state = new PlanningState({ workflow: 'plan', createPlanId: () => 'plan-1', now: () => '2026-01-01T00:00:00.000Z' });
  state.present({ title: '보고서 초안' });
  const approved = state.beginApproval({ planId: 'plan-1', sessionStatus: 'idle' });
  const prompt = buildApprovedPlanPrompt(approved.approvedPlan);
  assert.match(prompt, /<korean_writing_discipline>/);
  assert.match(prompt, /Plan ID: plan-1/);
});
