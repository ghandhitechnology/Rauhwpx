import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('hub registers Pi child capabilities only through the active root provider identity', () => {
  assert.match(serverSource, /piSubagents: new PiSubagentCapabilityRegistry\(\)/);
  assert.match(serverSource, /req\.method === 'POST' && piSubagentChildId/);
  assert.match(serverSource, /authenticateHttpSession\(req, url, \{[\s\S]{0,180}resource: activeSession\.providerCapabilityResource/);
  assert.match(serverSource, /record\.piSubagents\.register\(\{/);
  assert.match(serverSource, /sessions\.issue\(TOKEN, record\.sessionId, \{[\s\S]{0,180}resource: registration\.resource/);
});

test('child catalogs and websocket upgrades use the server registration profile and resource', () => {
  assert.match(serverSource, /requestedSubagentId/);
  assert.match(serverSource, /profile = piSubagent\.catalogProfile/);
  assert.match(serverSource, /resource = piSubagent\.resource/);
  assert.match(serverSource, /authenticatedPiSubagent = piSubagent/);
  assert.match(serverSource, /ws\.piSubagentId = authenticatedPiSubagent\?\.childId/);
});

test('every child tool frame rechecks live role and per-profile authorization', () => {
  assert.match(serverSource, /record\.piSubagents\.isCurrent\(piSubagent, activeSession\)/);
  assert.match(serverSource, /!piSubagent\.allowedTools\.has\(tool\)/);
  assert.match(serverSource, /PI_SUBAGENT_TOOL_DENIED/);
  assert.match(serverSource, /if \(workerJob \|\| sock\.piSubagentId \|\| sock\.agentRole !== 'chat' \|\| msg\.parentTaskId\)/);
  assert.match(serverSource, /parentTaskId: sock\.parentTaskId/);
});

test('settled turns and cancellation synchronously retire child capabilities and sockets', () => {
  assert.match(serverSource, /function retirePiSubagentsForTurn/);
  assert.match(serverSource, /record\.piSubagents\.clearTurn\(activeSession\)/);
  assert.match(serverSource, /record\.piSubagents\.revoke\(piSubagentChildId\)/);
  assert.match(serverSource, /pi subagent capability revoked/);
  assert.match(serverSource, /record\.piSubagents\.clear\(\)/);
});
