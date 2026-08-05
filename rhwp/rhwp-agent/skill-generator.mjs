import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export async function generateSkillDraft(input) {
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
