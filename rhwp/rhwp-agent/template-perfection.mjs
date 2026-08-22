import path from 'node:path';

export const COPY_LAYOUT_MAX_ITERATIONS = 3;

export const COPY_LAYOUT_PHASES = Object.freeze([
  Object.freeze({ index: 0, id: 'binding-source', title: '원본 고정' }),
  Object.freeze({ index: 1, id: 'inspecting', title: '텍스트·미디어 전수 검사' }),
  Object.freeze({ index: 2, id: 'planning', title: '보존·제거 결정' }),
  Object.freeze({ index: 3, id: 'generating', title: '후보 생성' }),
  Object.freeze({ index: 4, id: 'previewing', title: '대표 페이지 비교' }),
  Object.freeze({ index: 5, id: 'converging', title: '안전·충실도 수렴' }),
  Object.freeze({ index: 6, id: 'publishing', title: '검증본 게시' }),
]);

const PHASE_INDEX = new Map(COPY_LAYOUT_PHASES.map((phase) => [phase.id, phase.index]));

export function copyLayoutPhaseIndex(phase) {
  return PHASE_INDEX.get(String(phase ?? '')) ?? 0;
}

export function defaultTemplateName(fileName) {
  const extension = path.extname(String(fileName ?? ''));
  return path.basename(String(fileName ?? '레이아웃 템플릿'), extension)
    .replace(/\s+-\s+Layout(?:\s+\(\d+\))?$/iu, '')
    .trim() || '레이아웃 템플릿';
}

export function buildCopyLayoutWorkerPrompt({ jobId, binding, helperPath, jobDir }) {
  return `You are the dedicated autonomous copy-layout worker for Rauhwpx job ${jobId}.

This is a fresh independent provider process. It is not a provider-native subagent. Do not spawn, delegate, ask the user, request confirmation, or wait for human input. Work only on this job and call complete_copy_layout_job exactly once.

Immutable source binding (trusted hub data):
${JSON.stringify(binding, null, 2)}

Job workspace: ${jobDir}
Bundled helper copy: ${helperPath}
Hard iteration ceiling: ${COPY_LAYOUT_MAX_ITERATIONS} collision-free candidates.

Required workflow:
1. Call update_copy_layout_job(phase=binding-source). Read the bundled copy-layout skill completely with read_product_skill. Call get_document_info and require documentId and digest to equal the immutable binding. Always call materialize_document_snapshot, then use only that exact snapshot so the native source can never be modified or overwritten.
2. Call update_copy_layout_job(phase=inspecting). Run the helper with --inspect-text and review the complete paragraph, field, form-control, named-structure, visual-mark, and media inventory. Inspect all semantic text and every media use; never decide from a sample.
3. Call update_copy_layout_job(phase=planning). Write a source_sha256-bound decision JSON with default=keep. Preserve reusable guidance by default, remove only evidenced submission data, reset user-entered controls/marks, and record precise ambiguities as warnings. Do not paraphrase retained text.
4. Call update_copy_layout_job(phase=generating). Run the helper against the immutable snapshot to a fresh candidate path under the job workspace. Never write beside, rename, modify, or overwrite the source. Review the complete helper report and both kept/removed text lists.
5. Call update_copy_layout_job(phase=previewing). Render or preview representative first/middle/last and risk-bearing pages for both source snapshot and candidate using the bundled rhwp CLI when available. Compare hard safety/readability, semantic retention/removal, page/section counts, media, native conversion, render similarity, and geometry. render_page may be used only for the bound live source; candidate previews must come from the candidate file.
6. Call update_copy_layout_job(phase=converging). Revise decisions or media retention only when the evidence predicts a safer or more faithful result, and rerun to a new collision-free candidate. Stop at verified convergence or after ${COPY_LAYOUT_MAX_ITERATIONS} candidates with an explicit bounded-no-improvement result. Fidelity mismatches are warnings; any unresolved private payload, rejected text, unreadable output, invalid package, or broken structural guidance is a hard failure.
7. Call update_copy_layout_job(phase=publishing). For a successful candidate, call publish_artifact exactly once with its exact output path. Then call complete_copy_layout_job with the returned artifactId, quality, precise warnings, counts, preview data, and stoppedReason. On hard failure, publish nothing and complete with outcome=failed and stoppedReason=hard-failure.

The successful report must set safetyVerified and readabilityVerified true. quality=best_effort is valid only for fidelity mismatches, never for privacy or readability failures. The owning chat and Studio handle preview opening and the user's final template-registration decision; do not address the user yourself.`;
}

export function buildCopyLayoutCompletionPrompt(result) {
  return `<copy_layout_job_completion trust="hub-verified">
${JSON.stringify(result, null, 2)}
</copy_layout_job_completion>

The independent copy-layout worker has settled. Studio already opened the exact returned artifact in a new read-only template-preview window when outcome is succeeded. Report the quality, precise warnings, counts, and representative preview comparison concisely. Then ask exactly one final question: whether the user wants to save/register this exact artifact as a reusable template. Do not ask for any other confirmation. If the user accepts in their next reply, call register_copy_layout_template with this jobId; if they decline, do not call it and leave the preview open.`;
}

export function taskProgressForJob(job, activity, lastTool) {
  const phaseIndex = copyLayoutPhaseIndex(job.phase);
  return {
    type: 'task-progress',
    agent: job.agent,
    taskId: job.jobId,
    activity: String(activity || job.activity || COPY_LAYOUT_PHASES[phaseIndex].title).slice(0, 500),
    ...(lastTool ? { lastTool: String(lastTool).slice(0, 200) } : {}),
    phases: COPY_LAYOUT_PHASES.map(({ index, title }) => ({ index, title })),
    members: [{
      index: 0,
      label: '템플릿 완성 워커',
      state: job.status === 'failed'
        ? 'failed'
        : job.status === 'completed'
          ? 'completed'
          : 'running',
      phaseIndex,
      model: job.model,
      ...(Number.isFinite(job.usage?.totalTokens) ? { tokens: job.usage.totalTokens } : {}),
      ...(Number.isFinite(job.usage?.toolUses) ? { toolCalls: job.usage.toolUses } : {}),
      activity: String(activity || job.activity || '').slice(0, 500),
    }],
    ...(job.usage ? { usage: job.usage } : {}),
  };
}
