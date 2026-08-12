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
  // 첫 실패(attempt 1)가 첫 지연(1000ms)을 쓰도록 인덱스를 한 칸 당긴다.
  assert.match(bridge, /Math\.max\(0, this\.reconnectAttempt - 1\)/);
});

test('reconnectNow 는 예약된 백오프를 접고 즉시 붙는다', () => {
  assert.match(bridge, /reconnectNow\(\): Promise<void>|reconnectNow\(\): void/);
  assert.match(bridge, /private connectImmediately\(\): void \{\s*if \(this\.disposed \|\| this\.state === 'connected' \|\| this\.state === 'connecting'\) return;/);
  assert.match(bridge, /clearTimeout\(this\.reconnectTimer\)/);
  assert.match(bridge, /takeOverConnection\(\): void \{\s*this\.connectImmediately\(\);/);
  assert.match(bridge, /reconnectNow\(\): void \{\s*this\.connectImmediately\(\);/);
});

test('채팅에 연결 배너가 있고 실패 뒤에만 나타난다', () => {
  assert.match(source, /const connBanner = el\('div', 'ag-conn-banner'\)/);
  assert.match(source, /chatPage\.append\(header, connBanner, messages, review, composer\)/);
  // 첫 시도(attempt 0)는 조용히 지나간다.
  assert.match(source, /if \(connAttempt === 0\) \{\s*connBanner\.hidden = true;/);
  assert.match(source, /다시 연결 중… \(\$\{connAttempt\}번째 시도\)/);
  assert.match(source, /에이전트 허브와 연결이 끊어졌어요 · \$\{Math\.ceil\(remainMs \/ 1000\)\}초 후 재시도/);
  assert.match(css, /\.ag-conn-banner\s*\{/);
});

test('배너 카운트다운은 1초마다 갱신되고 정리된다', () => {
  assert.match(source, /connCountdownTimer = window\.setInterval\(paintConnCountdown, 1000\)/);
  assert.match(source, /function clearConnCountdown\(\): void \{[\s\S]*window\.clearInterval\(connCountdownTimer\)/);
  // 연결됨/다른 탭 사용 중에는 타이머를 남기지 않는다.
  assert.match(source, /if \(connState === 'connected' \|\| connState === 'replaced'\) \{\s*clearConnCountdown\(\);/);
  assert.ok(source.includes('clearConnCountdown();\n      writingStyleCalibration.dispose();'));
});

test('배너 버튼은 즉시 재연결을, 3회 실패 뒤에는 허브 실행 힌트를 준다', () => {
  assert.match(source, /connBannerRetry[\s\S]{0,160}bridge\.reconnectNow\(\)/);
  assert.match(source, /'허브 실행: rhwp-agent에서 npm start'/);
  assert.match(source, /connBannerHint\.hidden = connAttempt < 3/);
});

test('연결 상태 표시와 takeover 버튼 동작은 그대로 남는다', () => {
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
