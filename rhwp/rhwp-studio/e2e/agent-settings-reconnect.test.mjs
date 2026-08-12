/**
 * E2E: 허브 재연결 수명주기 + 설정 페이지 — 실제 서버 기동/중단으로 검증한다.
 *
 * 시나리오 (허브를 실제로 껐다 켜며 진행):
 *   a. 허브 없이 로드 → 채팅에 연결 배너(재시도 카운트다운 + 지금 다시 연결)가 뜬다
 *   b. 허브 기동 → 백오프 자동 재시도로 붙고 배너가 사라진다 (기동 순서 무관 복구)
 *   c. 설정 페이지 — 연결/기본 설정/글쓰기 보정/사용량 네 구역, 제공자 프로브 결과 표시
 *   d. 허브 강제 종료 → 배너 재등장, [지금 다시 연결] 클릭이 즉시 재시도를 건다
 *   e. 허브 재기동 → 다시 자동 복구
 *
 * 실행: npm run e2e:agent-settings-reconnect   (headless Chrome + 자체 vite/허브 기동)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(studioRoot, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const HUB_TOKEN = 'e2e';

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

// helpers.mjs 는 모듈 로드 시점에 CHROME_PATH/VITE_URL 을 고정하므로 import 전에 세팅한다.
if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(macChrome)) process.env.CHROME_PATH = macChrome;
}

const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || '5741'));
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || '7741'));
const viteUrl = `http://127.0.0.1:${vitePort}`;
fs.mkdirSync(path.join(repoRoot, 'target'), { recursive: true });
const usageDir = fs.mkdtempSync(path.join(repoRoot, 'target', 'rhwp-usage-e2e-'));

console.log('=== E2E: 설정·재연결 수명주기 (agent-settings-reconnect) ===\n');
console.log(`  [setup] 허브 포트=${hubPort}, vite 포트=${vitePort}`);

let hub = null;
function startHub() {
  hub = spawnLogged(
    process.execPath,
    [path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
    path.join(repoRoot, 'rhwp-agent'),
    { RHWP_AGENT_PORT: String(hubPort), RHWP_AGENT_TOKEN: HUB_TOKEN, RHWP_USAGE_DIR: usageDir },
    path.join(repoRoot, 'target', 'rhwp-agent-settings-e2e-hub.log'),
  );
  return waitForHttp(`http://127.0.0.1:${hubPort}/healthz`, 'rhwp-agent 허브', hub);
}

const vite = spawnLogged(
  npmCmd,
  ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
  studioRoot,
  {
    BROWSER: 'none',
    VITE_RHWP_AGENT_URL: `ws://127.0.0.1:${hubPort}`,
    VITE_RHWP_AGENT_TOKEN: HUB_TOKEN,
  },
  path.join(repoRoot, 'target', 'rhwp-studio-settings-e2e-vite.log'),
);
await waitForHttp(viteUrl, 'vite dev server', vite);

process.env.VITE_URL = viteUrl;
const { runTest, setTestCase, assert, screenshot } = await import('./helpers.mjs');

const connText = (page) =>
  page.evaluate(() => document.querySelector('#agent-sidebar .ag-conn')?.textContent ?? '');

try {
  await runTest('설정·재연결 수명주기', async ({ page }) => {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.waitForSelector('#agent-sidebar .ag-conn');

    // a. 허브 없음 → 배너 + 재시도 버튼 -------------------------------------
    setTestCase('a. 허브 부재 시 연결 배너');
    await page.waitForFunction(
      () => {
        const banner = document.querySelector('#agent-sidebar .ag-conn-banner');
        return banner && !banner.hidden;
      },
      { timeout: 15000 },
    );
    const bannerText = await page.evaluate(
      () => document.querySelector('.ag-conn-banner-text')?.textContent ?? '',
    );
    assert(bannerText.includes('연결이 끊어졌어요'), `배너 문구: ${bannerText}`);
    const retryVisible = await page.evaluate(() => {
      const btn = document.querySelector('.ag-conn-banner-retry');
      return !!btn && btn.offsetParent !== null && btn.textContent === '지금 다시 연결';
    });
    assert(retryVisible, '재시도 버튼이 보여야 한다');
    await screenshot(page, 'reconnect-banner-no-hub');

    // b. 허브 기동 → 자동 복구 ----------------------------------------------
    setTestCase('b. 허브 기동 후 자동 재연결');
    await startHub();
    await page.waitForFunction(
      () => document.querySelector('#agent-sidebar .ag-conn')?.textContent === '연결됨',
      { timeout: 20000 },
    );
    const bannerHidden = await page.evaluate(
      () => document.querySelector('#agent-sidebar .ag-conn-banner')?.hidden === true,
    );
    assert(bannerHidden, '연결되면 배너가 사라져야 한다');
    await screenshot(page, 'reconnect-recovered');

    // c. 설정 페이지 ---------------------------------------------------------
    setTestCase('c. 설정 페이지 구성');
    await page.click('#agent-sidebar .ag-settings-btn');
    await page.waitForFunction(
      () => document.querySelector('#agent-sidebar')?.classList.contains('ag-settings-open'),
    );
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 350)));
    const settings = await page.evaluate(() => {
      const panel = document.querySelector('#ag-settings-panel');
      const sections = [...(panel?.querySelectorAll('.ag-settings-section-title') ?? [])]
        .map((n) => n.textContent);
      return {
        sections,
        hubDetail: panel?.querySelector('.ag-settings-hub-row .ag-settings-row-detail')?.textContent,
        providerRows: panel?.querySelectorAll('.ag-settings-provider-row').length ?? 0,
        hasPlanSelect: !!panel?.querySelector('.ag-settings-select'),
        ariaHidden: panel?.getAttribute('aria-hidden'),
      };
    });
    assert(settings.ariaHidden === 'false', '설정 페이지가 열려야 한다');
    for (const name of ['연결', '기본 설정', '글쓰기 보정', '사용량']) {
      assert(settings.sections.includes(name), `${name} 구역이 있어야 한다 (${settings.sections})`);
    }
    assert(settings.hubDetail === '연결됨', `허브 행 상태: ${settings.hubDetail}`);
    assert(settings.providerRows === 2, `제공자 행 2개여야 한다: ${settings.providerRows}`);
    // 제공자 프로브는 비동기 — 두 행 모두 '확인 중…' 이 걷힐 때까지 기다린다.
    await page.waitForFunction(
      () => [...document.querySelectorAll('.ag-settings-provider-row .ag-settings-row-detail')]
        .every((n) => n.textContent && n.textContent !== '확인 중…'),
      { timeout: 20000 },
    );
    await screenshot(page, 'settings-page');

    // d. 허브 종료 → 배너 재등장 + 수동 재시도 -------------------------------
    setTestCase('d. 허브 중단 감지와 수동 재시도');
    await stopServer(hub);
    await page.waitForFunction(
      () => {
        const banner = document.querySelector('#agent-sidebar .ag-conn-banner');
        return banner && !banner.hidden;
      },
      { timeout: 15000 },
    );
    // 설정 페이지의 허브 행도 함께 갱신된다.
    const hubDetailDown = await page.evaluate(
      () => document.querySelector('.ag-settings-hub-row .ag-settings-row-detail')?.textContent,
    );
    assert(hubDetailDown !== '연결됨', `끊김이 설정에도 반영돼야 한다: ${hubDetailDown}`);
    // 수동 재시도 — 허브가 죽어 있으니 즉시 실패하고 카운트다운으로 되돌아온다.
    // (즉시 시도 자체는 단위 테스트가 reconnectNow 호출로 보증한다.)
    await page.click('.ag-conn-banner-retry');
    await delay(1200);
    const retryText = await page.evaluate(
      () => document.querySelector('.ag-conn-banner-text')?.textContent ?? '',
    );
    assert(
      retryText.includes('다시 연결 중') || retryText.includes('재시도'),
      `수동 재시도 후 배너 문구: ${retryText}`,
    );
    await screenshot(page, 'reconnect-banner-after-kill');

    // e. 허브 재기동 → 다시 자동 복구 ----------------------------------------
    setTestCase('e. 허브 재기동 후 재복구');
    await startHub();
    await page.waitForFunction(
      () => document.querySelector('#agent-sidebar .ag-conn')?.textContent === '연결됨',
      { timeout: 20000 },
    );
    await screenshot(page, 'reconnect-recovered-again');
  });
} finally {
  await stopServer(hub);
  await stopServer(vite);
  fs.rmSync(usageDir, { recursive: true, force: true });
}
