/**
 * 개인 기본값 — 설정 탭에서 고르는 "다음 대화부터 쓸" 프로바이더·모델·
 * 추론 강도·권한 프로필. localStorage 한 칸에 JSON 으로 산다.
 *
 * 대화 중 입력기 셀렉터로 바꾸는 값은 그 대화만의 덮어쓰기이므로 여기에
 * 저장되지 않는다(설정 탭만 저장한다).
 *
 * 읽을 때 models.ts 기준으로 정규화한다 — 모델 목록이 바뀌어도 저장된
 * 옛 값이 UI 를 깨뜨리지 않게, 모르는 값은 프로바이더 기본값으로 접힌다.
 */
import {
  defaultModelForAgent,
  resolveEffortForAgent,
  resolveModelForAgent,
} from './models.ts';
import type { AgentName, PermissionProfile } from './types.ts';

const STORAGE_KEY = 'rhwp-agent-prefs';

export interface AgentPrefs {
  defaultAgent: AgentName;
  defaultModel: string;
  defaultEffort: string;
  defaultPermissionProfile: PermissionProfile;
}

/** localStorage 최소 계약 — 테스트가 자기 저장소를 넣을 수 있게 뺐다. */
export interface AgentPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type AgentPrefsSaveResult =
  | { ok: true; value: AgentPrefs }
  | { ok: false; value: AgentPrefs; error: string };

function isAgentName(value: unknown): value is AgentName {
  return value === 'claude' || value === 'codex' || value === 'pi'
    || value === 'grok' || value === 'cursor' || value === 'rau';
}

function isPermissionProfile(value: unknown): value is PermissionProfile {
  return value === 'safe' || value === 'unrestricted';
}

function resolveStorage(storage?: AgentPrefsStorage | null): AgentPrefsStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function defaultAgentPrefs(): AgentPrefs {
  const agent: AgentName = 'codex';
  const model = defaultModelForAgent(agent);
  return {
    defaultAgent: agent,
    defaultModel: model,
    defaultEffort: resolveEffortForAgent(agent, null, model),
    defaultPermissionProfile: 'safe',
  };
}

/** 어떤 입력이 와도 쓸 수 있는 조합으로 접는다. */
export function normalizeAgentPrefs(raw: unknown): AgentPrefs {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const agent: AgentName = isAgentName(src['defaultAgent']) ? src['defaultAgent'] : 'codex';
  const model = resolveModelForAgent(
    agent,
    typeof src['defaultModel'] === 'string' ? src['defaultModel'] : null,
  );
  const effort = resolveEffortForAgent(
    agent,
    typeof src['defaultEffort'] === 'string' ? src['defaultEffort'] : null,
    model,
  );
  return {
    defaultAgent: agent,
    defaultModel: model,
    defaultEffort: effort,
    defaultPermissionProfile: isPermissionProfile(src['defaultPermissionProfile'])
      ? src['defaultPermissionProfile']
      : 'safe',
  };
}

export function loadAgentPrefs(storage?: AgentPrefsStorage | null): AgentPrefs {
  const store = resolveStorage(storage);
  if (!store) return defaultAgentPrefs();
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return defaultAgentPrefs();
    return normalizeAgentPrefs(JSON.parse(raw));
  } catch {
    return defaultAgentPrefs();
  }
}

/**
 * 바뀐 값만 덮어써 저장하고, 저장된 최종 형태를 돌려준다. 프로바이더가
 * 바뀌면 모델·강도는 그 프로바이더 기준으로 다시 해석된다.
 */
export function saveAgentPrefs(
  partial: Partial<AgentPrefs>,
  storage?: AgentPrefsStorage | null,
): AgentPrefs {
  return trySaveAgentPrefs(partial, storage).value;
}

/** 저장 실패를 숨기지 않는 설정 허브용 API. */
export function trySaveAgentPrefs(
  partial: Partial<AgentPrefs>,
  storage?: AgentPrefsStorage | null,
): AgentPrefsSaveResult {
  const store = resolveStorage(storage);
  const current = loadAgentPrefs(store);
  const next = normalizeAgentPrefs({ ...current, ...partial });
  if (!store) return { ok: false, value: next, error: '설정을 저장할 수 있는 저장소가 없습니다.' };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[agent-prefs] localStorage 저장 실패:', err);
    return {
      ok: false,
      value: next,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, value: next };
}

export const AGENT_PREFS_STORAGE_KEY = STORAGE_KEY;
