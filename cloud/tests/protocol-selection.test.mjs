import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProviderSelection } from '../src/protocol.mjs';

test('provider selection accepts stable lineups and concrete version IDs', () => {
  for (const model of ['astra', 'sol', 'luna', 'terra', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-6.1-sol', 'gpt-10.12-astra']) {
    assert.deepEqual(parseProviderSelection({ provider: 'codex', model, effort: 'high' }),
      { provider: 'codex', model, effort: 'high' });
  }
  for (const model of ['opus', 'fable', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-4-6-20260514']) {
    assert.deepEqual(parseProviderSelection({ provider: 'claude', model, effort: 'high' }),
      { provider: 'claude', model, effort: 'high' });
  }
});

test('provider selection rejects unrelated or unsafe model IDs', () => {
  for (const model of ['gpt-6-pro', 'gpt-6.1', 'gpt-0-sol', 'gpt-6..1-sol', 'sol/../../model', 'claude-opus-5-1']) {
    assert.throws(() => parseProviderSelection({ provider: 'codex', model, effort: 'high' }),
      { code: 'INVALID_MODEL' });
  }
  for (const model of ['gpt-6-sol', 'claude-unknown-5-1', 'claude-opus-5-x', 'claude-opus-0']) {
    assert.throws(() => parseProviderSelection({ provider: 'claude', model, effort: 'high' }),
      { code: 'INVALID_MODEL' });
  }
  for (const model of ['--unsafe-option', ' sol', 'sol\nnext']) {
    assert.throws(() => parseProviderSelection({ provider: 'codex', model, effort: 'high' }),
      { code: 'INVALID_REQUEST' });
  }
});

test('Haiku keeps its effort limit for stable and concrete IDs', () => {
  for (const model of ['haiku', 'claude-haiku-4-5']) {
    assert.throws(() => parseProviderSelection({ provider: 'claude', model, effort: 'max' }),
      { code: 'INVALID_EFFORT' });
  }
});
