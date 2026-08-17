import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('missed terminal outcome is replayed before reconnect welcome', () => {
  const replay = server.indexOf('if (record.missedTurnEnd) {');
  const welcome = server.indexOf("type: 'welcome'", replay);
  assert.ok(replay >= 0);
  assert.ok(welcome > replay, 'welcome must not precede the authoritative terminal outcome');
  assert.match(server, /Studio must never auto-commit an interrupted turn first/);
});
