import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = Object.freeze([
  'cloud/src',
  'cloud/install',
  'desktop',
  'rhwp/rhwp-agent/agents',
  'rhwp/rhwp-agent/server.mjs',
  'rhwp/rhwp-agent/style-calibrator.mjs',
  'rhwp/rhwp-agent/cli-setup-manager.mjs',
  'rhwp/rhwp-studio/src/agent',
  'rhwp/rhwp-studio/src/cloud',
  'rhwp/rhwp-studio/src/agent',
]);
const ALLOWED_BOUNDARY_TESTS = new Set([
  'tests/desktop-provider-auth.test.mjs',
]);
const ALLOWED_COMPATIBILITY_FILES = new Set([
  'rhwp/rhwp-studio/src/agent/models.ts',
  'rhwp/rhwp-studio/src/agent/types.ts',
]);

// These are provider identifiers and provider-specific wiring, rather than
// generic editor cursors or ordinary uses of the Rauhwpx product name.
const FORBIDDEN = Object.freeze([
  /\bgrok\b/i,
  /\bopenCode\b/i,
  /\bopencode\b/i,
  /cursor-agent/i,
  /CURSOR_API_KEY/,
  /XAI_API_KEY/,
  /provider-cursor/i,
  /provider-grok/i,
  /provider-opencode/i,
  /(?:^|[^a-z])(?:RAU_SECRET_ID|RAU_LOCKED_MODELS|RAU_DEFAULT_MODEL_ID)(?:[^a-z]|$)/,
  /(?:agentName|agent|provider)\s*[:=]\s*['"]rau['"]/i,
  /['"]rau['"]\s*:\s*(?:create|new|\{)/i,
]);

function trackedFiles({ run = spawnSync } = {}) {
  const result = run('git', ['ls-files', '--', ...ROOTS], { encoding: 'utf8' });
  if (result.status !== 0) throw result.error ?? new Error(result.stderr || 'git ls-files failed');
  return result.stdout.trim() ? result.stdout.trim().split('\n') : [];
}

export function findProviderSurfaceViolations({ run = spawnSync, read = readFileSync } = {}) {
  const violations = [];
  for (const file of trackedFiles({ run })) {
    if (!existsSync(file)) continue;
    if (/provider-(?:grok|cursor|opencode)/i.test(path.basename(file))) {
      violations.push({ file, pattern: 'unsupported provider asset path' });
      continue;
    }
    if (ALLOWED_BOUNDARY_TESTS.has(file)) continue;
    if (ALLOWED_COMPATIBILITY_FILES.has(file)) continue;
    if (file === 'scripts/check-provider-surface.mjs') continue;
    if (path.basename(file).toLowerCase().startsWith('readme')) continue;
    if (/^(?:package-lock|npm-shrinkwrap)\.json$/i.test(path.basename(file))) continue;
    if (!/\.(?:c?m?js|ts|tsx|json|sh|css|html)$/i.test(file)) continue;
    const text = read(file, 'utf8');
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) violations.push({ file, pattern: pattern.source });
    }
  }
  return violations;
}

export function checkProviderSurface(options = {}) {
  const violations = findProviderSurfaceViolations(options);
  if (violations.length) {
    const detail = violations.map(({ file, pattern }) => `- ${file}: ${pattern}`).join('\n');
    throw new Error(`Unsupported provider implementation remains:\n${detail}`);
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkProviderSurface();
  console.log(`Provider surface is limited to Claude, Codex, and Pi across ${ROOTS.length} implementation roots.`);
}
