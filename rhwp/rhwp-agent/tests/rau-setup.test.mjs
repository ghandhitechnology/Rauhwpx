import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hubDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Rau connects directly to OpenRouter with an isolated key and callback', async () => {
  const source = await fs.readFile(path.join(hubDir, 'server.mjs'), 'utf8');
  assert.match(source, /secretId: RAU_SECRET_ID/);
  assert.match(source, /lockedModels: RAU_LOCKED_MODELS/);
  assert.match(source, /prefixDir: piManager\.prefixDir/);
  assert.match(source, /callbackPath = agent === 'rau' \? '\/oauth\/openrouter\/rau\/callback'/);
  assert.match(source, /openRouterManager\(agent\)\.beginOAuth\(callbackUrl\)/);
  assert.match(source, /openRouterManager\(agent\)\.setApiKey/);
  assert.match(source, /openRouterOauthAgent === 'rau'/);
  assert.doesNotMatch(source, /createRauCreditsClient/);
  assert.doesNotMatch(source, /RAU_CREDITS_EMPTY/);
  assert.match(source, /case 'agent-setup-disconnect'/);
  assert.match(source, /rauManager\.clearApiKey\(\)/);
});
