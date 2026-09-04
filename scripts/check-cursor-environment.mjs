import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8');
const environment = JSON.parse(read('.cursor/environment.json'));

const allowedTopLevel = new Set([
  'name',
  'user',
  'install',
  'start',
  'build',
  'image',
  'snapshot',
  'agentCanUpdateSnapshot',
  'repositoryDependencies',
  'disableAllMcpServers',
  'mcpServerAllowlist',
  'egressAllowlist',
  'egressMode',
  'chromeExecutablePath',
  'enable_testing',
  'ports',
  'terminals',
]);

assert.deepEqual(
  Object.keys(environment).filter((key) => !allowedTopLevel.has(key)),
  [],
  'environment.json contains a field outside the current Cursor schema',
);
assert.equal(environment.name, 'Rauhwpx Cloud development');
assert.equal(environment.user, 'node');
assert.ok(environment.build && typeof environment.build === 'object', 'build must be an object');
assert.equal(typeof environment.build.dockerfile, 'string', 'build.dockerfile is required');
assert.deepEqual(environment.build, { dockerfile: 'Dockerfile' });
assert.equal(environment.install, 'bash .cursor/install.sh');
assert.equal(environment.start, 'true', 'a start command is required so repository terminals launch');
assert.equal(environment.chromeExecutablePath, '/usr/bin/chromium');
assert.equal(environment.enable_testing, true);

assert.ok(Array.isArray(environment.ports) && environment.ports.length === 2);
assert.ok(environment.ports.every((entry) => (
  entry !== null
    && typeof entry === 'object'
    && Number.isInteger(entry.port)
    && entry.port >= 1
    && entry.port <= 65535
    && typeof entry.name === 'string'
    && Object.keys(entry).every((key) => key === 'name' || key === 'port')
)), 'Cursor ports must use the current object form');
assert.deepEqual(environment.ports.map(({ port }) => port).sort((a, b) => a - b), [5175, 7700]);

assert.ok(Array.isArray(environment.terminals) && environment.terminals.length === 2);
assert.ok(environment.terminals.every((terminal) => (
  terminal !== null
    && typeof terminal === 'object'
    && typeof terminal.name === 'string'
    && typeof terminal.command === 'string'
    && terminal.command.trim().length > 0
    && typeof terminal.description === 'string'
    && Object.keys(terminal).every((key) => ['name', 'command', 'description'].includes(key))
)), 'Cursor terminals must use supported object fields');
assert.deepEqual(
  environment.terminals.map(({ name, command }) => [name, command]),
  [
    ['agent-hub', 'bash .cursor/run-agent-hub.sh'],
    ['studio-dev', 'bash .cursor/run-studio.sh'],
  ],
);

const dockerfile = read('.cursor/Dockerfile');
assert.match(dockerfile, /^FROM node:24\.20\.0-bookworm$/m);
assert.match(dockerfile, /^ARG RUST_TOOLCHAIN=1\.93\.1$/m);
assert.match(dockerfile, /^ARG WASM_PACK_VERSION=0\.15\.0$/m);
assert.match(dockerfile, /^\s*chromium \\/m);
assert.match(dockerfile, /^\s*fonts-noto-cjk \\/m);
assert.doesNotMatch(dockerfile, /^\s*(?:ADD|COPY)\s/im, 'Cursor manages the repository checkout');

const rustToolchain = read('rhwp/rust-toolchain.toml');
assert.match(rustToolchain, /^channel = "1\.93\.1"$/m);
assert.match(rustToolchain, /^targets = \["wasm32-unknown-unknown"\]$/m);

const cloudPackage = JSON.parse(read('cloud/package.json'));
assert.equal(cloudPackage.engines.node, '>=24.7.0');

const install = read('.cursor/install.sh');
for (const command of [
  'npm ci --no-audit --no-fund',
  'npm --prefix cloud ci --no-audit --no-fund',
  'npm --prefix cloud/install/provider-runtime ci --no-audit --no-fund',
  'npm --prefix rhwp/rau-credits ci --no-audit --no-fund',
  'npm --prefix rhwp/rhwp-agent ci --no-audit --no-fund',
  'npm --prefix rhwp/rhwp-studio ci --no-audit --no-fund',
]) {
  assert.ok(install.includes(command), `install.sh must run: ${command}`);
}
assert.match(install, /cargo \+1\.93\.1 build --manifest-path rhwp\/Cargo\.toml --release --locked --bin rhwp/);
assert.match(install, /wasm-pack build rhwp --target web -- --locked/);

for (const script of [
  '.cursor/install.sh',
  '.cursor/run-agent-hub.sh',
  '.cursor/run-studio.sh',
]) {
  assert.notEqual(statSync(join(repoRoot, script)).mode & 0o111, 0, `${script} must be executable`);
}

const viteConfig = read('rhwp/rhwp-studio/vite.config.ts');
const hubServer = read('rhwp/rhwp-agent/server.mjs');
assert.match(viteConfig, /port:\s*7700/);
assert.match(hubServer, /RHWP_AGENT_PORT \?\? 5175/);
assert.match(read('.cursor/run-studio.sh'), /payload\.protocol\) === 5/);

console.log('Cursor Cloud environment contract is valid.');
