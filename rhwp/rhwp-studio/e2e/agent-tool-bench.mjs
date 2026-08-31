/**
 * 벤치마크: 에이전트 MCP 도구 호출 왕복 시간 측정 — hub → bridge → executor → wasm.
 *
 * agent-edit-loop.test.mjs 와 동일하게 실제 허브 + 가짜 MCP WS 클라이언트로
 * 프로덕션 경로를 그대로 구동하고, 도구 종류별 ms/op (p50/p95/평균)을 출력한다.
 * LLM 시간은 제외 — 순수 도구 파이프라인 시간만 측정한다.
 *
 * 실행: node e2e/agent-tool-bench.mjs --mode=headless
 * 결과: 마지막에 JSON 한 줄 (BENCH_RESULT: {...}) — 전후 비교용.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(studioRoot, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const SAMPLE = 'footnote-01.hwp';
const HUB_TOKEN = 'bench';

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

function connectMcpClient(hubPort, token, sessionId) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}&agent=claude`,
  );
  let nextId = 1;
  const inflight = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
    if (msg?.type !== 'tool-result') return;
    const entry = inflight.get(msg.id);
    if (!entry) return;
    inflight.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('MCP WS 연결 실패')), { once: true });
  });
  const call = (tool, args) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      // 허브의 STUDIO_TIMEOUT(30s+) 보다 넉넉하게 — verify/렌더 계열 여유분
      const timer = setTimeout(() => {
        inflight.delete(id);
        reject(new Error(`tool-call 응답 시간 초과: ${tool}`));
      }, 45000);
      inflight.set(id, { resolve, timer });
      ws.send(JSON.stringify({ v: 3, type: 'tool-call', id, tool, args }));
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

// helpers.mjs 는 모듈 로드 시점에 CHROME_PATH/VITE_URL 을 고정하므로 import 전에 세팅한다.
if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(macChrome)) process.env.CHROME_PATH = macChrome;
}

const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || '5741'));
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || '7741'));
const viteUrl = `http://127.0.0.1:${vitePort}`;

console.log('=== BENCH: 에이전트 MCP 도구 왕복 시간 ===\n');
console.log(`  [setup] 허브 포트=${hubPort}, vite 포트=${vitePort}`);

const hub = spawnLogged(
  process.execPath,
  [path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
  path.join(repoRoot, 'rhwp-agent'),
  { RHWP_AGENT_PORT: String(hubPort), RHWP_AGENT_TOKEN: HUB_TOKEN },
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
const { runTest, loadHwpFile } = helpers;

let lastRevision = null;
let failed = false;
const results = {};

function printSummary() {
  const summary = {};
  for (const [bucket, samples] of Object.entries(results)) {
    summary[bucket] = stats(samples);
  }
  console.log('\n  [bench] 도구별 왕복 ms:');
  for (const [bucket, s] of Object.entries(summary)) {
    console.log(`    ${bucket.padEnd(20)} n=${String(s.n).padStart(3)}  mean=${s.mean}  p50=${s.p50}  p95=${s.p95}  max=${s.max}`);
  }
  console.log(`\nBENCH_RESULT: ${JSON.stringify(summary)}`);
}

try {
  await runTest('에이전트 도구 벤치마크', async ({ page }) => {
    await page.waitForFunction(
      () => window.__agentBridge?.getConnectionState?.() === 'connected',
      { timeout: 20000 },
    );
    await loadHwpFile(page, SAMPLE);
    await page.evaluate(() => window.__agentBridge.startChat(
      'claude', 'sonnet', 'high', false, 'safe', 'direct',
      'agent-tool-bench', null, 'footnote-01.hwp',
    ));
    await page.waitForFunction(
      () => window.__agentBridge?.getActiveAgent?.() === 'claude',
      { timeout: 10000 },
    );

    const healthResponse = await fetch(`http://127.0.0.1:${hubPort}/healthz?token=${encodeURIComponent(HUB_TOKEN)}`);
    const health = await healthResponse.json();
    const sessionId = health.sessions?.[0]?.sessionId;
    if (!sessionId) throw new Error('Studio hub session was not registered');
    const capabilities = await registerHubSession({
      port: hubPort, token: HUB_TOKEN, launchId: health.launchId, sessionId,
    });
    const mcp = connectMcpClient(hubPort, capabilities.mcp, sessionId);
    await mcp.opened;
    const call = mcp.call;

    const callWrite = async (tool, args) => {
      const attempt = async (rev) => await call(tool, { ...args, expectedRevision: rev });
      let msg = await attempt(lastRevision);
      if (!msg.ok && msg.error?.code === 'REVISION_MISMATCH') {
        const fresh = must(await call('get_structure', {}), 'get_structure(revision 재조회)');
        msg = await attempt(fresh.revision);
      }
      const result = must(msg, tool);
      if (Number.isInteger(result.revision)) lastRevision = result.revision;
      return result;
    };

    const timed = async (bucket, fn) => {
      const t0 = performance.now();
      const r = await fn();
      const dt = performance.now() - t0;
      (results[bucket] ??= []).push(dt);
      return r;
    };

    try {
      const s0 = must(await call('get_structure', {}), 'get_structure');
      lastRevision = s0.revision;
      const paraCount = s0.sections[0].paragraphCount;
      const lastParaLen = s0.sections[0].paragraphs[paraCount - 1]?.length ?? 0;

      // 시드: 벤치 대상 문단들을 문서 끝에 추가
      await callWrite('insert_text', {
        sectionIdx: 0, paraIdx: paraCount - 1, charOffset: lastParaLen,
        text: '\n벤치마크 대상 문단입니다 이 문단의 텍스트는 교체와 서식 대상이 됩니다\n두번째 벤치 문단입니다',
      });
      const benchP = paraCount;

      // 웜업 (JIT/캐시 안정화)
      for (let i = 0; i < 5; i += 1) {
        must(await call('get_structure', {}), 'warmup');
        must(await call('get_text_range', { sectionIdx: 0, paraIdx: benchP }), 'warmup');
      }

      // ── 읽기 도구 ──
      for (let i = 0; i < 20; i += 1) {
        must(await timed('get_structure', () => call('get_structure', {})), 'get_structure');
      }
      for (let i = 0; i < 40; i += 1) {
        must(await timed('get_text_range', () => call('get_text_range', { sectionIdx: 0, paraIdx: benchP })), 'get_text_range');
      }
      for (let i = 0; i < 40; i += 1) {
        must(await timed('get_para_format', () => call('get_para_format', { sectionIdx: 0, paraIdx: benchP })), 'get_para_format');
      }

      // ── 쓰기 버스트: 순차 insert_text 40회 (에이전트 버스트 재현) ──
      const burstStart = performance.now();
      for (let i = 0; i < 40; i += 1) {
        await timed('insert_text', () => callWrite('insert_text', {
          sectionIdx: 0, paraIdx: benchP, charOffset: 0, text: `버스트${i} `,
        }));
      }
      results.insert_burst_total = [performance.now() - burstStart];

      // ── replace_range 20회 ──
      for (let i = 0; i < 20; i += 1) {
        await timed('replace_range', () => callWrite('replace_range', {
          sectionIdx: 0, startParaIdx: benchP, startCharOffset: 0,
          endParaIdx: benchP, endCharOffset: 4, text: `교체${i % 10}함`,
        }));
      }

      // ── apply_char_format 20회 ──
      for (let i = 0; i < 20; i += 1) {
        await timed('apply_char_format', () => callWrite('apply_char_format', {
          sectionIdx: 0, paraIdx: benchP, startOffset: 0, endOffset: 4, bold: i % 2 === 0,
        }));
      }

      // ── 혼합 시퀀스 (read → write → verify 읽기): 에이전트 1턴 근사 ──
      for (let i = 0; i < 10; i += 1) {
        await timed('mixed_turn', async () => {
          must(await call('get_text_range', { sectionIdx: 0, paraIdx: benchP }), 'mixed read');
          await callWrite('insert_text', { sectionIdx: 0, paraIdx: benchP, charOffset: 0, text: '턴 ' });
          must(await call('get_text_range', { sectionIdx: 0, paraIdx: benchP }), 'mixed verify');
        });
      }

      // ── apply_edits: 8개 삽입을 배치 한 번에 (개별 insert_text 8회와 비교) ──
      for (let i = 0; i < 10; i += 1) {
        await timed('apply_edits_8', () => callWrite('apply_edits', {
          edits: Array.from({ length: 8 }, (_, k) => ({
            tool: 'insert_text',
            args: { sectionIdx: 0, paraIdx: benchP, charOffset: 0, text: `배치${i}-${k} ` },
          })),
        }));
      }

      // ── verify_changes (이미지 없음) ──
      for (let i = 0; i < 5; i += 1) {
        must(await timed('verify_changes', () => call('verify_changes', {})), 'verify_changes');
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
        process.exit(failed ? 1 : 0);
      }, 30_000).unref();
    } finally {
      try { mcp.ws.close(); } catch { /* 이미 닫힌 소켓 무시 */ }
    }
  });
} catch (err) {
  console.error('벤치 실패:', err.message || err);
  failed = true;
} finally {
  await stopServer(vite);
  await stopServer(hub);
}

// 요약은 테스트 콜백 안에서 이미 출력됐다 (teardown 행 방지).
// puppeteer/자식 프로세스 핸들이 이벤트 루프를 붙들 수 있어 명시적으로 종료한다.
process.exit(failed ? 1 : 0);
