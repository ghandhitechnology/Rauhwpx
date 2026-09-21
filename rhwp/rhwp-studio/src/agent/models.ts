import type { AgentName, PiModelConfig, ServiceTier } from './types.ts';

export interface AgentModelOption { id: string; label: string }
export interface AgentEffortOption { id: string; label: string }
export interface AgentModelGroup { label: string | null; options: readonly AgentModelOption[] }

type StaticAgentName = Exclude<AgentName, 'pi' | 'grok' | 'cursor' | 'opencode' | 'rau'>;
function isSupportedAgent(agent: AgentName): agent is 'claude' | 'codex' | 'pi' {
  return agent === 'claude' || agent === 'codex' || agent === 'pi';
}
export const AGENT_MODELS: Record<StaticAgentName, readonly AgentModelOption[]> = {
  claude: [
    { id: 'fable', label: 'Fable 5' }, { id: 'opus', label: 'Opus 5' },
    { id: 'sonnet', label: 'Sonnet 5' }, { id: 'haiku', label: 'Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-6-astra', label: 'Astra' }, { id: 'gpt-5.6-sol', label: 'Sol' },
    { id: 'gpt-5.6-terra', label: 'Terra' }, { id: 'gpt-5.6-luna', label: 'Luna' },
  ],
} as const;

const CLAUDE_EFFORTS_FULL = [
  { id: 'max', label: 'Max' }, { id: 'xhigh', label: 'Extra high' },
  { id: 'high', label: 'High' }, { id: 'medium', label: 'Medium' }, { id: 'low', label: 'Low' },
] as const;
const CLAUDE_EFFORTS_COMPACT = [
  { id: 'high', label: 'High' }, { id: 'medium', label: 'Medium' }, { id: 'low', label: 'Low' },
] as const;
const CODEX_EFFORTS = [
  { id: 'max', label: 'Max' }, { id: 'xhigh', label: 'Extra high' },
  { id: 'high', label: 'High' }, { id: 'medium', label: 'Medium' }, { id: 'low', label: 'Low' },
] as const;
const PI_EFFORT_IDS = ['high', 'medium', 'low'] as const;
const PI_EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
export const DEFAULT_AGENT_MODEL: Record<StaticAgentName, string> = { claude: 'sonnet', codex: 'gpt-5.6-sol' };
export const DEFAULT_AGENT_EFFORT: Record<StaticAgentName, string> = { claude: 'high', codex: 'medium' };

let piModelRegistry: readonly PiModelConfig[] = [];
export function setPiModels(models: readonly PiModelConfig[]): void { piModelRegistry = models; }
export function piModels(): readonly PiModelConfig[] { return piModelRegistry; }
function findPiModel(id: string | null | undefined): PiModelConfig | undefined { return piModelRegistry.find((model) => model.id === id); }

export function modelsForAgent(agent: AgentName): readonly AgentModelOption[] {
  if (agent === 'pi') return piModelRegistry.map((model) => ({ id: model.id, label: model.name }));
  return isSupportedAgent(agent) ? AGENT_MODELS[agent] : [];
}
export function modelGroupsForAgent(agent: AgentName): readonly AgentModelGroup[] { return [{ label: null, options: modelsForAgent(agent) }]; }
export function defaultModelForAgent(agent: AgentName): string { return agent === 'pi' ? piModelRegistry[0]?.id ?? '' : isSupportedAgent(agent) ? DEFAULT_AGENT_MODEL[agent] : ''; }
export function isModelForAgent(agent: AgentName, model: string): boolean { return modelsForAgent(agent).some((option) => option.id === model); }
export function modelSupportsImages(agent: AgentName, model?: string | null): boolean {
  return agent !== 'pi' || findPiModel(resolveModelForAgent('pi', model))?.supportsImages === true;
}
export function resolveModelForAgent(agent: AgentName, model?: string | null): string {
  if (agent === 'pi' && piModelRegistry.length === 0) return model ?? '';
  return model && isModelForAgent(agent, model) ? model : defaultModelForAgent(agent);
}
export function labelForModel(agent: AgentName, modelId: string): string { return modelsForAgent(agent).find((model) => model.id === modelId)?.label ?? modelId; }
export function effortsForAgent(agent: AgentName, model?: string | null): readonly AgentEffortOption[] {
  if (agent === 'pi') {
    const config = findPiModel(resolveModelForAgent('pi', model));
    if (!config) return [];
    return PI_EFFORT_IDS.filter((id) => config.efforts.includes(id)).map((id) => ({ id, label: PI_EFFORT_LABELS[id] ?? id }));
  }
  if (agent === 'codex') return CODEX_EFFORTS;
  if (agent !== 'claude') return [];
  return resolveModelForAgent('claude', model) === 'haiku' ? CLAUDE_EFFORTS_COMPACT : CLAUDE_EFFORTS_FULL;
}
export function defaultEffortForAgent(agent: AgentName, model?: string | null): string {
  const allowed = effortsForAgent(agent, model);
  if (allowed.length === 0) return '';
  if (agent === 'pi') return findPiModel(resolveModelForAgent('pi', model))?.defaultEffort ?? allowed[0]!.id;
  const preferred = isSupportedAgent(agent) ? DEFAULT_AGENT_EFFORT[agent] : '';
  return allowed.some((effort) => effort.id === preferred) ? preferred : allowed[0]!.id;
}
export function isEffortForAgent(agent: AgentName, effort: string, model?: string | null): boolean { return effortsForAgent(agent, model).some((option) => option.id === effort); }
export function resolveEffortForAgent(agent: AgentName, effort?: string | null, model?: string | null): string {
  if (agent === 'pi' && piModelRegistry.length === 0) return effort ?? '';
  return effort && isEffortForAgent(agent, effort, model) ? effort : defaultEffortForAgent(agent, model);
}
export function labelForEffort(agent: AgentName, effortId: string, model?: string | null): string { return effortsForAgent(agent, model).find((effort) => effort.id === effortId)?.label ?? effortId; }
export function agentSupportsFast(agent: AgentName): boolean { return agent === 'codex'; }
export function resolveServiceTier(agent: AgentName, requested?: string | null): ServiceTier { return agent === 'codex' && requested === 'fast' ? 'fast' : 'standard'; }
