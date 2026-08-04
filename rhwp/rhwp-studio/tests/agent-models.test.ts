import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultEffortForAgent,
  defaultModelForAgent,
  effortsForAgent,
  isModelForAgent,
  labelForEffort,
  labelForModel,
  modelsForAgent,
  resolveEffortForAgent,
  resolveModelForAgent,
} from '../src/agent/models.ts';

test('claude and codex expose distinct model catalogs', () => {
  const claude = modelsForAgent('claude').map((m) => m.id);
  const codex = modelsForAgent('codex').map((m) => m.id);
  assert.deepEqual(claude, ['fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(codex, ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
});

test('resolveModelForAgent falls back to provider default when model does not fit', () => {
  assert.equal(resolveModelForAgent('claude', 'gpt-5.6-sol'), defaultModelForAgent('claude'));
  assert.equal(resolveModelForAgent('codex', 'sonnet'), defaultModelForAgent('codex'));
  assert.equal(resolveModelForAgent('claude', 'fable'), 'fable');
  assert.equal(resolveModelForAgent('codex', 'gpt-5.6-luna'), 'gpt-5.6-luna');
});

test('isModelForAgent and labels stay provider-scoped', () => {
  assert.equal(isModelForAgent('claude', 'opus'), true);
  assert.equal(isModelForAgent('claude', 'gpt-5.6-sol'), false);
  assert.equal(labelForModel('claude', 'haiku'), 'Haiku 4.5');
  assert.equal(labelForModel('codex', 'gpt-5.6-terra'), 'Terra');
});

test('effort catalogs follow provider capabilities', () => {
  assert.deepEqual(
    effortsForAgent('claude', 'sonnet').map((e) => e.id),
    ['max', 'xhigh', 'high', 'medium', 'low'],
  );
  assert.deepEqual(
    effortsForAgent('claude', 'haiku').map((e) => e.id),
    ['high', 'medium', 'low'],
  );
  assert.deepEqual(
    effortsForAgent('codex').map((e) => e.id),
    ['high', 'medium', 'low'],
  );
});

test('resolveEffortForAgent clamps unsupported levels to provider default', () => {
  assert.equal(resolveEffortForAgent('claude', 'max', 'sonnet'), 'max');
  assert.equal(resolveEffortForAgent('claude', 'max', 'haiku'), defaultEffortForAgent('claude', 'haiku'));
  assert.equal(resolveEffortForAgent('codex', 'xhigh'), defaultEffortForAgent('codex'));
  assert.equal(labelForEffort('claude', 'high', 'sonnet'), 'High');
});
