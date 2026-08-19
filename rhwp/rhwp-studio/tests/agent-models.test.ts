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
  setCursorModels,
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

test('grok 은 정적 카탈로그와 세 단계 추론 강도를 갖는다', () => {
  assert.deepEqual(modelsForAgent('grok').map((m) => m.id), ['grok-4.6', 'grok-4.5']);
  assert.equal(defaultModelForAgent('grok'), 'grok-4.6');
  assert.equal(labelForModel('grok', 'grok-4.5'), 'Grok 4.5');
  assert.equal(isModelForAgent('grok', 'grok-4.6'), true);
  assert.equal(isModelForAgent('grok', 'sonnet'), false);
  // 다른 프로바이더의 모델은 grok 기본값으로 접힌다.
  assert.equal(resolveModelForAgent('grok', 'gpt-5.6-sol'), 'grok-4.6');
  assert.deepEqual(effortsForAgent('grok').map((e) => e.id), ['xhigh', 'high', 'medium', 'low']);
  assert.equal(defaultEffortForAgent('grok'), 'high');
  assert.equal(labelForEffort('grok', 'medium'), 'Medium');
  // grok CLI 가 모르는 강도는 grok 기본값으로 내려간다.
  assert.equal(resolveEffortForAgent('grok', 'max'), 'high');
  assert.equal(resolveEffortForAgent('grok', 'low'), 'low');
  assert.equal(modelSupportsImages('grok', 'grok-4.6'), true);
});

test('cursor 는 auto 씨앗으로 시작하고 추론 강도를 노출하지 않는다', () => {
  setCursorModels([]);
  try {
    assert.deepEqual(modelsForAgent('cursor'), [{ id: 'auto', label: 'Auto' }]);
    assert.equal(defaultModelForAgent('cursor'), 'auto');
    assert.equal(resolveModelForAgent('cursor', null), 'auto');
    // CLI 목록이 아직 없으면 cursor 것으로 보이는 저장값은 뭉개지 않는다.
    assert.equal(resolveModelForAgent('cursor', 'gpt-5.2-codex'), 'gpt-5.2-codex');
    // 추론 강도는 어떤 모델에서도 없다 — UI 가 선택기를 숨긴다.
    assert.deepEqual(effortsForAgent('cursor'), []);
    assert.equal(defaultEffortForAgent('cursor'), '');
    assert.equal(resolveEffortForAgent('cursor', 'high'), '');
  } finally {
    setCursorModels([]);
  }
});

test('cursor 동적 목록은 auto 뒤에 붙고 모르는 모델은 auto 로 접힌다', () => {
  setCursorModels(['auto', 'composer-1', 'claude-4.5-sonnet', 'composer-1']);
  try {
    assert.deepEqual(modelsForAgent('cursor'), [
      { id: 'auto', label: 'Auto' },
      { id: 'composer-1', label: 'composer-1' },
      { id: 'claude-4.5-sonnet', label: 'claude-4.5-sonnet' },
    ]);
    assert.equal(isModelForAgent('cursor', 'composer-1'), true);
    assert.equal(isModelForAgent('cursor', 'unknown-model'), false);
    assert.equal(labelForModel('cursor', 'composer-1'), 'composer-1');
    assert.equal(resolveModelForAgent('cursor', 'composer-1'), 'composer-1');
    assert.equal(resolveModelForAgent('cursor', 'unknown-model'), 'auto');
    assert.deepEqual(effortsForAgent('cursor', 'composer-1'), []);
  } finally {
    setCursorModels([]);
  }
});

test('cursor 목록 대기 중이라도 다른 프로바이더의 모델 id 는 auto 로 접힌다', () => {
  setCursorModels([]);
  setPiModels([PI_MODEL_A]);
  try {
    // Claude/sonnet 에서 Cursor 로 갈아타면 'sonnet' 이 따라오지 않는다.
    assert.equal(resolveModelForAgent('cursor', 'sonnet'), 'auto');
    assert.equal(resolveModelForAgent('cursor', 'gpt-5.6-sol'), 'auto');
    assert.equal(resolveModelForAgent('cursor', 'grok-4.6'), 'auto');
    // pi 레지스트리에 등록된 id 도 마찬가지다.
    assert.equal(resolveModelForAgent('cursor', PI_MODEL_A.id), 'auto');
    // cursor 것으로 볼 수 있는(다른 카탈로그에 없는) 저장값은 그대로 지킨다.
    assert.equal(resolveModelForAgent('cursor', 'composer-1'), 'composer-1');
  } finally {
    setPiModels([]);
    setCursorModels([]);
  }
});

test('pi 레지스트리 유예는 다른 프로바이더 id 검사와 무관하게 유지된다', () => {
  setPiModels([]);
  // pi-status 도착 전에는 저장된 값을(다른 프로바이더의 id 라도) 그대로 지킨다.
  assert.equal(resolveModelForAgent('pi', 'sonnet'), 'sonnet');
  assert.equal(resolveModelForAgent('pi', null), '');
  // claude/codex/grok 은 정적 카탈로그라 유예 없이 즉시 기본값으로 접힌다.
  assert.equal(resolveModelForAgent('claude', 'composer-1'), 'sonnet');
  assert.equal(resolveModelForAgent('codex', 'composer-1'), 'gpt-5.6-sol');
  assert.equal(resolveModelForAgent('grok', 'composer-1'), 'grok-4.6');
});
