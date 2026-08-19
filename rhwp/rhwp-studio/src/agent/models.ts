import type { AgentName, PiModelConfig } from './types.ts';

export interface AgentModelOption {
  /** CLI `--model` / `-m` 에 넘기는 값 */
  id: string;
  /** 사이드바에 표시할 짧은 라벨 */
  label: string;
}

export interface AgentEffortOption {
  /** Claude `--effort` / Codex `model_reasoning_effort` / pi `reasoning_effort` 값 */
  id: string;
  label: string;
}

/** 셀렉트/메뉴에 그릴 모델 묶음. label 이 null 이면 머리글 없는 단일 목록이다. */
export interface AgentModelGroup {
  label: string | null;
  options: readonly AgentModelOption[];
}

/**
 * 정적 카탈로그를 갖는 프로바이더 (pi 는 동적 레지스트리 — 아래 참조).
 * cursor 는 'auto' 한 줄을 씨앗으로 갖고, CLI 가 알려 주는 목록을 그 뒤에 잇는다.
 */
type StaticAgentName = Exclude<AgentName, 'pi'>;

/** 프로바이더별 선택 가능 모델 (강함 → 약함). 프로바이더 전환 시 UI가 이 목록으로 교체된다. */
export const AGENT_MODELS: Record<StaticAgentName, readonly AgentModelOption[]> = {
  claude: [
    { id: 'fable', label: 'Fable 5' },
    { id: 'opus', label: 'Opus 5' },
    { id: 'sonnet', label: 'Sonnet 5' },
    { id: 'haiku', label: 'Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'Sol' },
    { id: 'gpt-5.6-terra', label: 'Terra' },
    { id: 'gpt-5.6-luna', label: 'Luna' },
  ],
  grok: [
    { id: 'grok-4.6', label: 'Grok 4.6' },
    { id: 'grok-4.5', label: 'Grok 4.5' },
  ],
  cursor: [
    { id: 'auto', label: 'Auto' },
  ],
} as const;

/** Claude CLI `--effort` (강함 → 약함). Haiku 는 xhigh/max 미지원으로 축소. */
const CLAUDE_EFFORTS_FULL: readonly AgentEffortOption[] = [
  { id: 'max', label: 'Max' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

const CLAUDE_EFFORTS_COMPACT: readonly AgentEffortOption[] = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

/** Codex `model_reasoning_effort` (강함 → 약함). */
const CODEX_EFFORTS: readonly AgentEffortOption[] = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

/** Grok CLI `--reasoning-effort` (강함 → 약함). */
const GROK_EFFORTS: readonly AgentEffortOption[] = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

/** OpenRouter `reasoning_effort` 라벨. pi 모델이 노출하는 effort id 는 이 셋뿐이다. */
const PI_EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const DEFAULT_AGENT_MODEL: Record<StaticAgentName, string> = {
  claude: 'sonnet',
  codex: 'gpt-5.6-sol',
  grok: 'grok-4.6',
  cursor: 'auto',
};

/** cursor 는 추론 강도 옵션이 없다 — effortsForAgent 가 빈 목록을 준다. */
export const DEFAULT_AGENT_EFFORT: Record<StaticAgentName, string> = {
  claude: 'high',
  codex: 'medium',
  grok: 'high',
  cursor: '',
};

/*
 * pi 모델은 정적 카탈로그가 없다 — 사용자가 OpenRouter 에서 고른 최대 3개를
 * 허브가 `pi-status` 로 보내면 여기에 반영된다(setPiModels). 도착 전에는 빈
 * 배열이라 modelsForAgent('pi') 도 빈 목록을 준다 — 그 사이엔 저장된 값을
 * 함부로 프로바이더 기본값으로 접지 않는다(resolveModelForAgent 참조).
 */
let piModelRegistry: readonly PiModelConfig[] = [];

/** 허브의 `pi-status` 를 받을 때마다 브리지가 호출한다. */
export function setPiModels(models: readonly PiModelConfig[]): void {
  piModelRegistry = models;
}

export function piModels(): readonly PiModelConfig[] {
  return piModelRegistry;
}

function findPiModel(id: string | null | undefined): PiModelConfig | undefined {
  if (!id) return undefined;
  return piModelRegistry.find((m) => m.id === id);
}

/*
 * cursor 도 카탈로그가 CLI 쪽에 있다 — 허브가 `cursor-agent --list-models` 결과를
 * agent-setup-status 의 statuses.cursor.models 로 실어 보내면 여기에 반영된다
 * (setCursorModels). 'auto' 씨앗은 항상 맨 앞에 남고, 받은 id 가 그 뒤로 붙는다.
 */
let cursorModelRegistry: readonly string[] = [];

/** 허브의 `agent-setup-status` 를 받을 때마다 브리지가 호출한다. */
export function setCursorModels(ids: readonly string[]): void {
  cursorModelRegistry = ids;
}

export function cursorModels(): readonly string[] {
  return cursorModelRegistry;
}

/** 'auto' 씨앗 + CLI 목록 (id 중복 제거, 라벨은 id 그대로). */
function cursorModelOptions(): readonly AgentModelOption[] {
  const options = [...AGENT_MODELS.cursor];
  const seen = new Set(options.map((m) => m.id));
  for (const id of cursorModelRegistry) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label: id });
  }
  return options;
}

/*
 * Cursor 모델은 과금 풀이 둘이다 — auto·composer(·cheetah)·grok 계열은 Cursor
 * 구독의 포함 사용량에서 차감되고, 나머지 프런티어 모델은 토큰당 API 사용량으로
 * 따로 과금된다. CLI 의 --list-models 출력엔 이 구분이 없어서 여기서 나눈다.
 */
const CURSOR_PLAN_MODEL_PATTERN = /^(?:auto$|composer|cheetah|grok)/;
const CURSOR_PLAN_GROUP_LABEL = '구독 사용량';
const CURSOR_API_GROUP_LABEL = 'API 사용량';

/** 과금 풀 기준 그룹 목록. cursor 외 프로바이더는 머리글 없는 단일 그룹이다. */
export function modelGroupsForAgent(agent: AgentName): readonly AgentModelGroup[] {
  if (agent !== 'cursor') return [{ label: null, options: modelsForAgent(agent) }];
  const options = cursorModelOptions();
  // CLI 목록 도착 전엔 씨앗(auto)뿐이라 머리글 없이 한 그룹으로 둔다.
  if (cursorModelRegistry.length === 0) return [{ label: null, options }];
  const plan = options.filter((m) => CURSOR_PLAN_MODEL_PATTERN.test(m.id));
  const api = options.filter((m) => !CURSOR_PLAN_MODEL_PATTERN.test(m.id));
  const groups: AgentModelGroup[] = [];
  if (plan.length > 0) groups.push({ label: CURSOR_PLAN_GROUP_LABEL, options: plan });
  if (api.length > 0) groups.push({ label: CURSOR_API_GROUP_LABEL, options: api });
  return groups;
}

/** 동적 목록을 쓰는 프로바이더가 아직 목록을 받지 못했는지. */
function dynamicCatalogPending(agent: AgentName): boolean {
  if (agent === 'pi') return piModelRegistry.length === 0;
  if (agent === 'cursor') return cursorModelRegistry.length === 0;
  return false;
}

/** 다른 프로바이더가 실제로 쓰는 모델 id 인지 (정적 카탈로그 + pi 레지스트리). */
function isModelOfOtherAgent(agent: AgentName, model: string): boolean {
  for (const [name, options] of Object.entries(AGENT_MODELS)) {
    if (name === agent) continue;
    if (options.some((m) => m.id === model)) return true;
  }
  if (agent !== 'pi' && piModelRegistry.some((m) => m.id === model)) return true;
  return false;
}

export function modelsForAgent(agent: AgentName): readonly AgentModelOption[] {
  if (agent === 'pi') return piModelRegistry.map((m) => ({ id: m.id, label: m.name }));
  if (agent === 'cursor') return cursorModelOptions();
  return AGENT_MODELS[agent];
}

export function defaultModelForAgent(agent: AgentName): string {
  if (agent === 'pi') return piModelRegistry[0]?.id ?? '';
  return DEFAULT_AGENT_MODEL[agent];
}

export function isModelForAgent(agent: AgentName, model: string): boolean {
  if (agent === 'pi') return piModelRegistry.some((m) => m.id === model);
  if (agent === 'cursor') return cursorModelOptions().some((m) => m.id === model);
  return AGENT_MODELS[agent].some((m) => m.id === model);
}

export function modelSupportsImages(agent: AgentName, model?: string | null): boolean {
  if (agent !== 'pi') return true;
  return findPiModel(resolveModelForAgent('pi', model))?.supportsImages === true;
}

export function resolveModelForAgent(agent: AgentName, model?: string | null): string {
  if (agent === 'pi') {
    // 레지스트리가 비어 있으면(pi-status 도착 전) 저장된 값을 그대로 지켜
    // 기본값으로 뭉개지 않는다.
    if (dynamicCatalogPending('pi')) return model ?? '';
    if (model && isModelForAgent('pi', model)) return model;
    return defaultModelForAgent('pi');
  }
  if (model && isModelForAgent(agent, model)) return model;
  // cursor 목록이 아직 없으면(설정 상태 도착 전) 저장된 모델을 지킨다.
  // 다만 다른 프로바이더의 모델 id 는 유예 대상이 아니다 — Claude/sonnet 에서
  // Cursor 로 갈아탈 때 'sonnet' 이 그대로 남아 `--model sonnet` 으로 실행되고
  // 스레드에까지 저장되던 문제를 막기 위해 기본값('auto')으로 접는다.
  if (model && dynamicCatalogPending(agent) && !isModelOfOtherAgent(agent, model)) return model;
  return defaultModelForAgent(agent);
}

export function labelForModel(agent: AgentName, modelId: string): string {
  if (agent === 'pi') return findPiModel(modelId)?.name ?? modelId;
  if (agent === 'cursor') return cursorModelOptions().find((m) => m.id === modelId)?.label ?? modelId;
  return AGENT_MODELS[agent].find((m) => m.id === modelId)?.label ?? modelId;
}

/** 프로바이더(+모델)가 지원하는 effort 목록. */
export function effortsForAgent(
  agent: AgentName,
  model?: string | null,
): readonly AgentEffortOption[] {
  switch (agent) {
    case 'pi': {
      const cfg = findPiModel(resolveModelForAgent('pi', model));
      if (!cfg) return [];
      return cfg.efforts.map((id) => ({ id, label: PI_EFFORT_LABELS[id] ?? id }));
    }
    // cursor-agent 는 추론 강도 플래그가 없다 — UI 가 선택기를 숨긴다.
    case 'cursor':
      return [];
    case 'grok':
      return GROK_EFFORTS;
    case 'codex':
      return CODEX_EFFORTS;
    case 'claude': {
      const resolved = resolveModelForAgent('claude', model);
      return resolved === 'haiku' ? CLAUDE_EFFORTS_COMPACT : CLAUDE_EFFORTS_FULL;
    }
    default: {
      const exhaustive: never = agent;
      void exhaustive;
      return [];
    }
  }
}

export function defaultEffortForAgent(agent: AgentName, model?: string | null): string {
  const allowed = effortsForAgent(agent, model);
  if (allowed.length === 0) return '';
  if (agent === 'pi') {
    const cfg = findPiModel(resolveModelForAgent('pi', model));
    const preferred = cfg?.defaultEffort;
    return preferred && allowed.some((e) => e.id === preferred) ? preferred : allowed[0]!.id;
  }
  const preferred = DEFAULT_AGENT_EFFORT[agent];
  return allowed.some((e) => e.id === preferred) ? preferred : allowed[0]!.id;
}

export function isEffortForAgent(
  agent: AgentName,
  effort: string,
  model?: string | null,
): boolean {
  return effortsForAgent(agent, model).some((e) => e.id === effort);
}

export function resolveEffortForAgent(
  agent: AgentName,
  effort?: string | null,
  model?: string | null,
): string {
  // pi 레지스트리가 비어 있는 동안은(모델이 아직 없으니 effort 도 검증 불가)
  // 저장된 값을 지킨다 — pi-status 도착 전에 설정 화면이 초기화되지 않게.
  // cursor 는 어떤 모델이든 effort 자체가 없어 이 유예가 필요 없다.
  if (agent === 'pi' && dynamicCatalogPending('pi')) return effort ?? '';
  if (effort && isEffortForAgent(agent, effort, model)) return effort;
  return defaultEffortForAgent(agent, model);
}

export function labelForEffort(
  agent: AgentName,
  effortId: string,
  model?: string | null,
): string {
  return effortsForAgent(agent, model).find((e) => e.id === effortId)?.label ?? effortId;
}
