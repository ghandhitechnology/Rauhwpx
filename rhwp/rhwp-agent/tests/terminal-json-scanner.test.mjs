import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalJsonScanner } from '../terminal-json-scanner.mjs';

test('Codex terminal JSONL is scanned incrementally across one-byte chunks', () => {
  const scanner = createTerminalJsonScanner('codex-jsonl');
  const event = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}\n`;
  let complete = false;
  for (const character of event) complete = scanner.push(character);
  assert.equal(complete, true);
});

test('nonterminal objects do not hide a later Claude terminal result', () => {
  const scanner = createTerminalJsonScanner('claude-json');
  assert.equal(scanner.push('{"type":"progress","nested":{"done":false}}\n'), false);
  assert.equal(scanner.push('{"type":"result","structured_output":{"ok":true}}'), true);
});

test('oversized partial frames are discarded without becoming terminal', () => {
  const scanner = createTerminalJsonScanner('codex-jsonl', { maxFrameBytes: 32 });
  assert.equal(scanner.push(`{"padding":"${'x'.repeat(64)}`), false);
  assert.equal(scanner.push('","type":"turn.failed"}'), false);
});
