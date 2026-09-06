import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { CloudInputQueue } from '../../../desktop/cloud-input-queue.mjs';
import { applyDisplayInput } from '../../../cloud/document-runtime/studio-harness.mjs';

// Exercise production viewer, transport batching and worker input with real browser events.
// Only the frame transport and network latency are fixtures; no WASM or hosted account is needed.
const studio = resolve(import.meta.dirname, '..');
const artifacts = resolve(studio, 'sidebar-preview/artifacts/cloud-display');
const executablePath = [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable');
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false }, logLevel: 'error',
  plugins: [{ name: 'cloud-display-check', configureServer(server) {
    server.middlewares.use('/cloud-display-check', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    });
  } }],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
let workerBrowser;
let queue;
try {
  const launchOptions = { executablePath, headless: true, protocolTimeout: 10000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] };
  browser = await puppeteer.launch(launchOptions);
  workerBrowser = await puppeteer.launch(launchOptions);
  const remote = await workerBrowser.newPage();
  await remote.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await remote.setContent(`<!doctype html><style>
    * { box-sizing: border-box } body { margin:0; background:#e5e7eb; font:18px sans-serif }
    header { height:54px; padding:16px 50px; background:#fff; border-bottom:1px solid #aaa }
    article { margin:24px auto; padding:50px; width:760px; height:665px; background:white; box-shadow:0 2px 6px #aaa }
    h1 { font-size:30px } p { line-height:1.8; color:#52606d }
    button { position:absolute; width:24px; height:24px; border:1px solid #175e40; padding:0; border-radius:4px; background:#d8f3e5 }
    textarea { position:absolute; left:350px; top:320px; width:580px; height:100px; font:20px sans-serif }
  </style><header>Cloud document · page navigation and pointer accuracy</header>
  <article><h1>Cloud workspace interaction check</h1><p>The complete remote screen stays visible.<br>Green targets verify clicks at every edge and across the page.</p></article>
  <textarea>Drag across these words to select text reliably.</textarea>`);
  await remote.evaluate(() => {
    window.hits = [];
    window.doubleClicks = [];
    for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) {
      const button = document.createElement('button');
      button.id = `target-${row * 5 + col}`;
      button.textContent = String(row * 5 + col + 1);
      button.style.left = `${col * 312 + 4}px`;
      button.style.top = `${row * 192 + 4}px`;
      button.addEventListener('click', () => window.hits.push(button.id));
      button.addEventListener('dblclick', () => window.doubleClicks.push(button.id));
      document.body.append(button);
    }
  });
  const frame = [...await remote.screenshot({ type: 'jpeg', quality: 85 })];
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const pressed = { displayPressedKeys: new Set(), displayPressedButtons: new Set() };
  const inputBatches = [];
  let latencyMs = 80;
  queue = new CloudInputQueue(async (_streamId, events) => {
    inputBatches.push(events);
    await delay(latencyMs);
    for (const event of events) await applyDisplayInput(remote, event, pressed);
  }, () => 32);
  await page.exposeFunction('remoteInput', (event) => queue.enqueue('test-stream', event));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${origin}/cloud-display-check`);
  await page.evaluate(async (frame) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/src/styles/cloud-workspace.css'; document.head.append(css);
    const style = document.createElement('style');
    style.textContent = `:root { --doc-workspace:#e5e7eb; --ui-text:#17211d; --ui-text-secondary:#49545d; --ui-border:#bfc6cc; --ui-chrome-tool:#fff; --ui-surface:#fff; --ui-hover:#e2ebe6; --focus-ring:#25855c; --font-size-sm:12px; --radius-sm:4px; --ag-sidebar-width:360px }
      * { box-sizing:border-box } body { margin:0; height:100vh; display:flex; font-family:sans-serif }
      aside { position:absolute; right:0; top:0; bottom:0; width:var(--ag-sidebar-width); padding:24px; background:#fafafa; border-left:1px solid #ccc }
      body:not(.ag-sidebar-open) aside { display:none }
      @media(max-width:767px) { aside { display:none } }`;
    document.head.append(style);
    document.body.className = 'ag-sidebar-open';
    document.body.innerHTML = '<main id="workspace-stack"></main><aside><h3>Cloud conversation</h3><p>The viewer fits beside this sidebar.</p></aside>';
    const { createCloudWorkspace } = await import('/src/ui/cloud-workspace.ts');
    window.pendingInputs = 0;
    window.inputErrors = [];
    let listener;
    const workspace = createCloudWorkspace({ display: { async openDisplay(_sessionId, onEvent) {
      listener = onEvent;
      return { capability: { kind:'available', width:1280, height:800, inputBatchSize:32 },
        async sendInput(event) {
          window.pendingInputs++;
          try { await window.remoteInput(event); } catch (error) { window.inputErrors.push(String(error)); throw error; }
          finally { window.pendingInputs--; }
        }, async close() {} };
    } } });
    window.__displayTestWorkspace = workspace;
    document.querySelector('main').append(workspace.root);
    workspace.setContext({ visible:true, session:{ kind:'running', sessionId:'test-session' } });
    await Promise.resolve();
    listener({ kind:'frame', sessionId:'test-session', streamId:'test-stream', sequence:1,
      width:1280, height:800, bytes:new Uint8Array(frame) });
  }, frame);
  await page.waitForSelector('#cloud-workspace[data-display-state="live"]');
  const settle = async () => {
    await delay(60); // Flush the viewer's coalesced movement as well as queued requests.
    await page.waitForFunction(() => window.pendingInputs === 0);
    assert.deepEqual(await page.evaluate(() => window.inputErrors), []);
  };
  const point = async (x, y) => page.$eval('.cloud-workspace-canvas', (node, { x, y }) => {
    const r = node.getBoundingClientRect();
    return { x:r.left + x * r.width / 1280, y:r.top + y * r.height / 800 };
  }, { x, y });
  const checkFit = async () => {
    await page.waitForFunction(() => {
      const viewport = document.querySelector('.cloud-workspace-viewport');
      const r = document.querySelector('.cloud-workspace-canvas').getBoundingClientRect();
      const v = viewport.getBoundingClientRect();
      const style = getComputedStyle(viewport);
      const availableWidth = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const availableHeight = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const expectedWidth = Math.floor(1280 * Math.min(1, availableWidth / 1280, availableHeight / 800));
      return r.width > 0 && r.left >= v.left && r.top >= v.top && r.right <= v.right && r.bottom <= v.bottom
        && Math.abs(r.width - expectedWidth) <= 1
        && viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight;
    });
    const alignment = await page.$eval('.cloud-workspace-viewport', (viewport) => {
      const v = viewport.getBoundingClientRect();
      const c = viewport.firstElementChild.getBoundingClientRect();
      return { x: Math.abs((c.left + c.right) - (v.left + v.right)), y: Math.abs((c.top + c.bottom) - (v.top + v.bottom)) };
    });
    assert(alignment.x <= 2 && alignment.y <= 2, 'screen is centered in both directions');
  };
  let totalClicks = 0;
  for (const [width, height, dpr] of [[1280,900,1], [900,700,2], [390,700,2], [1920,1080,1]]) {
    await page.setViewport({ width, height, deviceScaleFactor:dpr });
    await checkFit();
    console.log(`Fit verified at ${width}x${height}`);
    const expected = [];
    await remote.evaluate(() => { window.hits = []; });
    for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) {
      const p = await point(col * 312 + 16, row * 192 + 16);
      await page.mouse.click(p.x, p.y);
      expected.push(`target-${row * 5 + col}`);
    }
    await settle();
    assert.deepEqual(await remote.evaluate(() => window.hits), expected, `all 25 targets at ${width}x${height}, DPR ${dpr}`);
    totalClicks += expected.length;
    if (width === 1280 || width === 390) await page.screenshot({ path:resolve(artifacts, `fit-${width}.png`) });
  }
  // A human press lasts longer than the old 8ms batching window. Both edges
  // must still use one request, even when the round trip exceeds the hold time.
  await page.setViewport({ width:390, height:700, deviceScaleFactor:2 });
  await checkFit();
  latencyMs = 250;
  const jitterTarget = await point(16, 16);
  await remote.evaluate(() => { window.hits = []; });
  inputBatches.length = 0;
  await page.mouse.move(jitterTarget.x, jitterTarget.y);
  await settle();
  inputBatches.length = 0;
  await page.mouse.down();
  assert.equal(await page.$eval('.cloud-workspace-click-feedback', node => node.hidden), false);
  await delay(70);
  // Four CSS pixels can leave a tiny fitted target, but are still hand jitter.
  await page.mouse.move(jitterTarget.x + 4, jitterTarget.y);
  await page.mouse.up();
  await page.screenshot({ path:resolve(artifacts, 'click-pending.png') });
  await settle();
  assert.deepEqual(await remote.evaluate(() => window.hits), ['target-0']);
  assert.equal(inputBatches.length, 1, 'one round trip for a human click');
  assert.deepEqual(inputBatches[0].map(event => event.action), ['down', 'up']);
  assert.deepEqual(inputBatches[0][0], { ...inputBatches[0][1], action:'down' });
  assert.equal(await page.$eval('.cloud-workspace-click-feedback', node => node.hidden), true);
  latencyMs = 80;
  console.log('PASS one-request human click with 4px hand jitter at 390px/DPR 2 and 250ms latency');
  await page.setViewport({ width:1280, height:900 });
  await page.evaluate(() => document.documentElement.style.setProperty('--ag-sidebar-width', '560px'));
  await checkFit();
  await page.evaluate(() => document.body.classList.remove('ag-sidebar-open'));
  await checkFit();
  await page.evaluate(() => {
    document.body.classList.add('ag-sidebar-open');
    document.documentElement.style.removeProperty('--ag-sidebar-width');
  });
  await checkFit();
  // Manual 100% zoom remains scrollable. Fit restores the full screen after resize.
  await page.setViewport({ width:900, height:700 });
  await page.click('[data-cloud-zoom="reset"]');
  assert.equal(await page.$eval('.cloud-workspace-canvas', (node) => Math.round(node.getBoundingClientRect().width)), 1280);
  await page.$eval('.cloud-workspace-viewport', (node) => { node.scrollLeft = 200; node.scrollTop = 150; });
  await remote.evaluate(() => { window.hits = []; });
  const scrolled = await point(640, 400);
  await page.mouse.click(scrolled.x, scrolled.y);
  await settle();
  assert.deepEqual(await remote.evaluate(() => window.hits), ['target-12']);
  await page.click('[data-cloud-zoom="fit"]');
  await checkFit();
  // Local double clicks retain their meaning after network batching.
  await remote.evaluate(() => { window.doubleClicks = []; });
  const target = await point(16, 16);
  await page.mouse.click(target.x, target.y);
  await page.mouse.click(target.x, target.y);
  await settle();
  assert.deepEqual(await remote.evaluate(() => window.doubleClicks), ['target-0']);
  // Select actual remote textarea text while requests are still in flight.
  const start = await point(360, 335);
  const end = await point(680, 335);
  await page.mouse.move(start.x, start.y);
  await delay(60);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps:10 });
  await page.mouse.up();
  await settle();
  assert(await remote.$eval('textarea', (node) => node.selectionEnd > node.selectionStart), 'drag selects remote text');
  await page.keyboard.type('replaced');
  await settle();
  assert.match(await remote.$eval('textarea', (node) => node.value), /replaced/);
  assert.equal(pressed.displayPressedButtons.size, 0);
  // Capture can be lost without pointerup, for example when another control takes it.
  // The remote browser must release the drag using the last valid document point.
  await page.$eval('.cloud-workspace-canvas', (node) => {
    node.addEventListener('pointerdown', (event) => { window.lastPointerId = event.pointerId; });
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await page.$eval('.cloud-workspace-canvas', (node) => node.releasePointerCapture(window.lastPointerId));
  await page.mouse.move(end.x, end.y);
  await settle();
  assert.equal(pressed.displayPressedButtons.size, 0, 'lost pointer capture releases the remote drag');
  await page.mouse.up();
  await settle();
  // Chromium's actual composition events stay bound to the original document.
  // This exercises browser IME plumbing without changing the host OS input method.
  const cdp = await page.createCDPSession();
  await remote.$eval('textarea', (node) => { node.value = ''; node.focus(); });
  await page.focus('.cloud-workspace-input');
  await cdp.send('Input.imeSetComposition', { text: '정', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '정상 입력' });
  await settle();
  assert.equal(await remote.$eval('textarea', (node) => node.value), '정상 입력',
    'Chromium compositionend commits Korean exactly once without a later non-composing input');
  const committedBefore = await remote.$eval('textarea', (node) => node.value);
  await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await page.evaluate(() => window.__displayTestWorkspace.setContext({
    visible: true, session: { kind: 'running', sessionId: 'other-session' },
  }));
  await cdp.send('Input.insertText', { text: '한글' });
  await settle();
  assert.equal(await remote.$eval('textarea', (node) => node.value), committedBefore,
    'composition started in the old session cannot edit the new document');
  await page.evaluate(() => window.__displayTestWorkspace.setContext({
    visible: true, session: { kind: 'running', sessionId: 'test-session' },
  }));
  assert.equal(await page.$eval('textarea[readonly]', (node) => node.value), '한글');
  assert.equal(await page.$eval('textarea[readonly]', (node) => node.hidden), false);
  await cdp.detach();
  assert.deepEqual(errors, []);
  console.log(`PASS ${totalClicks} remote target clicks, centered fit at four viewport sizes and DPR 1/2, sidebar resize/collapse, scrolling at 100%, double click, drag selection, lost capture release, typing, Korean IME commit and cross-session recovery; 80ms simulated latency`);
  console.log(`Screenshots: ${artifacts}`);
} finally {
  await queue?.close();
  await browser?.close();
  await workerBrowser?.close();
  await server.close();
}
