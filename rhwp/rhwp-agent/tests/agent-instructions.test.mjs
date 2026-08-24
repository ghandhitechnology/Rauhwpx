import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AgentInstructionsStore,
  DEFAULT_AGENT_INSTRUCTIONS,
  MAX_AGENT_INSTRUCTIONS_CHARS,
  defaultAgentInstructionsRoot,
} from '../agent-instructions.mjs';

test('app instructions are created as a private standalone AGENTS.md', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  const store = await new AgentInstructionsStore({
    rootDir,
    now: () => '2026-08-24T00:00:00.000Z',
  }).init();
  const snapshot = store.snapshot();

  assert.equal(snapshot.fileName, 'AGENTS.md');
  assert.equal(snapshot.scope, 'rauhwpx-app');
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.content, DEFAULT_AGENT_INSTRUCTIONS);
  assert.equal(await fs.readFile(path.join(rootDir, 'AGENTS.md'), 'utf8'), DEFAULT_AGENT_INSTRUCTIONS);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(rootDir, 'AGENTS.md'))).mode & 0o777, 0o600);
  }
});

test('updates are newline-normalized and reject stale revisions', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const timestamps = ['2026-08-24T00:00:00.000Z', '2026-08-24T00:01:00.000Z'];
  const store = await new AgentInstructionsStore({ rootDir, now: () => timestamps.shift() }).init();

  const updated = await store.update('# 내 지시\r\n\r\n- 간결하게', { expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.equal(updated.content, '# 내 지시\n\n- 간결하게\n');
  assert.equal(updated.updatedAt, '2026-08-24T00:01:00.000Z');
  await assert.rejects(
    store.update('stale', { expectedRevision: 1 }),
    (error) => error?.code === 'INSTRUCTIONS_REVISION_CONFLICT',
  );
});

test('instruction size is bounded and platform roots stay outside project workspaces', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new AgentInstructionsStore({ rootDir }).init();
  await assert.rejects(
    store.update('x'.repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1), { expectedRevision: 1 }),
    (error) => error?.code === 'INSTRUCTIONS_TOO_LARGE',
  );

  assert.equal(
    defaultAgentInstructionsRoot({}, 'darwin', '/Users/example'),
    '/Users/example/Library/Application Support/rhwp/agent-instructions',
  );
  assert.equal(
    defaultAgentInstructionsRoot({ APPDATA: 'C:\\Users\\example\\AppData\\Roaming' }, 'win32', 'C:\\Users\\example'),
    'C:\\Users\\example\\AppData\\Roaming\\rhwp\\agent-instructions',
  );
});

test('prompt block carries the current app-scoped revision and content', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new AgentInstructionsStore({ rootDir }).init();
  const block = store.promptBlock();

  assert.match(block, /<app_agents_md trust="user-authored-instructions">/);
  assert.match(block, /"scope":"rauhwpx-app"/);
  assert.match(block, /"fileName":"AGENTS\.md"/);
});

test('a symlink cannot make app instructions read a file from another harness', async (t) => {
  if (process.platform === 'win32') return;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-foreign-instructions-'));
  t.after(() => Promise.all([
    fs.rm(rootDir, { recursive: true, force: true }),
    fs.rm(foreignDir, { recursive: true, force: true }),
  ]));
  const foreign = path.join(foreignDir, 'AGENTS.md');
  await fs.writeFile(foreign, 'outside app');
  await fs.symlink(foreign, path.join(rootDir, 'AGENTS.md'));

  await assert.rejects(
    new AgentInstructionsStore({ rootDir }).init(),
    (error) => error?.code === 'INSTRUCTIONS_FILE_INVALID',
  );
});
