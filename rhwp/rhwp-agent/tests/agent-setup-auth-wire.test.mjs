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
  const start = source.indexOf('cliSetup.authenticate(');
  assert.notEqual(start, -1, 'agent-setup-auth 핸들러를 찾지 못했어요');
  const frame = source.slice(start, source.indexOf('.then(', start));
  assert.match(frame, /type: 'agent-setup-progress'/);
  assert.match(frame, /entry\.authUrl \? \{ authUrl: entry\.authUrl \}/);
  assert.match(frame, /entry\.userCode \? \{ userCode: entry\.userCode \}/);
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
