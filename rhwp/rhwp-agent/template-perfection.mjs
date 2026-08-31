import path from 'node:path';

export const COPY_LAYOUT_MAX_ITERATIONS = 3;

export const COPY_LAYOUT_PHASES = Object.freeze([
  Object.freeze({ index: 0, id: 'binding-source', title: '원본' }),
  Object.freeze({ index: 1, id: 'inspecting', title: '전체 검사' }),
  Object.freeze({ index: 2, id: 'planning', title: '정리' }),
  Object.freeze({ index: 3, id: 'generating', title: '생성' }),
  Object.freeze({ index: 4, id: 'previewing', title: '비교' }),
  Object.freeze({ index: 5, id: 'converging', title: '검증' }),
  Object.freeze({ index: 6, id: 'publishing', title: '게시' }),
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

function copyLayoutStateError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function claimCopyLayoutSnapshot(job) {
  if (job.snapshot) return { bound: job.snapshot, claimed: false };
  if (job.snapshotPending) {
    throw copyLayoutStateError(
      'COPY_LAYOUT_SNAPSHOT_ACTIVE',
      'The immutable document snapshot is already being materialized for this job',
    );
  }
  job.snapshotPending = true;
  return { bound: null, claimed: true };
}

export function releaseCopyLayoutSnapshot(job) {
  if (job) job.snapshotPending = false;
}

export function claimCopyLayoutPublication(job, candidate) {
  if (job.publishPending || job.publishedArtifacts.size > 0) {
    throw copyLayoutStateError(
      'COPY_LAYOUT_ARTIFACT_ALREADY_PUBLISHED',
      'This copy-layout job already claimed its one immutable artifact publication',
    );
  }
  if (job.helperPending > 0) {
    throw copyLayoutStateError(
      'COPY_LAYOUT_HELPER_ACTIVE',
      'Wait for the structured helper to finish before publishing its candidate',
    );
  }
  if (!candidate) {
    throw copyLayoutStateError(
      'COPY_LAYOUT_ARTIFACT_UNBOUND',
      'The copy-layout worker may publish only an exact candidate returned by its structured helper',
    );
  }
  job.publishPending = true;
  return candidate;
}

export function releaseCopyLayoutPublication(job, candidate) {
  if (job?.status === 'running'
    && job.publishedArtifacts.size === 0
    && job.generatedCandidates.get(candidate?.iteration) === candidate) {
    job.publishPending = false;
  }
}

export function claimCopyLayoutSettlement(job) {
  if (job.status !== 'running') {
    throw copyLayoutStateError('COPY_LAYOUT_JOB_SETTLED', 'This copy-layout job is already settling or settled');
  }
  job.status = 'settling';
}

export function buildCopyLayoutWorkerPrompt({ jobId, binding, jobDir }) {
  return `You are the dedicated autonomous copy-layout worker for Rauhwpx job ${jobId}.

This is a fresh independent provider process. It is not a provider-native subagent. Do not spawn, delegate, ask the user, request confirmation, or wait for human input. Work only on this job and call complete_copy_layout_job exactly once.

Immutable source binding (trusted hub data):
${JSON.stringify(binding, null, 2)}

Job workspace: ${jobDir}
Hard iteration ceiling: ${COPY_LAYOUT_MAX_ITERATIONS} collision-free candidates.
Never use Bash, a shell, Python, or a provider filesystem command to run the helper. The worker-only run_copy_layout_helper tool owns the executable, bundled script, immutable source, private output paths, timeout, and process cleanup.

Required workflow:
1. Call update_copy_layout_job(phase=binding-source). Read the bundled copy-layout skill completely with read_product_skill. Call get_document_info and require documentId and digest to equal the immutable binding. Always call materialize_document_snapshot, then use only that exact snapshot so the native source can never be modified or overwritten.
2. Call update_copy_layout_job(phase=inspecting). Call run_copy_layout_helper(action=inspect) and review the complete paragraph, field, form-control, named-structure, visual-mark, and media inventory. Inspect all semantic text and every media use; never decide from a sample.
3. Call update_copy_layout_job(phase=planning). Form a source_sha256-bound textPlan object with default=keep. Preserve reusable guidance by default, remove only evidenced submission data, reset user-entered controls/marks, and record precise ambiguities as warnings. Do not paraphrase retained text.
4. Call update_copy_layout_job(phase=generating). Call run_copy_layout_helper(action=generate) with that textPlan and iteration. The hub writes a fresh candidate into provider-read-only private storage and returns its exact outputPath. Never write beside, rename, modify, or overwrite the source. Review the complete helper report and both kept/removed text lists.
5. Call update_copy_layout_job(phase=previewing). Use only the helper report's source-bound candidate_evidence: the hub has already rendered matching representative source/candidate pages and recorded page/section counts, bounded SVG hashes/dimensions, geometry, safety, and readability. Do not invoke a CLI or claim a comparison absent from that report. Compare semantic retention/removal, media, pagination, and geometry.
6. Call update_copy_layout_job(phase=converging). Revise decisions or media retention only when the evidence predicts a safer or more faithful result, and rerun to a new collision-free candidate. Stop at verified convergence or after ${COPY_LAYOUT_MAX_ITERATIONS} candidates with an explicit bounded-no-improvement result. Fidelity mismatches are warnings; any unresolved private payload, rejected text, unreadable output, invalid package, or broken structural guidance is a hard failure.
7. Call update_copy_layout_job(phase=publishing). For a successful candidate, call publish_artifact exactly once with its exact output path. Then call complete_copy_layout_job with the returned artifactId and copy quality, warnings, counts, page counts, representative pages, and verification booleans exactly from that candidate's helper report and candidate_evidence; the hub rejects invented or altered claims. Use stoppedReason=verified-convergence only for verified quality. Best-effort completion requires all three bounded generation iterations and stoppedReason=bounded-no-improvement. On hard failure, publish nothing and complete with only outcome=failed plus a diagnostic summary/warnings; do not assert counts or preview verification.

The successful report must set safetyVerified and readabilityVerified true. quality=best_effort is valid only for fidelity mismatches, never for privacy or readability failures. The owning chat and Studio handle preview opening and the user's final template-registration decision; do not address the user yourself.`;
}

export function buildCopyLayoutCompletionPrompt(result) {
  return `<copy_layout_job_completion trust="hub-verified">
${JSON.stringify(result, null, 2)}
</copy_layout_job_completion>

This is the hub's automatic completion notification for the independent copy-layout worker — not a collaboration-tool result (never a wait_agent result) and not a user message. The worker has settled. Do not open the artifact automatically. Notify the user now: report the quality, precise warnings, counts, and representative preview comparison concisely. When outcome is succeeded, include exactly one Markdown link labeled 템플릿 미리보기 whose href is the exact artifact.downloadUrl from the payload. Studio renders it as a clickable document card; only the user's click opens a new read-only template-preview window. Then ask exactly one final question: whether the user wants to save/register this exact artifact as a reusable template. Do not ask for any other confirmation. If the user accepts in their next reply, call register_copy_layout_template with this jobId; if they decline, do not call it and leave the card available.`;
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
    phaseIndex,
    ...(job.usage ? { usage: job.usage } : {}),
  };
}
