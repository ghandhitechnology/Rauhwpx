import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COPY_LAYOUT_MAX_ITERATIONS,
  COPY_LAYOUT_PHASES,
  buildCopyLayoutCompletionPrompt,
  buildCopyLayoutWorkerPrompt,
  defaultTemplateName,
  taskProgressForJob,
} from '../template-perfection.mjs';

const binding = {
  documentId: 'document-exact',
  digest: 'sha256-exact',
  documentName: '신청서.hwp',
  sourceFormat: 'hwp',
  dirty: true,
  sourcePath: null,
};

test('copy-layout worker prompt defines a fresh bounded no-prompt process', () => {
  const prompt = buildCopyLayoutWorkerPrompt({
    jobId: 'job-1',
    binding,
    helperPath: '/private/job/copy_layout.py',
    jobDir: '/private/job',
  });
  assert.equal(COPY_LAYOUT_MAX_ITERATIONS, 3);
  assert.match(prompt, /fresh independent provider process/);
  assert.match(prompt, /not a provider-native subagent/);
  assert.match(prompt, /Do not spawn, delegate, ask the user, request confirmation/);
  assert.match(prompt, /Always call materialize_document_snapshot/);
  assert.match(prompt, /complete paragraph, field, form-control, named-structure, visual-mark, and media inventory/);
  assert.match(prompt, /Hard iteration ceiling: 3 collision-free candidates/);
  assert.match(prompt, /verified convergence/);
  assert.match(prompt, /bounded-no-improvement/);
  assert.match(prompt, /any unresolved private payload[\s\S]*hard failure/);
  assert.match(prompt, /publish_artifact exactly once/);
  assert.match(prompt, /complete_copy_layout_job/);
  assert.match(prompt, /"documentId": "document-exact"/);
  assert.match(prompt, /\/private\/job\/copy_layout\.py/);
});

test('completion prompt leaves one exact registration decision to the owning chat', () => {
  const prompt = buildCopyLayoutCompletionPrompt({
    jobId: 'job-1',
    outcome: 'succeeded',
    artifact: { artifactId: 'artifact-1', fileName: '신청서 - Layout.hwp' },
  });
  assert.match(prompt, /hub's automatic completion notification/);
  // provider 중립 문구 — wait_agent 은 codex 협업 도구명이라 예시로만 남는다.
  assert.match(prompt, /not a collaboration-tool result \(never a wait_agent result\)/);
  assert.match(prompt, /Notify the user now/);
  assert.match(prompt, /Do not open the artifact automatically/);
  assert.match(prompt, /exactly one Markdown link labeled 템플릿 미리보기/);
  assert.match(prompt, /only the user's click opens a new read-only template-preview window/);
  assert.match(prompt, /ask exactly one final question/);
  assert.match(prompt, /register_copy_layout_template/);
  assert.match(prompt, /if they decline, do not call it and leave the card available/);
});

test('fleet progress reports one task row with a direct phase index', () => {
  assert.deepEqual(
    COPY_LAYOUT_PHASES.map(({ title }) => title),
    ['원본', '전체 검사', '정리', '생성', '비교', '검증', '게시'],
  );
  const progress = taskProgressForJob({
    jobId: 'job-1',
    agent: 'codex',
    model: 'gpt-5.6-sol',
    phase: 'previewing',
    status: 'running',
    activity: '대표 페이지 비교 중',
    usage: { totalTokens: 123, toolUses: 7 },
  });
  assert.equal(progress.type, 'task-progress');
  assert.equal(progress.taskId, 'job-1');
  assert.equal(progress.phases.length, COPY_LAYOUT_PHASES.length);
  assert.equal(progress.phaseIndex, 4);
  assert.equal(progress.members, undefined, 'a single worker must not render as its own child row');
  assert.deepEqual(progress.usage, { totalTokens: 123, toolUses: 7 });
});

test('default registration name strips format and generated collision suffixes', () => {
  assert.equal(defaultTemplateName('신청서 - Layout (3).hwpx'), '신청서');
  assert.equal(defaultTemplateName('보고서.hwp'), '보고서');
});
