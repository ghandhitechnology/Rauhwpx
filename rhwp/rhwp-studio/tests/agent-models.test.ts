import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentSupportsFast,
  availableModelsForAgent,
  defaultEffortForAgent,
  defaultModelForAgent,
  effortsForAgent,
  isModelForAgent,
  labelForEffort,
  labelForModel,
  modelGroupsForAgent,
  modelsForAgent,
  modelSupportsImages,
  resolveEffortForAgent,
  resolveModelForAgent,
  resolveServiceTier,
  setPiModels,
  setModelCatalog,
  setSelectedModels,
} from '../src/agent/models.ts';
import type { PiModelConfig } from '../src/agent/types.ts';

test('claude and codex expose distinct model catalogs', () => {
  const claude = modelsForAgent('claude').map((m) => m.id);
  const codex = modelsForAgent('codex').map((m) => m.id);
  assert.deepEqual(claude, ['fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(codex, ['astra', 'sol', 'luna', 'terra']);
});

test('resolveModelForAgent falls back to provider default when model does not fit', () => {
  assert.equal(resolveModelForAgent('claude', 'gpt-5.6-sol'), defaultModelForAgent('claude'));
  assert.equal(resolveModelForAgent('codex', 'sonnet'), defaultModelForAgent('codex'));
  assert.equal(resolveModelForAgent('claude', 'fable'), 'fable');
  assert.equal(resolveModelForAgent('codex', 'gpt-5.6-luna'), 'sol');
  assert.equal(resolveModelForAgent('codex', 'gpt-6-sol'), 'sol');
});

test('isModelForAgent and labels stay provider-scoped', () => {
  assert.equal(isModelForAgent('claude', 'opus'), true);
  assert.equal(isModelForAgent('claude', 'gpt-5.6-sol'), false);
  assert.equal(labelForModel('claude', 'haiku'), 'Haiku');
  assert.equal(labelForModel('codex', 'terra'), 'Terra');
  assert.equal(labelForModel('codex', 'astra'), 'Astra');
  assert.equal(labelForModel('claude', 'opus'), 'Opus');
  assert.equal(labelForModel('claude', 'fable'), 'Fable');
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
    ['max', 'xhigh', 'high', 'medium', 'low'],
  );
});

test('resolveEffortForAgent clamps unsupported levels to provider default', () => {
  assert.equal(resolveEffortForAgent('claude', 'max', 'sonnet'), 'max');
  assert.equal(resolveEffortForAgent('claude', 'max', 'haiku'), defaultEffortForAgent('claude', 'haiku'));
  assert.equal(resolveEffortForAgent('codex', 'xhigh'), 'xhigh');
  assert.equal(resolveEffortForAgent('codex', 'ultra'), defaultEffortForAgent('codex'));
  assert.equal(labelForEffort('claude', 'high', 'sonnet'), 'High');
});

test('Fast service tier is Codex-only and defaults to standard', () => {
  assert.equal(agentSupportsFast('codex'), true);
  assert.equal(agentSupportsFast('claude'), false);
  assert.equal(resolveServiceTier('codex', 'fast'), 'fast');
  assert.equal(resolveServiceTier('codex', 'standard'), 'standard');
  assert.equal(resolveServiceTier('codex', 'priority'), 'standard');
  assert.equal(resolveServiceTier('claude', 'fast'), 'standard');
  assert.equal(resolveServiceTier('pi', 'fast'), 'standard');
});

const PI_MODEL_A: PiModelConfig = {
  id: 'deepseek/deepseek-chat-v3.1',
  name: '내 모델 A',
  reasoning: true,
  supportsImages: false,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium',
  contextLength: 128000,
  pricing: { prompt: 0.000001, completion: 0.000002 },
};

const PI_MODEL_B: PiModelConfig = {
  id: 'openai/gpt-oss-20b',
  name: '내 모델 B',
  reasoning: false,
  supportsImages: true,
  efforts: [],
  defaultEffort: '',
  contextLength: 32000,
  pricing: { prompt: 0.0000005, completion: 0.000001 },
};

test('pi 모델 레지스트리가 비어 있으면 목록도 비어 있고 저장된 값을 뭉개지 않는다', () => {
  setPiModels([]);
  try {
    assert.deepEqual(modelsForAgent('pi'), []);
    assert.equal(defaultModelForAgent('pi'), '');
    // 아직 pi-status 가 오지 않았으니 저장된 옛 모델/강도를 그대로 지킨다.
    assert.equal(resolveModelForAgent('pi', 'some/old-model'), 'some/old-model');
    assert.equal(resolveModelForAgent('pi', null), '');
    assert.equal(resolveEffortForAgent('pi', 'high', 'some/old-model'), 'high');
    assert.deepEqual(effortsForAgent('pi', 'some/old-model'), []);
  } finally {
    setPiModels([]);
  }
});

test('pi 모델 레지스트리가 채워지면 표시 이름 · effort · 기본값이 그 모델을 따른다', () => {
  setPiModels([PI_MODEL_A, PI_MODEL_B]);
  try {
    assert.deepEqual(modelsForAgent('pi'), [
      { id: 'deepseek/deepseek-chat-v3.1', label: '내 모델 A' },
      { id: 'openai/gpt-oss-20b', label: '내 모델 B' },
    ]);
    assert.equal(defaultModelForAgent('pi'), 'deepseek/deepseek-chat-v3.1');
    assert.equal(labelForModel('pi', 'openai/gpt-oss-20b'), '내 모델 B');
    assert.equal(labelForModel('pi', 'unknown/model'), 'unknown/model');
    assert.equal(isModelForAgent('pi', 'openai/gpt-oss-20b'), true);
    assert.equal(isModelForAgent('pi', 'unknown/model'), false);
    assert.equal(modelSupportsImages('pi', 'deepseek/deepseek-chat-v3.1'), false);
    assert.equal(modelSupportsImages('pi', 'openai/gpt-oss-20b'), true);
    assert.equal(modelSupportsImages('codex', 'gpt-5.6-sol'), true);

    // 등록되지 않은 모델은(레지스트리가 비어 있지 않으므로) 첫 모델로 접힌다.
    assert.equal(resolveModelForAgent('pi', 'unknown/model'), 'deepseek/deepseek-chat-v3.1');
    assert.equal(resolveModelForAgent('pi', 'openai/gpt-oss-20b'), 'openai/gpt-oss-20b');

    // 허브는 low→high 로 주지만 카탈로그는 다른 프로바이더와 같이 강함→약함.
    // 슬라이더가 이걸 뒤집으므로 Low 가 왼쪽, High 가 오른쪽에 선다.
    assert.deepEqual(
      effortsForAgent('pi', 'deepseek/deepseek-chat-v3.1').map((e) => e.id),
      ['high', 'medium', 'low'],
    );
    assert.equal(labelForEffort('pi', 'high', 'deepseek/deepseek-chat-v3.1'), 'High');
    assert.equal(defaultEffortForAgent('pi', 'deepseek/deepseek-chat-v3.1'), 'medium');
    // 추론을 지원하지 않는 모델은 effort 목록이 비어 있다 — UI 가 선택기를 숨긴다.
    assert.deepEqual(effortsForAgent('pi', 'openai/gpt-oss-20b'), []);
    assert.equal(defaultEffortForAgent('pi', 'openai/gpt-oss-20b'), '');

    assert.equal(
      resolveEffortForAgent('pi', 'xhigh', 'deepseek/deepseek-chat-v3.1'),
      'medium',
    );
  } finally {
    setPiModels([]);
  }
});

test('claude and codex model groups stay a single unlabeled list', () => {
  assert.deepEqual(modelGroupsForAgent('claude').map((g) => g.label), [null]);
  assert.deepEqual(
    modelGroupsForAgent('claude')[0]!.options.map((m) => m.id),
    modelsForAgent('claude').map((m) => m.id),
  );
  assert.deepEqual(modelGroupsForAgent('codex').map((g) => g.label), [null]);
  assert.deepEqual(
    modelGroupsForAgent('codex')[0]!.options.map((m) => m.id),
    modelsForAgent('codex').map((m) => m.id),
  );
});

test('live catalogs expose all models while the sidebar shows only saved selections', () => {
  setModelCatalog('codex', [
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', supportedEfforts: ['low', 'medium', 'high'] },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', supportedEfforts: ['medium', 'high', 'xhigh'] },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', supportedEfforts: [] },
  ]);
  setSelectedModels({ claude: ['sonnet'], codex: ['sol', 'gpt-5.3-codex'] });
  try {
    assert.equal(availableModelsForAgent('codex').length, 3);
    assert.deepEqual(modelsForAgent('codex').map((model) => model.id), ['gpt-6.1-sol', 'gpt-5.3-codex']);
    assert.deepEqual(effortsForAgent('codex', 'gpt-6.1-sol').map((effort) => effort.id), ['xhigh', 'high', 'medium']);
    assert.deepEqual(effortsForAgent('codex', 'gpt-5.3-codex'), []);
    assert.equal(resolveModelForAgent('codex', 'gpt-5.3-codex'), 'gpt-5.3-codex');
    assert.equal(resolveModelForAgent('codex', 'gpt-6-sol'), 'gpt-6.1-sol');
    setSelectedModels({ claude: ['sonnet'], codex: ['astra', 'terra'] });
    setModelCatalog('codex', availableModelsForAgent('codex'));
    assert.deepEqual(modelsForAgent('codex').map((model) => model.id), ['gpt-6.1-sol']);
  } finally {
    setModelCatalog('codex', []);
    setSelectedModels({ claude: ['fable', 'opus', 'sonnet', 'haiku'], codex: ['astra', 'sol', 'luna', 'terra'] });
  }
});

test('pi 레지스트리 유예는 다른 프로바이더 id 검사와 무관하게 유지된다', () => {
  setPiModels([]);
  assert.equal(resolveModelForAgent('pi', 'sonnet'), 'sonnet');
  assert.equal(resolveModelForAgent('pi', null), '');
  assert.equal(resolveModelForAgent('claude', 'composer-1'), 'sonnet');
  assert.equal(resolveModelForAgent('codex', 'composer-1'), 'sol');
});
