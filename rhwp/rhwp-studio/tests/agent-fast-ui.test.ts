import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../rhwp-agent/README.md', import.meta.url), 'utf8');

test('slash menu exposes /fast only for Codex', () => {
  assert.match(source, /value: '\/fast'/);
  assert.match(source, /agentSupportsFast\(selectedAgent\)/);
  assert.match(source, /local: 'fast'/);
  assert.match(source, /Codex Fast 켜기/);
  assert.match(source, /Codex Fast 끄기/);
});

test('local /fast commands finish before a user message is sent', () => {
  assert.match(source, /function applyFastCommand\(action: 'on' \| 'off' \| 'status' \| 'toggle'\)/);
  const fastHandler = source.indexOf('const fastCommand = text.match');
  assert.ok(fastHandler > 0);
  assert.ok(fastHandler < source.indexOf('recordUserMessage(messageText,'));
  assert.ok(fastHandler < source.indexOf('bridge.sendUserMessage(requestText, skillNameForMessage,'));
  assert.match(source, /option\.local === 'fast'/);
  assert.match(source, /지원하지 않는 \/fast 인자입니다/);
});

test('hub and Codex consume a ServiceTier session field', () => {
  assert.match(bridge, /type: 'chat-service-tier-set'/);
  assert.match(bridge, /serviceTier: this\.serviceTier/);
  assert.match(bridge, /setServiceTier\(tier: ServiceTier\)/);
  assert.match(readme, /\/fast \[on\|off\|status\]/);
});
