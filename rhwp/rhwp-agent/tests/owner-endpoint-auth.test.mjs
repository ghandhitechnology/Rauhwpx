import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'owner-hardening-token';
const LAUNCH_ID = 'launch-owner-test';

function waitForLine(stream, predicate) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (predicate(line)) {
          cleanup();
          resolve(line);
          return;
        }
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

test('production hub keeps owner endpoints bearer-only and healthz quiet without token', { timeout: 30_000 }, async (t) => {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-owner-hardening-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RHWP_AGENT_PORT: '0',
      RHWP_AGENT_TOKEN: TOKEN,
      RHWP_LAUNCH_ID: LAUNCH_ID,
      RHWP_WORK_DIR: workRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(workRoot, { recursive: true, force: true });
  });

  const readyLine = await waitForLine(child.stdout, (line) => line.startsWith('RHWP_HUB_READY '));
  const ready = JSON.parse(readyLine.slice('RHWP_HUB_READY '.length));
  const base = `http://127.0.0.1:${ready.port}`;

  const unauthenticatedHealth = await fetch(`${base}/healthz`);
  assert.equal(unauthenticatedHealth.status, 401);
  const healthBody = await unauthenticatedHealth.json();
  assert.equal('launchId' in healthBody, false);
  assert.equal('sessions' in healthBody, false);

  // 토큰을 URL 파라미터로 넘기는 소유자 요청은 거부된다(로그·히스토리 유출 방지).
  const queryTokenShutdown = await fetch(`${base}/shutdown?token=${encodeURIComponent(TOKEN)}`, {
    method: 'POST',
    headers: { 'x-rhwp-launch-id': LAUNCH_ID },
  });
  assert.equal(queryTokenShutdown.status, 401);

  // Authorization 헤더 + launch id 면 정상 처리된다.
  const shutdown = await fetch(`${base}/shutdown`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'x-rhwp-launch-id': LAUNCH_ID },
  });
  assert.equal(shutdown.status, 202);

  await once(child, 'exit');
});
