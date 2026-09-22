/*
 * Production PendingOverlayRenderer benchmark. It mounts the shipped renderer in a
 * browser and gives it a deterministic 240-page geometry probe. The WASM probe is
 * the only fixture seam; DOM reconciliation, VirtualScroll, EventBus and overlay
 * CSS are production modules. Run with --mode=headless on the Mac so Chrome keeps
 * its GPU process enabled (the generic e2e helper intentionally disables GPU).
 *
 *   node e2e/agent-overlay-performance.mjs
 *   BENCH_DURATION_MS=1000 BENCH_REPEATS=1 node e2e/agent-overlay-performance.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = path.resolve(here, '..');
const out = path.resolve(studio, '../output/agent-overlay-performance');
const port = Number(process.env.OVERLAY_BENCH_PORT || 7793);
const durationMs = Number(process.env.BENCH_DURATION_MS || 16000);
const repeats = Number(process.env.BENCH_REPEATS || 2);
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baselineCommit = process.env.OVERLAY_BASELINE_COMMIT || 'd1129992';
fs.mkdirSync(out, { recursive: true });
if (!Number.isInteger(durationMs) || durationMs < 250 || durationMs > 120000) throw new Error('BENCH_DURATION_MS must be 250..120000');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('BENCH_REPEATS must be 1..10');

function makeBaseline() {
  const source = execFileSync('git', ['show', `${baselineCommit}:rhwp/rhwp-studio/src/agent/pending-overlay.ts`], { cwd: studio, encoding: 'utf8' });
  const transformed = source
    .replace("import './pending-overlay.css';", "import '/src/agent/pending-overlay.css';")
    .replace("from './exact-text-diff.ts'", "from '/src/agent/exact-text-diff.ts'")
    .replace("from './selection-ink.ts'", "from '/src/agent/selection-ink.ts'");
  const file = path.join(here, '.agent-overlay-baseline.ts');
  fs.writeFileSync(file, transformed);
  return file;
}

function descendants(pid) {
  const ids = [pid];
  for (let i = 0; i < ids.length; i++) {
    try {
      const children = execFileSync('pgrep', ['-P', String(ids[i])], { encoding: 'utf8' }).trim();
      if (children) ids.push(...children.split(/\s+/).map(Number).filter(Boolean));
    } catch {}
  }
  return [...new Set(ids)];
}
function rssBytes(pid) {
  if (!pid) return 0;
  return descendants(pid).reduce((total, id) => {
    try { return total + Number(execFileSync('ps', ['-o', 'rss=', '-p', String(id)], { encoding: 'utf8' }).trim()) * 1024; } catch { return total; }
  }, 0);
}
function metricMap(metrics) { return Object.fromEntries(metrics.metrics.map(m => [m.name, m.value])); }
async function metrics(page, session) {
  const perf = metricMap(await session.send('Performance.getMetrics'));
  let processes = [];
  try {
    const browserSession = await page.browser().target().createCDPSession();
    processes = (await browserSession.send('SystemInfo.getProcessInfo')).processInfo || [];
    await browserSession.detach();
  } catch {}
  const gpu = processes.find(p => String(p.type).toLowerCase().includes('gpu'));
  return {
    taskDurationMs: (perf.TaskDuration || 0) * 1000,
    scriptDurationMs: (perf.ScriptDuration || 0) * 1000,
    layoutDurationMs: (perf.LayoutDuration || 0) * 1000,
    recalcStyleDurationMs: (perf.RecalcStyleDuration || 0) * 1000,
    jsHeapUsedBytes: perf.JSHeapUsedSize || 0,
    jsHeapTotalBytes: perf.JSHeapTotalSize || 0,
    browserRssBytes: rssBytes(page.browser().process()?.pid),
    gpuCpuTimeSeconds: gpu?.cpuTime ?? null,
    gpuProcessId: gpu?.id ?? null,
    processInfoAvailable: processes.length > 0,
  };
}
function delta(after, before) { return Object.fromEntries(Object.keys(after).map(k => [k, typeof after[k] === 'number' && typeof before[k] === 'number' ? after[k] - before[k] : after[k]])); }
async function waitPort() {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/e2e/agent-overlay-performance.html`)).ok) return; } catch {} await delay(100); }
  throw new Error('Vite did not become ready');
}
async function runOne(implementation, iteration, server) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-gpu', '--enable-accelerated-2d-canvas', '--js-flags=--expose-gc'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();
  const session = await page.createCDPSession();
  await session.send('Performance.enable');
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${server}/e2e/agent-overlay-performance.html?implementation=${implementation}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__overlayBenchReady === true);
  await delay(100);
  if (typeof global.gc === 'function') global.gc();
  await page.evaluate(() => { if (typeof gc === 'function') gc(); });
  const before = await metrics(page, session);
  const wallStartMs = Date.now();
  const result = await page.evaluate(ms => window.__overlayBench.workload(ms), durationMs);
  const wallEndMs = Date.now();
  await page.evaluate(() => { if (typeof gc === 'function') gc(); });
  await delay(100);
  const after = await metrics(page, session);
  const screenshot = await page.screenshot({ path: path.join(out, `${implementation}-${iteration}.png`) });
  const item = { implementation, iteration, durationMs, wallStartMs, wallEndMs, workload: result, nodes: await page.evaluate(() => window.__overlayBench.nodeStats()), before, after, delta: delta(after, before), errors, screenshot: `${implementation}-${iteration}.png` };
  await browser.close();
  return item;
}

const baselineFile = makeBaseline();
let server;
try {
  const log = fs.openSync(path.join(out, 'vite.log'), 'w');
  server = spawn(process.execPath, [path.join(studio, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: studio, env: { ...process.env, BROWSER: 'none' }, stdio: ['ignore', log, log] });
  await waitPort();
  const results = [];
  for (let i = 0; i < repeats; i++) {
    results.push(await runOne('baseline', i, `http://127.0.0.1:${port}`));
    results.push(await runOne('current', i, `http://127.0.0.1:${port}`));
  }
  const firstBase = path.join(out, 'baseline-0.png');
  const firstCurrent = path.join(out, 'current-0.png');
  let pixelDiff = null;
  if (fs.existsSync(firstBase) && fs.existsSync(firstCurrent)) {
    const a = PNG.sync.read(fs.readFileSync(firstBase)); const b = PNG.sync.read(fs.readFileSync(firstCurrent));
    const diff = new PNG({ width: Math.min(a.width, b.width), height: Math.min(a.height, b.height) });
    pixelDiff = pixelmatch(a.data, b.data, diff.data, diff.width, diff.height, { threshold: 0.1 });
    fs.writeFileSync(path.join(out, 'baseline-current-diff.png'), PNG.sync.write(diff));
  }
  let power = null;
  try {
    const { summarizePower } = await import('./power-samples.mjs');
    const logText = fs.readFileSync(path.join(os.homedir(), 'rhwp-power.log'), 'utf8');
    power = results.map(r => ({ implementation: r.implementation, iteration: r.iteration, ...summarizePower(logText, r.wallStartMs, r.wallEndMs) }));
  } catch (error) { power = { unavailable: String(error) }; }
  const report = { generatedAt: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: studio, encoding: 'utf8' }).trim(), baselineCommit, durationMs, repeats, gpuEnabled: true, screenshotPixelDiffCount: pixelDiff, results, power };
  fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { fs.unlinkSync(baselineFile); } catch {}
  if (server) server.kill('SIGTERM');
}
