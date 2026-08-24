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
  const metadata = JSON.parse(await fs.readFile(path.join(rootDir, '.AGENTS.md.meta.json'), 'utf8'));
  assert.equal(metadata.revision, 1);
  assert.match(metadata.contentHash, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(rootDir, 'AGENTS.md'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(rootDir, '.AGENTS.md.meta.json'))).mode & 0o777, 0o600);
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

test('revision persists across restarts and keeps old drafts stale', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const timestamps = [
    '2026-08-24T00:00:00.000Z',
    '2026-08-24T00:01:00.000Z',
    '2026-08-24T00:02:00.000Z',
  ];
  const store = await new AgentInstructionsStore({ rootDir, now: () => timestamps.shift() }).init();
  await store.update('revision two', { expectedRevision: 1 });
  await store.update('revision three', { expectedRevision: 2 });

  const reopened = await new AgentInstructionsStore({ rootDir }).init();
  assert.equal(reopened.snapshot().revision, 3);
  assert.equal(reopened.snapshot().content, 'revision three\n');
  await assert.rejects(
    reopened.update('stale after restart', { expectedRevision: 1 }),
    (error) => error?.code === 'INSTRUCTIONS_REVISION_CONFLICT',
  );
});

test('corrupt revision metadata is repaired without reviving stale drafts', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new AgentInstructionsStore({ rootDir }).init();
  await store.update('revision two', { expectedRevision: 1 });
  const staleRevision = store.snapshot().revision;
  await fs.writeFile(path.join(rootDir, '.AGENTS.md.meta.json'), '{broken-json', 'utf8');

  const reopened = await new AgentInstructionsStore({ rootDir }).init();
  assert.ok(reopened.snapshot().revision > staleRevision);
  assert.equal(reopened.snapshot().content, 'revision two\n');
  await assert.rejects(
    reopened.update('stale after metadata repair', { expectedRevision: staleRevision }),
    (error) => error?.code === 'INSTRUCTIONS_REVISION_CONFLICT',
  );
  const repaired = JSON.parse(await fs.readFile(path.join(rootDir, '.AGENTS.md.meta.json'), 'utf8'));
  assert.equal(repaired.revision, reopened.snapshot().revision);
});

test('a symlinked revision sidecar is replaced without reading its target', async (t) => {
  if (process.platform === 'win32') return;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-foreign-metadata-'));
  t.after(() => Promise.all([
    fs.rm(rootDir, { recursive: true, force: true }),
    fs.rm(foreignDir, { recursive: true, force: true }),
  ]));
  await new AgentInstructionsStore({ rootDir }).init();
  const metadataPath = path.join(rootDir, '.AGENTS.md.meta.json');
  const foreignPath = path.join(foreignDir, 'metadata.json');
  await fs.writeFile(foreignPath, '{"foreign":true}\n');
  await fs.rm(metadataPath);
  await fs.symlink(foreignPath, metadataPath);

  const reopened = await new AgentInstructionsStore({ rootDir }).init();
  assert.ok(reopened.snapshot().revision > 1);
  assert.equal((await fs.lstat(metadataPath)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(foreignPath, 'utf8'), '{"foreign":true}\n');
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
  assert.equal(
    defaultAgentInstructionsRoot({ APPDATA: 'relative\\roaming' }, 'win32', 'C:\\Users\\example'),
    'C:\\Users\\example\\AppData\\Roaming\\rhwp\\agent-instructions',
  );
  assert.equal(
    defaultAgentInstructionsRoot({ XDG_DATA_HOME: '/srv/user-data' }, 'linux', '/home/example'),
    '/srv/user-data/rhwp/agent-instructions',
  );
  assert.equal(
    defaultAgentInstructionsRoot({ XDG_DATA_HOME: 'relative/data' }, 'linux', '/home/example'),
    '/home/example/.local/share/rhwp/agent-instructions',
  );
  assert.equal(
    defaultAgentInstructionsRoot({ RHWP_AGENT_INSTRUCTIONS_DIR: 'relative/override' }, 'linux', '/home/example'),
    '/home/example/.local/share/rhwp/agent-instructions',
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

async function createSymlinkSwapFs(filePath, foreignPath) {
  const racingFs = Object.create(fs);
  let swapped = false;
  let simulatedWindowsReparsePoint = false;
  racingFs.open = async (candidate, flags) => {
    if (candidate === filePath && !swapped) {
      swapped = true;
      await fs.rm(filePath, { force: true });
      try {
        await fs.symlink(foreignPath, filePath, process.platform === 'win32' ? 'file' : undefined);
      } catch (error) {
        if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
        // Some Windows runners disallow test symlink creation. Model the same
        // open-to-foreign/lstat-as-reparse state so the Windows branch remains covered.
        simulatedWindowsReparsePoint = true;
        return fs.open(foreignPath, flags);
      }
    }
    return fs.open(candidate, flags);
  };
  racingFs.lstat = async (candidate, options) => {
    if (candidate === filePath && simulatedWindowsReparsePoint) {
      return { isFile: () => false, isSymbolicLink: () => true };
    }
    return fs.lstat(candidate, options);
  };
  return racingFs;
}

test('POSIX safe open rejects a symlink replacement during loading', async (t) => {
  if (process.platform === 'win32') return;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-race-'));
  const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-foreign-instructions-race-'));
  t.after(() => Promise.all([
    fs.rm(rootDir, { recursive: true, force: true }),
    fs.rm(foreignDir, { recursive: true, force: true }),
  ]));
  const filePath = path.join(rootDir, 'AGENTS.md');
  const foreignPath = path.join(foreignDir, 'AGENTS.md');
  await fs.writeFile(filePath, 'inside app');
  await fs.writeFile(foreignPath, 'outside app');

  await assert.rejects(
    new AgentInstructionsStore({
      rootDir,
      platform: 'linux',
      fsApi: await createSymlinkSwapFs(filePath, foreignPath),
    }).init(),
    (error) => error?.code === 'INSTRUCTIONS_FILE_INVALID',
  );
});

test('Windows file-id validation rejects a symlink replacement during loading', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-race-'));
  const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-foreign-instructions-race-'));
  t.after(() => Promise.all([
    fs.rm(rootDir, { recursive: true, force: true }),
    fs.rm(foreignDir, { recursive: true, force: true }),
  ]));
  const filePath = path.join(rootDir, 'AGENTS.md');
  const foreignPath = path.join(foreignDir, 'AGENTS.md');
  await fs.writeFile(filePath, 'inside app');
  await fs.writeFile(foreignPath, 'outside app');

  const racingFs = await createSymlinkSwapFs(filePath, foreignPath);
  await assert.rejects(
    new AgentInstructionsStore({ rootDir, platform: 'win32', fsApi: racingFs }).init(),
    (error) => error?.code === 'INSTRUCTIONS_FILE_INVALID',
  );
});
