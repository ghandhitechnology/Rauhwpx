import type { AgentName } from './types.ts';

export interface AgentModelOption {
  /** CLI `--model` / `-m` 에 넘기는 값 */
  id: string;
  /** 사이드바에 표시할 짧은 라벨 */
  label: string;
}

export interface AgentEffortOption {
  /** Claude `--effort` / Codex `model_reasoning_effort` 값 */
  id: string;
  label: string;
}

/** 프로바이더별 선택 가능 모델 (강함 → 약함). 프로바이더 전환 시 UI가 이 목록으로 교체된다. */
export const AGENT_MODELS: Record<AgentName, readonly AgentModelOption[]> = {
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

export const DEFAULT_AGENT_MODEL: Record<AgentName, string> = {
  claude: 'sonnet',
  codex: 'gpt-5.6-sol',
};

export const DEFAULT_AGENT_EFFORT: Record<AgentName, string> = {
  claude: 'high',
  codex: 'high',
};

export function modelsForAgent(agent: AgentName): readonly AgentModelOption[] {
  return AGENT_MODELS[agent];
}

export function defaultModelForAgent(agent: AgentName): string {
  return DEFAULT_AGENT_MODEL[agent];
}

export function isModelForAgent(agent: AgentName, model: string): boolean {
  return AGENT_MODELS[agent].some((m) => m.id === model);
}

export function resolveModelForAgent(agent: AgentName, model?: string | null): string {
  if (model && isModelForAgent(agent, model)) return model;
  return defaultModelForAgent(agent);
}

export function labelForModel(agent: AgentName, modelId: string): string {
  return AGENT_MODELS[agent].find((m) => m.id === modelId)?.label ?? modelId;
}

/** 프로바이더(+모델)가 지원하는 effort 목록. */
export function effortsForAgent(
  agent: AgentName,
  model?: string | null,
): readonly AgentEffortOption[] {
  if (agent === 'codex') return CODEX_EFFORTS;
  const resolved = resolveModelForAgent(agent, model);
  return resolved === 'haiku' ? CLAUDE_EFFORTS_COMPACT : CLAUDE_EFFORTS_FULL;
}

export function defaultEffortForAgent(agent: AgentName, model?: string | null): string {
  const allowed = effortsForAgent(agent, model);
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
