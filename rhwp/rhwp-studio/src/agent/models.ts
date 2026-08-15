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

/** 정적 카탈로그를 갖는 프로바이더 (pi 는 동적 레지스트리 — 아래 참조). */
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

/** OpenRouter `reasoning_effort` 라벨. pi 모델이 노출하는 effort id 는 이 셋뿐이다. */
const PI_EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const DEFAULT_AGENT_MODEL: Record<StaticAgentName, string> = {
  claude: 'sonnet',
  codex: 'gpt-5.6-sol',
};

export const DEFAULT_AGENT_EFFORT: Record<StaticAgentName, string> = {
  claude: 'high',
  codex: 'medium',
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

export function modelsForAgent(agent: AgentName): readonly AgentModelOption[] {
  if (agent === 'pi') return piModelRegistry.map((m) => ({ id: m.id, label: m.name }));
  return AGENT_MODELS[agent];
}

export function defaultModelForAgent(agent: AgentName): string {
  if (agent === 'pi') return piModelRegistry[0]?.id ?? '';
  return DEFAULT_AGENT_MODEL[agent];
}

export function isModelForAgent(agent: AgentName, model: string): boolean {
  if (agent === 'pi') return piModelRegistry.some((m) => m.id === model);
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
    if (piModelRegistry.length === 0) return model ?? '';
    if (model && isModelForAgent('pi', model)) return model;
    return defaultModelForAgent('pi');
  }
  if (model && isModelForAgent(agent, model)) return model;
  return defaultModelForAgent(agent);
}

export function labelForModel(agent: AgentName, modelId: string): string {
  if (agent === 'pi') return findPiModel(modelId)?.name ?? modelId;
  return AGENT_MODELS[agent].find((m) => m.id === modelId)?.label ?? modelId;
}

/** 프로바이더(+모델)가 지원하는 effort 목록. */
export function effortsForAgent(
  agent: AgentName,
  model?: string | null,
): readonly AgentEffortOption[] {
  if (agent === 'pi') {
    const cfg = findPiModel(resolveModelForAgent('pi', model));
    if (!cfg) return [];
    return cfg.efforts.map((id) => ({ id, label: PI_EFFORT_LABELS[id] ?? id }));
  }
  if (agent === 'codex') return CODEX_EFFORTS;
  const resolved = resolveModelForAgent(agent, model);
  return resolved === 'haiku' ? CLAUDE_EFFORTS_COMPACT : CLAUDE_EFFORTS_FULL;
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
  if (agent === 'pi' && piModelRegistry.length === 0) return effort ?? '';
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
