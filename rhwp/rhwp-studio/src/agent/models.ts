import type { AgentName, PiModelConfig, ServiceTier } from './types.ts';

export interface AgentModelOption { id: string; label: string }
export interface ModelCatalogEntry extends AgentModelOption { description?: string; supportedEfforts?: string[] }
export interface AgentEffortOption { id: string; label: string }
export interface AgentModelGroup { label: string | null; options: readonly ModelCatalogEntry[] }
export type CatalogAgent = 'claude' | 'codex';
export type SelectedModels = Record<CatalogAgent, string[]>;

function isCatalogAgent(agent: AgentName): agent is CatalogAgent {
  return agent === 'claude' || agent === 'codex';
}
export const AGENT_MODELS: Record<CatalogAgent, readonly AgentModelOption[]> = {
  claude: [
    // 허브 목록이 오기 전 표시값. 버전은 rhwp-agent/claude-model-label.mjs 의 공식 목록과 같다.
    { id: 'fable', label: 'Fable 5.1' }, { id: 'opus', label: 'Opus 5.5' },
    { id: 'sonnet', label: 'Sonnet 5' }, { id: 'haiku', label: 'Haiku 4.5' },
  ],
  codex: [
    { id: 'astra', label: 'Astra' }, { id: 'sol', label: 'Sol' },
    { id: 'luna', label: 'Luna' }, { id: 'terra', label: 'Terra' },
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
  { id: 'ultra', label: 'Ultra' },
  { id: 'max', label: 'Max' }, { id: 'xhigh', label: 'Extra high' },
  { id: 'high', label: 'High' }, { id: 'medium', label: 'Medium' }, { id: 'low', label: 'Low' },
] as const;
const PI_EFFORT_IDS = ['high', 'medium', 'low'] as const;
const PI_EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
export const DEFAULT_AGENT_MODEL: Record<CatalogAgent, string> = { claude: 'sonnet', codex: 'sol' };
export const DEFAULT_AGENT_EFFORT: Record<CatalogAgent, string> = { claude: 'high', codex: 'medium' };

let piModelRegistry: readonly PiModelConfig[] = [];
export function setPiModels(models: readonly PiModelConfig[]): void { piModelRegistry = models; }
export function piModels(): readonly PiModelConfig[] { return piModelRegistry; }
function findPiModel(id: string | null | undefined): PiModelConfig | undefined { return piModelRegistry.find((model) => model.id === id); }

const CATALOG_STORAGE_KEY = 'rhwp-agent-model-catalog';
const catalogs: Record<CatalogAgent, ModelCatalogEntry[]> = { claude: [], codex: [] };
let cacheLoaded = false;
let selectedModels: SelectedModels = {
  claude: AGENT_MODELS.claude.map((model) => model.id),
  codex: AGENT_MODELS.codex.map((model) => model.id),
};

const CLAUDE_MODEL_ID = /^claude-([a-z]+)((?:-\d+)+?)(?:-(\d{8}))?(\[[^\]]+\])?$/;

/**
 * claude-opus-5-5[1m] → "Opus 5.5 (1M)". CLI 표시 이름에는 버전이 없어 해석된 ID에서 만든다.
 * 허브의 rhwp-agent/claude-model-label.mjs 와 같은 규칙이다 (agent-models.test.ts 가 비교).
 */
export function claudeModelLabel(id: string, fallback = id): string {
  const match = CLAUDE_MODEL_ID.exec(id);
  if (!match) return fallback;
  const [, family = '', version = '', , context] = match;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  const suffix = context ? ` (${context.slice(1, -1).toUpperCase()})` : '';
  return `${name} ${version.slice(1).split('-').join('.')}${suffix}`;
}

/** CLI 설명 앞의 "Sonnet 5 · " 같은 이름 반복을 걷는다. */
export function claudeModelDescription(description: unknown): string {
  if (typeof description !== 'string') return '';
  const trimmed = description.trim();
  const parts = trimmed.split(' · ');
  if (parts.length > 1 && /^(Fable|Opus|Sonnet|Haiku)\b/i.test(parts[0] ?? '')) return parts.slice(1).join(' · ').trim();
  return trimmed;
}

function readCatalog(raw: unknown, agent?: CatalogAgent): ModelCatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: ModelCatalogEntry[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)) continue;
    seen.add(item.id);
    const label = typeof item.label === 'string' && item.label.trim() ? item.label : item.id;
    // 예전 허브가 남긴 캐시("Sonnet")도 같은 버전 이름으로 고친다.
    const description = agent === 'claude'
      ? claudeModelDescription(item.description)
      : typeof item.description === 'string' ? item.description.trim() : '';
    result.push({
      id: item.id,
      label: agent === 'claude' ? claudeModelLabel(item.id, label) : label,
      ...(description ? { description } : {}),
      ...(Array.isArray(item.supportedEfforts)
        ? { supportedEfforts: item.supportedEfforts.filter((effort): effort is string => typeof effort === 'string') }
        : {}),
    });
  }
  return result;
}

function ensureCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(CATALOG_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    catalogs.claude = readCatalog(saved.claude, 'claude');
    catalogs.codex = readCatalog(saved.codex, 'codex');
  } catch { /* A stale cache must not block the picker. */ }
}

export function availableModelsForAgent(agent: AgentName): readonly ModelCatalogEntry[] {
  if (!isCatalogAgent(agent)) return [];
  ensureCache();
  return catalogs[agent].length ? catalogs[agent] : AGENT_MODELS[agent];
}
export function hasLiveModelCatalog(agent: CatalogAgent): boolean {
  ensureCache();
  return catalogs[agent].length > 0;
}

export function setModelCatalog(agent: CatalogAgent, models: readonly ModelCatalogEntry[]): void {
  ensureCache();
  catalogs[agent] = readCatalog(models, agent);
  selectedModels[agent] = normalizeSelectedModels(selectedModels)[agent];
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(catalogs));
  } catch { /* The live catalog still works without storage. */ }
}

/** Apply saved preferences to the sidebar registry; staged settings do not call this. */
export function setSelectedModels(models: SelectedModels): void {
  selectedModels = { claude: [...models.claude], codex: [...models.codex] };
}

function legacyLineup(agent: CatalogAgent, model: string): string | null {
  if (AGENT_MODELS[agent].some((option) => option.id === model)) return model;
  if (agent === 'codex') return /^gpt-\d+(?:\.\d+)*-(astra|sol|luna|terra)(?:-preview)?$/.exec(model)?.[1] ?? null;
  return /^claude-(fable|opus|sonnet|haiku)-\d+(?:[-.]\d+)*$/.exec(model)?.[1] ?? null;
}

function versionNumbers(id: string): number[] {
  const match = /(?:^|-)\d+(?:[.-]\d+)*/.exec(id);
  return match ? match[0].replace(/^-/, '').split(/[.-]/).map(Number) : [];
}

export function concreteModelForAgent(agent: CatalogAgent, id: string): string {
  ensureCache();
  if (!catalogs[agent].length || catalogs[agent].some((model) => model.id === id)) return id;
  const lineup = legacyLineup(agent, id);
  if (!lineup) return id;
  const matches = catalogs[agent].filter((model) => legacyLineup(agent, model.id) === lineup);
  matches.sort((a, b) => {
    const av = versionNumbers(a.id);
    const bv = versionNumbers(b.id);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      const difference = (bv[i] ?? 0) - (av[i] ?? 0);
      if (difference) return difference;
    }
    return Number(a.id.includes('preview')) - Number(b.id.includes('preview'));
  });
  return matches[0]?.id ?? id;
}

export function normalizeSelectedModels(raw: unknown): SelectedModels {
  ensureCache();
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const normalized = {} as SelectedModels;
  for (const agent of ['claude', 'codex'] as const) {
    const input = Array.isArray(source[agent]) ? source[agent] : AGENT_MODELS[agent].map((model) => model.id);
    const ids = input.filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => concreteModelForAgent(agent, id))
      .filter((id) => catalogs[agent].length === 0 || catalogs[agent].some((model) => model.id === id));
    normalized[agent] = [...new Set(ids)];
    if (!normalized[agent].length) {
      const preferred = concreteModelForAgent(agent, DEFAULT_AGENT_MODEL[agent]);
      normalized[agent] = [catalogs[agent].find((model) => model.id === preferred)?.id
        ?? catalogs[agent][0]?.id ?? preferred];
    }
  }
  return normalized;
}

export function modelsForAgent(agent: AgentName): readonly ModelCatalogEntry[] {
  if (agent === 'pi') return piModelRegistry.map((model) => ({ id: model.id, label: model.name }));
  if (!isCatalogAgent(agent)) return [];
  // 고른 순서가 아니라 카탈로그 순서(프로바이더가 정한 성능 순)로 선다.
  const selected = new Set(selectedModels[agent].map((id) => concreteModelForAgent(agent, id)));
  return availableModelsForAgent(agent).filter((model) => selected.has(model.id));
}
export function modelGroupsForAgent(agent: AgentName): readonly AgentModelGroup[] { return [{ label: null, options: modelsForAgent(agent) }]; }
export function defaultModelForAgent(agent: AgentName): string {
  if (agent === 'pi') return piModelRegistry[0]?.id ?? '';
  if (!isCatalogAgent(agent)) return '';
  const preferred = concreteModelForAgent(agent, DEFAULT_AGENT_MODEL[agent]);
  const selected = modelsForAgent(agent);
  return selected.find((model) => model.id === preferred)?.id ?? selected[0]?.id ?? preferred;
}
export function isModelForAgent(agent: AgentName, model: string): boolean { return modelsForAgent(agent).some((option) => option.id === model); }
export function modelSupportsImages(agent: AgentName, model?: string | null): boolean {
  return agent !== 'pi' || findPiModel(resolveModelForAgent('pi', model))?.supportsImages === true;
}
export function resolveModelForAgent(agent: AgentName, model?: string | null): string {
  if (agent === 'pi' && piModelRegistry.length === 0) return model ?? '';
  if (isCatalogAgent(agent) && model) {
    const concrete = concreteModelForAgent(agent, model);
    if (isModelForAgent(agent, concrete)) return concrete;
  }
  return model && isModelForAgent(agent, model) ? model : defaultModelForAgent(agent);
}
export function labelForModel(agent: AgentName, modelId: string): string {
  if (isCatalogAgent(agent)) {
    const concrete = concreteModelForAgent(agent, modelId);
    return availableModelsForAgent(agent).find((model) => model.id === concrete)?.label ?? modelId;
  }
  return modelsForAgent(agent).find((model) => model.id === modelId)?.label ?? modelId;
}
export function effortsForAgent(agent: AgentName, model?: string | null): readonly AgentEffortOption[] {
  if (agent === 'pi') {
    const config = findPiModel(resolveModelForAgent('pi', model));
    if (!config) return [];
    return PI_EFFORT_IDS.filter((id) => config.efforts.includes(id)).map((id) => ({ id, label: PI_EFFORT_LABELS[id] ?? id }));
  }
  if (!isCatalogAgent(agent)) return [];
  const id = model ? concreteModelForAgent(agent, model) : defaultModelForAgent(agent);
  const supported = availableModelsForAgent(agent).find((entry) => entry.id === id)?.supportedEfforts;
  const all = agent === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS_FULL;
  if (supported) return all.filter((effort) => supported.includes(effort.id));
  if (agent === 'codex') return CODEX_EFFORTS.filter((effort) => effort.id !== 'ultra');
  return legacyLineup('claude', id) === 'haiku' ? CLAUDE_EFFORTS_COMPACT : CLAUDE_EFFORTS_FULL;
}
export function defaultEffortForAgent(agent: AgentName, model?: string | null): string {
  const allowed = effortsForAgent(agent, model);
  if (allowed.length === 0) return '';
  if (agent === 'pi') return findPiModel(resolveModelForAgent('pi', model))?.defaultEffort ?? allowed[0]!.id;
  const preferred = isCatalogAgent(agent) ? DEFAULT_AGENT_EFFORT[agent] : '';
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
