import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hubDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Rau redeem stores the Rau secret and can drop only the local key', async () => {
  const source = await fs.readFile(path.join(hubDir, 'server.mjs'), 'utf8');
  assert.match(source, /secretId: RAU_SECRET_ID/);
  assert.match(source, /lockedModels: RAU_LOCKED_MODELS/);
  assert.match(source, /prefixDir: piManager\.prefixDir/);
  const start = source.indexOf("if (agent === 'rau' && method === 'oauth')");
  assert.notEqual(start, -1, 'Rau oauth 핸들러를 찾지 못했어요');
  const block = source.slice(start, source.indexOf("if (agent === 'pi' && method === 'oauth')", start));
  assert.match(block, /storeRauApiKey\(rauManager\.setApiKey\.bind\(rauManager\), key/);
  assert.match(block, /createDeviceSession\(\{ signal: abort\.signal \}\)/);
  assert.match(block, /acknowledgeDeviceSession\(session\.id, \{ signal: abort\.signal \}\)/);
  assert.ok(block.indexOf('rauLogin = login') < block.indexOf('createDeviceSession'));
  assert.doesNotMatch(block, /piManager\.setApiKey/);
  assert.match(source, /code: 'RAU_CREDITS_EMPTY'/);
  assert.match(source, /creditBalanceEmpty\(rauCreditsBalance\)/);
  assert.match(source, /case 'agent-setup-disconnect'/);
  assert.match(source, /rauManager\.clearApiKey\(\)/);
  assert.match(source, /isOpenRouterCreditError\(evt\.message\)/);
  assert.match(source, /piManager: selection\.agent === 'rau' \? rauManager : piManager/);
  assert.match(source, /openRouter: selection\.agent === 'rau' \? rauOpenRouter : openRouter/);
  for (const mutation of source.matchAll(/(?:piManager|rauManager)\.(?:install|automaticUpdate)\(/g)) {
    const index = mutation.index;
    const start = source.lastIndexOf('\n', index);
    assert.match(source.slice(start, index), /mutateSharedNpmPrefix/);
  }
});
