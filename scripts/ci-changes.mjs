import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const groups = ['packages', 'sessions', 'app', 'browser', 'npm', 'rustAudit', 'engine'];

// Unknown code/configuration runs every check. Only known documentation is free.
export function selectChecks(paths) {
  const selected = Object.fromEntries(groups.map((name) => [name, false]));
  const enable = (...names) => names.forEach((name) => { selected[name] = true; });
  for (const file of paths) {
    if (/^(?:docs|\.audit|rhwp\/docs)\//.test(file) || /(?:^|\/)(?:README|CONTRIBUTING|CHANGELOG|SECURITY|AGENTS|CLAUDE|LICENSE)(?:\.[^/]+|-APACHE|-MIT)?$/.test(file)) continue;
    if (/^rhwp\/(?:samples|pdf|pdf-large)\//.test(file)) {
      enable('engine', 'browser');
    } else if (/^rhwp\/(?:src|tests|fuzz|benches)\//.test(file)) {
      enable('engine', 'browser');
      if (/^rhwp\/src\/(?:main\.rs|atomic_file\.rs)/.test(file)) enable('packages');
    } else if (/^rhwp\/(?:Cargo\.(?:toml|lock)|\.cargo\/|\.config\/|build\.rs)/.test(file)) {
      enable('engine', 'rustAudit', 'browser');
      if (file !== 'rhwp/Cargo.lock') enable('packages');
    } else if (/^rhwp\/rhwp-agent\//.test(file)) {
      enable('app', 'sessions');
      if (/package(?:-lock)?\.json$/.test(file)) enable('npm');
    } else if (/^rhwp\/rhwp-studio\//.test(file)) {
      enable('app', 'browser');
      if (/\/tests\/desktop-/.test(file)) enable('sessions');
      if (/\/(?:package(?:-lock)?\.json|vite[^/]*\.[cm]?ts|vite[^/]*\.mjs)$/.test(file)) enable('packages', 'npm');
    } else if (/^desktop\//.test(file)) {
      enable('packages', 'sessions', 'app');
    } else if (/^rhwp\/(?:rau-credits|rhwp-shared|rhwp-chrome|rhwp-firefox|rhwp-safari)\//.test(file)) {
      enable('app');
      if (/package(?:-lock)?\.json$/.test(file)) enable('npm');
      if (file.startsWith('rhwp/rhwp-shared/')) enable('browser');
      if (file === 'rhwp/rau-credits/catalog.mjs') enable('browser', 'packages');
    } else if (/^build\//.test(file)) {
      enable('packages');
    } else {
      enable(...groups);
    }
  }
  return selected;
}

export function changedPaths(event, git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) {
  const base = event.pull_request?.base.sha ?? event.before;
  const head = event.pull_request?.head.sha ?? event.after;
  if (!head || !base || /^0+$/.test(base)) return ['<full-check>'];
  if (![base, head].every((sha) => /^[0-9a-f]{40,64}$/.test(sha))) throw new Error('Invalid event commit SHA');
  // Disable rename detection so moving code into a docs directory still checks its deletion.
  return git(['diff', '--name-only', '--no-renames', '-z', base, head, '--']).split('\0').filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const checks = selectChecks(changedPaths(event));
  for (const [name, enabled] of Object.entries(checks)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${enabled}\n`);
  }
  console.log(checks);
}
