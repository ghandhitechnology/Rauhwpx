/**
 * E2E: 서브에이전트 fleet 종단간 — 가짜 claude CLI → 하니스 파싱 → 허브 → 사이드바.
 *
 * PATH 를 가짜 claude(fake-claude-fleet.mjs)로 가려 실제 프로덕션 경로 전체를
 * 구동한다: claude.mjs 의 task 수명주기 파싱·다중 result 턴 정착, 허브의
 * agent-event 중계, 사이드바 fleet 카드 렌더링. 검증 순서:
 *   a. 스폰 직후 fleet 카드 + 에이전트 행 2개 (작업 중 상태)
 *   b. 첫 result 뒤에도 턴이 열려 있다 (조기 turn-end = 정착 회귀)
 *   c. parentTaskId 붙은 도구 호출이 루트 활동이 아니라 해당 행으로 귀속
 *   d. 두 task 완료 후에야 정확히 한 번의 turn-end, 카드 라벨 완료 전환
 *
 * 실행: npm run e2e:subagent-fleet   (headless Chrome + 자체 vite/허브 기동)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(studioRoot, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const SAMPLE = 'footnote-01.hwp';
const HUB_TOKEN = 'e2e-fleet';

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

// ─── 가짜 claude 를 PATH 에 심는다 ─────────────────────────────

const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-fleet-stub-'));
const stubBinDir = path.join(stubRoot, 'bin');
const stubCliDir = path.join(stubRoot, 'cli'); // 빈 RHWP_CLI_DIR → 관리형 설치 없음 → PATH 의 claude 사용
fs.mkdirSync(stubBinDir, { recursive: true });
fs.mkdirSync(stubCliDir, { recursive: true });
const stubScript = path.join(__dirname, 'fake-claude-fleet.mjs');
const stubBin = path.join(stubBinDir, 'claude');
fs.writeFileSync(stubBin, `#!/bin/sh\nexec "${process.execPath}" "${stubScript}" "$@"\n`);
fs.chmodSync(stubBin, 0o755);

// ─── 메인 ──────────────────────────────────────────────────────

if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(macChrome)) process.env.CHROME_PATH = macChrome;
}

const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || '5741'));
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || '7741'));
const viteUrl = `http://127.0.0.1:${vitePort}`;

console.log('=== E2E: 서브에이전트 fleet (subagent-fleet) ===\n');
console.log(`  [setup] 허브 포트=${hubPort}, vite 포트=${vitePort}, 가짜 claude=${stubBin}`);

const hub = spawnLogged(
  process.execPath,
  [path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
  path.join(repoRoot, 'rhwp-agent'),
  {
    RHWP_AGENT_PORT: String(hubPort),
    RHWP_AGENT_TOKEN: HUB_TOKEN,
    RHWP_CLI_DIR: stubCliDir,
    PATH: `${stubBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
  },
  path.join(repoRoot, 'target', 'rhwp-agent-fleet-e2e-hub.log'),
);
await waitForHttp(`http://127.0.0.1:${hubPort}/healthz?token=${encodeURIComponent(HUB_TOKEN)}`, 'rhwp-agent 허브', hub);

const vite = spawnLogged(
  npmCmd,
  ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
  studioRoot,
  {
    BROWSER: 'none',
    VITE_RHWP_AGENT_URL: `ws://127.0.0.1:${hubPort}`,
    VITE_RHWP_AGENT_TOKEN: HUB_TOKEN,
  },
  path.join(repoRoot, 'target', 'rhwp-studio-fleet-e2e-vite.log'),
);
await waitForHttp(viteUrl, 'vite dev server', vite);

process.env.VITE_URL = viteUrl;
const helpers = await import('./helpers.mjs');
const { runTest, setTestCase, assert, loadHwpFile, screenshot } = helpers;

let failed = false;
// 브라우저 종료가 매달리는 경우까지 덮는 전역 상한 — 판정(assert)은 그 전에 끝난다.
const globalWatchdog = setTimeout(() => {
  console.error('[watchdog] 정리 단계가 매달려 강제 종료합니다');
  process.exit(failed ? 1 : 0);
}, 240_000);
globalWatchdog.unref?.();
try {
  await runTest('서브에이전트 fleet 종단간', async ({ page }) => {
    await page.waitForFunction(
      () => window.__agentBridge?.getConnectionState?.() === 'connected',
      { timeout: 20000 },
    );
    await loadHwpFile(page, SAMPLE);

    // 에이전트 이벤트 관찰자 — turn-end 시점/횟수 검증용
    await page.evaluate(() => {
      window.__agentEvents = [];
      window.__agentBridge.onEvent((e) => {
        if (e.type === 'agent') window.__agentEvents.push(e.event.type);
      });
    });

    await page.evaluate(() => window.__agentBridge.startChat(
      'claude', 'sonnet', 'high', false, 'safe', 'direct',
      'subagent-fleet-e2e', null, 'footnote-01.hwp',
    ));
    await page.waitForFunction(
      () => window.__agentBridge?.getActiveAgent?.() === 'claude',
      { timeout: 10000 },
    );

    setTestCase('a. 스폰 → fleet 카드 + 행 2개');
    await page.evaluate(() => { void window.__agentBridge.sendUserMessage('2쪽과 3쪽을 병렬로 정리해줘'); });
    await page.waitForSelector('.ag-fleet', { timeout: 20000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.ag-fleet .ag-fleet-row').length >= 2,
      { timeout: 10000 },
    );
    const liveState = await page.evaluate(() => ({
      rows: document.querySelectorAll('.ag-fleet .ag-fleet-row').length,
      cardText: document.querySelector('.ag-fleet')?.textContent ?? '',
    }));
    assert(liveState.rows === 2, `fleet 행 2개 렌더 (rows=${liveState.rows})`);
    assert(
      liveState.cardText.includes('2쪽 정리') && liveState.cardText.includes('3쪽 정리'),
      'fleet 행에 task 제목 표시',
    );
    await screenshot(page, 'subagent-fleet-live');

    setTestCase('b. 첫 result 뒤에도 턴 유지');
    // 가짜 CLI 는 스폰 직후 result #1 을 이미 흘렸다 — 이 시점에 turn-end 가
    // 오면 정착 회귀다 (task 2건이 아직 진행 중).
    const midTurn = await page.evaluate(() => ({
      turnEnds: window.__agentEvents.filter((t) => t === 'turn-end').length,
      taskStarts: window.__agentEvents.filter((t) => t === 'task-start').length,
    }));
    assert(midTurn.taskStarts === 2, `task-start 2건 수신 (${midTurn.taskStarts})`);
    assert(midTurn.turnEnds === 0, `첫 result 시점에 turn-end 없음 (${midTurn.turnEnds})`);

    setTestCase('c. 서브에이전트 도구 호출 귀속');
    // 행 안에 해당 서브에이전트의 도구 호출이 나타난다 (루트 활동 그룹이 아니라)
    await page.waitForFunction(
      () => (document.querySelector('.ag-fleet')?.textContent ?? '').includes('replace_range'),
      { timeout: 15000 },
    );
    const routing = await page.evaluate(() => {
      const fleetText = document.querySelector('.ag-fleet')?.textContent ?? '';
      const rootActivityText = [...document.querySelectorAll('.ag-activity')]
        .map((el) => el.textContent ?? '').join('\n');
      return {
        fleetHasA: fleetText.includes('replace_range'),
        fleetHasB: fleetText.includes('insert_text'),
        rootHasChild: rootActivityText.includes('replace_range') || rootActivityText.includes('insert_text'),
      };
    });
    assert(routing.fleetHasA && routing.fleetHasB, 'fleet 행에 서브에이전트 도구 호출 표시');
    assert(!routing.rootHasChild, '루트 활동 그룹에는 서브에이전트 도구가 새지 않음');

    setTestCase('d. 완료 정착 — turn-end 정확히 1회');
    await page.waitForFunction(
      () => window.__agentEvents.filter((t) => t === 'turn-end').length >= 1,
      { timeout: 30000 },
    );
    // 정착 유예(1.5s) 이후 추가 turn-end 가 없어야 한다
    await delay(2500);
    const settled = await page.evaluate(() => ({
      turnEnds: window.__agentEvents.filter((t) => t === 'turn-end').length,
      taskEnds: window.__agentEvents.filter((t) => t === 'task-end').length,
      cardText: document.querySelector('.ag-fleet')?.textContent ?? '',
      liveRows: document.querySelectorAll('.ag-fleet .ag-fleet-row.ag-live').length,
    }));
    assert(settled.turnEnds === 1, `turn-end 정확히 1회 (${settled.turnEnds})`);
    assert(settled.taskEnds >= 2, `task-end 2건 이상 수신 (${settled.taskEnds})`);
    assert(settled.liveRows === 0, `모든 행이 종결 상태 (live=${settled.liveRows})`);
    assert(/완료/.test(settled.cardText), 'fleet 카드 라벨이 완료로 전환');
    await screenshot(page, 'subagent-fleet-settled');
  });
} catch (err) {
  console.error('테스트 환경 구동 실패:', err.message || err);
  failed = true;
} finally {
  // 브라우저/서버 정리가 어디선가 매달려도 판정은 이미 끝났다 — 상한을 두고 종료한다.
  const watchdog = setTimeout(() => process.exit(failed ? 1 : 0), 15_000);
  watchdog.unref?.();
  await stopServer(vite);
  await stopServer(hub);
  fs.rmSync(stubRoot, { recursive: true, force: true });
}

// 가짜 CLI 가 실제 CLI 처럼 생존하는 탓에 이벤트 루프 핸들이 남을 수 있다 —
// 단정이 모두 끝났으므로 명시적으로 종료한다.
process.exit(failed ? 1 : 0);
