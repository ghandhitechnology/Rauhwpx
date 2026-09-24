import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_PREFS_STORAGE_KEY,
  applyFirstRunDefaultAgent,
  defaultAgentPrefs,
  DEFAULT_CHAT_AGENT,
  firstRunDefaultAgent,
  hasExplicitDefaultAgent,
  loadAgentPrefs,
  normalizeAgentPrefs,
  saveAgentPrefs,
  trySaveAgentPrefs,
} from '../src/agent/agent-prefs.ts';
import { setPiModels } from '../src/agent/models.ts';
import type { PiModelConfig } from '../src/agent/types.ts';

/** localStorage 대역 — 테스트는 브라우저 없이 돌아간다. */
function makeStorage(seed?: unknown) {
  const map = new Map<string, string>();
  if (seed !== undefined) {
    map.set(AGENT_PREFS_STORAGE_KEY, typeof seed === 'string' ? seed : JSON.stringify(seed));
  }
  return {
    map,
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
  };
}

test('빈 저장소는 Claude/Sonnet/High/안전 기본값을 준다', () => {
  const prefs = loadAgentPrefs(makeStorage());
  assert.deepEqual(prefs, {
    defaultAgent: 'claude',
    defaultModel: 'sonnet',
    defaultEffort: 'high',
    defaultPermissionProfile: 'safe',
  });
  assert.deepEqual(prefs, defaultAgentPrefs());
  assert.equal(DEFAULT_CHAT_AGENT, 'claude');
});

test('모르는 모델은 프로바이더 기본 모델로 접힌다', () => {
  const prefs = loadAgentPrefs(makeStorage({ defaultAgent: 'claude', defaultModel: 'gpt-4o' }));
  assert.equal(prefs.defaultModel, 'sonnet');
});

test('프로바이더가 다르면 모델도 그 프로바이더 기준으로 다시 해석된다', () => {
  const prefs = loadAgentPrefs(makeStorage({ defaultAgent: 'codex', defaultModel: 'opus' }));
  assert.equal(prefs.defaultAgent, 'codex');
  assert.equal(prefs.defaultModel, 'sol');
});

test('모델이 지원하지 않는 추론 강도는 그 모델의 기본값으로 내려간다', () => {
  const prefs = loadAgentPrefs(
    makeStorage({ defaultAgent: 'claude', defaultModel: 'haiku', defaultEffort: 'max' }),
  );
  assert.equal(prefs.defaultModel, 'haiku');
  assert.equal(prefs.defaultEffort, 'high');
});

test('지원되는 조합은 그대로 살아남는다', () => {
  const prefs = loadAgentPrefs(
    makeStorage({ defaultAgent: 'claude', defaultModel: 'opus', defaultEffort: 'xhigh' }),
  );
  assert.equal(prefs.defaultModel, 'opus');
  assert.equal(prefs.defaultEffort, 'xhigh');
});

test('모르는 프로바이더는 claude, 모르는 권한 프로필은 safe', () => {
  const prefs = normalizeAgentPrefs({ defaultAgent: 'gemini', defaultPermissionProfile: 'root' });
  assert.equal(prefs.defaultAgent, 'claude');
  assert.equal(prefs.defaultPermissionProfile, 'safe');
});

test('전체 접근은 유효한 권한 프로필이므로 보존된다', () => {
  const prefs = normalizeAgentPrefs({ defaultPermissionProfile: 'unrestricted' });
  assert.equal(prefs.defaultPermissionProfile, 'unrestricted');
});

test('깨진 JSON 이나 배열이 들어 있어도 기본값으로 복구한다', () => {
  assert.deepEqual(loadAgentPrefs(makeStorage('{not json')), defaultAgentPrefs());
  assert.deepEqual(loadAgentPrefs(makeStorage('[1,2,3]')), defaultAgentPrefs());
});

test('저장은 부분 갱신이고, 저장된 값은 다시 읽힌다', () => {
  const storage = makeStorage();
  const saved = saveAgentPrefs({ defaultAgent: 'claude', defaultModel: 'opus', defaultEffort: 'max' }, storage);
  assert.equal(saved.defaultAgent, 'claude');
  assert.equal(saved.defaultModel, 'opus');
  assert.equal(saved.defaultEffort, 'max');
  assert.deepEqual(loadAgentPrefs(storage), saved);

  // 프로바이더를 바꾸면 남아 있던 모델은 새 프로바이더 기준으로 접히고,
  // 강도는 codex 도 max 를 받으니 그대로 살아남는다.
  const switched = saveAgentPrefs({ defaultAgent: 'codex' }, storage);
  assert.equal(switched.defaultModel, 'sol');
  assert.equal(switched.defaultEffort, 'max');
  assert.equal(JSON.parse(storage.map.get(AGENT_PREFS_STORAGE_KEY)!).defaultAgent, 'codex');
});

test('저장소가 없으면 정규화된 값만 돌려주고 던지지 않는다', () => {
  const prefs = saveAgentPrefs({ defaultAgent: 'codex' }, null);
  assert.equal(prefs.defaultAgent, 'codex');
  assert.equal(prefs.defaultModel, 'sol');
});

const PI_MODEL: PiModelConfig = {
  id: 'deepseek/deepseek-chat-v3.1',
  name: '내 모델',
  reasoning: true,
  supportsImages: false,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium',
  contextLength: 128000,
  pricing: { prompt: 0.000001, completion: 0.000002 },
};

test('pi 레지스트리가 비어 있으면 저장된 pi 모델/강도를 뭉개지 않는다', () => {
  setPiModels([]);
  try {
    const prefs = normalizeAgentPrefs({
      defaultAgent: 'pi',
      defaultModel: 'deepseek/deepseek-chat-v3.1',
      defaultEffort: 'high',
    });
    assert.equal(prefs.defaultAgent, 'pi');
    assert.equal(prefs.defaultModel, 'deepseek/deepseek-chat-v3.1');
    assert.equal(prefs.defaultEffort, 'high');
  } finally {
    setPiModels([]);
  }
});

test('pi 레지스트리가 채워지면 모르는 모델은 레지스트리 기본값으로 접힌다', () => {
  setPiModels([PI_MODEL]);
  try {
    const prefs = normalizeAgentPrefs({
      defaultAgent: 'pi',
      defaultModel: 'unknown/model',
      defaultEffort: 'high',
    });
    assert.equal(prefs.defaultModel, 'deepseek/deepseek-chat-v3.1');
    assert.equal(prefs.defaultEffort, 'high');

    const known = normalizeAgentPrefs({
      defaultAgent: 'pi',
      defaultModel: 'deepseek/deepseek-chat-v3.1',
      defaultEffort: 'xhigh',
    });
    assert.equal(known.defaultModel, 'deepseek/deepseek-chat-v3.1');
    assert.equal(known.defaultEffort, 'medium');
  } finally {
    setPiModels([]);
  }
});

test('쓰기가 실패해도 호출자는 값을 받는다', () => {
  const prefs = saveAgentPrefs(
    { defaultAgent: 'claude', defaultModel: 'opus' },
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    },
  );
  assert.equal(prefs.defaultModel, 'opus');
});

test('결과형 저장 API는 쓰기 실패를 호출자에게 남긴다', () => {
  const result = trySaveAgentPrefs(
    { defaultAgent: 'claude', defaultModel: 'opus' },
    {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.value.defaultModel, 'opus');
  if (!result.ok) assert.match(result.error, /quota/);
});

test('저장된 rau/grok/cursor/opencode 는 라이브 기본값으로 접힌다', () => {
  for (const agent of ['rau', 'grok', 'cursor', 'opencode'] as const) {
    const prefs = normalizeAgentPrefs({
      defaultAgent: agent,
      defaultModel: 'composer-1',
      defaultEffort: 'unknown',
    });
    assert.equal(prefs.defaultAgent, 'claude');
    assert.equal(prefs.defaultModel, 'sonnet');
    assert.equal(prefs.defaultEffort, 'high');
  }

  const storage = makeStorage();
  const saved = saveAgentPrefs({ defaultAgent: 'grok', defaultEffort: 'unknown' }, storage);
  assert.equal(saved.defaultAgent, 'claude');
  assert.equal(saved.defaultModel, 'sonnet');
  assert.equal(saved.defaultEffort, 'high');
  assert.deepEqual(loadAgentPrefs(storage), saved);
});

for (const model of ['gpt-5.6-terra', 'gpt-6-astra']) {
  test(`saved Codex ${model} survives first-run setup and reload`, () => {
    const storage = makeStorage({
      defaultAgent: 'codex',
      defaultModel: model,
      defaultEffort: 'high',
    });
    assert.equal(hasExplicitDefaultAgent(storage), true);
    const kept = applyFirstRunDefaultAgent(['claude'], storage);
    assert.equal(kept.defaultAgent, 'codex');
    assert.equal(kept.defaultModel, model.endsWith('terra') ? 'terra' : 'astra');
    assert.equal(loadAgentPrefs(storage).defaultAgent, 'codex');
    assert.equal(loadAgentPrefs(storage).defaultModel, model.endsWith('terra') ? 'terra' : 'astra');
  });
}

test('첫 실행을 마친 빈 프로필은 Claude 가 기본값이 된다', () => {
  const storage = makeStorage();
  assert.equal(hasExplicitDefaultAgent(storage), false);
  assert.equal(firstRunDefaultAgent([]), 'claude');
  const seeded = applyFirstRunDefaultAgent([], storage);
  assert.equal(seeded.defaultAgent, 'claude');
  assert.equal(seeded.defaultModel, 'sonnet');
  assert.equal(loadAgentPrefs(storage).defaultAgent, 'claude');
});

test('첫 실행에서 BYOK 만 연결하면 그 프로바이더가 기본값이 된다', () => {
  const storage = makeStorage();
  assert.equal(firstRunDefaultAgent(['codex', 'claude']), 'codex');
  const seeded = applyFirstRunDefaultAgent(['codex'], storage);
  assert.equal(seeded.defaultAgent, 'codex');
  assert.equal(seeded.defaultModel, 'sol');
});
