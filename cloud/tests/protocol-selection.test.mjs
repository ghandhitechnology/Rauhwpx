import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProviderSelection } from '../src/protocol.mjs';

test('provider selection accepts catalog IDs without a version allowlist', () => {
  for (const model of ['astra', 'sol', 'luna', 'terra', 'gpt-6-sol', 'gpt-5.5', 'o3', 'codex-next']) {
    assert.deepEqual(parseProviderSelection({ provider: 'codex', model, effort: 'high' }),
      { provider: 'codex', model, effort: 'high' });
  }
  for (const model of ['opus', 'fable', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-newfamily-6-1']) {
    assert.deepEqual(parseProviderSelection({ provider: 'claude', model, effort: 'high' }),
      { provider: 'claude', model, effort: 'high' });
  }
});

test('provider selection rejects unsafe model identifiers', () => {
  for (const model of ['--unsafe-option', ' sol', 'sol\nnext', 'model name', 'model;rm']) {
    assert.throws(() => parseProviderSelection({ provider: 'codex', model, effort: 'high' }),
      { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => parseProviderSelection({ provider: 'pi', model: 'sol/../../model', effort: 'high' }),
    { code: 'INVALID_MODEL' });
});

test('Haiku keeps its effort limit for stable and concrete IDs', () => {
  for (const model of ['haiku', 'claude-haiku-4-5']) {
    assert.throws(() => parseProviderSelection({ provider: 'claude', model, effort: 'max' }),
      { code: 'INVALID_EFFORT' });
  }
});

test('provider selections can omit effort for models without reasoning controls', () => {
  assert.equal(parseProviderSelection({ provider: 'codex', model: 'gpt-5.5', effort: '' }).effort, '');
  assert.equal(parseProviderSelection({ provider: 'claude', model: 'claude-sonnet-5', effort: '' }).effort, '');
  assert.equal(parseProviderSelection({ provider: 'codex', model: 'gpt-5.5', effort: 'ultra' }).effort, 'ultra');
  assert.throws(() => parseProviderSelection({ provider: 'claude', model: 'claude-sonnet-5', effort: 'ultra' }),
    { code: 'INVALID_EFFORT' });
});
