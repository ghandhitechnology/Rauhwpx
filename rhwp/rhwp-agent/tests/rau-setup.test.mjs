import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hubDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Rau v2 redemption stores the local secret before acknowledgement and deletes it before session disposal', async () => {
  const source = await fs.readFile(path.join(hubDir, 'server.mjs'), 'utf8');
  assert.match(source, /secretId: RAU_SECRET_ID/);
  assert.match(source, /lockedModels: RAU_LOCKED_MODELS/);
  assert.match(source, /prefixDir: piManager\.prefixDir/);
  const start = source.indexOf("if (agent === 'rau' && method === 'oauth')");
  assert.notEqual(start, -1, 'Rau oauth 핸들러를 찾지 못했어요');
  const block = source.slice(start, source.indexOf("if (agent === 'pi' && method === 'oauth')", start));
  assert.match(block, /storeRauApiKey\(rauManager\.setApiKey\.bind\(rauManager\), redeemed\.apiKey/);
  assert.match(block, /createDeviceSessionV2\(/);
  assert.match(block, /redeemDeviceSessionV2\(/);
  assert.match(block, /acknowledgeDeviceSessionV2\(/);
  assert.ok(block.indexOf('storeRauApiKey') < block.indexOf('acknowledgeDeviceSessionV2'));
  assert.match(block, /callbackState = crypto\.randomBytes\(24\)\.toString\('base64url'\)/);
  assert.doesNotMatch(block, /piManager\.setApiKey/);
  assert.match(source, /code: 'RAU_CREDITS_EMPTY'/);
  assert.match(source, /creditBalanceEmpty\(rauCreditsBalance\)/);
  assert.match(source, /case 'agent-setup-disconnect'/);
  assert.match(source, /filter\(\(session\) => session\.agentSession\?\.agent === 'rau'\)/);
  assert.match(source, /Promise\.all\(rauSessions\.map\(disposeSession\)\)/);
  assert.match(source, /rauManager\.clearApiKey\(\)/);
  const clearKey = source.indexOf('void rauManager.clearApiKey()');
  const disposeSessions = source.indexOf('Promise.all(rauSessions.map(disposeSession))');
  assert.notEqual(clearKey, -1);
  assert.notEqual(disposeSessions, -1);
  assert.ok(clearKey < disposeSessions);
  assert.match(source, /isOpenRouterCreditError\(evt\.message\)/);
  assert.match(source, /piManager: selection\.agent === 'rau' \? rauManager : piManager/);
  assert.match(source, /openRouter: selection\.agent === 'rau' \? rauOpenRouter : openRouter/);
  assert.match(source, /health: providerHealth\.cached\(\),\s*\n\s*piStatus,\s*\n\s*rauStatus,/);
  for (const mutation of source.matchAll(/(?:piManager|rauManager)\.(?:install|automaticUpdate)\(/g)) {
    const index = mutation.index;
    const start = source.lastIndexOf('\n', index);
    assert.match(source.slice(start, index), /mutateSharedNpmPrefix/);
  }
});
