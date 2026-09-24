import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createClaudeModelCatalog,
  discoverClaudeModels,
  normalizeClaudeModels,
} from '../claude-model-catalog.mjs';
import { claudeModelDescription, claudeModelLabel } from '../claude-model-label.mjs';

test('Claude catalog uses explicit IDs and keeps the context variant', () => {
  assert.deepEqual(normalizeClaudeModels([
    { value: 'default', resolvedModel: 'claude-sonnet-5', displayName: 'Default (recommended)' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet',
      description: 'Sonnet 5 · Efficient for routine tasks',
      supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 1M' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku',
      description: 'Haiku 4.5 · Fastest for quick answers' },
  ]), [
    { id: 'claude-fable-5-1[1m]', label: 'Fable 5.1 (1M)' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Efficient for routine tasks',
      supportedEfforts: ['low', 'medium', 'high'] },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fastest for quick answers' },
  ]);
});

test('Claude catalog upgrades outdated CLI models to the official lineup', () => {
  const catalog = normalizeClaudeModels([
    { value: 'claude-opus-4-6', displayName: 'Opus 4.6' },
    { value: 'claude-opus-5[1m]', displayName: 'Opus (1M context)',
      description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'claude-opus-5', displayName: 'Opus' },
  ]);
  assert.deepEqual(catalog.map((model) => model.id), [
    'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
  ]);
  const opus = catalog.find((model) => model.id === 'claude-opus-5-5[1m]');
  assert.equal(opus.label, 'Opus 5.5 (1M)');
  assert.equal(opus.description, 'Best for everyday, complex tasks');
  assert.deepEqual(opus.supportedEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  // 공식 목록보다 새 모델은 그대로 둔다.
  assert.ok(normalizeClaudeModels([{ value: 'claude-sonnet-6' }]).some((model) => model.id === 'claude-sonnet-6'));
});

test('Claude labels fall back to the CLI name for unfamiliar IDs', () => {
  assert.equal(claudeModelLabel('claude-3-5-sonnet-20241022', 'Sonnet 3.5'), 'Sonnet 3.5');
  assert.equal(claudeModelLabel('claude-opus-5[1m]'), 'Opus 5 (1M)');
  assert.equal(claudeModelDescription('Opus 5 with 1M context · Best for everyday, complex tasks'),
    'Best for everyday, complex tasks');
  assert.equal(claudeModelDescription('Custom model'), 'Custom model');
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
    // 공식 목록보다 새 버전이어야 CLI 항목이 그대로 남는다.
    discover: async () => [{ value: 'sonnet', resolvedModel: `claude-sonnet-${10 + ++calls}`, displayName: 'Sonnet' }],
  });
  const options = { bin: '/test/claude', env: { CLAUDE_CONFIG_DIR: '/test/config' } };
  const sonnet = (models) => models.find((model) => model.id.startsWith('claude-sonnet-'))?.id;
  assert.equal(sonnet(await catalog(options)), 'claude-sonnet-11');
  assert.equal(sonnet(await catalog(options)), 'claude-sonnet-11');
  assert.equal(sonnet(await catalog(options, { refresh: true })), 'claude-sonnet-12');
  assert.equal(calls, 2);
});

test('an empty Claude response is a catalog error', async () => {
  const catalog = createClaudeModelCatalog({ discover: async () => [] });
  await assert.rejects(catalog(), /empty model catalog/);
});
