import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createClaudeModelCatalog,
  discoverClaudeModels,
  normalizeClaudeModels,
} from '../claude-model-catalog.mjs';

test('Claude catalog uses explicit IDs and keeps the context variant', () => {
  assert.deepEqual(normalizeClaudeModels([
    { value: 'default', resolvedModel: 'claude-sonnet-5', displayName: 'Default (recommended)' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet',
      supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 1M' },
    { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus' },
  ]), [
    { id: 'claude-sonnet-5', label: 'Sonnet', supportedEfforts: ['low', 'medium', 'high'] },
    { id: 'claude-fable-5-1[1m]', label: 'Fable 1M' },
    { id: 'claude-opus-5', label: 'Opus' },
  ]);
});

test('Claude discovery opens only a control channel and closes it', async () => {
  let closed = false;
  const models = await discoverClaudeModels({
    bin: '/test/claude', cwd: '/test', env: { PATH: '/bin' },
    queryModels: ({ prompt, options }) => {
      assert.equal(options.pathToClaudeCodeExecutable, '/test/claude');
      assert.equal(options.cwd, '/test');
      assert.deepEqual(options.settingSources, []);
      assert.equal(typeof prompt[Symbol.asyncIterator], 'function');
      return { supportedModels: async () => [{ value: 'sonnet' }], close: () => { closed = true; } };
    },
  });
  assert.deepEqual(models, [{ value: 'sonnet' }]);
  assert.equal(closed, true);
});

test('Claude discovery closes a stalled control channel at its deadline', async () => {
  let closed = false;
  await assert.rejects(discoverClaudeModels({
    timeoutMs: 10,
    queryModels: () => ({ supportedModels: () => new Promise(() => {}), close: () => { closed = true; } }),
  }), /timed out/);
  assert.equal(closed, true);
});

test('Claude catalog caches successful discovery and refreshes on request', async () => {
  let calls = 0;
  const catalog = createClaudeModelCatalog({
    discover: async () => [{ value: 'sonnet', resolvedModel: `claude-sonnet-${++calls}`, displayName: 'Sonnet' }],
  });
  const options = { bin: '/test/claude', env: { CLAUDE_CONFIG_DIR: '/test/config' } };
  assert.equal((await catalog(options))[0].id, 'claude-sonnet-1');
  assert.equal((await catalog(options))[0].id, 'claude-sonnet-1');
  assert.equal((await catalog(options, { refresh: true }))[0].id, 'claude-sonnet-2');
  assert.equal(calls, 2);
});

test('an empty Claude response is a catalog error', async () => {
  const catalog = createClaudeModelCatalog({ discover: async () => [] });
  await assert.rejects(catalog(), /empty model catalog/);
});
