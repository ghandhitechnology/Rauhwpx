import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hubDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readSource(name) {
  return fs.readFile(path.join(hubDir, name), 'utf8');
}

/** 로그인 진행 프레임은 스튜디오가 그대로 그리는 유일한 통로다 — 필드가 빠지면 로그인이 멈춘다. */
test('the auth progress frame forwards both the login URL and the device code', async () => {
  const source = await readSource('server.mjs');
  const start = source.indexOf('const progress = (entry) => {');
  assert.notEqual(start, -1, 'agent-setup-auth 핸들러를 찾지 못했어요');
  const frame = source.slice(start, source.indexOf('const started =', start));
  assert.match(frame, /type: 'agent-setup-progress'/);
  assert.match(frame, /entry\.authUrl \? \{ authUrl: entry\.authUrl \}/);
  assert.match(frame, /entry\.userCode \? \{ userCode: entry\.userCode \}/);
  assert.match(frame, /authRunId: run\.runId|sendAuthRunFrame\(authRun/);
});

/** 원격 사용자는 허브 기기의 localhost 콜백에 접근할 수 없다. */
test('codex OAuth never falls back to the localhost callback login', async () => {
  const source = await readSource('cli-setup-manager.mjs');
  const start = source.indexOf('const loginSpec = {');
  assert.notEqual(start, -1);
  const spec = source.slice(start, source.indexOf('}[agent];', start));
  assert.match(spec, /argv: \['login', '--device-auth'\]/);
  assert.doesNotMatch(spec, /platform === 'win32'/);
});

/** 데스크톱 앱 밖(개발·브라우저)에서도 API 키 로그인은 성공해야 한다. */
test('API key setup no longer requires the desktop secret vault', async () => {
  const source = await readSource('cli-setup-manager.mjs');
  assert.doesNotMatch(source, /SECRET_STORE_UNAVAILABLE/);
});

test('auth-run cancellation and owner-session close fence API key manager commits', async () => {
  const source = await readSource('server.mjs');
  const start = source.indexOf("case 'agent-setup-auth':");
  const end = source.indexOf("case 'agent-setup-auth-code':", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = source.slice(start, end);

  assert.match(handler, /const cancelProvider = \(\) => \{\s*abort\.abort\(\)/);
  assert.match(handler, /piManager\.setApiKey\([^;]+signal: abort\.signal,[^;]+onCommitted: commitAuthRun/s);
  assert.match(handler, /cliSetup\.authenticate\([^;]+signal: abort\.signal,[^;]+onCommitted: commitAuthRun/s);
  assert.match(source, /case 'agent-setup-cancel':[\s\S]+authRuns\.cancelOwned\(/);
  assert.match(source, /authRuns\.cancelForSession\(sessionId, 'owner-session-closed'\)/);
});

test('OAuth callback and post-auth work share one exact credential commit boundary', async () => {
  const source = await readSource('server.mjs');
  const authStart = source.indexOf("case 'agent-setup-auth':");
  const authEnd = source.indexOf("case 'agent-setup-auth-code':", authStart);
  const handler = source.slice(authStart, authEnd);
  assert.match(handler, /const isLiveAuthRun = \(\) => !abort\.signal\.aborted && authRuns\.get\(agent\) === authRun/);
  assert.match(handler, /authRuns\.finish\(authRun\)[\s\S]+authRun\.credentialsCommitted = true/);
  assert.match(handler, /const progress = \(entry\) => \{\s*if \(!isLiveAuthRun\(\)\) return/);
  assert.match(handler, /storeRauApiKey\([\s\S]+onCommitted: commitAuthRun,[\s\S]+acknowledgeDeviceSessionV2\(/);
  assert.ok(handler.indexOf('onCommitted: commitAuthRun') < handler.indexOf('providerHealth.check(true)'));

  const callbackStart = source.indexOf("url.pathname === '/oauth/openrouter/callback'");
  const callbackEnd = source.indexOf("url.pathname.startsWith('/sessions/')", callbackStart);
  const callback = source.slice(callbackStart, callbackEnd);
  assert.match(callback, /piManager\.completeOAuth\([^;]+signal: authRun\.signal,[^;]+onCommitted: authRun\.commitCredentials/s);
  assert.match(callback, /authRun\.credentialsCommitted !== true/);
});
