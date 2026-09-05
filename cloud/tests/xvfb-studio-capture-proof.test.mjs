import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSessionDisplay } from '../document-runtime/session-display.mjs';
import { applyDisplayInput, launchChromium } from '../document-runtime/studio-harness.mjs';
import { DisplayFrameStore } from '../src/display-frame-store.mjs';

function commandAvailable(command, args = ['--version'], pattern = null) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5_000 });
  if (result.error) return false;
  return !pattern || pattern.test(`${result.stdout}\n${result.stderr}`);
}

const enabled = process.env.RAUHWpx_XVFB_CAPTURE_PROOF === '1';
const chromiumPath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate) => candidate && existsSync(candidate));
const skipReason = !enabled
  ? 'set RAUHWpx_XVFB_CAPTURE_PROOF=1 to run the real capture proof'
  : !commandAvailable('Xvfb', ['-help'])
    ? 'Xvfb is unavailable'
    : !commandAvailable('xauth', ['-V'])
      ? 'xauth is unavailable'
      : !commandAvailable('ffmpeg', ['-hide_banner', '-devices'], /x11grab/)
        ? 'ffmpeg with x11grab is unavailable'
        : !chromiumPath || !commandAvailable(chromiumPath)
          ? 'Chromium is unavailable'
          : false;

function run(command, args, { env = process.env, input = null, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited ${signal ?? code}: ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

async function captureJpeg(environment, { width, height }) {
  return run('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'x11grab',
    '-framerate', '1',
    '-video_size', `${width}x${height}`,
    '-i', `${environment.DISPLAY}.0`,
    '-frames:v', '1',
    '-an',
    '-c:v', 'mjpeg',
    '-q:v', '2',
    '-f', 'image2pipe',
    'pipe:1',
  ], { env: { ...process.env, ...environment } });
}

async function decodeJpeg(jpeg) {
  return run('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'image2pipe',
    '-c:v', 'mjpeg',
    '-i', 'pipe:0',
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ], { input: jpeg });
}

function variance(bytes) {
  let sum = 0;
  let squareSum = 0;
  for (const value of bytes) {
    sum += value;
    squareSum += value * value;
  }
  const mean = sum / bytes.length;
  return (squareSum / bytes.length) - (mean * mean);
}

function meanAbsoluteDifference(first, second) {
  assert.equal(first.length, second.length);
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference += Math.abs(first[index] - second[index]);
  }
  return difference / first.length;
}

test('real Xvfb captures aligned Studio pixels and applies Korean keyboard input', {
  skip: !enabled ? skipReason : false,
  timeout: 45_000,
}, async (t) => {
  assert.equal(skipReason, false, `Capture proof prerequisites missing: ${skipReason}`);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-xvfb-capture-proof-'));
  const geometry = { width: 960, height: 640 };
  const display = createSessionDisplay({ workspace, ...geometry });
  let browser;
  t.after(async () => {
    await browser?.close().catch(() => {});
    await display.stop().catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const snapshot = await display.start();
  assert.equal(snapshot.status, 'ready', snapshot.lastError);
  const baselineJpeg = await captureJpeg(display.environment, geometry);

  const { default: puppeteer } = await import('puppeteer-core');
  browser = await launchChromium(puppeteer, {
    chromiumPath,
    displayEnv: display.environment,
    displayGeometry: snapshot,
  });
  const pages = await browser.pages();
  const page = pages[0] ?? await browser.newPage();
  await page.setContent(`<!doctype html>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { display: grid; grid-template-columns: 3fr 2fr; background: #f4efe3; color: #17211d; font-family: sans-serif; }
      main { padding: 72px; border-right: 18px solid #e84b32; }
      h1 { max-width: 600px; margin: 0; font-size: 94px; line-height: .9; letter-spacing: -6px; }
      aside { background: repeating-linear-gradient(135deg, #123b35 0 32px, #d8b84c 32px 64px); }
      textarea { position: absolute; left: 72px; top: 360px; width: 420px; height: 70px; border: 4px solid #ff00ff; background: white; font-size: 18px; }
    </style>
    <main><h1>Studio capture proof</h1><textarea aria-label="Cloud document input"></textarea></main><aside></aside>`, { waitUntil: 'load' });
  await page.bringToFront();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const capturedJpeg = await captureJpeg(display.environment, geometry);
  assert.deepEqual([...capturedJpeg.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...capturedJpeg.subarray(-2)], [0xff, 0xd9]);
  assert.notDeepEqual(capturedJpeg, baselineJpeg);
  const frameStore = new DisplayFrameStore();
  const stream = frameStore.openStream({
    sessionId: 'xvfb-proof', workerId: 'proof-worker', ...geometry,
  });
  const retained = frameStore.publishFrame({
    sessionId: 'xvfb-proof',
    workerId: 'proof-worker',
    streamId: stream.streamId,
    sequence: 1,
    capturedAt: new Date().toISOString(),
    bytes: capturedJpeg,
  });
  assert.deepEqual({ width: retained.width, height: retained.height }, geometry);

  const [baseline, captured] = await Promise.all([
    decodeJpeg(baselineJpeg),
    decodeJpeg(capturedJpeg),
  ]);
  assert.equal(captured.length, geometry.width * geometry.height * 3);
  assert.ok(variance(captured) > 500, 'captured surface must contain nontrivial visual variance');
  assert.ok(meanAbsoluteDifference(baseline, captured) > 20, 'captured surface must differ from blank Xvfb');

  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }));
  assert.deepEqual(viewport, { ...geometry, scale: 1 }, 'screen pixels and viewport coordinates must match');
  const border = (362 * geometry.width + 80) * 3;
  assert.ok(captured[border] > 180 && captured[border + 1] < 90 && captured[border + 2] > 180,
    'the input border must occupy its expected Xvfb screen coordinates, without browser chrome offsets');
  const pressed = { displayPressedKeys: new Set(), displayPressedButtons: new Set() };
  const dispatch = (input) => applyDisplayInput(page, input, pressed);
  await dispatch({ kind: 'pointer', action: 'down', button: 'left', x: 100, y: 390 });
  await dispatch({ kind: 'pointer', action: 'up', button: 'left', x: 100, y: 390 });
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', 'clicks must hit the visible input');
  const text = '구름 공동편집 검증 PR188_MANUAL_KOREAN';
  await dispatch({ kind: 'text', text });
  await dispatch({ kind: 'key', action: 'down', key: 'End' });
  await dispatch({ kind: 'key', action: 'up', key: 'End' });
  await dispatch({ kind: 'text', text: ' 끝' });
  assert.equal(await page.$eval('textarea', (node) => node.value), `${text} 끝`);
  await page.evaluate(() => {
    globalThis.remoteClicks = [];
    document.querySelector('textarea').addEventListener('dblclick', (event) => globalThis.remoteClicks.push(event.detail));
  });
  for (const clickCount of [1, 2]) {
    await dispatch({ kind: 'pointer', action: 'down', button: 'left', x: 100, y: 390, clickCount });
    await dispatch({ kind: 'pointer', action: 'move', x: 101, y: 390 });
    await dispatch({ kind: 'pointer', action: 'up', button: 'left', x: 101, y: 390, clickCount });
  }
  assert.deepEqual(await page.evaluate(() => globalThis.remoteClicks), [2], 'remote double click must reach the visible editor');
  assert.equal(pressed.displayPressedKeys.size, 0);
  assert.equal(pressed.displayPressedButtons.size, 0);
});
