import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRouterReady } from './agents/title.mjs';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'files'],
  properties: {
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$' },
    files: {
      type: 'array', minItems: 1, maxItems: 30,
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
    },
  },
};

function promptFor(input) {
  return `Create a concise, portable agent skill for rhwp. Return JSON matching the supplied schema. The files array must include SKILL.md. SKILL.md frontmatter must contain only name and description. Use lowercase hyphen-case. Write imperative instructions. Put detailed reusable material in references/, and deterministic code only when scripts are genuinely needed. Do not create README or changelog files.\n\nGoal: ${input.goal}\nShould trigger: ${input.triggerExamples || '(infer from goal)'}\nShould not trigger: ${input.nonTriggerExamples || '(none supplied)'}\nResource guidance: ${input.resourceNotes || 'instruction-only unless a resource is clearly necessary'}${input.existingSkill ? `\n\nImprove this existing skill:\n${input.existingSkill}` : ''}`;
}

function run(command, args, stdin, timeoutMs = 90_000, spawnOptions = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Skill generation timed out')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin.end(stdin);
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
  if (typeof name !== 'string' || !new RegExp(SCHEMA.properties.name.pattern).test(name)) {
    throw new Error('name must be lowercase hyphen-case');
  }
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
  if (!normalized.some((file) => /(^|\/)SKILL\.md$/.test(file.path))) {
    throw new Error('files must include SKILL.md');
  }
  return { name, files: normalized };
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
 * @param {{ useOpenRouter?: boolean, piManager?: any, openRouter?: any }} [deps]
 */
export async function generateSkillDraft(input, deps = {}) {
  if (openRouterReady(deps)) return draftViaOpenRouter(input, deps);
  const prompt = promptFor(input);
  if (input.agent === 'claude') {
    const output = await run('claude', [
      '-p', '--safe-mode', '--output-format', 'json', '--tools', '', '--disable-slash-commands',
      '--json-schema', JSON.stringify(SCHEMA), ...(input.model ? ['--model', input.model] : []),
    ], prompt);
    return extractClaude(output);
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-skill-schema-'));
  const schemaPath = path.join(temp, 'schema.json');
  try {
    await fs.writeFile(schemaPath, JSON.stringify(SCHEMA), 'utf8');
    const output = await run('codex', [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
      '--disable', 'image_generation', '--disable', 'multi_agent', '--disable', 'plugins',
      '--disable', 'skill_search',
      '--sandbox', 'read-only', '--output-schema', schemaPath,
      ...(input.model ? ['--model', input.model] : []), '-'
    ], prompt, 90_000, { cwd: temp });
    return extractCodex(output);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
