import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  takeEnvironmentScreenshot,
  capScreenshotDir,
  convertXwdToPng,
} from '../environment-screenshot.mjs';
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

test('convertXwdToPng reads standard XWD header offsets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-xwd-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const xwdPath = path.join(root, 'display.xwd');
  const pngPath = path.join(root, 'display.png');
  const xwd = Buffer.alloc(104);
  xwd.writeUInt32BE(100, 0); // header_size
  xwd.writeUInt32BE(7, 4); // file_version
  xwd.writeUInt32BE(2, 8); // pixmap_format: ZPixmap
  xwd.writeUInt32BE(24, 12); // pixmap_depth
  xwd.writeUInt32BE(1, 16); // pixmap_width
  xwd.writeUInt32BE(1, 20); // pixmap_height
  xwd.writeUInt32BE(0, 28); // byte_order: LSBFirst
  xwd.writeUInt32BE(32, 44); // bits_per_pixel
  xwd.writeUInt32BE(4, 48); // bytes_per_line
  Buffer.from([3, 2, 1, 0]).copy(xwd, 100);
  await fs.writeFile(xwdPath, xwd);

  await convertXwdToPng(xwdPath, pngPath);
  const png = await fs.readFile(pngPath);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1);
  assert.equal(png.readUInt32BE(20), 1);
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

test('takeEnvironmentScreenshot writes under workDir screens for insert_image', async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-env-shot-'));
  t.after(() => fs.rm(workDir, { recursive: true, force: true }));
  const result = await takeEnvironmentScreenshot({
    workDir,
    display: ':10',
    now: () => Date.UTC(2026, 7, 28, 3, 0, 0),
    capture: async ({ outputPath }) => {
      await fs.writeFile(outputPath, Buffer.from('png-bytes'));
    },
  });
  assert.equal(
    result.imagePath,
    path.join(workDir, '.rhwp-agent', 'screens', '2026-08-28T03-00-00-000Z.png'),
  );
  assert.equal(result.bytes, 9);
  assert.equal(result.image.mimeType, 'image/png');
  assert.equal(result.image.data, Buffer.from('png-bytes').toString('base64'));
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
