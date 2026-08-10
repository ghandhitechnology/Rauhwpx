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

test('규율 블록은 금지 패턴과 보정 규칙을 함께 싣는다', () => {
  const block = humanizerPromptBlock('implementing');
  assert.match(block, /결론적으로/);
  assert.match(block, /번역투/);
  assert.match(block, /S1 must be 0/);
  assert.match(block, /at most ~20% of sentences/);
  assert.match(block, /Over 50%: stop and ask/);
  assert.match(block, /Read 2-3 paragraphs around the insertion point/);
  assert.match(block, /does not apply to your chat replies/);
  assert.match(block, /Meaning is invariant/);
  assert.match(block, /Style decides how a sentence is built, never what it asserts/);
});

test('개인 프로필이 있으면 리듬 수치를 프로필에 넘긴다', () => {
  const generic = humanizerPromptBlock('direct');
  const profiled = humanizerPromptBlock('direct', { personalProfile: true });
  assert.match(generic, /Put an 8자 sentence next to a 40자 one/);
  assert.doesNotMatch(profiled, /Put an 8자 sentence next to a 40자 one/);
  assert.match(profiled, /come from the user's personal profile above/);
});

test('영어 프로필에는 영어 규율 블록이 붙는다', () => {
  const english = humanizerPromptBlock('implementing', { language: 'en' });
  assert.match(english, /<english_writing_discipline>/);
  assert.doesNotMatch(english, /<korean_writing_discipline>/);
  assert.match(english, /In today's fast-paced world/);
  assert.match(english, /Meaning is invariant/);
  assert.match(english, /at most ~20% of sentences/);
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
