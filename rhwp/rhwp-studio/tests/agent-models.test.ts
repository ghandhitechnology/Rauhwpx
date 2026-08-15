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
  modelSupportsImages,
  resolveEffortForAgent,
  resolveModelForAgent,
  setPiModels,
} from '../src/agent/models.ts';
import type { PiModelConfig } from '../src/agent/types.ts';

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

    assert.deepEqual(
      effortsForAgent('pi', 'deepseek/deepseek-chat-v3.1').map((e) => e.id),
      ['low', 'medium', 'high'],
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
