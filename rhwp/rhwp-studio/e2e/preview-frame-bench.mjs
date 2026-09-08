/** 실제 WASM 편집 버스트의 프레임/렌더 비용. 절대 시간 임계값 없이 최종 텍스트를 검증한다.
 * node e2e/preview-frame-bench.mjs --label=after
 * BENCH_STUDIO_ROOT=/path/to/baseline/rhwp/rhwp-studio 로 같은 워크로드를 비교한다.
 * BENCH_MODES=typewriter BENCH_BURSTS=10 BENCH_BURST_SIZE=10: 알림 100개.
 * BENCH_MODES=multi-local BENCH_BURSTS=1 BENCH_BURST_SIZE=1: 두 페이지 동시 무효화.
 * BENCH_SAMPLES=biz_plan.hwp: 단일 문서. VITE_PORT=7784: 독립 서버 포트.
 * output/preview-frame-bench/<label>에 결과와 PNG를 기록한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { createHash } from 'node:crypto';
const here = path.dirname(fileURLToPath(import.meta.url));
const studio = process.env.BENCH_STUDIO_ROOT || path.resolve(here, '..');
const label = process.argv.find(x => x.startsWith('--label='))?.slice(8) || 'current';
assert.match(label, /^[a-zA-Z0-9_-]+$/);
const out = path.resolve(here, '../output/preview-frame-bench', label);
fs.mkdirSync(out, { recursive: true });
const bursts = Number(process.env.BENCH_BURSTS || 12);
const burstSize = Number(process.env.BENCH_BURST_SIZE || 4);
assert.ok(Number.isInteger(bursts) && bursts > 0 && bursts <= 100);
assert.ok(Number.isInteger(burstSize) && burstSize > 0 && burstSize <= 32);
const port = process.env.VITE_PORT || '7784';
const url = `http://127.0.0.1:${port}`;
process.env.VITE_URL = url;
process.env.CHROME_PATH ||= '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
process.argv = process.argv.filter(arg => !arg.startsWith('--mode='));
process.argv.push('--mode=headless');
const { launchBrowser, createPage, loadApp, loadHwpFile } = await import('./helpers.mjs');
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(Number(port), '127.0.0.1', () => probe.close(resolve));
});
const log = fs.openSync(path.join(out, 'vite.log'), 'w');
const server = spawn(process.execPath, [path.join(studio, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', port, '--strictPort'], {
  cwd: studio, env: { ...process.env, RHWP_SKIP_AGENT_HUB: '1', BROWSER: 'none' }, stdio: ['ignore', log, log],
});
let browser;
const results = { label, source: studio, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, wasmSha256: createHash('sha256').update(fs.readFileSync(path.resolve(studio, '../pkg/rhwp_bg.wasm'))).digest('hex'), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: studio, encoding: 'utf8' }).trim(), scenarios: [] };
try {
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw new Error('Vite exited: inspect vite.log');
    try { if ((await fetch(url)).ok) break; } catch {}
    if (i === 100) throw new Error('Vite readiness timeout');
    await delay(200);
  }
  browser = await launchBrowser();
  results.browser = await browser.version();
  for (const sample of (process.env.BENCH_SAMPLES || 'biz_plan.hwp,kps-ai.hwp').split(',')) {
    const sampleSlug = sample.replaceAll('/', '_');
    for (const mode of (process.env.BENCH_MODES || 'global,page-local').split(',')) {
      assert.ok(['global', 'page-local', 'multi-local', 'typewriter', 'engine-batch', 'pending-multiline'].includes(mode), `unknown mode: ${mode}`);
      const page = await createPage(browser);
      const errors = [];
      page.on('error', e => errors.push(`crash: ${e.message}`));
      page.on('pageerror', e => { errors.push(e.message); console.error('pageerror', e.message); });
      await loadApp(page, '?renderer=canvas2d');
      const loaded = await loadHwpFile(page, sample);
      const result = await page.evaluate(async ({ mode, bursts, burstSize }) => {
        const wasm = window.__wasm, view = window.__canvasView, bus = window.__eventBus;
        if (mode === 'typewriter') {
          wasm.insertText(0, 0, 0, 'agent preview '.repeat(20));
          bus.emit('document-changed');
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
        const geometryCalls = { getCursorRect: 0, getSelectionRects: 0 };
        const geometryOriginals = {};
        for (const name of Object.keys(geometryCalls)) {
          geometryOriginals[name] = wasm[name];
          wasm[name] = function(...args) { geometryCalls[name]++; return geometryOriginals[name].apply(this, args); };
        }
        const raf = [], longTasks = [], renderDurations = [], renderedPages = [];
        let running = true, previous = performance.now(), calls = 0;
        const tick = now => { if (!running) return; raf.push(now - previous); previous = now; requestAnimationFrame(tick); };
        const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
        observer.observe({ type: 'longtask', buffered: false });
        const original = view.renderCanvas;
        view.renderCanvas = function(...args) {
          const start = performance.now(); calls++;
          try { return original.apply(this, args); }
          finally { renderDurations.push(performance.now() - start); renderedPages.push(args[0]); }
        };
        const paragraphCountBefore = wasm.getParagraphCount(0);
        const before = wasm.getTextRange(0, 0, 0, 100000);
        let expectedPrefix = '';
        const started = performance.now();
        requestAnimationFrame(tick);
        // 각 macrotask마다 설정한 개수의 편집을 밀어 넣는다. 단일 JS WASM 인스턴스는 직렬이다.
        for (let burst = 0; burst < bursts; burst++) {
          await new Promise(resolve => setTimeout(resolve, 8));
          if (mode === 'engine-batch') wasm.doc.beginBatch();
          try {
            await Promise.all(Array.from({ length: burstSize }, (_, index) => Promise.resolve().then(() => {
              if (mode === 'pending-multiline') {
                const text = Array.from({ length: 32 }, (_, line) => `벤치마크 문단 ${line}`).join('\n');
                window.__agentBridge.pendingEdits.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 0 }, text);
                expectedPrefix = text + expectedPrefix;
                return;
              }
              if (mode === 'typewriter') {
                bus.emit('agent-text-inserted', { agent: 'claude', text: 'agent', range: {sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 5} });
                return;
              }
              const text = `[${burst}:${index}]`;
              const raw = wasm.insertText(0, 0, 0, text);
              const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
              if (parsed?.error || parsed?.ok === false) throw new Error(JSON.stringify(parsed));
              expectedPrefix = text + expectedPrefix;
              if (mode === 'engine-batch') return;
              if (mode === 'global') bus.emit('document-changed');
              else {
                bus.emit('document-page-invalidated', { pageIndex: 0 });
                if (mode === 'multi-local') bus.emit('document-page-invalidated', { pageIndex: 1 });
              }
            })));
          } finally {
            if (mode === 'engine-batch') {
              wasm.doc.endBatch();
              bus.emit('document-changed');
            }
          }
        }
        const editEnd = performance.now();
        const activeFrameCount = raf.length;
        // 동일한 종료 관찰 구간에 예약 렌더/idle 작업까지 포함한다.
        await new Promise(resolve => setTimeout(resolve, 1200));
        running = false;
        observer.disconnect();
        view.renderCanvas = original;
        for (const name of Object.keys(geometryCalls)) wasm[name] = geometryOriginals[name];
        const summarize = values => {
          const sorted = [...values].sort((a,b) => a-b);
          return { n: values.length, mean: values.reduce((a,b) => a+b,0)/(values.length || 1), p50: sorted[Math.floor(sorted.length*.5)] || 0, p95: sorted[Math.floor(sorted.length*.95)] || 0, max: sorted.at(-1) || 0 };
        };
        const canvas = document.querySelector('#scroll-container canvas');
        const pixelsBefore = canvas?.toDataURL();
        view.rerenderPageForDiagnostics(0);
        const pixelsAfter = document.querySelector('#scroll-container canvas')?.toDataURL();
        const actual = mode === 'pending-multiline'
          ? Array.from({ length: 1 + 31 * bursts * burstSize }, (_, paragraph) => wasm.getTextRange(0, paragraph, 0, 100000)).join('\n')
          : wasm.getTextRange(0, 0, 0, 100000);
        const exportedHwpSha256 = mode === 'pending-multiline'
          ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', wasm.exportHwp())), byte => byte.toString(16).padStart(2, '0')).join('')
          : null;
        return { mode, paragraphCountBefore, paragraphCountAfter: wasm.getParagraphCount(0), exportedHwpSha256, previewPng: mode === 'multi-local' ? pixelsBefore : null, freshPng: mode === 'multi-local' ? pixelsAfter : null, geometryCalls, operations: bursts * burstSize, edits: mode === 'typewriter' ? 0 : bursts * burstSize, bursts, burstSize, pageCount: wasm.pageCount, editMs: editEnd-started,
          observationMs: performance.now()-started, finalPixelsMatchFreshRender: pixelsBefore === pixelsAfter, activeRaf: summarize(raf.slice(0, activeFrameCount)), activeFps: activeFrameCount * 1000 / (editEnd-started), raf: summarize(raf), fps: 1000/(summarize(raf).mean || 1),
          framesOver33ms: raf.filter(x => x > 33.34).length, longTasks: summarize(longTasks),
          renderCalls: calls, renderMs: summarize(renderDurations), renderedPages: [...new Set(renderedPages)],
          correct: actual === expectedPrefix + before, actualLength: actual.length, expectedLength: (expectedPrefix+before).length,
          canvasCount: document.querySelectorAll('#scroll-container canvas').length };
      }, { mode, bursts, burstSize });
      for (const field of ['previewPng', 'freshPng']) {
        if (result[field]) fs.writeFileSync(path.join(out, `${sampleSlug}-${mode}-${field}.png`), Buffer.from(result[field].split(',')[1], 'base64'));
        delete result[field];
      }
      result.sample = sample;
      result.initialPageCount = loaded.pageCount;
      result.errors = errors;
      results.scenarios.push(result);
      fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify(result));
      if (mode === 'pending-multiline') assert.equal(result.paragraphCountAfter, result.paragraphCountBefore + 31 * bursts * burstSize, 'all inserted paragraph boundaries remain');
      assert.equal(result.correct, true, `${sample}/${mode}: final WASM text`);
      assert.equal(result.finalPixelsMatchFreshRender, true, 'final pixels match fresh WASM render');
      assert.ok(result.canvasCount > 0, 'visible canvases remain');
      assert.equal(errors.length, 0, 'no browser crashes or uncaught errors');
      await page.screenshot({ path: path.join(out, `${sampleSlug}-${mode}.png`) });
      await page.close();
    }
  }
  results.complete = true;
} catch (error) {
  results.failure = error.stack || String(error);
  throw error;
} finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  await browser?.close();
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  fs.closeSync(log);
}
