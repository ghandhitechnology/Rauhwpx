/**
 * 벤치마크: 에이전트 MCP 도구 비용 — hub → bridge → executor → wasm.
 *
 * agent-edit-loop.test.mjs 와 같이 실제 허브 + 가짜 프로바이더 턴(pi) + 가짜 MCP WS
 * 클라이언트로 프로덕션 경로를 그대로 구동한다. 모델/추론 시간은 재지 않는다.
 *   1. 왕복 지연: 도구 종류별 ms/op (p50/p95/평균)
 *   2. 작업 스크립트: 샘플 문서 위 여섯 작업을 턴 하나씩 실행하고, 허브가 턴마다 남기는
 *      도구 텔레메트리 행(RHWP_WORK_DIR/tool-telemetry.jsonl)에서 호출 수, 결과 글자 수,
 *      이미지 수, 도구 ms 를 읽는다. 작업마다 "today"(현재 도구) 스크립트가 있고, 이후
 *      슬라이스가 같은 작업의 "target" 스크립트를 더해 비교한다.
 *
 * 실행: node e2e/agent-tool-bench.mjs --mode=headless [--tasks-only] [--task=<이름>]
 * 결과: 마지막에 JSON 한 줄 (BENCH_RESULT: {...}) — 전후 비교용.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { writeFakeCliBin } from '../../rhwp-agent/tests/fake-cli-bin.mjs';
import { prepareInsertImageArgs } from '../../rhwp-agent/insert-image-source.mjs';
import { readToolTelemetryRows } from '../../rhwp-agent/tool-telemetry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(studioRoot, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const LATENCY_SAMPLE = 'footnote-01.hwp';
const HUB_TOKEN = 'bench';
const TASKS_ONLY = process.argv.includes('--tasks-only');
const TASK_FILTER = process.argv.find((arg) => arg.startsWith('--task='))?.slice('--task='.length) ?? null;

async function findAvailablePort(startPort, attempts = 20) {
  for (let port = startPort; port < startPort + attempts; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`failed to find an available port starting at ${startPort}`);
}

async function waitForHttp(url, label, child, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode)) {
      throw new Error(`${label} 프로세스가 준비 전 종료 (code=${child.exitCode ?? child.signalCode})`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(400);
  }
  throw new Error(`${label} 준비 대기 시간 초과: ${lastError?.message || 'unknown'}`);
}

function spawnLogged(cmd, args, cwd, extraEnv, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFile = fs.openSync(logPath, 'w');
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', logFile, logFile],
    env: { ...process.env, ...extraEnv },
  });
  child._logFile = logFile;
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    delay(5000).then(() => {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    }),
  ]);
  if (child._logFile !== undefined) fs.closeSync(child._logFile);
}

// ─── 가짜 MCP WS 클라이언트 (mcp-stdio.mjs 와 동일 프레임) ─────

function connectMcpClient(hubPort, token, sessionId, capabilityEpoch) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}&agent=pi`,
  );
  let nextId = 1;
  const inflight = new Map();
  const rejectAll = (error) => {
    for (const entry of inflight.values()) { clearTimeout(entry.timer); entry.reject(error); }
    inflight.clear();
  };
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
    if (msg?.type === 'protocol-error') { rejectAll(new Error(msg.message)); return; }
    if (msg?.type !== 'tool-result') return;
    const entry = inflight.get(msg.id);
    if (!entry) return;
    inflight.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  });
  ws.addEventListener('close', (event) => {
    rejectAll(new Error(`MCP WS 연결 종료 (${event.code}): ${event.reason}`));
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('MCP WS 연결 실패')), { once: true });
  });
  const call = async (tool, rawArgs) => {
    // mcp-stdio.mjs 처럼 insert_image 는 허브로 보내기 전에 이미지 크기를 채운다.
    const args = tool === 'insert_image' ? await prepareInsertImageArgs(rawArgs, []) : rawArgs;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      // 허브의 STUDIO_TIMEOUT(30s+) 보다 넉넉하게 — verify/렌더 계열 여유분
      const timer = setTimeout(() => {
        inflight.delete(id);
        reject(new Error(`tool-call 응답 시간 초과: ${tool}`));
      }, 45000);
      inflight.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ v: 5, type: 'tool-call', id, tool, args, workflow: 'direct', capabilityEpoch }));
    });
  };
  return { ws, opened, call };
}

function must(msg, label) {
  if (!msg?.ok) {
    const code = msg?.error?.code ?? 'NO_RESPONSE';
    throw new Error(`${label} 실패 [${code}] ${msg?.error?.message ?? '(no message)'}`);
  }
  return msg.result;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    n: samples.length,
    mean: Math.round(mean * 100) / 100,
    p50: Math.round(pick(0.5) * 100) / 100,
    p95: Math.round(pick(0.95) * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

/** 단색 PNG (base64) — insert_image 입력. */
function solidPngBase64(width, height, [r, g, b]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png).toString('base64');
}

const bodyParagraphs = (structure) => structure.sections[0].paragraphs;
const cellArgs = (match) => ({
  ...(match.cell ? { cell: match.cell } : {}),
  ...(match.cellPath ? { cellPath: match.cellPath } : {}),
});

// ─── 작업 스크립트 ─────────────────────────────────────────
// 각 스크립트는 에이전트가 한 턴에 하는 도구 호출 순서를 그대로 적는다.
// t.read(tool, args) / t.write(tool, args) — write 는 expectedRevision 을 채운다. t.nextTurn() 은 턴 경계.
// "today" = 현재 도구로 할 수 있는 가장 짧은 합리적 경로 (apply_edits 배치 포함).

const TASKS = [
  {
    name: 'typo-fixes',
    sample: 'biz_plan.hwp',
    today: async (t) => {
      await t.read('get_structure', {});
      const fixes = [
        ['하여야  한다', '하여야 한다'],
        ['운용중인', '운용 중인'],
        ['발생시 구성원', '발생 시 구성원'],
      ];
      const edits = [];
      for (const [wrong, right] of fixes) {
        const found = await t.read('find_text', { query: wrong });
        const match = found.matches[0];
        if (!match) throw new Error(`오탈자 "${wrong}" 를 찾지 못함`);
        edits.push({ tool: 'replace_range', args: {
          sectionIdx: match.sectionIdx,
          startParaIdx: match.paraIdx, startCharOffset: match.charOffset,
          endParaIdx: match.paraIdx, endCharOffset: match.charOffset + match.length,
          text: right, ...cellArgs(match),
        } });
      }
      await t.write('apply_edits', { edits });
      await t.read('verify_changes', {});
    },
  },
  {
    name: 'heading-restyle-list',
    sample: 'biz_plan.hwp',
    today: async (t) => {
      const structure = await t.read('get_structure', {});
      const { styles } = await t.read('list_styles', {});
      const heading = styles.find((s) => s.name === '개요 1') ?? styles.find((s) => /개요/.test(s.name));
      if (!heading) throw new Error('개요 스타일 없음');
      const paragraphs = bodyParagraphs(structure);
      const headings = paragraphs.filter((p) => /^\s*\d+\.\s*\S/.test(p.text) && !p.text.includes('·'));
      if (headings.length < 3) throw new Error(`제목 문단 부족 (${headings.length})`);
      await t.read('get_para_format', { sectionIdx: 0, paraIdx: headings[0].paraIdx });
      // 「2. 사업목적」 아래 수동 "가. 나. 다." 항목을 진짜 목록으로 바꾼다.
      const purpose = paragraphs.findIndex((p) => p.text.includes('사업목적') && !p.text.includes('·'));
      const items = [];
      for (let i = purpose + 1; i < paragraphs.length; i += 1) {
        const prefix = /^\s*[가-하]\.\s*/.exec(paragraphs[i].text);
        if (!prefix) break;
        items.push({ paraIdx: paragraphs[i].paraIdx, prefixLength: prefix[0].length });
      }
      if (items.length < 2) throw new Error(`목록 항목 부족 (${items.length})`);
      await t.write('apply_edits', { edits: [
        ...headings.map((p) => ({ tool: 'apply_style', args: { sectionIdx: 0, paraIdx: p.paraIdx, styleId: heading.id } })),
        ...items.map((item) => ({ tool: 'delete_range', args: {
          sectionIdx: 0, startParaIdx: item.paraIdx, startCharOffset: 0,
          endParaIdx: item.paraIdx, endCharOffset: item.prefixLength,
        } })),
        { tool: 'apply_list', args: {
          sectionIdx: 0, startParaIdx: items[0].paraIdx, endParaIdx: items[items.length - 1].paraIdx, format: '가.',
        } },
      ] });
      await t.read('verify_changes', {});
    },
  },
  {
    name: 'table-fill-widths',
    sample: 'biz_plan.hwp',
    today: async (t) => {
      const findTable = (structure) => structure.sections[0].tables
        .find((table) => table.cells.some((cell) => cell.paragraphs.some((p) => p.text.includes('성명'))));
      const table = findTable(await t.read('get_structure', {}));
      if (!table) throw new Error('인력투입 표 없음');
      const addr = { sectionIdx: 0, paraIdx: table.paraIdx, controlIdx: table.controlIdx };
      const layout = await t.read('get_table_layout', addr);
      await t.write('edit_table', { ...addr, op: 'insert_row', rowIdx: table.rowCount - 1, below: true });
      // 스테이징된 행 삽입은 턴 커밋 뒤에야 셀 번호가 확정된다 — 새 턴에서 다시 읽고 채운다.
      await t.nextTurn();
      const grown = findTable(await t.read('get_structure', {}));
      const newRow = grown.cells.filter((cell) => cell.row === grown.rowCount - 1);
      const values = ['개발자', '백엔드', '김O민', '중급', '6년', '정보처리기사'];
      const tableWidthMm = layout.fragments?.[0]?.widthMm ?? 160;
      const weights = Array.from({ length: grown.colCount }, (_, i) => (i === 0 || i === grown.colCount - 1 ? 1.4 : 1));
      const weightSum = weights.reduce((a, b) => a + b, 0);
      await t.write('apply_edits', { edits: [
        ...newRow.map((cell, i) => ({ tool: 'insert_text', args: {
          sectionIdx: 0, paraIdx: 0, charOffset: 0, text: values[i % values.length],
          cell: { paraIdx: grown.paraIdx, controlIdx: grown.controlIdx, cellIdx: cell.cellIdx },
        } })),
        { tool: 'edit_table', args: {
          ...addr, op: 'set_column_widths',
          columnWidthsMm: weights.map((w) => Math.round((tableWidthMm * w / weightSum) * 10) / 10),
        } },
      ] });
      await t.read('get_table_layout', addr);
    },
  },
  {
    name: 'two-positioned-images',
    sample: 'footnote-01.hwp',
    today: async (t) => {
      const paragraphs = bodyParagraphs(await t.read('get_structure', {}));
      const anchors = paragraphs.filter((p) => p.length > 10).slice(2, 4);
      if (anchors.length < 2) throw new Error('그림 앵커 문단 부족');
      const inserted = [];
      for (const [i, anchor] of anchors.entries()) {
        const result = await t.write('insert_image', {
          sectionIdx: 0, paraIdx: anchor.paraIdx, charOffset: anchor.length,
          imageBase64: solidPngBase64(480, 320, i === 0 ? [40, 90, 200] : [200, 90, 40]), extension: 'png',
          widthMm: 50, heightMm: 33, description: `벤치 그림 ${i + 1}`,
        });
        inserted.push(result.image);
      }
      // 스테이징된 의미 쓰기와 raw 엔진 배치는 한 턴에 섞을 수 없다 — 커밋 뒤 새 턴에서 배치한다.
      await t.nextTurn();
      await t.read('get_engine_edit_capabilities', { query: 'setPictureProperties' });
      await t.write('apply_engine_edits', { operations: inserted.map((image, i) => ({
        method: 'setPictureProperties',
        args: [0, image.paraIdx, image.controlIdx, {
          treatAsChar: false, textWrap: 'Square',
          horzRelTo: 'Column', horzAlign: i === 0 ? 'Right' : 'Left', horzOffset: 0,
          vertRelTo: 'Para', vertAlign: 'Top', vertOffset: 0,
        }],
      })) });
      await t.read('render_page', { pageIndex: 0, format: 'png' });
    },
  },
  {
    name: 'odd-even-page-numbers',
    sample: 'biz_plan.hwp',
    today: async (t) => {
      await t.read('get_document_info', {});
      await t.read('get_engine_edit_capabilities', { query: 'HeaderFooter' });
      // applyTo: 1 짝수 쪽, 2 홀수 쪽. 필드 1 = 현재 쪽 번호.
      const footer = (applyTo, alignment) => [
        { method: 'createHeaderFooter', args: [0, false, applyTo] },
        { method: 'insertFieldInHf', args: [0, false, applyTo, 0, 0, 1] },
        { method: 'applyParaFormatInHf', args: [0, false, applyTo, 0, JSON.stringify({ alignment })] },
      ];
      await t.write('apply_engine_edits', { operations: [...footer(2, 'right'), ...footer(1, 'left')] });
      await t.read('render_page', { pageIndex: 2, format: 'png' });
      await t.read('render_page', { pageIndex: 3, format: 'png' });
    },
  },
  {
    name: 'figure-page-layout-copy',
    sample: 'ta-pic-001-r-쪽영역안제한.hwp',
    today: async (t) => {
      await t.read('get_document_info', {});
      const paragraphs = bodyParagraphs(await t.read('get_structure', {}));
      await t.read('render_page', { pageIndex: 0, format: 'png' });
      // 원본 그림/캡션 위치는 SVG 좌표로 잰다 — 배치를 읽는 전용 도구가 아직 없다.
      await t.read('render_page', { pageIndex: 0, format: 'svg' });
      const last = paragraphs[paragraphs.length - 1];
      const title = last.paraIdx + 1;
      const figure = last.paraIdx + 2;
      const caption = last.paraIdx + 3;
      const titleText = '입법 디지털 트윈 예시 (사본)';
      await t.write('apply_edits', { edits: [
        { tool: 'insert_text', args: {
          sectionIdx: 0, paraIdx: last.paraIdx, charOffset: last.length,
          text: `\n${titleText}\n\n<그림 2> 의정활동 모니터링 시스템 예시 (사본)`,
        } },
        { tool: 'insert_page_break', args: { sectionIdx: 0, paraIdx: title } },
        { tool: 'apply_char_format', args: {
          sectionIdx: 0, paraIdx: title, startOffset: 0, endOffset: titleText.length, bold: true, fontSizePt: 16,
        } },
        { tool: 'apply_para_format', args: { sectionIdx: 0, paraIdx: title, alignment: 'center' } },
        { tool: 'apply_para_format', args: { sectionIdx: 0, paraIdx: figure, alignment: 'center' } },
        { tool: 'apply_para_format', args: { sectionIdx: 0, paraIdx: caption, alignment: 'center' } },
      ] });
      await t.write('insert_image', {
        sectionIdx: 0, paraIdx: figure, charOffset: 0,
        imageBase64: solidPngBase64(640, 400, [90, 140, 90]), extension: 'png',
        widthMm: 150, heightMm: 94, description: '의정활동 모니터링 시스템 예시 (사본)',
      });
      await t.read('render_page', { pageIndex: 1, format: 'png' });
    },
  },
];

// helpers.mjs 는 모듈 로드 시점에 CHROME_PATH/VITE_URL 을 고정하므로 import 전에 세팅한다.
if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(macChrome)) process.env.CHROME_PATH = macChrome;
}

const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || '5741'));
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || '7741'));
const viteUrl = `http://127.0.0.1:${vitePort}`;

console.log('=== BENCH: 에이전트 MCP 도구 비용 ===\n');
console.log(`  [setup] 허브 포트=${hubPort}, vite 포트=${vitePort}`);

// 실제 프로바이더 턴을 열되 외부 계정/API 없이 도구만 구동한다 (agent-edit-loop 과 같은 가짜 pi).
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-tool-bench-'));
const piRoot = path.join(fixtureRoot, 'pi');
const packageDir = path.join(piRoot, 'prefix/node_modules/@earendil-works/pi-coding-agent');
fs.mkdirSync(packageDir, { recursive: true });
fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
fs.writeFileSync(path.join(piRoot, 'config.json'), JSON.stringify({
  version: 1, installedVersion: '0.0.0-test', defaultModelId: 'mock-model',
  models: [{ id: 'mock-model', name: 'Mock model', reasoning: false, supportsImages: true,
    efforts: [], defaultEffort: null, contextLength: 8192, pricing: { prompt: 0, completion: 0 } }],
}));
fs.mkdirSync(path.join(piRoot, 'agent'), { recursive: true });
fs.writeFileSync(path.join(piRoot, 'agent/models.json'), JSON.stringify({
  providers: { openrouter: { apiKey: 'test-placeholder-key' } },
}));
const finishTurnPath = path.join(fixtureRoot, 'finish-turn');
writeFakeCliBin(path.join(piRoot, 'prefix/node_modules/.bin'), 'pi', `
  if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
  const fs = require('node:fs');
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(finishTurnPath)})) return;
    clearInterval(timer);
    console.log(JSON.stringify({ type: 'agent_settled' }));
  }, 25);
`);

const hub = spawnLogged(
  process.execPath,
  [path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
  path.join(repoRoot, 'rhwp-agent'),
  { NODE_ENV: 'test', RHWP_AGENT_MODE: 'development', RHWP_SECRET_BROKER: '',
    RHWP_AGENT_PORT: String(hubPort), RHWP_AGENT_TOKEN: HUB_TOKEN,
    RHWP_PI_DIR: piRoot, RHWP_WORK_DIR: fixtureRoot,
    RHWP_AGENT_INSTRUCTIONS_DIR: path.join(fixtureRoot, 'instructions'),
    RHWP_TEMPLATES_DIR: path.join(fixtureRoot, 'templates') },
  path.join(repoRoot, 'target', 'rhwp-agent-bench-hub.log'),
);
await waitForHttp(`http://127.0.0.1:${hubPort}/healthz?token=${encodeURIComponent(HUB_TOKEN)}`, 'rhwp-agent 허브', hub);

const vite = spawnLogged(
  npmCmd,
  ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
  studioRoot,
  {
    BROWSER: 'none',
    VITE_RHWP_AGENT_URL: `ws://127.0.0.1:${hubPort}`,
    RHWP_AGENT_TOKEN: HUB_TOKEN,
  },
  path.join(repoRoot, 'target', 'rhwp-studio-bench-vite.log'),
);
await waitForHttp(viteUrl, 'vite dev server', vite);

process.env.VITE_URL = viteUrl;
const helpers = await import('./helpers.mjs');
const { runTest } = helpers;

let failed = false;
const latency = {};
const tasks = {};

function printSummary() {
  const latencySummary = {};
  for (const [bucket, samples] of Object.entries(latency)) latencySummary[bucket] = stats(samples);
  if (Object.keys(latencySummary).length > 0) {
    console.log('\n  [bench] 도구별 왕복 ms:');
    for (const [bucket, s] of Object.entries(latencySummary)) {
      console.log(`    ${bucket.padEnd(20)} n=${String(s.n).padStart(3)}  mean=${s.mean}  p50=${s.p50}  p95=${s.p95}  max=${s.max}`);
    }
  }
  console.log('\n  [bench] 작업별 도구 비용 (calls / result chars / images / tool ms):');
  for (const [name, scripts] of Object.entries(tasks)) {
    for (const [variant, row] of Object.entries(scripts)) {
      console.log(`    ${`${name} ${variant}`.padEnd(34)} turns=${row.turns}  calls=${String(row.calls).padStart(3)}  chars=${String(row.resultChars).padStart(7)}  images=${row.images}  toolMs=${row.toolMs}`);
    }
  }
  console.log(`\nBENCH_RESULT: ${JSON.stringify({ latency: latencySummary, tasks })}`);
}

try {
  await runTest('에이전트 도구 벤치마크', async ({ page }) => {
    await page.waitForFunction(
      () => window.__agentBridge?.getConnectionState?.() === 'connected',
      { timeout: 20000 },
    );

    const openSample = async (name) => {
      await page.evaluate(async (fileName) => {
        const response = await fetch(`/samples/${encodeURIComponent(fileName)}`);
        if (!response.ok) throw new Error(`Sample load failed: ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const requestId = `bench-${Date.now()}`;
        await new Promise((resolve, reject) => {
          const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
            if (payload?.requestId !== requestId) return;
            off();
            if (payload.ok) resolve(); else reject(new Error(payload.error || 'open failed'));
          });
          window.__eventBus.emit('open-document-bytes', {
            bytes, fileName, requestId, suppressDialogs: true, skipUnsavedGuard: true,
          });
        });
      }, name);
      await page.waitForFunction(() => window.__wasm?.pageCount > 0
        && document.querySelector('#scroll-content canvas')
        && window.__versionController?.getState().enabled);
    };

    // 문서를 바꾸면 사이드바가 그 문서의 스레드로 옮겨 기본 프로바이더를 띄울 수 있다 —
    // 매번 가짜 pi 채팅을 다시 확인한다. apply_engine_edits 는 전체 접근에서만 열린다.
    const ensurePiChat = async () => {
      await delay(300);
      const agent = await page.evaluate(() => window.__agentBridge.getActiveAgent());
      if (agent === 'pi') return;
      await page.evaluate(() => window.__agentBridge.startChat(
        'pi', 'mock-model', null, false, 'unrestricted', 'direct',
      ));
      await page.waitForFunction(() => window.__agentBridge?.getActiveAgent?.() === 'pi', { timeout: 10000 });
    };
    await openSample(TASKS_ONLY ? TASKS[0].sample : LATENCY_SAMPLE);
    await ensurePiChat();

    const health = await (await fetch(`http://127.0.0.1:${hubPort}/healthz?token=${encodeURIComponent(HUB_TOKEN)}`)).json();
    const sessionId = health.sessions?.[0]?.sessionId;
    if (!sessionId) throw new Error('Studio hub session was not registered');

    let telemetryRows = 0;
    // 프로바이더 턴을 열고 MCP 를 붙인다. 반환된 end() 가 턴을 닫고 허브의 텔레메트리 행을 돌려준다.
    const beginTurn = async () => {
      await page.evaluate(async () => {
        window.__benchTurnStarted = false;
        const unsubscribe = window.__agentBridge.onEvent((event) => {
          if (event.type === 'agent' && event.event.type === 'turn-start') {
            window.__benchTurnStarted = true;
            unsubscribe();
          }
        });
        await window.__agentBridge.sendUserMessage('Bench turn.');
      });
      await page.waitForFunction(() => window.__benchTurnStarted, { timeout: 15000 });
      const capabilityEpoch = await page.evaluate(() => window.__agentBridge.getWorkflowState().capabilityEpoch);
      // MCP 자격은 현재 프로바이더 세션에 묶인다 — 채팅이 다시 시작됐을 수 있으니 턴마다 새로 받는다.
      const capabilities = await registerHubSession({
        port: hubPort, token: HUB_TOKEN, launchId: health.launchId, sessionId,
      });
      const mcp = connectMcpClient(hubPort, capabilities.mcp, sessionId, capabilityEpoch);
      await mcp.opened;
      const end = async () => {
        fs.writeFileSync(finishTurnPath, 'finish');
        let rows = [];
        for (let i = 0; i < 200 && rows.length <= telemetryRows; i += 1) {
          rows = await readToolTelemetryRows(fixtureRoot);
          if (rows.length <= telemetryRows) await delay(25);
        }
        if (rows.length <= telemetryRows) throw new Error('턴 텔레메트리 행이 기록되지 않음');
        telemetryRows = rows.length;
        await page.waitForFunction(() => !window.__inputHandler.isUserEditingLocked(), { timeout: 15000 });
        try { mcp.ws.close(); } catch { /* 이미 닫힌 소켓 무시 */ }
        fs.rmSync(finishTurnPath);
        return rows[rows.length - 1];
      };
      return { call: mcp.call, end };
    };

    // 스크립트 API. write 는 expectedRevision 을 채우고 REVISION_MISMATCH 면 한 번 다시 읽어
    // 재시도한다. nextTurn() 은 지금 턴을 닫고 새 턴을 연다 — 스테이징된 행/열 삽입처럼
    // 턴 커밋 뒤에만 이어갈 수 있는 작업용. finish() 는 턴별 텔레메트리 행을 돌려준다.
    const scriptApi = (firstTurn) => {
      let turn = firstTurn;
      let revision = null;
      const rows = [];
      const track = (result) => {
        if (Number.isInteger(result?.revision)) revision = result.revision;
        return result;
      };
      const read = async (tool, args) => track(must(await turn.call(tool, args), tool));
      const write = async (tool, args) => {
        if (revision === null) await read('get_structure', { maxParagraphs: 1 });
        let msg = await turn.call(tool, { ...args, expectedRevision: revision });
        if (!msg.ok && msg.error?.code === 'REVISION_MISMATCH') {
          await read('get_structure', { maxParagraphs: 1 });
          msg = await turn.call(tool, { ...args, expectedRevision: revision });
        }
        return track(must(msg, tool));
      };
      const nextTurn = async () => {
        rows.push(await turn.end());
        turn = await beginTurn();
      };
      const finish = async () => {
        rows.push(await turn.end());
        return rows;
      };
      return { read, write, nextTurn, finish };
    };

    // ── 1. 왕복 지연 ──
    if (!TASKS_ONLY) {
      const { read, write, finish } = scriptApi(await beginTurn());
      const timed = async (bucket, fn) => {
        const t0 = performance.now();
        const r = await fn();
        (latency[bucket] ??= []).push(performance.now() - t0);
        return r;
      };
      const s0 = await read('get_structure', {});
      const paraCount = s0.sections[0].paragraphCount;
      const lastParaLen = s0.sections[0].paragraphs[paraCount - 1]?.length ?? 0;
      // 시드: 벤치 대상 문단들을 문서 끝에 추가
      await write('insert_text', {
        sectionIdx: 0, paraIdx: paraCount - 1, charOffset: lastParaLen,
        text: '\n벤치마크 대상 문단입니다 이 문단의 텍스트는 교체와 서식 대상이 됩니다\n두번째 벤치 문단입니다',
      });
      const benchP = paraCount;
      // 웜업 (JIT/캐시 안정화)
      for (let i = 0; i < 5; i += 1) {
        await read('get_structure', {});
        await read('get_text_range', { sectionIdx: 0, paraIdx: benchP });
      }
      for (let i = 0; i < 20; i += 1) await timed('get_structure', () => read('get_structure', {}));
      for (let i = 0; i < 40; i += 1) await timed('get_text_range', () => read('get_text_range', { sectionIdx: 0, paraIdx: benchP }));
      for (let i = 0; i < 40; i += 1) await timed('get_para_format', () => read('get_para_format', { sectionIdx: 0, paraIdx: benchP }));
      // 쓰기 버스트: 순차 insert_text 40회 (에이전트 버스트 재현)
      const burstStart = performance.now();
      for (let i = 0; i < 40; i += 1) {
        await timed('insert_text', () => write('insert_text', { sectionIdx: 0, paraIdx: benchP, charOffset: 0, text: `버스트${i} ` }));
      }
      latency.insert_burst_total = [performance.now() - burstStart];
      for (let i = 0; i < 20; i += 1) {
        await timed('replace_range', () => write('replace_range', {
          sectionIdx: 0, startParaIdx: benchP, startCharOffset: 0,
          endParaIdx: benchP, endCharOffset: 4, text: `교체${i % 10}함`,
        }));
      }
      for (let i = 0; i < 20; i += 1) {
        await timed('apply_char_format', () => write('apply_char_format', {
          sectionIdx: 0, paraIdx: benchP, startOffset: 0, endOffset: 4, bold: i % 2 === 0,
        }));
      }
      // 혼합 시퀀스 (read → write → verify 읽기): 에이전트 1턴 근사
      for (let i = 0; i < 10; i += 1) {
        await timed('mixed_turn', async () => {
          await read('get_text_range', { sectionIdx: 0, paraIdx: benchP });
          await write('insert_text', { sectionIdx: 0, paraIdx: benchP, charOffset: 0, text: '턴 ' });
          await read('get_text_range', { sectionIdx: 0, paraIdx: benchP });
        });
      }
      // apply_edits: 8개 삽입을 배치 한 번에 (개별 insert_text 8회와 비교)
      for (let i = 0; i < 10; i += 1) {
        await timed('apply_edits_8', () => write('apply_edits', {
          edits: Array.from({ length: 8 }, (_, k) => ({
            tool: 'insert_text',
            args: { sectionIdx: 0, paraIdx: benchP, charOffset: 0, text: `배치${i}-${k} ` },
          })),
        }));
      }
      for (let i = 0; i < 5; i += 1) await timed('verify_changes', () => read('verify_changes', {}));
      await finish();
    }

    // ── 2. 작업 스크립트 ──
    for (const task of TASKS) {
      if (TASK_FILTER && task.name !== TASK_FILTER) continue;
      for (const variant of ['today', 'target']) {
        const script = task[variant];
        if (!script) continue;
        await openSample(task.sample);
        await ensurePiChat();
        const api = scriptApi(await beginTurn());
        try {
          await script(api);
        } finally {
          const rows = await api.finish();
          const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
          const errors = {};
          for (const row of rows) {
            for (const [code, count] of Object.entries(row.errors)) errors[code] = (errors[code] ?? 0) + count;
          }
          (tasks[task.name] ??= {})[variant] = {
            turns: rows.length,
            calls: sum('toolCalls'),
            resultChars: sum('resultChars'),
            images: sum('images'),
            imagePixels: sum('imagePixels'),
            toolMs: Math.round(sum('toolMs') * 10) / 10,
            argsBytes: sum('argsBytes'),
            errors,
            tools: rows.flatMap((row) => row.calls.map((entry) => entry.tool)),
          };
        }
        console.log(`  [task] ${task.name} ${variant}: calls=${tasks[task.name][variant].calls} chars=${tasks[task.name][variant].resultChars}`);
      }
    }

    // 브라우저/서버 teardown 이 걸려도 결과는 이미 출력돼 있도록 여기서 찍는다.
    printSummary();
    // teardown(브라우저 close + 서버 2개 종료, 최악 ~10초)이 끝나지 않으면 강제
    // 종료한다 (unref — 정상 종료를 막지 않음). 자식 프로세스는 고아로 남지 않게
    // 먼저 SIGKILL 한다.
    setTimeout(() => {
      for (const child of [vite, hub]) {
        try { child?.kill('SIGKILL'); } catch { /* 이미 종료됨 */ }
      }
      process.exit(failed || process.exitCode ? 1 : 0);
    }, 30_000).unref();
  });
} catch (err) {
  console.error('벤치 실패:', err.message || err);
  failed = true;
} finally {
  await stopServer(vite);
  await stopServer(hub);
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
}

// 요약은 테스트 콜백 안에서 이미 출력됐다 (teardown 행 방지).
// puppeteer/자식 프로세스 핸들이 이벤트 루프를 붙들 수 있어 명시적으로 종료한다.
process.exit(failed || process.exitCode ? 1 : 0);
