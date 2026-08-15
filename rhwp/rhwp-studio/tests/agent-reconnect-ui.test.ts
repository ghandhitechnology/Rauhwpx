import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* bridge.ts 는 WebSocket·DOM(창 포커스, pending-overlay.css)에 묶여 있어
   Node 테스트에서 인스턴스화할 수 없다. 기존 브리지 테스트와 같은 방식으로
   계약을 소스 텍스트로 못박고, 짝 맞추기 동작은 pending-requests 테스트가
   실제 모듈로 검증한다. */
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/agent/types.ts', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');

test('connection 이벤트는 시도 횟수와 다음 재시도 시각을 함께 싣는다', () => {
  assert.match(types, /type: 'connection';[\s\S]*attempt\?: number;[\s\S]*retryInMs\?: number;/);
  assert.match(bridge, /private emitConnection\(retryInMs\?: number\): void/);
  assert.match(bridge, /attempt: this\.reconnectAttempt/);
  assert.match(bridge, /\.\.\.\(retryInMs !== undefined \? \{ retryInMs \} : \{\}\)/);
  // 백오프를 예약할 때 남은 시간을 알려야 사이드바가 카운트다운을 만들 수 있다.
  assert.match(bridge, /this\.reconnectTimer = setTimeout\([\s\S]*this\.emitConnection\(delay\);/);
});

test('실패한 시도만 세고 연결이 열리면 0으로 돌아간다', () => {
  // onclose(비-replaced)와 소켓 생성 실패 두 곳에서만 증가한다.
  assert.equal((bridge.match(/this\.reconnectAttempt\+\+;/g) ?? []).length, 2);
  assert.match(bridge, /ws\.onopen = \(\) => \{[\s\S]*this\.reconnectAttempt = 0;/);
  // 첫 실패(attempt 1)가 첫 지연(250ms)을 쓰도록 인덱스를 한 칸 당긴다.
  assert.match(bridge, /Math\.max\(0, this\.reconnectAttempt - 1\)/);
  assert.match(bridge, /const RECONNECT_DELAYS_MS = \[250, 500, 1000, 2000, 5000\]/);
  assert.match(bridge, /const CONNECT_TIMEOUT_MS = 4000/);
});

test('reconnectNow 는 허브가 뜬 뒤에 붙는다', () => {
  assert.match(bridge, /reconnectNow\(\): Promise<void>/);
  assert.match(bridge, /if \(this\.disposed \|\| this\.state === 'connected'\) return;/);
  assert.match(bridge, /private forceReconnect\(\): void/);
  assert.match(bridge, /this\.abortSocket\(\)/);
  assert.match(bridge, /takeOverConnection\(\): void \{\s*this\.forceReconnect\(\);/);
  assert.match(
    bridge,
    /async reconnectNow\(\): Promise<void> \{[\s\S]*await this\.requestHubLaunch\(\);[\s\S]*this\.forceReconnect\(\);/,
  );
  assert.doesNotMatch(
    bridge,
    /private connectImmediately\(\): void \{\s*if \(this\.disposed \|\| this\.state === 'connected' \|\| this\.state === 'connecting'\) return;/,
  );
});

test('채팅에 연결 배너가 있고 실패 뒤에만 나타난다', () => {
  assert.match(source, /const connBanner = el\('div', 'ag-conn-banner'\)/);
  assert.match(source, /chatPage\.append\(header, connBanner, messages, review, composer\)/);
  // 첫 시도(attempt 0)는 조용히 지나간다.
  assert.match(source, /if \(connAttempt === 0\) \{\s*connBanner\.hidden = true;/);
  assert.match(source, /연결하는 중… \(\$\{connAttempt\}번째 시도\)/);
  assert.match(source, /에이전트에 연결하는 중이에요 · \$\{Math\.ceil\(remainMs \/ 1000\)\}초 후 다시 시도/);
  assert.match(css, /\.ag-conn-banner\s*\{/);
});

test('배너 카운트다운은 1초마다 갱신되고 정리된다', () => {
  assert.match(source, /connCountdownTimer = window\.setInterval\(paintConnCountdown, 1000\)/);
  assert.match(source, /function clearConnCountdown\(\): void \{[\s\S]*window\.clearInterval\(connCountdownTimer\)/);
  // 연결됨/다른 탭 사용 중에는 타이머를 남기지 않는다.
  assert.match(source, /if \(connState === 'connected' \|\| connState === 'replaced'\) \{\s*clearConnCountdown\(\);/);
  assert.ok(source.includes('clearConnCountdown();\n      writingStyleCalibration.dispose();'));
});

test('배너 버튼은 즉시 재연결을, 관리되지 않는 환경에서만 실행 힌트를 준다', () => {
  assert.match(source, /connBannerRetry[\s\S]{0,160}bridge\.reconnectNow\(\)/);
  assert.match(source, /저장소 루트에서 npm start 를 한 번 실행하세요/);
  assert.match(source, /잠시만 기다리면 다시 붙어요/);
  assert.match(source, /connBannerHint\.hidden = managedHub \|\| connAttempt < 6/);
  assert.match(
    source,
    /connBannerText\.textContent = `연결하는 중… \(\$\{connAttempt\}번째 시도\)`;\s*connBannerRetry\.hidden = false;/,
  );
  assert.match(source, /ag-conn-banner-wait/);
  assert.match(css, /\.ag-conn-banner\.ag-conn-banner-wait/);
});

test('끊김 상태도 연결 중으로 보여 재시도가 경고처럼 보이지 않는다', () => {
  assert.match(source, /const visual = state === 'disconnected' \? 'connecting' : state/);
  assert.match(source, /conn\.textContent = state === 'connected' \|\| state === 'replaced'/);
  assert.match(source, /takeoverBtn\.hidden = state !== 'replaced'/);
  assert.match(source, /bridge\.takeOverConnection\(\)/);
  assert.match(source, /setConnection\(e\.state, \{ attempt: e\.attempt, retryInMs: e\.retryInMs \}\)/);
});

test('CLI 스폰 실패는 대화 안에서 다시 시도할 수 있다', () => {
  assert.match(source, /if \(e\.code === 'AGENT_SPAWN_FAILED'\) appendSpawnRetryAction\(\)/);
  assert.match(source, /function appendSpawnRetryAction\(\): void/);
  assert.match(source, /el\('button', 'ag-hub-retry-btn', '다시 시도'\)/);
  // 강제 재시작(force=true)이어야 죽은 세션 자리에 새 CLI 가 뜬다. 스레드/문서 식별자도 같이 간다.
  assert.match(
    source,
    /function restartAgentSession\(\): void \{\s*startCurrentBridgeChat\(true\);/,
  );
});

test('끊기면 허브 기동을 요청하고 포커스·온라인·가시성에서 다시 붙는다', () => {
  assert.match(bridge, /import \{[\s\S]*ensureDesktopAgentHub,[\s\S]*\} from '\.\.\/desktop-integration\.ts'/);
  assert.match(
    bridge,
    /private requestHubLaunch\(\): Promise<boolean> \{\s*if \(!this\.hubLaunch\) \{\s*this\.hubLaunch = ensureDesktopAgentHub\(\)/,
  );
  assert.match(
    bridge,
    /private scheduleReconnect\(\): void \{\s*if \(this\.disposed \|\| this\.reconnectTimer !== null\) return;\s*void this\.requestHubLaunch\(\);/,
  );
  assert.match(bridge, /private async connectAfterHub\(seq: number\): Promise<void>/);
  assert.match(bridge, /window\.addEventListener\('focus', this\.onResume\)/);
  assert.match(bridge, /window\.addEventListener\('online', this\.onResume\)/);
  assert.match(bridge, /document\.addEventListener\('visibilitychange', this\.onVisibility\)/);
  assert.match(bridge, /window\.removeEventListener\('focus', this\.onResume\)/);
  assert.match(bridge, /window\.removeEventListener\('online', this\.onResume\)/);
  assert.match(bridge, /document\.removeEventListener\('visibilitychange', this\.onVisibility\)/);
});
