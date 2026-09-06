import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { CloudInputQueue } from '../../../desktop/cloud-input-queue.mjs';
import { applyDisplayInput, startStudioServer } from '../../../cloud/document-runtime/studio-harness.mjs';
import { verifyDocumentShell } from '../../../cloud/document-runtime/document-shell.mjs';

// Use the published worker shell and real document engine. Pointer/keyboard
// events travel from the production viewer through its normal input queue.
// Only network transport is local; document loading and exported edits are real.
const studio = resolve(import.meta.dirname, '..');
const studioRoot = process.env.RAUHWpx_STUDIO_DIST || resolve(studio, 'dist');
const artifacts = resolve(studio, 'sidebar-preview/artifacts/cloud-document');
const executablePath = [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(candidate => candidate && existsSync(candidate));
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable');
assert(existsSync(resolve(studioRoot, 'index.html')),
  'Build Studio with VITE_RHWP_CLOUD_RUNTIME=1 before running e2e:cloud-document');
await mkdir(artifacts, { recursive: true });
const bootstrap = 'cloud-document-editing-proof-'.padEnd(43, 'x');
const resources = new Map([['document', resolve(studio, 'public/samples/field-01.hwp')]]);
function documentText(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(end >= 0, 'export is an HWPX ZIP archive');
  let offset = bytes.readUInt32LE(end + 16);
  const sections = [];
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString();
    if (/^Contents\/section\d+\.xml$/.test(name)) {
      const local = bytes.readUInt32LE(offset + 42);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const content = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
      sections.push((bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(content) : content)
        .toString('utf8').replace(/<[^>]*>/g, ''));
    }
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  assert(sections.length > 0, 'export contains document sections');
  return sections.join('\n');
}
const worker = await startStudioServer({ studioRoot, resources, bootstrap });
const viewerServer = await createServer({
  configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false }, logLevel: 'error',
  plugins: [{ name: 'cloud-document-proof', configureServer(server) {
    server.middlewares.use('/cloud-document-proof', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    });
  } }],
});
let browser;
let queue;
try {
  await viewerServer.listen();
  browser = await puppeteer.launch({ executablePath, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const remote = await browser.newPage();
  await remote.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await remote.goto(`${worker.origin}/document.html?cloudRuntime=1&bootstrap=${bootstrap}`);
  await remote.waitForFunction(() => Boolean(window.rauhwpxCloudRuntime), { timeout: 30_000 });
  await remote.evaluate(async ({ bootstrap, origin }) => {
    await window.rauhwpxCloudRuntime.loadDocument(bootstrap, {
      url: `${origin}/_runtime/resource/document?bootstrap=${bootstrap}`,
      name: 'field-01.hwp',
    });
  }, { bootstrap, origin: worker.origin });
  await verifyDocumentShell(remote);
  const local = await browser.newPage();
  const errors = [];
  local.on('pageerror', error => errors.push(error.message));
  let sequence = 0;
  const publishFrame = async () => {
    const bytes = [...await remote.screenshot({ type: 'jpeg', quality: 90 })];
    await local.evaluate(({ bytes, sequence }) => window.receiveFrame({
      kind: 'frame', sessionId: 'real-document', streamId: 'real-stream', sequence,
      width: 1280, height: 900, bytes: new Uint8Array(bytes),
    }), { bytes, sequence: ++sequence });
  };
  const pressed = { displayPressedKeys: new Set(), displayPressedButtons: new Set() };
  const batches = [];
  queue = new CloudInputQueue(async (_streamId, events) => {
    await delay(80);
    batches.push(events);
    for (const event of events) await applyDisplayInput(remote, event, pressed);
    await publishFrame();
  }, () => 32);
  await local.exposeFunction('remoteInput', event => queue.enqueue('real-stream', event));
  const origin = `http://127.0.0.1:${viewerServer.httpServer.address().port}`;
  await local.goto(`${origin}/cloud-document-proof`);
  await local.evaluate(async () => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/src/styles/cloud-workspace.css';
    document.head.append(css);
    const style = document.createElement('style');
    style.textContent = `:root { --doc-workspace:#eceeed; --ui-text:#242625;
      --ui-text-secondary:#696d6b; --ui-border:#d8dbd9; --ui-surface:#fff;
      --ui-chrome-tool:#fff; --ui-hover:#f1f2f1; --focus-ring:#888;
      --font-size-sm:12px; --radius-sm:4px }
      * { box-sizing:border-box } body { margin:0; height:100vh; font-family:sans-serif }
      #workspace-stack { height:100%; width:100%; position:relative }`;
    document.head.append(style);
    document.body.innerHTML = '<main id="workspace-stack"></main>';
    window.pendingInputs = 0;
    window.inputErrors = [];
    const { createCloudWorkspace } = await import('/src/ui/cloud-workspace.ts');
    window.workspace = createCloudWorkspace({ display: {
      async openDisplay(_sessionId, onEvent) {
        window.receiveFrame = onEvent;
        return { capability: { kind:'available', width:1280, height:900, inputBatchSize:32 },
          async sendInput(event) {
            window.pendingInputs++;
            try { await window.remoteInput(event); }
            catch (error) { window.inputErrors.push(String(error)); throw error; }
            finally { window.pendingInputs--; }
          }, async close() {} };
      },
    } });
    document.querySelector('main').append(window.workspace.root);
    window.workspace.setContext({ visible:true, session:{ kind:'running', sessionId:'real-document' } });
  });
  await publishFrame();
  await local.waitForSelector('#cloud-workspace[data-display-state="live"]');
  const settle = async () => {
    await local.waitForFunction(() => window.pendingInputs === 0);
    assert.deepEqual(await local.evaluate(() => window.inputErrors), []);
  };
  const exportDocument = () => remote.evaluate(async (bootstrap) => {
    const api = window.rauhwpxCloudRuntime;
    const metadata = await api.prepareExport(bootstrap, 'hwpx');
    let base64 = '';
    // These small documents fit into a single export chunk.
    const chunk = api.readExportChunk(bootstrap, 0, 1024 * 1024);
    if (chunk.size !== metadata.size) throw new Error('Proof document exceeded export chunk');
    base64 = chunk.dataBase64;
    return { base64, revision:api.status(bootstrap).documentRevision };
  }, bootstrap);
  const initial = await exportDocument();
  for (const [width, height, dpr] of [[1280,900,1], [640,900,2], [390,700,2]]) {
    await local.setViewport({ width, height, deviceScaleFactor:dpr });
    await local.waitForFunction(() => {
      const frame = document.querySelector('.cloud-workspace-canvas').getBoundingClientRect();
      return frame.width > 0 && frame.right <= innerWidth && frame.bottom <= innerHeight;
    });
    // Focus is earned by clicking the streamed page, never by calling the
    // worker's input handler or focusing its hidden textarea from the test.
    const point = await remote.$eval('#scroll-content canvas', node => {
      const r = node.getBoundingClientRect();
      return { x:r.left + r.width / 2, y:Math.min(450, r.top + r.height / 2) };
    });
    const fitted = await local.$eval('.cloud-workspace-canvas', (node, point) => {
      const r = node.getBoundingClientRect();
      return { x:r.left + point.x * r.width / 1280, y:r.top + point.y * r.height / 900 };
    }, point);
    await local.mouse.click(fitted.x, fitted.y);
    await settle();
    assert.equal(await remote.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      '문서 편집 입력', 'click on the streamed document focuses the real editor');
    await local.keyboard.down('Control');
    await local.keyboard.press('End');
    await local.keyboard.up('Control');
    await local.keyboard.press('Enter');
    const marker = `CLOUD_CLICK_${width} 한글 입력 확인`;
    await local.keyboard.sendCharacter(marker);
    await settle();
    const exported = await exportDocument();
    assert(exported.revision > initial.revision, 'remote typing changes the shared document revision');
    const text = documentText(exported.base64);
    assert.equal(text.split(marker).length - 1, 1, 'typed text persists exactly once in the exported document');
    await local.screenshot({ path:resolve(artifacts, `edited-${width}.png`) });
    console.log(`PASS streamed document click and Korean typing at ${width}x${height}, DPR ${dpr}`);
  }
  const final = await exportDocument();
  await writeFile(resolve(artifacts, 'edited-document.hwpx'), Buffer.from(final.base64, 'base64'));
  resources.set('edited', resolve(artifacts, 'edited-document.hwpx'));
  await remote.evaluate(async ({ bootstrap, origin }) => {
    await window.rauhwpxCloudRuntime.loadDocument(bootstrap, {
      url:`${origin}/_runtime/resource/edited?bootstrap=${bootstrap}`, name:'edited-document.hwpx',
    });
  }, { bootstrap, origin:worker.origin });
  const reopened = documentText((await exportDocument()).base64);
  for (const width of [1280,640,390]) assert.equal(reopened.split(`CLOUD_CLICK_${width} 한글 입력 확인`).length - 1, 1);
  await verifyDocumentShell(remote);
  await remote.screenshot({ path:resolve(artifacts, 'worker-document-only.png') });
  assert.equal(pressed.displayPressedButtons.size, 0);
  assert.equal(pressed.displayPressedKeys.size, 0);
  assert(batches.some(events => events.some(event => event.action === 'down')
    && events.some(event => event.action === 'up')), 'click transitions reach the real worker in one batch');
  assert.deepEqual(errors, []);
  console.log('PASS all typed edits survive document export/reopen; document-only shell remains usable');
} finally {
  await queue?.close().catch(() => {});
  await browser?.close();
  await viewerServer.close();
  await new Promise(resolve => worker.server.close(resolve));
}
