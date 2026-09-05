import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWritingStyleCatalog, resolveWritingStyleSelection } from '../writing-style-catalog.mjs';

const health = {
  codex: { available: false, error: 'Codex is not connected.' },
  claude: { available: true, error: null },
  pi: { available: true, error: null },
};

const piStatus = {
  setupComplete: true,
  defaultModelId: 'openai/gpt-5.4',
  models: [
    {
      id: 'openai/gpt-5.4', name: 'GPT-5.4', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
      pricing: { prompt: 1, completion: 2 }, contextLength: 100_000,
    },
  ],
};

test('catalog exposes Codex, Claude, Rau, and only the Pi models the user configured', () => {
  const catalog = buildWritingStyleCatalog({ health, piStatus });
  assert.deepEqual(catalog.providers.map((provider) => provider.id), ['codex', 'claude', 'rau', 'pi']);
  assert.equal(catalog.providers.find((provider) => provider.id === 'codex').available, false);
  assert.equal(catalog.providers.find((provider) => provider.id === 'rau').available, false);
  assert.deepEqual(catalog.providers.find((provider) => provider.id === 'pi').models.map((model) => model.id), ['openai/gpt-5.4']);
  assert.deepEqual(catalog.defaultSelection, { agent: 'claude', model: 'sonnet', effort: 'high' });
});
test('Astra calibration selection survives catalog reload with max effort', () => {
  const selection = { agent: 'codex', model: 'gpt-6-astra', effort: 'max' };
  const options = { health: { codex: { available: true } } };
  assert.deepEqual(resolveWritingStyleSelection(selection, options), selection);
  assert.deepEqual(buildWritingStyleCatalog({ ...options, currentSelection: selection }).defaultSelection, selection);
});

test('calibration selection rejects unavailable providers and stale models without fallback', () => {
  assert.throws(
    () => resolveWritingStyleSelection({ agent: 'codex', model: 'gpt-5.6-sol' }, { health, piStatus }),
    (error) => error?.code === 'PROVIDER_UNAVAILABLE',
  );
  assert.throws(
    () => resolveWritingStyleSelection({ agent: 'pi', model: 'not/configured' }, { health, piStatus }),
    (error) => error?.code === 'MODEL_UNAVAILABLE',
  );
  assert.deepEqual(
    resolveWritingStyleSelection({ agent: 'pi', model: 'openai/gpt-5.4', effort: 'high' }, { health, piStatus }),
    { agent: 'pi', model: 'openai/gpt-5.4', effort: 'high' },
  );
});
