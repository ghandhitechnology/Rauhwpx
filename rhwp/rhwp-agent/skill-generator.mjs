import spawn from 'cross-spawn';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRouterReady } from './agents/title.mjs';
import {
  isolatedProcessEnv,
  PROCESS_TREE_CLEANUP_OUTCOME,
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExitOutcome,
  terminateProcessTree,
} from './process-tree.mjs';
import { validateSkillPayload } from './skills.mjs';
import { createTerminalJsonScanner } from './terminal-json-scanner.mjs';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'files'],
  properties: {
    name: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$' },
    files: {
      type: 'array', minItems: 1, maxItems: 30,
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
    },
  },
};
const MAX_STRUCTURED_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STRUCTURED_STDERR_BYTES = 64 * 1024;

function promptFor(input) {
  return `Create a concise, portable agent skill for rhwp. Return JSON matching the supplied schema. The files array must include SKILL.md. SKILL.md frontmatter must contain name and description; the product UI adds its optional icon selection. Use lowercase hyphen-case. Write imperative instructions. Put detailed reusable material in references/, and deterministic code only when scripts are genuinely needed. Do not create README or changelog files.\n\nGoal: ${input.goal}\nShould trigger: ${input.triggerExamples || '(infer from goal)'}\nShould not trigger: ${input.nonTriggerExamples || '(none supplied)'}\nResource guidance: ${input.resourceNotes || 'instruction-only unless a resource is clearly necessary'}${input.existingSkill ? `\n\nImprove this existing skill:\n${input.existingSkill}` : ''}`;
}

function run(command, args, stdin, timeoutMs = 90_000, spawnOptions = {}, deps = {}) {
  return new Promise((resolve, reject) => {
    const spawnProcess = deps.spawnProcess ?? spawn;
    const terminateProcess = deps.terminateProcess ?? terminateProcessTree;
    const child = spawnProcess(command, args, {
      ...spawnOptions,
      ...processTreeSpawnOptions(),
      env: isolatedProcessEnv(deps, { ...process.env, ...(spawnOptions.env ?? {}) }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let settled = false;
    let finalizing = false;
    let forcedError = null;
    let cleanupPromise = null;
    const terminalScanner = createTerminalJsonScanner(deps.terminalProtocol, {
      maxFrameBytes: MAX_STRUCTURED_STDOUT_BYTES,
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const cleanup = () => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (typeof deps.cleanupProcessOutcome === 'function'
        ? Promise.resolve(deps.cleanupProcessOutcome(child))
        : terminateAndWaitForProcessTreeExitOutcome(child, { terminateProcess }))
        .catch(() => PROCESS_TREE_CLEANUP_OUTCOME.FAILED);
      return cleanupPromise;
    };
    const finishAfterCleanup = (error, value, { allowUnavailable = false } = {}) => {
      if (settled || finalizing) return;
      finalizing = true;
      clearTimeout(timer);
      void cleanup().then((outcome) => {
        if (!error && allowUnavailable
          && outcome === PROCESS_TREE_CLEANUP_OUTCOME.UNAVAILABLE) {
          deps.onCleanupUncertain?.();
          finish(null, value);
          return;
        }
        if (outcome !== PROCESS_TREE_CLEANUP_OUTCOME.PROVEN) {
          const cleanupError = error ?? new Error('Skill generator process-tree cleanup could not be confirmed');
          cleanupError.processCleanupUncertain = true;
          finish(cleanupError);
          return;
        }
        finish(error, value);
      });
    };
    const forceFailure = (error) => {
      if (settled || forcedError) return;
      forcedError = error;
      clearTimeout(timer);
      finishAfterCleanup(error);
    };
    const timer = setTimeout(() => {
      forceFailure(new Error('Skill generation timed out'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > MAX_STRUCTURED_STDOUT_BYTES) {
        forceFailure(new Error('Skill generation output exceeded the 8 MiB safety limit'));
        return;
      }
      stdout += chunk;
      if (typeof deps.cleanupProcessOutcome === 'function'
        && terminalScanner.push(chunk)) {
        finishAfterCleanup(null, stdout);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_STRUCTURED_STDERR_BYTES);
    });
    child.on('error', (error) => {
      if (forcedError) return;
      if (child.pid) finishAfterCleanup(error);
      else finish(error);
    });
    child.on('close', (code) => {
      if (forcedError) return;
      if (code === 0) finishAfterCleanup(null, stdout, { allowUnavailable: true });
      else finishAfterCleanup(
        new Error(stderr.trim() || `${command} exited with code ${code}`),
        undefined,
      );
    });
    child.stdin?.on?.('error', forceFailure);
    try {
      child.stdin.end(stdin);
    } catch (error) {
      forceFailure(error);
    }
  });
}

function extractClaude(output) {
  const parsed = JSON.parse(output);
  return parsed.structured_output ?? JSON.parse(parsed.result);
}

function extractCodex(output) {
  let text = '';
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text ?? '';
  }
  return JSON.parse(text);
}

/** OpenRouter 는 스키마 강제 모드가 없다 — 지시문으로 요구하고 결과를 여기서 검증한다. */
function openRouterPrompt(input) {
  return [
    promptFor(input),
    '',
    'Return ONLY a JSON object matching this JSON Schema. No prose, no code fences.',
    JSON.stringify(SCHEMA),
  ].join('\n');
}

function parseJsonObject(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Skill draft was not JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * SCHEMA 를 허브에서 직접 검증한다 (CLI 의 --json-schema 대체).
 * 통과하면 정리된 초안을, 아니면 사람이 읽을 이유를 담아 던진다.
 *
 * @param {unknown} draft
 */
export function validateSkillDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('draft is not an object');
  const name = draft.name;
  const files = draft.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > SCHEMA.properties.files.maxItems) {
    throw new Error('files must hold 1-30 entries');
  }
  const normalized = files.map((file) => {
    if (!file || typeof file.path !== 'string' || !file.path.trim() || typeof file.content !== 'string') {
      throw new Error('every file needs a path and content');
    }
    return { path: file.path.trim(), content: file.content };
  });
  const checked = validateSkillPayload({ name, files: normalized }, {
    maxFiles: SCHEMA.properties.files.maxItems,
  });
  return {
    name: checked.name,
    files: checked.decoded.map((file) => ({
      path: file.path,
      content: file.bytes.toString('utf8'),
    })),
  };
}

/** 한 번 더 시킨다 — 형식만 틀린 경우가 대부분이라 재시도로 붙는다. */
async function draftViaOpenRouter(input, { piManager, openRouter }) {
  const model = piManager.defaultModel();
  if (!model) {
    const error = new Error('Pi 모델이 설정되지 않았어요');
    error.code = 'PI_NOT_CONFIGURED';
    throw error;
  }
  const messages = [{ role: 'user', content: openRouterPrompt(input) }];
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = await openRouter.chat({
      key: piManager.apiKey(),
      model: model.id,
      messages,
      maxTokens: 8_000,
      timeout: 120_000,
    });
    try {
      return validateSkillDraft(parseJsonObject(text));
    } catch (error) {
      lastError = error;
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: `That reply was rejected: ${error.message}. Reply again with only the JSON object.`,
      });
    }
  }
  throw new Error(`Skill draft did not match the schema: ${lastError?.message ?? 'unknown'}`);
}

/**
 * @param {object} input
 * @param {{ useOpenRouter?: boolean, piManager?: any, openRouter?: any, isolatedHome?: string,
 *   sessionId?: string, spawnProcess?: typeof spawn, terminateProcess?: typeof terminateProcessTree }} [deps]
 */
export async function generateSkillDraft(input, deps = {}) {
  if (openRouterReady(deps)) return draftViaOpenRouter(input, deps);
  const prompt = promptFor(input);
  if (input.agent === 'claude') {
    const output = await run('claude', [
      '-p', '--safe-mode', '--output-format', 'json', '--tools', '', '--disable-slash-commands',
      '--json-schema', JSON.stringify(SCHEMA), ...(input.model ? ['--model', input.model] : []),
    ], prompt, 90_000, {}, { ...deps, terminalProtocol: 'claude-json' });
    return validateSkillDraft(extractClaude(output));
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-skill-schema-'));
  const schemaPath = path.join(temp, 'schema.json');
  let cleanupUncertain = false;
  try {
    await fs.writeFile(schemaPath, JSON.stringify(SCHEMA), 'utf8');
    const output = await run('codex', [
      'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
      '--disable', 'image_generation', '--disable', 'multi_agent', '--disable', 'plugins',
      '--disable', 'skill_search',
      '--sandbox', 'read-only', '--output-schema', schemaPath,
      ...(input.model ? ['--model', input.model] : []), '-'
    ], prompt, 90_000, { cwd: temp }, {
      ...deps,
      terminalProtocol: 'codex-jsonl',
      onCleanupUncertain: () => { cleanupUncertain = true; },
    });
    return validateSkillDraft(extractCodex(output));
  } catch (error) {
    cleanupUncertain ||= error?.processCleanupUncertain === true;
    throw error;
  } finally {
    if (!cleanupUncertain) await fs.rm(temp, { recursive: true, force: true });
  }
}
