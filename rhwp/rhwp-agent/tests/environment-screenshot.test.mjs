import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  takeEnvironmentScreenshot,
  capScreenshotDir,
} from '../environment-screenshot.mjs';
import { createSessionDisplay } from '../../../cloud/document-runtime/session-display.mjs';
import { sessionDisplayReady, buildCodexArgv } from '../agents/codex.mjs';
import { filterToolDefinitions, TOOL_DEFINITIONS, TOOL_CLASSIFICATIONS } from '../tools.mjs';

test('environment_screenshot is classified and on the direct profile', () => {
  assert.equal(TOOL_CLASSIFICATIONS.environment_screenshot, 'environment');
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.name === 'environment_screenshot'));
  const direct = new Set(filterToolDefinitions('direct').map((tool) => tool.name));
  assert.ok(direct.has('environment_screenshot'));
});

test('capScreenshotDir deletes oldest files past the bound', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-screens-cap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 5; i += 1) {
    const file = path.join(root, `shot-${i}.png`);
    await fs.writeFile(file, Buffer.alloc(100 + i));
    await fs.utimes(file, new Date(1_000_000 + i * 1_000), new Date(1_000_000 + i * 1_000));
  }
  const result = await capScreenshotDir(root, { maxFiles: 2, maxBytes: 10_000 });
  assert.equal(result.kept, 2);
  assert.deepEqual(result.deleted, ['shot-0.png', 'shot-1.png', 'shot-2.png']);
});

test('takeEnvironmentScreenshot refuses without DISPLAY', async () => {
  const previous = process.env.DISPLAY;
  const previousFlag = process.env.RAUHWpx_SESSION_DISPLAY;
  delete process.env.DISPLAY;
  delete process.env.RAUHWpx_SESSION_DISPLAY;
  try {
    await assert.rejects(
      () => takeEnvironmentScreenshot({ workDir: os.tmpdir() }),
      { code: 'ENVIRONMENT_DISPLAY_UNAVAILABLE' },
    );
  } finally {
    if (previous !== undefined) process.env.DISPLAY = previous;
    else delete process.env.DISPLAY;
    if (previousFlag !== undefined) process.env.RAUHWpx_SESSION_DISPLAY = previousFlag;
    else delete process.env.RAUHWpx_SESSION_DISPLAY;
  }
});

test('live environment_screenshot writes a PNG under workDir for insert_image', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-env-shot-ws-'));
  const workDir = path.join(workspace, 'work');
  await fs.mkdir(workDir, { recursive: true });
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const display = createSessionDisplay({
    workspace,
    baseDisplay: 75,
    startWindowManager: false,
  });
  const snapshot = await display.start();
  t.after(async () => { await display.stop(); });
  assert.equal(snapshot.status, 'ready', snapshot.lastError);

  const started = Date.now();
  const result = await takeEnvironmentScreenshot({
    workDir,
    display: snapshot.display,
    authFile: path.join(workspace, 'home', '.Xauthority'),
  });
  const elapsed = Date.now() - started;
  assert.ok(result.imagePath.startsWith(path.join(workDir, '.rhwp-agent', 'screens')));
  assert.match(result.imagePath, /\.png$/);
  assert.ok(result.bytes > 0);
  assert.equal(result.image.mimeType, 'image/png');
  assert.ok(result.image.data.length > 32);
  assert.ok(elapsed < 2_000, `1280x800 capture under 2s budget, got ${elapsed}ms`);
  const stat = await fs.stat(result.imagePath);
  assert.ok(stat.isFile());
});

test('Codex disables computer use on desktop and enables it when session display is ready', () => {
  const desktop = buildCodexArgv({
    hubPort: 9,
    token: 't',
    rootDir: '/tmp',
    permissionProfile: 'unrestricted',
    sessionDisplay: 'stopped',
  }, null);
  assert.ok(desktop.includes('computer_use'));
  assert.ok(desktop.includes('browser_use'));

  const cloud = buildCodexArgv({
    hubPort: 9,
    token: 't',
    rootDir: '/tmp',
    permissionProfile: 'unrestricted',
    sessionDisplay: 'ready',
  }, null);
  assert.equal(cloud.includes('computer_use'), false);
  assert.equal(cloud.includes('browser_use'), false);
  assert.equal(sessionDisplayReady({ sessionDisplay: 'ready' }), true);
  assert.equal(sessionDisplayReady({}, { RAUHWpx_SESSION_DISPLAY: 'ready' }), true);
  assert.equal(sessionDisplayReady({}, { RAUHWpx_SESSION_DISPLAY: 'error' }), false);
  assert.equal(sessionDisplayReady({}, {}), false);
});
