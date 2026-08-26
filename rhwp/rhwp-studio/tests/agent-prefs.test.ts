import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_PREFS_STORAGE_KEY,
  defaultAgentPrefs,
  loadAgentPrefs,
  normalizeAgentPrefs,
  saveAgentPrefs,
  trySaveAgentPrefs,
} from '../src/agent/agent-prefs.ts';
import { setCursorModels, setPiModels } from '../src/agent/models.ts';
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

test('빈 저장소는 Codex/Sol/Medium/안전 기본값을 준다', () => {
  const prefs = loadAgentPrefs(makeStorage());
  assert.deepEqual(prefs, {
    defaultAgent: 'codex',
    defaultModel: 'gpt-5.6-sol',
    defaultEffort: 'medium',
    defaultPermissionProfile: 'safe',
  });
  assert.deepEqual(prefs, defaultAgentPrefs());
});

test('모르는 모델은 프로바이더 기본 모델로 접힌다', () => {
  const prefs = loadAgentPrefs(makeStorage({ defaultAgent: 'claude', defaultModel: 'gpt-4o' }));
  assert.equal(prefs.defaultModel, 'sonnet');
});

test('프로바이더가 다르면 모델도 그 프로바이더 기준으로 다시 해석된다', () => {
  const prefs = loadAgentPrefs(makeStorage({ defaultAgent: 'codex', defaultModel: 'opus' }));
  assert.equal(prefs.defaultAgent, 'codex');
  assert.equal(prefs.defaultModel, 'gpt-5.6-sol');
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

test('모르는 프로바이더는 codex, 모르는 권한 프로필은 safe', () => {
  const prefs = normalizeAgentPrefs({ defaultAgent: 'gemini', defaultPermissionProfile: 'root' });
  assert.equal(prefs.defaultAgent, 'codex');
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
  assert.equal(switched.defaultModel, 'gpt-5.6-sol');
  assert.equal(switched.defaultEffort, 'max');
  assert.equal(JSON.parse(storage.map.get(AGENT_PREFS_STORAGE_KEY)!).defaultAgent, 'codex');
});

test('저장소가 없으면 정규화된 값만 돌려주고 던지지 않는다', () => {
  const prefs = saveAgentPrefs({ defaultAgent: 'codex' }, null);
  assert.equal(prefs.defaultAgent, 'codex');
  assert.equal(prefs.defaultModel, 'gpt-5.6-sol');
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

test('grok 기본값은 저장되고 모르는 모델/강도는 grok 기준으로 접힌다', () => {
  const prefs = normalizeAgentPrefs({
    defaultAgent: 'grok',
    defaultModel: 'gpt-5.6-sol',
    defaultEffort: 'max',
  });
  assert.equal(prefs.defaultAgent, 'grok');
  assert.equal(prefs.defaultModel, 'grok-4.6');
  assert.equal(prefs.defaultEffort, 'high');

  const kept = normalizeAgentPrefs({
    defaultAgent: 'grok',
    defaultModel: 'grok-4.5',
    defaultEffort: 'low',
  });
  assert.equal(kept.defaultModel, 'grok-4.5');
  assert.equal(kept.defaultEffort, 'low');
});

test('cursor 기본값은 auto 로 접히고 추론 강도는 비어 있다', () => {
  setCursorModels([]);
  try {
    // CLI 목록이 아직 없으면 저장된 모델을 지킨다.
    const pending = normalizeAgentPrefs({ defaultAgent: 'cursor', defaultModel: 'composer-1' });
    assert.equal(pending.defaultAgent, 'cursor');
    assert.equal(pending.defaultModel, 'composer-1');
    assert.equal(pending.defaultEffort, '');

    setCursorModels(['composer-1']);
    const known = normalizeAgentPrefs({ defaultAgent: 'cursor', defaultModel: 'composer-1' });
    assert.equal(known.defaultModel, 'composer-1');
    const unknown = normalizeAgentPrefs({ defaultAgent: 'cursor', defaultModel: 'no-such-model' });
    assert.equal(unknown.defaultModel, 'auto');
  } finally {
    setCursorModels([]);
  }
});

test('저장된 grok 기본값은 다시 읽어도 살아남는다', () => {
  const storage = makeStorage();
  const saved = saveAgentPrefs({ defaultAgent: 'grok', defaultEffort: 'medium' }, storage);
  assert.equal(saved.defaultAgent, 'grok');
  assert.equal(saved.defaultModel, 'grok-4.6');
  assert.equal(saved.defaultEffort, 'medium');
  assert.deepEqual(loadAgentPrefs(storage), saved);
});
