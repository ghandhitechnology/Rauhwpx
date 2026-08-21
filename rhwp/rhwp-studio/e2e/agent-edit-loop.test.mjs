/**
 * E2E: 에이전트 편집 루프 종단간 검증 — hub → bridge → executor → pending → wasm 렌더.
 *
 * 실제 rhwp-agent 허브(server.mjs)를 테스트 포트로 띄우고, mcp-stdio.mjs 와 동일한
 * `{v:3,type:'tool-call',id,tool,args}` 프레임을 보는 가짜 MCP WS 클라이언트로
 * 스튜디오의 에이전트 도구 표면을 프로덕션 경로 그대로 구동한다. 검증 순서:
 *   a. get_structure revision 반환 + write 툴 expectedRevision 게이트(REVISION_MISMATCH)
 *   b. replace_range 원자성(단일 'replace' op) + 삽입 텍스트의 교체 구간 글자 서식 상속
 *   c. apply_list format '1)'/'1.' level 1 → 숫자 번호 (기존 정의와의 재사용 충돌에서도
 *      문서 기본 가,나,다 가 아님을 렌더로 확인)
 *   d. preview_equation 깨진 스크립트 warnings+metrics / insert_equation fontSizePt 상속
 *   e. verify_changes per-op 요약 + postEditText 다이제스트 + includeImage PNG 블록
 *   f. 인라인 수식 줄바꿈 — 수식 bbox/텍스트 런이 열 오른쪽 가장자리를 넘지 않음
 *   g. pageBreakBefore 문단의 멀티라인 삽입이 continuation마다 쪽 나눔을 복제하지 않음
 *   h. pending/approve/권위 refresh의 page map 동일 + 문서 상태 영속
 *
 * 실행: npm run e2e:agent-edit-loop   (headless Chrome + 자체 vite/허브 프로세스 기동)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { issueScopedHubToken } from '../../rhwp-agent/hub-session-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(studioRoot, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const SAMPLE = 'footnote-01.hwp';
const HUB_TOKEN = 'e2e';

// ─── 서버 프로세스 유틸 (run-render-diff.mjs 패턴) ─────────────

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
      // 허브의 STUDIO_TIMEOUT(30s) 보다 넉넉하게 — includeImage PNG 렌더 여유분
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

/** tool-result 언랩 — 실패 시 코드를 담아 throw */
function must(msg, label) {
  if (!msg?.ok) {
    const code = msg?.error?.code ?? 'NO_RESPONSE';
    const message = msg?.error?.message ?? '(no message)';
    throw new Error(`${label} 실패 [${code}] ${message}`);
  }
  return msg.result;
}

// ─── 메인 ──────────────────────────────────────────────────────

// helpers.mjs 는 모듈 로드 시점에 CHROME_PATH/VITE_URL 을 고정하므로 import 전에 세팅한다.
if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(macChrome)) process.env.CHROME_PATH = macChrome;
}

const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || '5731'));
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || '7731'));
const viteUrl = `http://127.0.0.1:${vitePort}`;

console.log('=== E2E: 에이전트 편집 루프 (agent-edit-loop) ===\n');
console.log(`  [setup] 허브 포트=${hubPort}, vite 포트=${vitePort}`);

const hub = spawnLogged(
  process.execPath,
  [path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
  path.join(repoRoot, 'rhwp-agent'),
  { RHWP_AGENT_PORT: String(hubPort), RHWP_AGENT_TOKEN: HUB_TOKEN },
  path.join(repoRoot, 'target', 'rhwp-agent-e2e-hub.log'),
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
  path.join(repoRoot, 'target', 'rhwp-studio-agent-e2e-vite.log'),
);
await waitForHttp(viteUrl, 'vite dev server', vite);

process.env.VITE_URL = viteUrl;
const helpers = await import('./helpers.mjs');
const { runTest, setTestCase, assert, loadHwpFile, screenshot } = helpers;

// 테스트가 쓰는 본문 (한글 음절 = UTF-16 1유닛 — JS length 와 charOffset 이 일치한다)
const FILLER =
  '에이전트 줄바꿈 검증용 채움 문단입니다 이 문장은 첫 줄을 가득 채우고 다음 줄로 '
  + '넘어가야 하므로 일부러 아주 길게 작성한 문장입니다 끝';
const L1 = '첫째 에이전트 목록 항목입니다';
const L2 = '둘째 항목의 원본 텍스트 구간입니다';
const L3 = '셋째 에이전트 목록 항목입니다';
// L2 오프셋 지도: 둘0 째1 ␣2 항3 목4 의5 ␣6 원7 본8 ␣9 텍10 스11 트12 ␣13 구14 간15 입16 니17 다18
const BOLD_START = 6;   // ' 원본 텍스트 ' (공백 포함 8자)
const BOLD_END = 14;
const REPLACE_START = 7; // '원본'
const REPLACE_END = 9;
const REPLACE_TEXT = '교체';
const EQ_SCRIPT = 'x = {-b +- sqrt {b^2 - 4ac}} over {2a}';

// write 툴 호출 — REVISION_MISMATCH 시 revision 을 다시 읽고 1회 재시도 (문서화된 에이전트 절차)
let lastRevision = null;
async function callWrite(call, tool, args) {
  const attempt = async (rev) => await call(tool, { ...args, expectedRevision: rev });
  let msg = await attempt(lastRevision);
  if (!msg.ok && msg.error?.code === 'REVISION_MISMATCH') {
    const fresh = must(await call('get_structure', {}), 'get_structure(revision 재조회)');
    msg = await attempt(fresh.revision);
  }
  const result = must(msg, tool);
  if (Number.isInteger(result.revision)) lastRevision = result.revision;
  return result;
}

let failed = false;
try {
  await runTest('에이전트 편집 루프 종단간', async ({ page }) => {
    // 스튜디오가 테스트 허브에 붙을 때까지 대기 (bridge 는 앱 초기화 시 자동 접속)
    await page.waitForFunction(
      () => window.__agentBridge?.getConnectionState?.() === 'connected',
      { timeout: 20000 },
    );
    console.log('  [bridge] 스튜디오 ↔ 테스트 허브 연결 확인');

    await loadHwpFile(page, SAMPLE);

    // MCP 도구는 실제 채팅 세션의 workflow/권한 아래에서만 허용된다. 메시지를
    // 보내지 않으므로 CLI 프로세스는 시작하지 않고, 허브 권한 상태만 direct로 연다.
    await page.evaluate(() => window.__agentBridge.startChat(
      'claude', 'sonnet', 'high', false, 'safe', 'direct',
      'agent-edit-loop-e2e', null, 'footnote-01.hwp',
    ));
    await page.waitForFunction(
      () => window.__agentBridge?.getActiveAgent?.() === 'claude',
      { timeout: 10000 },
    );

    const healthResponse = await fetch(`http://127.0.0.1:${hubPort}/healthz?token=${encodeURIComponent(HUB_TOKEN)}`);
    const health = await healthResponse.json();
    const sessionId = health.sessions?.[0]?.sessionId;
    if (!sessionId) throw new Error('Studio hub session was not registered');
    const mcp = connectMcpClient(hubPort, issueScopedHubToken(HUB_TOKEN, sessionId), sessionId);
    await mcp.opened;
    const call = mcp.call;
    try {
      // ── a. revision 게이트 ─────────────────────────────────
      setTestCase('a. revision / REVISION_MISMATCH');
      const s0 = must(await call('get_structure', {}), 'get_structure');
      assert(
        Number.isInteger(s0.revision) && s0.revision >= 1,
        `get_structure 가 revision 을 반환 (revision=${s0.revision})`,
      );
      const paraCount = s0.sections[0].paragraphCount;
      const lastParaLen = s0.sections[0].paragraphs[paraCount - 1]?.length ?? 0;
      assert(paraCount >= 1, `샘플 문서 문단 수: ${paraCount}`);
      lastRevision = s0.revision;

      const stale = await call('insert_text', {
        expectedRevision: s0.revision + 999,
        sectionIdx: 0, paraIdx: paraCount - 1, charOffset: 0, text: 'x',
      });
      assert(
        !stale.ok && stale.error?.code === 'REVISION_MISMATCH',
        `오래된 expectedRevision → REVISION_MISMATCH (실제: ${stale.ok ? '성공(버그)' : stale.error?.code})`,
      );

      // 문서에 미리 존재하는 번호 정의 — 재사용 충돌 검증(c 절)의 기준선
      const preNumberings = must(await call('list_numberings', {}), 'list_numberings(기존 정의)');
      const preNumberingIds = (preNumberings.numberings ?? []).map((n) => n.id);
      console.log(`  [list] 기존 번호 정의 ${preNumberingIds.length}건: ${JSON.stringify(preNumberings.numberings)}`);

      // ── 본문 시드: 채움 문단 + 목록 후보 3문단을 문서 끝에 추가 ──
      // 첫 write 의 pending 생존을 단정한다 — 과거에는 로드 직후 첫 write 가 dirty
      // false→true 전이의 discardAll('document loaded') 에 걸려 pending op 이
      // 유실됐으나, pending-edits.ts 의 null-digest 초기 동기화 가드로 수정됐다.
      await page.evaluate(() => {
        window.__pendingEvents = [];
        window.__agentBridge.pendingEdits.onChange((e) => window.__pendingEvents.push(e.type));
      });
      await callWrite(call, 'insert_text', {
        sectionIdx: 0, paraIdx: paraCount - 1, charOffset: lastParaLen, text: ' ',
      });
      const firstWrite = await page.evaluate(() => ({
        pending: window.__agentBridge.pendingEdits.hasPending(),
        events: window.__pendingEvents,
      }));
      assert(
        firstWrite.pending === true && !firstWrite.events.includes('invalidated'),
        `첫 write op 이 pending 으로 유지 (pending=${firstWrite.pending}, events=${JSON.stringify(firstWrite.events)})`,
      );
      // 측정 대상 op 들과 섞이지 않도록 첫 write set 은 approve 로 정리해 동일한 출발 상태를 만든다
      const warmupIds = await page.evaluate(() => window.__agentBridge.pendingEdits.getChangeSets().map((s) => s.id));
      for (const id of warmupIds) {
        await page.evaluate((i) => window.__agentBridge.pendingEdits.approve(i), id);
      }
      // 첫 write 가 마지막 문단 끝에 공백을 추가했으므로 좌표를 다시 읽는다
      const s1 = must(await call('get_structure', {}), 'get_structure(첫 write 후)');
      lastRevision = s1.revision;
      const seedBase = s1.sections[0].paragraphCount;
      const seedBaseLen = s1.sections[0].paragraphs[seedBase - 1]?.length ?? 0;

      // 영구 회귀 재현 조건: pageBreakBefore가 켜진 문단에서 agent multiline insert.
      // splitParagraph의 일반 Enter 상속을 그대로 쓰면 모든 continuation이 이 속성을
      // 받아 각 문단이 별도 페이지가 되고, IR에 저장되어 approve 후에도 남는다.
      await callWrite(call, 'insert_page_break', { sectionIdx: 0, paraIdx: seedBase - 1 });
      const ins = await callWrite(call, 'insert_text', {
        sectionIdx: 0, paraIdx: seedBase - 1, charOffset: seedBaseLen,
        text: `\n${FILLER}\n${L1}\n${L2}\n${L3}`,
      });
      const fillerP = seedBase;
      const l1P = seedBase + 1;
      const l2P = seedBase + 2;
      const l3P = seedBase + 3;
      assert(
        ins.insertedRange?.endParaIdx === l3P,
        `insert_text 다중 문단 삽입 (끝 문단=${ins.insertedRange?.endParaIdx}, 기대 ${l3P})`,
      );
      const seed = must(
        await call('get_text_range', { sectionIdx: 0, paraIdx: l2P }),
        'get_text_range(시드 확인)',
      );
      assert(seed.text === L2, `시드 문단 텍스트 일치: "${seed.text}"`);
      const inheritedBreaks = [];
      for (const p of [seedBase - 1, fillerP, l1P, l2P, l3P]) {
        const pf = must(await call('get_para_format', { sectionIdx: 0, paraIdx: p }), `get_para_format(${p}, break)`);
        inheritedBreaks.push(pf.pageBreakBefore === true);
      }
      assert(
        JSON.stringify(inheritedBreaks) === JSON.stringify([true, false, false, false, false]),
        `원본의 의도된 쪽나눔만 유지하고 continuation은 해제: ${JSON.stringify(inheritedBreaks)}`,
      );

      // ── b. replace_range 원자성 + 서식 상속 ─────────────────
      setTestCase('b. replace_range 원자성/서식 상속');
      await callWrite(call, 'apply_char_format', {
        sectionIdx: 0, paraIdx: l2P, startOffset: BOLD_START, endOffset: BOLD_END, bold: true,
      });
      const rep = await callWrite(call, 'replace_range', {
        sectionIdx: 0, startParaIdx: l2P, startCharOffset: REPLACE_START,
        endParaIdx: l2P, endCharOffset: REPLACE_END, text: REPLACE_TEXT,
      });
      assert(typeof rep.changeSetId === 'string' && rep.changeSetId.length > 0, 'replace_range changeSetId 반환');

      await page.waitForFunction(
        () => document.querySelector('.ag-exact-change, .ag-exact-anchor') !== null,
        { timeout: 5000 },
      );
      const exactOverlay = await page.evaluate(() => ({
        exactHunks: new Set(
          [...document.querySelectorAll('[data-diff-hunk]')]
            .map((element) => element.getAttribute('data-diff-hunk')),
        ).size,
        legacyReplaceMarkers: document.querySelectorAll('.ag-pending-marker.ag-replace').length,
      }));
      assert(exactOverlay.exactHunks > 0, `replace_range exact canvas hunk 렌더링 (${exactOverlay.exactHunks}개)`);
      assert(exactOverlay.legacyReplaceMarkers === 0, 'replace_range 전체 범위 marker 미렌더링');
      await page.$eval('[data-diff-hunk]', (element) => {
        element.scrollIntoView({ block: 'center', inline: 'center' });
      });
      const exactBox = await page.$eval('.ag-exact-change', (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await page.mouse.move(exactBox.x, exactBox.y);
      await page.waitForFunction(
        () => document.querySelector('.ag-exact-popover')?.hidden === false,
      );
      const removedPreview = await page.$eval('.ag-exact-popover-text', (element) => element.textContent);
      assert(removedPreview === '원본', `hover 가 삭제된 fragment 만 표시 ("${removedPreview}")`);
      await page.mouse.click(exactBox.x, exactBox.y);
      await page.mouse.move(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const caretPinned = await page.$eval('.ag-exact-popover', (element) => element.hidden === false);
      assert(caretPinned, 'exact hunk 클릭이 일반 caret 을 배치하고 popover 를 고정');
      await page.keyboard.press('Escape');
      const escaped = await page.$eval('.ag-exact-popover', (element) => element.hidden === true);
      assert(escaped, 'Escape 로 exact diff popover 닫기');
      await screenshot(page, 'agent-edit-loop-exact-diff-desktop');
      await page.waitForFunction(
        () => document.querySelectorAll('.ag-liquid-flow-in, .ag-liquid-anchor-in').length === 0,
        { timeout: 2000 },
      );
      const desktopViewport = page.viewport();
      await page.setViewport({ width: 390, height: 844 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const replayedAnimations = await page.$$eval(
        '.ag-liquid-flow-in, .ag-liquid-anchor-in',
        (elements) => elements.length,
      );
      assert(replayedAnimations === 0, 'viewport rerender 가 liquid reveal 을 재생하지 않음');
      await page.click('.ag-collapse-tab');
      await page.waitForFunction(
        () => document.querySelector('#agent-sidebar')?.classList.contains('ag-collapsed') === true,
      );
      await new Promise((resolve) => setTimeout(resolve, 320));
      await page.$eval('[data-diff-hunk]', (element) => {
        element.scrollIntoView({ block: 'center', inline: 'center' });
      });
      await screenshot(page, 'agent-edit-loop-exact-diff-mobile');
      await page.click('.ag-collapse-tab');
      await page.setViewport(desktopViewport ?? { width: 1280, height: 900 });

      const vB = must(await call('verify_changes', {}), 'verify_changes(b)');
      const kindsB = vB.ops.map((o) => o.kind);
      assert(
        kindsB.filter((k) => k === 'replace').length === 1
          && kindsB.filter((k) => k === 'insert').length === 1
          && kindsB.filter((k) => k === 'delete').length === 0
          && kindsB.filter((k) => k === 'object:paraFormat').length === 1
          && vB.ops.length === 4,
        `replace_range 가 정확히 하나의 'replace' op (ops=${JSON.stringify(kindsB)})`,
      );
      const fmtIn = must(
        await call('get_char_format', { sectionIdx: 0, paraIdx: l2P, charOffset: REPLACE_START }),
        'get_char_format(교체 위치)',
      );
      const fmtOut = must(
        await call('get_char_format', { sectionIdx: 0, paraIdx: l2P, charOffset: 0 }),
        'get_char_format(비교 위치)',
      );
      assert(
        fmtIn.bold === true && fmtOut.bold === false,
        `삽입 텍스트가 교체 구간 서식(bold) 상속 (삽입=${fmtIn.bold}, 범위 밖=${fmtOut.bold})`,
      );

      // ── c. apply_list 숫자 서식 ─────────────────────────────
      setTestCase('c. apply_list digit numbering');
      // 1) '1)' — 기존 정의와 패턴이 겹치지 않는 신규 정의 생성 경로.
      const listRes = await callWrite(call, 'apply_list', {
        sectionIdx: 0, startParaIdx: l1P, endParaIdx: l3P, format: '1)', level: 1,
      });
      assert(
        Number.isInteger(listRes.numberingId) && listRes.numberingId > 0 && listRes.paragraphs === 3
          && !preNumberingIds.includes(listRes.numberingId),
        `apply_list 반환 numberingId=${listRes.numberingId}, paragraphs=${listRes.paragraphs} (신규 정의)`,
      );
      let paraFmtOk = true;
      for (const p of [l1P, l2P, l3P]) {
        const pf = must(await call('get_para_format', { sectionIdx: 0, paraIdx: p }), `get_para_format(${p})`);
        if (!(pf.headType === 'number' && pf.numberingId === listRes.numberingId && pf.paraLevel === 1)) {
          paraFmtOk = false;
        }
      }
      assert(paraFmtOk, '3개 문단 모두 headType=number + numberingId 일치 + paraLevel=1');

      // 채움 문단 앞에서 쪽 나누기 — 내 콘텐츠가 빈 페이지에 격리되어 렌더 단정이 정확해진다
      await callWrite(call, 'insert_page_break', { sectionIdx: 0, paraIdx: fillerP });

      // 목록 머리 렌더 확인: 숫자 '1)' 이어야 하고 문서 기본(레벨1 = 가,나,다)이 아니어야 함
      const listPage = await page.evaluate((p) => {
        const r = window.__wasm.getCursorRect(0, p, 0);
        return r?.pageIndex ?? -1;
      }, l1P);
      // 페이지 SVG 는 글리프당 <text> 1개 — 머리글은 인접 글리프 쌍('1'+꼬리 글리프)으로 판별한다.
      // 내 콘텐츠만 있는 격리 페이지라 본문에 ')'/'.' 가 없어 오탐이 없다.
      const headPairs = (svg, tail) => {
        const glyphs = [...svg.matchAll(/>([^<>]+)</g)]
          .map((m) => m[1].trim())
          .filter((g) => g.length > 0);
        const pair = (ch) => glyphs.some((g, i) => g === ch && glyphs[i + 1] === tail);
        return { digit: ['1', '2', '3'].every(pair), hangul: ['가', '나', '다'].some(pair), glyphs };
      };
      const svg1 = must(
        await call('render_page', { pageIndex: listPage, format: 'svg' }),
        'render_page(svg-1))',
      );
      const heads1 = headPairs(svg1.svg, ')');
      if (!heads1.digit || heads1.hangul) {
        console.log(`  [debug] listPage=${listPage} svg=${svg1.svg.length}B glyphs=${JSON.stringify(heads1.glyphs.slice(0, 120))}`);
      }
      assert(
        heads1.digit && !heads1.hangul,
        `목록 머리가 '1)' 숫자 서식으로 렌더 (digit=${heads1.digit}, hangul=${heads1.hangul})`,
      );

      // 2) '1.' — 재사용 충돌 경로: 이 샘플의 기존 정의는 level 1 패턴이 '^2.' 로
      // 요청 패턴과 같지만 유형 코드가 가,나,다(8)라 DIGIT(0)과 다르다. executor 는
      // 패턴+코드가 모두 일치할 때만 재사용하므로 새 정의를 만들어야 하고, 머리글은
      // '가.'/'나.'/'다.' 가 아닌 '1.'/'2.'/'3.' 이어야 한다.
      const listResDot = await callWrite(call, 'apply_list', {
        sectionIdx: 0, startParaIdx: l1P, endParaIdx: l3P, format: '1.', level: 1,
      });
      assert(
        Number.isInteger(listResDot.numberingId)
          && !preNumberingIds.includes(listResDot.numberingId)
          && listResDot.numberingId !== listRes.numberingId,
        `충돌 정의 미재사용 — 신규 numberingId=${listResDot.numberingId} (기존=${JSON.stringify(preNumberingIds)}, '1)'=${listRes.numberingId})`,
      );
      let paraFmtDotOk = true;
      for (const p of [l1P, l2P, l3P]) {
        const pf = must(await call('get_para_format', { sectionIdx: 0, paraIdx: p }), `get_para_format(${p}, '1.')`);
        if (!(pf.headType === 'number' && pf.numberingId === listResDot.numberingId && pf.paraLevel === 1)) {
          paraFmtDotOk = false;
        }
      }
      assert(paraFmtDotOk, `3개 문단 모두 '1.' 정의(numberingId=${listResDot.numberingId})로 교체`);
      const svg2 = must(
        await call('render_page', { pageIndex: listPage, format: 'svg' }),
        'render_page(svg-1.)',
      );
      const heads2 = headPairs(svg2.svg, '.');
      if (!heads2.digit || heads2.hangul) {
        console.log(`  [debug] listPage=${listPage} svg=${svg2.svg.length}B glyphs=${JSON.stringify(heads2.glyphs.slice(0, 120))}`);
      }
      assert(
        heads2.digit && !heads2.hangul,
        `재사용 충돌 케이스: 목록 머리가 '1.' 숫자 서식으로 렌더 (digit=${heads2.digit}, hangul=${heads2.hangul})`,
      );

      // ── d. 수식 미리보기/삽입 ───────────────────────────────
      setTestCase('d. preview_equation / insert_equation');
      const broken = must(
        await call('preview_equation', { script: '\\foo x + 1' }),
        'preview_equation(깨진 스크립트)',
      );
      assert(
        Array.isArray(broken.warnings) && broken.warnings.length > 0
          && typeof broken.widthMm === 'number' && broken.widthMm > 0,
        `깨진 스크립트 → warnings ${broken.warnings?.length}건 + metrics(widthMm=${broken.widthMm})`,
      );
      const good = must(await call('preview_equation', { script: EQ_SCRIPT }), 'preview_equation(정상)');
      assert(
        Array.isArray(good.warnings) && good.warnings.length === 0,
        `정상 스크립트 → warnings 비어 있음 (${JSON.stringify(good.warnings)})`,
      );

      // 채움 문단에 10pt 를 명시해 줄바꿈 폭 추정과 실제 조판 메트릭을 일치시킨다.
      // [known-issue] 상속된 15pt 서식에서는 reflow 폭 추정이 실측보다 작게 나와
      // 수식(폭 ~47mm)이 첫 줄 끝의 부족한 공간(~20mm)에 배치돼 열 오른쪽을
      // ~100px 넘는다 — line_breaking.rs 측정 수정(이 워크트리) 후에도 브라우저
      // 빌드에서 재현됨을 확인했다 (eqRight=819.0 > rightEdge=718.1).
      const fillerLenRes = must(
        await call('get_text_range', { sectionIdx: 0, paraIdx: fillerP }),
        'get_text_range(채움 문단)',
      );
      await callWrite(call, 'apply_char_format', {
        sectionIdx: 0, paraIdx: fillerP, startOffset: 0, endOffset: fillerLenRes.paraLength, fontSizePt: 10,
      });

      // 채움 문단 첫 줄 끝 근처 삽입점 탐색 (수식 폭이 남은 폭보다 크게)
      const probe = await page.evaluate((p) => {
        const w = window.__wasm;
        const len = w.getParagraphLength(0, p);
        const r0 = w.getCursorRect(0, p, 0);
        let lineEnd = len;
        for (let o = 1; o <= len; o += 1) {
          const r = w.getCursorRect(0, p, o);
          if (!r || r.pageIndex !== r0.pageIndex || r.y > r0.y + 1) { lineEnd = o - 1; break; }
        }
        return { len, lineEnd };
      }, fillerP);
      assert(probe.lineEnd > 10 && probe.lineEnd < probe.len, `채움 문단이 2줄 이상으로 조판 (lineEnd=${probe.lineEnd}/${probe.len})`);
      const eqOffset = probe.lineEnd - 2;

      const ambient = must(
        await call('get_char_format', { sectionIdx: 0, paraIdx: fillerP, charOffset: eqOffset - 1 }),
        'get_char_format(주변)',
      );
      const insEq = await callWrite(call, 'insert_equation', {
        sectionIdx: 0, paraIdx: fillerP, charOffset: eqOffset, script: EQ_SCRIPT,
      });
      assert(
        typeof insEq.fontSizePt === 'number' && insEq.fontSizePt === ambient.fontSizePt,
        `insert_equation fontSizePt 주변 텍스트 상속 (${insEq.fontSizePt}pt == ambient ${ambient.fontSizePt}pt)`,
      );
      assert(
        Array.isArray(insEq.warnings) && insEq.warnings.length === 0 && typeof insEq.widthMm === 'number',
        `insert_equation warnings 비어 있음 + metrics(widthMm=${insEq.widthMm})`,
      );

      // ── e. verify_changes 종합 + PNG ────────────────────────
      setTestCase('e. verify_changes 요약/다이제스트/PNG');
      const v1 = must(await call('verify_changes', {}), 'verify_changes(요약)');
      const kindCount = (k) => v1.ops.filter((o) => o.kind === k).length;
      assert(
        v1.changeSetId && v1.status === 'open'
          && kindCount('insert') === 1 && kindCount('format') === 2 && kindCount('replace') === 1
          && kindCount('object:paraFormat') === 8 && kindCount('object:insertEquation') === 1
          && v1.ops.length === 13,
        `per-op 요약 13건 (insert 1 / format 2 / replace 1 / paraFormat 8 / insertEquation 1): ${JSON.stringify(v1.ops.map((o) => o.kind))}`,
      );
      assert(
        v1.ops.every((o) => o.id && typeof o.applied === 'boolean' && typeof o.summary === 'string'),
        '모든 op 에 id/applied/summary 존재',
      );
      assert(
        Array.isArray(v1.postEditText) && v1.postEditText.length > 0
          && v1.postEditText.every((t) => typeof t.text === 'string')
          && Array.isArray(v1.warnings),
        `postEditText 다이제스트 ${v1.postEditText?.length}건 + warnings 배열`,
      );

      const v2 = must(await call('verify_changes', { includeImage: true }), 'verify_changes(includeImage)');
      const png = v2.image?.data ? Buffer.from(v2.image.data, 'base64') : Buffer.alloc(0);
      assert(
        v2.image?.mimeType === 'image/png'
          && png.length > 4096
          && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
        `includeImage → PNG 블록 (mimeType=${v2.image?.mimeType}, ${png.length}B, magic=${png.subarray(0, 4).toString('hex')})`,
      );
      // verify 이미지는 첫 영향 문단(시드 삽입 = 원본 마지막 문단) 페이지를 그리므로
      // 내 콘텐츠 페이지가 아닐 수 있다 → 콘텐츠 페이지를 직접 렌더해 잉크를 확인한다.
      const rp = must(
        await call('render_page', { pageIndex: listPage, format: 'png' }),
        'render_page(png)',
      );
      const rpPng = Buffer.from(rp.image?.data ?? '', 'base64');
      let inkPixels = 0;
      try {
        const decoded = PNG.sync.read(rpPng);
        for (let i = 0; i < decoded.data.length; i += 4) {
          if (decoded.data[i] < 200 && decoded.data[i + 3] > 128) inkPixels += 1;
        }
      } catch { /* 디코드 실패는 아래 단정이 잡는다 */ }
      fs.writeFileSync('e2e/screenshots/agent-edit-loop-verify.png', rpPng);
      assert(
        rp.image?.mimeType === 'image/png' && rpPng.length > 4096 && inkPixels > 5000,
        `콘텐츠 페이지 PNG 렌더 (page=${listPage}, ${rpPng.length}B, 잉크 ${inkPixels}px)`,
      );
      await screenshot(page, 'agent-edit-loop-pending');

      // ── f. 인라인 수식 줄바꿈 overflow ──────────────────────
      setTestCase('f. 수식 줄바꿈 overflow 없음');
      const overflow = await page.evaluate((p) => {
        const w = window.__wasm;
        const textLen = w.getParagraphLength(0, p);
        const rects = [];
        for (let o = 0; o <= textLen + 10; o += 1) {
          let r = null;
          try { r = w.getCursorRect(0, p, o); } catch { break; }
          if (!r) break;
          rects.push({ o, x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10 });
        }
        const pageIndex = rects.length > 0 ? w.getCursorRect(0, p, 0).pageIndex : 0;
        const info = w.getPageInfo(pageIndex);
        const layout = w.getPageControlLayout(pageIndex);
        const eq = (layout.controls || []).find((c) => c.type === 'equation' && c.paraIdx === p) ?? null;
        return {
          pageIndex, textLen, rects, eq,
          rightEdge: info.width - info.marginRight,
          marginLeft: info.marginLeft,
        };
      }, fillerP);
      const maxProbeX = overflow.rects.length > 0 ? Math.max(...overflow.rects.map((r) => r.x)) : -1;
      const eqRight = overflow.eq ? overflow.eq.x + overflow.eq.w : -1;
      const caretOk = maxProbeX > 0 && maxProbeX <= overflow.rightEdge + 4;
      const eqOk = overflow.eq !== null && eqRight <= overflow.rightEdge + 4;
      // 수식이 줄 끝에 못 들어가 다음 줄로 밀렸는지: 수식이 줄 좌측(본문 시작) 근처에 있어야 함
      const wrappedToOwnLine = overflow.eq !== null
        && overflow.eq.x <= overflow.marginLeft + 40;
      if (!caretOk || !eqOk || !wrappedToOwnLine) {
        console.log(`  [debug] overflow probe: textLen=${overflow.textLen} page=${overflow.pageIndex} rightEdge=${overflow.rightEdge.toFixed(1)} eq=${JSON.stringify(overflow.eq)}`);
        console.log(`  [debug] rects=${JSON.stringify(overflow.rects)}`);
      }
      assert(
        eqOk,
        `수식 bbox 가 열 안에 있음 (eqRight=${eqRight.toFixed(1)} <= rightEdge=${overflow.rightEdge.toFixed(1)})`,
      );
      assert(
        wrappedToOwnLine,
        `남은 폭보다 넓은 수식이 다음 줄로 밀려남 (eq.x=${overflow.eq?.x.toFixed(1)}, marginLeft=${overflow.marginLeft.toFixed(1)})`,
      );
      assert(
        caretOk,
        `수식 문단 어떤 런도 열 오른쪽을 넘지 않음 (maxX=${maxProbeX.toFixed(1)} <= rightEdge=${overflow.rightEdge.toFixed(1)})`,
      );

      // ── g/h. 승인 전후 page map 동일 + 승인 후 영속 ──────────
      setTestCase('g/h. preview/approve/refresh page map + 영속');
      const affectedParas = [seedBase - 1, fillerP, l1P, l2P, l3P];
      const previewLayout = await page.evaluate((paras) => {
        const w = window.__wasm;
        return {
          pageCount: w.pageCount,
          pages: paras.map((p) => w.getCursorRect(0, p, 0)?.pageIndex ?? -1),
        };
      }, affectedParas);
      const beforeApprove = await page.evaluate(() => window.__agentBridge.pendingEdits.hasPending());
      await page.evaluate((id) => window.__agentBridge.pendingEdits.approve(id), v2.changeSetId);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
      const after = await page.evaluate(({ p, paras }) => {
        const w = window.__wasm;
        return {
          hasPending: window.__agentBridge.pendingEdits.hasPending(),
          setCount: window.__agentBridge.pendingEdits.getChangeSets().length,
          text: w.getTextRange(0, p, 0, 100),
          layout: {
            pageCount: w.pageCount,
            pages: paras.map((para) => w.getCursorRect(0, para, 0)?.pageIndex ?? -1),
          },
        };
      }, { p: l2P, paras: affectedParas });
      assert(beforeApprove === true && after.hasPending === false && after.setCount === 0,
        `approve 후 change set 정리 (전 pending=${beforeApprove}, 후 sets=${after.setCount})`);
      assert(
        JSON.stringify(after.layout) === JSON.stringify(previewLayout),
        `approve 전후 page map 동일 (preview=${JSON.stringify(previewLayout)}, approved=${JSON.stringify(after.layout)})`,
      );
      const refreshedLayout = await page.evaluate((paras) => {
        const w = window.__wasm;
        w.refreshLayout();
        return {
          pageCount: w.pageCount,
          pages: paras.map((p) => w.getCursorRect(0, p, 0)?.pageIndex ?? -1),
        };
      }, affectedParas);
      assert(
        JSON.stringify(refreshedLayout) === JSON.stringify(after.layout),
        `승인 후 권위 refresh에도 page map 유지 (${JSON.stringify(refreshedLayout)})`,
      );
      assert(
        after.text.includes(REPLACE_TEXT) && !after.text.includes('원본'),
        `approve 후 교체 텍스트 영속: "${after.text}"`,
      );
      const pfAfter = must(await call('get_para_format', { sectionIdx: 0, paraIdx: l1P }), 'get_para_format(승인 후)');
      assert(
        pfAfter.headType === 'number' && pfAfter.numberingId === listResDot.numberingId,
        `approve 후 목록 서식 영속 (headType=${pfAfter.headType}, numberingId=${pfAfter.numberingId})`,
      );
      await screenshot(page, 'agent-edit-loop-approved');

      // ── i. 병렬 서브에이전트 리베이스 — 실제 엔진 위 편집 저널 검증 ──
      // 형제 에이전트 둘이 같은 revision 을 읽고 서로소 문단에 쓰는 시나리오.
      // 실제 wasm 의 이벤트 타이밍(스테이징 → document-mutated bump)이 저널
      // 기록과 어긋나면 여기서 gap 으로 드러난다.
      setTestCase('i. 병렬 리베이스 (edit journal)');
      const sR = must(await call('get_structure', {}), 'get_structure(리베이스 기준)');
      const sharedRev = sR.revision;
      const rParaCount = sR.sections[0].paragraphCount;
      const rLastLen = sR.sections[0].paragraphs[rParaCount - 1]?.length ?? 0;

      const insA = must(await call('insert_text', {
        expectedRevision: sharedRev, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '병렬A\n',
      }), 'insert_text(형제 A, 문단 +1)');
      assert(insA.rebasedParaShift === undefined, '형제 A 는 정확한 revision — 리베이스 없음');

      const insB = must(await call('insert_text', {
        expectedRevision: sharedRev, sectionIdx: 0, paraIdx: rParaCount - 1, charOffset: rLastLen, text: '병렬B',
      }), 'insert_text(형제 B, stale revision)');
      assert(
        insB.rebasedParaShift === 1,
        `형제 B 의 stale 쓰기가 +1 리베이스로 통과 (rebasedParaShift=${insB.rebasedParaShift})`,
      );
      const rebasedText = must(
        await call('get_text_range', { sectionIdx: 0, paraIdx: rParaCount }),
        'get_text_range(리베이스된 문단)',
      );
      assert(
        String(rebasedText.text ?? '').includes('병렬B'),
        `리베이스된 좌표(문단 ${rParaCount})에 텍스트가 놓임: "${rebasedText.text}"`,
      );

      const conflict = await call('insert_text', {
        expectedRevision: sharedRev, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'X',
      });
      assert(
        !conflict.ok && conflict.error?.code === 'REVISION_MISMATCH'
          && /concurrent edit touched/.test(conflict.error?.message ?? ''),
        `같은 문단을 노린 stale 쓰기는 충돌 메시지로 거부 (${conflict.ok ? '성공(버그)' : conflict.error?.code})`,
      );

      // 정리 — 검증용 스테이징 편집을 되돌려 종료 상태를 깨끗이 한다
      const rebaseSetIds = await page.evaluate(() => window.__agentBridge.pendingEdits.getChangeSets().map((s) => s.id));
      for (const id of rebaseSetIds) {
        await page.evaluate((i) => window.__agentBridge.pendingEdits.reject(i), id);
      }
    } finally {
      try { mcp.ws.close(); } catch { /* 이미 닫힌 소켓 무시 */ }
    }
  });
} catch (err) {
  console.error('테스트 환경 구동 실패:', err.message || err);
  failed = true;
} finally {
  await stopServer(vite);
  await stopServer(hub);
}

if (failed) process.exitCode = 1;
