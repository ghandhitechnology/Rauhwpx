// Run over SSH inside the published worker image. Uses only its bundled sample.
// Default requires native Xvfb capture. --headless checks this script locally.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const runtimeRoot = process.env.RAUHWpx_PROOF_RUNTIME_ROOT || '/app';
const studioRoot = process.env.RAUHWpx_STUDIO_DIST || '/app/studio';
const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const require = createRequire(path.join(runtimeRoot, 'package.json'));
const { default: puppeteer } = await import(pathToFileURL(require.resolve('puppeteer-core')).href);
const { startStudioServer, applyDisplayInput, launchChromium } = await import(pathToFileURL(path.join(runtimeRoot, 'document-runtime/studio-harness.mjs')));
const { verifyDocumentShell } = await import(pathToFileURL(path.join(runtimeRoot, 'document-runtime/document-shell.mjs')));
const { createSessionDisplay } = await import(pathToFileURL(path.join(runtimeRoot, 'document-runtime/session-display.mjs')));
const headless = process.argv.includes('--headless');
const geometry = { width: 1280, height: 900 };
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-hosted-document-proof-'));
const marker = 'CLOUD_HOSTED_CLICK 한글 입력 확인';
const bootstrap = 'cloud-hosted-document-proof-'.padEnd(43, 'x');
const documentPath = path.join(studioRoot, 'samples/field-01.hwp');

function documentText(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(end >= 0, 'export must be an HWPX archive');
  let offset = bytes.readUInt32LE(end + 16);
  const sections = [];
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString();
    if (/^Contents\/section\d+\.xml$/.test(name)) {
      const local = bytes.readUInt32LE(offset + 42);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
      sections.push((bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(compressed) : compressed)
        .toString('utf8').replace(/<[^>]*>/g, ''));
    }
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  assert(sections.length, 'export must contain document sections');
  return sections.join('\n');
}

let browser;
let worker;
let display;
try {
  if (!headless) {
    display = createSessionDisplay({ workspace, ...geometry });
    const snapshot = await display.start();
    assert.equal(snapshot.status, 'ready', snapshot.lastError);
  }
  worker = await startStudioServer({ studioRoot, bootstrap, resources: new Map([['document', documentPath]]) });
  browser = await launchChromium(puppeteer, { chromiumPath, displayEnv: display?.environment, displayGeometry: geometry });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.goto(`${worker.origin}/document.html?cloudRuntime=1&bootstrap=${bootstrap}`);
  await page.waitForFunction(() => Boolean(window.rauhwpxCloudRuntime), { timeout: 60_000 });
  await page.evaluate(async ({ bootstrap, origin }) => window.rauhwpxCloudRuntime.loadDocument(bootstrap, {
    url: `${origin}/_runtime/resource/document?bootstrap=${bootstrap}`, name: 'field-01.hwp',
  }), { bootstrap, origin: worker.origin });
  await page.bringToFront();
  const layout = await verifyDocumentShell(page);
  assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })),
    { ...geometry, scale: 1 }, 'captured screen pixels must match input coordinates');
  const capture = async (name) => {
    const filename = path.join(workspace, `${name}.jpg`);
    if (headless) await page.screenshot({ path: filename, type: 'jpeg', quality: 90 });
    else await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'x11grab', '-framerate', '1', '-video_size', `${geometry.width}x${geometry.height}`,
        '-i', `${display.environment.DISPLAY}.0`, '-frames:v', '1', '-an', '-c:v', 'mjpeg', '-q:v', '2', filename],
      { env: { ...process.env, ...display.environment }, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Capture timed out')); }, 15_000);
      child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr)); });
    });
    return filename;
  };
  const before = await capture('before');
  const revision = () => page.evaluate(secret => window.rauhwpxCloudRuntime.status(secret).documentRevision, bootstrap);
  const initialRevision = await revision();
  const point = await page.$eval('#scroll-content canvas', node => {
    const box = node.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(Math.min(450, box.top + box.height / 2)) };
  });
  const pressed = { displayPressedKeys: new Set(), displayPressedButtons: new Set() };
  const dispatch = input => applyDisplayInput(page, input, pressed);
  for (const action of ['down', 'up']) await dispatch({ kind: 'pointer', action, button: 'left', ...point });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '문서 편집 입력');
  for (const [key, action] of [['Control', 'down'], ['End', 'down'], ['End', 'up'], ['Control', 'up'], ['Enter', 'down'], ['Enter', 'up']]) {
    await dispatch({ kind: 'key', action, key });
  }
  await dispatch({ kind: 'text', text: marker });
  assert(await revision() > initialRevision, 'native typing must change the document');
  const exportBase64 = await page.evaluate(async secret => {
    const api = window.rauhwpxCloudRuntime;
    const metadata = await api.prepareExport(secret, 'hwpx');
    const chunk = api.readExportChunk(secret, 0, 1024 * 1024);
    if (chunk.size !== metadata.size) throw new Error('Proof document exceeded export chunk');
    return chunk.dataBase64;
  }, bootstrap);
  const exported = Buffer.from(exportBase64, 'base64');
  assert.equal(documentText(exported).split(marker).length - 1, 1, 'native edit must persist exactly once');
  await fs.writeFile(path.join(workspace, 'edited.hwpx'), exported, { mode: 0o600 });
  const after = await capture('after');
  assert.notDeepEqual(await fs.readFile(before), await fs.readFile(after), 'Xvfb capture must show the edit');
  await verifyDocumentShell(page);
  console.log(JSON.stringify({ ok: true, capture: headless ? 'headless-local-check' : 'native-xvfb', marker, point,
    initialRevision, finalRevision: await revision(), layout, before, after, exportBytes: exported.length }));
} finally {
  await browser?.close().catch(() => {});
  await display?.stop().catch(() => {});
  if (worker) await new Promise(resolve => worker.server.close(resolve));
  // Retain only test artifacts for SSH download; deleting the disposable service
  // removes these files. No user document or provider credentials are used.
}
