/**
 * E2E: codex / grok / cursor 네이티브 서브에이전트 fleet 종단간.
 *
 * claude 용 subagent-fleet.test.mjs 와 같은 뼈대다 — PATH 를 가짜 CLI 로 가려
 * 프로덕션 경로 전체(하니스 파싱 → 허브 중계 → 사이드바 fleet 카드)를 구동한다.
 * 다만 세 제공자는 fleet 소스가 전부 달라서, 가짜 CLI 도 각자의 실측 배선을
 * 흉내 낸다:
 *   codex  — stdout 에는 자식 활동이 없다. 가짜가 $CODEX_HOME/sessions 아래
 *            부모·자식 롤아웃을 증분으로 쓰고 롤아웃 워처가 그걸 읽는다.
 *   grok   — 스폰 이후 stdout 귀속이 깨진다. 가짜가 $GROK_HOME/sessions 아래
 *            updates.jsonl 을 쓰고, stdout 으로는 자식 본문이 섞인 루트 델타를
 *            일부러 흘린다 (하니스가 전부 버려야 한다).
 *   cursor — stdout 하나뿐. 완료 시점에 자식 전사가 통째로 오고, 백그라운드
 *            서브에이전트는 system/task_notification 이 닫는다.
 *
 * 제공자마다 같은 네 지점을 본다:
 *   a. 스폰 직후 fleet 카드 + 에이전트 행 2개
 *   b. 자식이 살아 있는 동안 turn-end 가 없다 (조기 종료 = 정착 회귀)
 *   c. 자식 도구 호출이 루트 활동이 아니라 해당 행으로 귀속
 *   d. 정착 후 정확히 한 번의 turn-end, 모든 행 종결, 카드 라벨 완료
 * grok 은 여기에 "루트 본문이 깨지거나 중복되지 않는다"를 더한다.
 *
 * 실행: npm run e2e:provider-fleets (또는 e2e:codex-fleet / e2e:grok-fleet /
 *       e2e:cursor-fleet). headless Chrome + 자체 vite/허브 기동.
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
const HUB_TOKEN = 'e2e-provider-fleet';

/**
 * 가짜 CLI 는 허브가 PATH 에서 찾는 이름 그대로 심는다.
 * grok 만 전체 접근으로 연다 — 1.0.5 는 dontAsk 아래에서 spawn_subagent 승인을
 * 자동 취소하므로 fleet 이 실제로 뜨는 유일한 프로필이 --always-approve 다.
 */
const PROVIDERS = {
  codex: { bin: 'codex', script: 'fake-codex-fleet.mjs', model: 'gpt-5.6-sol', permission: 'safe' },
  grok: { bin: 'grok', script: 'fake-grok-fleet.mjs', model: 'grok-4.6', permission: 'unrestricted' },
  cursor: { bin: 'cursor-agent', script: 'fake-cursor-fleet.mjs', model: 'auto', permission: 'safe' },
};

const requested = (process.argv.find((arg) => arg.startsWith('--provider=')) ?? '')
  .replace('--provider=', '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const targets = requested.length > 0 ? requested : Object.keys(PROVIDERS);
for (const name of targets) {
  if (!PROVIDERS[name]) throw new Error(`알 수 없는 제공자: ${name} (codex|grok|cursor)`);
}

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

// ─── 가짜 CLI 세 개를 PATH 에 심는다 ───────────────────────────

const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-provider-fleet-stub-'));
const stubBinDir = path.join(stubRoot, 'bin');
const stubCliDir = path.join(stubRoot, 'cli'); // 빈 RHWP_CLI_DIR → 관리형 설치 없음 → PATH 사용
fs.mkdirSync(stubBinDir, { recursive: true });
fs.mkdirSync(stubCliDir, { recursive: true });
for (const name of targets) {
  const { bin, script } = PROVIDERS[name];
  const stubBin = path.join(stubBinDir, bin);
  fs.writeFileSync(stubBin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, script)}" "$@"\n`);
  fs.chmodSync(stubBin, 0o755);
}

// ─── 관찰 도우미 (브라우저 안에서 도는 조각들) ────────────────

/** 이번 턴에 만들어진 fleet 카드 한 장의 요약. */
const readFleet = () => {
  const card = document.querySelector('.ag-fleet');
  const rows = [...document.querySelectorAll('.ag-fleet .ag-fleet-row')];
  return {
    cards: document.querySelectorAll('.ag-fleet').length,
    cardText: card?.textContent ?? '',
    rowTexts: rows.map((row) => row.textContent ?? ''),
    liveRows: document.querySelectorAll('.ag-fleet .ag-fleet-row.ag-live').length,
    rootActivity: [...document.querySelectorAll('.ag-activity')].map((el) => el.textContent ?? '').join('\n'),
    // 루트 본문. 스폰 전 본문은 카드가 붙을 때 진행 이정표로 옮겨지므로
    // (.ag-progress-milestone) 두 형태를 함께 읽고, 그 안에 끼워진 fleet 카드와
    // 도구 활동 그룹은 걷어 낸다 — 순수한 루트 문장만 남긴다.
    rootText: [...document.querySelectorAll('.ag-msg-assistant, .ag-progress-milestone')].map((node) => {
      const clone = node.cloneNode(true);
      for (const nested of clone.querySelectorAll('.ag-fleet, .ag-activity')) nested.remove();
      return clone.textContent ?? '';
    }).join('\n'),
  };
};

const readCounts = () => ({
  turnEnds: window.__agentEvents.filter((t) => t === 'turn-end').length,
  taskStarts: window.__agentEvents.filter((t) => t === 'task-start').length,
  taskEnds: window.__agentEvents.filter((t) => t === 'task-end').length,
  // parentTaskId 없는 도구 호출 = 루트 활동. 스폰/수거 도구가 여기 섞이면 회귀다.
  rootTools: window.__rootToolCalls.slice(),
  // 자식 본문은 카드 행이 흡수하므로 DOM 에 남지 않는다 — 이벤트로 확인한다.
  childTexts: window.__childTexts.slice(),
});

// ─── 메인 ──────────────────────────────────────────────────────

if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(macChrome)) process.env.CHROME_PATH = macChrome;
}

const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || '5751'));
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || '7751'));
const viteUrl = `http://127.0.0.1:${vitePort}`;

console.log('=== E2E: 제공자별 서브에이전트 fleet (codex/grok/cursor) ===\n');
console.log(`  [setup] 허브 포트=${hubPort}, vite 포트=${vitePort}, 대상=${targets.join(', ')}`);

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
  path.join(repoRoot, 'target', 'rhwp-agent-provider-fleet-e2e-hub.log'),
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
  path.join(repoRoot, 'target', 'rhwp-studio-provider-fleet-e2e-vite.log'),
);
await waitForHttp(viteUrl, 'vite dev server', vite);

process.env.VITE_URL = viteUrl;
const helpers = await import('./helpers.mjs');
const { runTest, setTestCase, assert, loadApp, loadHwpFile, screenshot } = helpers;

let failed = false;
/** assert 실패는 process.exitCode 에 쌓인다 — 강제 종료 경로도 그걸 함께 본다. */
const exitStatus = () => (failed || process.exitCode ? 1 : 0);

/** 서버를 남기지 않고 즉시 끝낸다 (정리가 매달렸을 때의 탈출구). */
function forceExit(reason) {
  console.error(`[watchdog] ${reason} — 판정은 모두 끝났습니다`);
  for (const child of [vite, hub]) {
    try { child.kill('SIGKILL'); } catch {}
  }
  process.exit(exitStatus());
}

// 브라우저 종료가 매달리는 경우까지 덮는 전역 상한 — 판정(assert)은 그 전에 끝난다.
const globalWatchdog = setTimeout(() => forceExit('전체 상한 초과'), 600_000);
globalWatchdog.unref?.();

/** 채팅을 열고 fleet 이벤트 관찰자를 붙인 뒤 한 마디 보낸다. */
async function openChat(page, provider, prompt) {
  await page.waitForFunction(
    () => window.__agentBridge?.getConnectionState?.() === 'connected',
    { timeout: 20000 },
  );
  await loadHwpFile(page, SAMPLE);
  await page.evaluate(() => {
    window.__agentEvents = [];
    window.__rootToolCalls = [];
    window.__childTexts = [];
    window.__agentBridge.onEvent((e) => {
      if (e.type !== 'agent') return;
      window.__agentEvents.push(e.event.type);
      if (e.event.type === 'tool-call' && !e.event.parentTaskId) window.__rootToolCalls.push(e.event.tool);
      if (e.event.type === 'text-delta' && e.event.parentTaskId) {
        window.__childTexts.push(`${e.event.parentTaskId}|${e.event.text}`);
      }
    });
  });
  await page.evaluate(
    (agent, model, permission) => window.__agentBridge.startChat(
      agent, model, 'high', false, permission, 'direct',
      `provider-fleet-e2e-${agent}`, null, 'footnote-01.hwp',
    ),
    provider,
    PROVIDERS[provider].model,
    PROVIDERS[provider].permission,
  );
  await page.waitForFunction(
    (agent) => window.__agentBridge?.getActiveAgent?.() === agent,
    { timeout: 10000 },
    provider,
  );
  await page.evaluate((text) => { void window.__agentBridge.sendUserMessage(text); }, prompt);
}

/** 공통 마무리 판정 — 정착, 카드 상태, 루트 도구 행 목록, 자식 본문 귀속. */
async function assertSettled(page, provider, { rootTools, minChildTexts }) {
  setTestCase(`${provider} d. 완료 정착 — turn-end 정확히 1회`);
  await page.waitForFunction(
    () => window.__agentEvents.filter((t) => t === 'turn-end').length >= 1,
    { timeout: 45000 },
  );
  // 정착 유예 이후 추가 turn-end 가 없어야 한다.
  await delay(3000);
  const counts = await page.evaluate(readCounts);
  const fleet = await page.evaluate(readFleet);
  assert(counts.turnEnds === 1, `${provider}: turn-end 정확히 1회 (${counts.turnEnds})`);
  assert(counts.taskEnds >= 2, `${provider}: task-end 2건 이상 (${counts.taskEnds})`);
  assert(fleet.liveRows === 0, `${provider}: 모든 행이 종결 상태 (live=${fleet.liveRows})`);
  assert(/완료/.test(fleet.cardText), `${provider}: fleet 카드 라벨이 완료로 전환`);
  assert(fleet.cards === 1, `${provider}: fleet 카드는 한 장 (${fleet.cards})`);
  assert(
    JSON.stringify(counts.rootTools) === JSON.stringify(rootTools),
    `${provider}: 루트 도구 행은 [${rootTools}] 뿐 (실제 [${counts.rootTools}])`,
  );
  assert(
    counts.childTexts.length >= minChildTexts,
    `${provider}: 자식 본문 ${minChildTexts}건 이상이 parentTaskId 로 귀속 (${counts.childTexts.length})`,
  );
  await screenshot(page, `provider-fleet-${provider}-settled`);
}

const scenarios = {
  /**
   * codex: 롤아웃 워처가 유일한 fleet 소스다. stdout 의 collab_tool_call 은
   * 카드가 아니라 루트의 wait_agents 도구 행 한 줄로만 나와야 한다.
   */
  async codex(page) {
    await openChat(page, 'codex', '2쪽과 3쪽을 자식 에이전트로 나눠 정리해줘');

    setTestCase('codex a. 롤아웃 스폰 → fleet 카드 + 행 2개');
    await page.waitForSelector('.ag-fleet', { timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.ag-fleet .ag-fleet-row').length >= 2,
      { timeout: 20000 },
    );
    const live = await page.evaluate(readFleet);
    assert(live.rowTexts.length === 2, `codex: fleet 행 2개 (${live.rowTexts.length})`);
    assert(
      live.cardText.includes('page2_edit') && live.cardText.includes('page3_edit'),
      'codex: spawn_agent task_name 이 행 제목으로 표시',
    );
    assert(
      live.cardText.includes('Halley') && live.cardText.includes('Popper'),
      'codex: 자식 롤아웃의 agent_nickname 이 역할로 표시',
    );
    await screenshot(page, 'provider-fleet-codex-live');

    setTestCase('codex c. 자식 도구 호출 귀속 + wait 은 루트 행');
    await page.waitForFunction(
      () => (document.querySelector('.ag-fleet')?.textContent ?? '').includes('page2-check'),
      { timeout: 25000 },
    );
    await page.waitForFunction(
      () => [...document.querySelectorAll('.ag-activity')].some((el) => (el.textContent ?? '').includes('wait_agents')),
      { timeout: 25000 },
    );
    const routing = await page.evaluate(readFleet);
    const [rowA, rowB] = routing.rowTexts;
    assert(rowA.includes('page2-check'), 'codex: 첫 행에 자기 자식의 exec 호출');
    assert(rowB.includes('page3-check'), 'codex: 둘째 행에 자기 자식의 exec 호출');
    assert(!routing.rootActivity.includes('page2-check'), 'codex: 자식 exec 가 루트 활동으로 새지 않음');
    assert(routing.rootActivity.includes('wait_agents'), 'codex: collab_tool_call 은 루트 도구 행');
    assert(!routing.cardText.includes('wait_agents'), 'codex: wait 호출이 fleet 카드를 만들지 않음');
    assert(routing.rowTexts.length === 2, 'codex: wait 호출이 새 행을 만들지 않음');

    setTestCase('codex b. 자식이 도는 동안 턴 유지');
    const mid = await page.evaluate(readCounts);
    assert(mid.taskStarts === 2, `codex: task-start 2건 (${mid.taskStarts})`);
    assert(mid.turnEnds === 0, `codex: 자식 진행 중 turn-end 없음 (${mid.turnEnds})`);

    await assertSettled(page, 'codex', { rootTools: ['wait_agents'], minChildTexts: 2 });
    const done = await page.evaluate(readFleet);
    assert(
      done.rowTexts[0].includes('2쪽 표 정렬') && done.rowTexts[1].includes('3쪽 문단 서식'),
      'codex: FINAL_ANSWER 페이로드가 행 요약으로 표시',
    );
  },

  /**
   * grok: 스폰 이후 stdout 은 통째로 버려지고 본문·도구는 디스크에서 온다.
   * 루트 본문에 자식 조각(GARBLED-CHILD-LEAK)이 섞이거나 전환 전 본문이
   * 중복되면 회귀다.
   */
  async grok(page) {
    await openChat(page, 'grok', '2쪽과 3쪽을 병렬로 정리해줘');

    setTestCase('grok a. spawn_subagent → fleet 카드 + 행 2개');
    await page.waitForSelector('.ag-fleet', { timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.ag-fleet .ag-fleet-row').length >= 2,
      { timeout: 20000 },
    );
    const live = await page.evaluate(readFleet);
    assert(live.rowTexts.length === 2, `grok: fleet 행 2개 (${live.rowTexts.length})`);
    assert(
      live.cardText.includes('2쪽 표 정리') && live.cardText.includes('3쪽 서식 정리'),
      'grok: 스폰 description 이 행 제목으로 표시',
    );
    const spawnRows = await page.evaluate(readCounts);
    assert(
      !spawnRows.rootTools.includes('spawn_subagent'),
      'grok: 스폰이 루트 도구 행으로 새지 않음',
    );
    await screenshot(page, 'provider-fleet-grok-live');

    setTestCase('grok c. 자식 도구 호출 귀속 (디스크 출처)');
    await page.waitForFunction(
      () => (document.querySelector('.ag-fleet')?.textContent ?? '').includes('page2.md'),
      { timeout: 25000 },
    );
    const routing = await page.evaluate(readFleet);
    assert(routing.rowTexts[0].includes('page2.md'), 'grok: 첫 행에 자기 자식의 read_file');
    assert(routing.rowTexts[1].includes('page3.md'), 'grok: 둘째 행에 자기 자식의 read_file');
    assert(!routing.rootActivity.includes('read_file'), 'grok: 자식 도구가 루트 활동으로 새지 않음');

    setTestCase('grok b. 자식 하나가 남은 채 온 result 는 턴을 닫지 않는다');
    await page.waitForFunction(
      () => window.__agentEvents.filter((t) => t === 'task-end').length >= 1,
      { timeout: 30000 },
    );
    await delay(1200); // 이 사이에 stdout result 가 지나간다.
    const mid = await page.evaluate(readCounts);
    assert(mid.taskStarts === 2, `grok: task-start 2건 (${mid.taskStarts})`);
    assert(mid.turnEnds === 0, `grok: result 시점에 turn-end 없음 (${mid.turnEnds})`);

    // 스폰·수거·중단 메타 도구는 전부 task 이벤트가 대신한다 — 루트 행은 없다.
    await assertSettled(page, 'grok', { rootTools: [], minChildTexts: 2 });

    setTestCase('grok e. 루트 본문이 깨지지도 중복되지도 않는다');
    const text = (await page.evaluate(readFleet)).rootText;
    const intro = '2쪽과 3쪽을 서브에이전트 둘에게 나눠 맡기겠습니다.';
    assert(!text.includes('GARBLED-CHILD-LEAK'), 'grok: 다중화된 stdout 본문이 화면에 새지 않음');
    assert(text.includes(intro), 'grok: 전환 전 stdout 본문이 살아 있음');
    assert(text.split(intro).length - 1 === 1, 'grok: 디스크 재공급이 전환 전 본문을 중복시키지 않음');
    assert(
      text.includes('두 서브에이전트가 모두 끝났습니다'),
      'grok: 전환 후 루트 본문이 디스크에서 이어짐',
    );
    assert(
      !text.includes('표 너비를 맞췄습니다'),
      'grok: 자식 본문이 루트 말풍선에 이어 붙지 않음',
    );
  },

  /**
   * cursor: stdout 하나뿐. 완료 전사가 자식 이벤트로 재생되고, 백그라운드
   * 서브에이전트는 result 뒤에 오는 task_notification 이 닫는다.
   */
  async cursor(page) {
    await openChat(page, 'cursor', '2쪽과 3쪽을 서브에이전트로 나눠 정리해줘');

    setTestCase('cursor a. taskToolCall → fleet 카드 + 행 2개');
    await page.waitForSelector('.ag-fleet', { timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.ag-fleet .ag-fleet-row').length >= 2,
      { timeout: 20000 },
    );
    const live = await page.evaluate(readFleet);
    assert(live.rowTexts.length === 2, `cursor: fleet 행 2개 (${live.rowTexts.length})`);
    assert(
      live.cardText.includes('2쪽 표 정리') && live.cardText.includes('3쪽 서식 정리'),
      'cursor: TaskArgs.description 이 행 제목으로 표시',
    );
    assert(live.cardText.includes('doc-editor'), 'cursor: custom subagentType 이름이 역할로 표시');
    const spawnRows = await page.evaluate(readCounts);
    assert(spawnRows.rootTools.length === 0, `cursor: 스폰이 루트 도구 행으로 새지 않음 ([${spawnRows.rootTools}])`);
    await screenshot(page, 'provider-fleet-cursor-live');

    setTestCase('cursor c. 전사 재생이 해당 행으로 귀속');
    await page.waitForFunction(
      () => (document.querySelector('.ag-fleet')?.textContent ?? '').includes('replace_range'),
      { timeout: 25000 },
    );
    const routing = await page.evaluate(readFleet);
    const routed = await page.evaluate(readCounts);
    assert(routing.rowTexts[0].includes('replace_range'), 'cursor: 첫 행에 자식 MCP 도구 호출');
    assert(
      routed.childTexts.some((entry) => entry.startsWith('call-task-a|') && entry.includes('표 너비를 맞췄습니다')),
      'cursor: 전사의 assistantMessage 가 해당 카드로 귀속',
    );
    assert(!routing.rootActivity.includes('replace_range'), 'cursor: 자식 도구가 루트 활동으로 새지 않음');
    assert(
      !routing.rootText.includes('표 너비를 맞췄습니다'),
      'cursor: 자식 본문이 루트 말풍선으로 새지 않음',
    );

    setTestCase('cursor b. 백그라운드 카드가 열린 채 온 result 는 턴을 닫지 않는다');
    await page.waitForFunction(
      () => window.__agentEvents.filter((t) => t === 'task-end').length >= 1,
      { timeout: 30000 },
    );
    await delay(1500); // 이 사이에 result 와 정착 유예의 첫 구간이 지나간다.
    const mid = await page.evaluate(readCounts);
    assert(mid.taskStarts === 2, `cursor: task-start 2건 (${mid.taskStarts})`);
    assert(mid.turnEnds === 0, `cursor: result 시점에 turn-end 없음 (${mid.turnEnds})`);

    await assertSettled(page, 'cursor', { rootTools: [], minChildTexts: 2 });
    const done = await page.evaluate(readFleet);
    assert(
      done.rowTexts[1].includes('3쪽 문단 서식을 맞췄습니다'),
      'cursor: task_notification 의 detail 이 행 요약으로 표시',
    );
  },
};

try {
  // 브라우저는 한 번만 띄우고 제공자마다 앱을 새로 로드한다 — 카드/이벤트가
  // 이전 제공자와 섞이지 않으면서 크롬 기동 비용을 한 번만 낸다.
  await runTest('제공자별 서브에이전트 fleet 종단간', async ({ page }) => {
    for (const [index, provider] of targets.entries()) {
      if (index > 0) await loadApp(page);
      await scenarios[provider](page);
    }
    // 판정 끝. 이 환경의 puppeteer close 는 종종 돌아오지 않으므로(가짜 CLI 가
    // 살아 있는 동안 특히), 정리에 상한을 걸고 결과 코드를 지켜 낸다.
    const cleanupWatchdog = setTimeout(() => forceExit('브라우저 정리 상한 초과'), 20_000);
    cleanupWatchdog.unref?.();
  });
} catch (err) {
  console.error('테스트 환경 구동 실패:', err.message || err);
  failed = true;
} finally {
  // 서버 정리가 매달려도 판정은 이미 끝났다 — 상한을 두고 종료한다.
  const watchdog = setTimeout(() => forceExit('서버 정리 상한 초과'), 15_000);
  watchdog.unref?.();
  await stopServer(vite);
  await stopServer(hub);
  fs.rmSync(stubRoot, { recursive: true, force: true });
}

// 가짜 CLI 가 실제 CLI 처럼 생존하는 탓에 이벤트 루프 핸들이 남을 수 있다 —
// 단정이 모두 끝났으므로 명시적으로 종료한다.
process.exit(exitStatus());
