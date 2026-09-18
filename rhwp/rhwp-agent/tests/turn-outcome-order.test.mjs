import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayMissedTurnEnd } from '../turn-outcome-replay.mjs';

const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('missed terminal outcome is delivered before reconnect welcome', () => {
  const event = { type: 'turn-end', outcome: 'success' };
  const record = { missedTurnEnd: event };
  const frames = [];
  const sendJson = (_socket, frame) => {
    frames.push(frame);
    return true;
  };

  assert.equal(replayMissedTurnEnd(record, {}, sendJson), true);
  sendJson({}, { v: 1, type: 'welcome' });

  assert.equal(frames[0].type, 'agent-event');
  assert.equal(frames[0].event, event);
  assert.equal(frames[1].type, 'welcome');
  assert.equal(record.missedTurnEnd, null);
});

test('failed replay keeps the terminal outcome for the next reconnect', () => {
  const event = { type: 'turn-end', outcome: 'failed' };
  const record = { missedTurnEnd: event };

  assert.equal(replayMissedTurnEnd(record, {}, () => false), false);
  assert.equal(record.missedTurnEnd, event);

  const frames = [];
  assert.equal(replayMissedTurnEnd(record, {}, (_socket, frame) => {
    frames.push(frame);
    return true;
  }), true);
  assert.equal(frames[0].event, event);
  assert.equal(record.missedTurnEnd, null);
});

test('server invokes terminal replay before reconnect welcome', () => {
  const replay = server.indexOf('replayMissedTurnEnd(record, ws, sendJson);');
  const welcome = server.indexOf("type: 'welcome'", replay);
  assert.ok(replay >= 0);
  assert.ok(welcome > replay, 'welcome must not precede the authoritative terminal outcome');
});
