import type { AgentName, PiModelConfig, ServiceTier } from './types.ts';

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
 * cursor와 opencode는 각각 한 줄의 폴백을 씨앗으로 갖고, CLI가 알려 주는
 * 목록을 그 뒤에 잇는다.
 */
type StaticAgentName = Exclude<AgentName, 'pi'>;

/** 프로바이더별 선택 가능 모델 (강함 → 약함). 프로바이더 전환 시 UI가 이 목록으로 교체된다. */
export const AGENT_MODELS: Record<StaticAgentName, readonly AgentModelOption[]> = {
  rau: [
    { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash' },
    { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash' },
    { id: 'qwen/qwen3.8-flash', label: 'Qwen 3.8 Flash' },
    { id: 'upstage/solar-pro4', label: 'Solar Pro 4' },
  ],
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
  opencode: [
    { id: 'opencode/big-pickle', label: 'Big Pickle' },
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

/** Codex `model_reasoning_effort` (강함 → 약함). gpt-5.6 는 max 까지 받는다. */
const CODEX_EFFORTS: readonly AgentEffortOption[] = [
  { id: 'max', label: 'Max' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

/** Grok CLI `--reasoning-effort` (강함 → 약함). CLI 가 받는 값: xhigh|high|medium|low. */
const GROK_EFFORTS: readonly AgentEffortOption[] = [
  { id: 'xhigh', label: 'Extra high' },
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

/** 허브는 약함→강함으로 주지만, 슬라이더는 카탈로그가 강함→약함이라고 가정하고 뒤집는다. */
const PI_EFFORTS_STRONG_TO_WEAK = ['high', 'medium', 'low'] as const;

export const DEFAULT_AGENT_MODEL: Record<StaticAgentName, string> = {
  rau: 'z-ai/glm-5.3-flash',
  claude: 'sonnet',
  codex: 'gpt-5.6-sol',
  grok: 'grok-4.6',
  cursor: 'auto',
  opencode: 'opencode/big-pickle',
};

/** cursor와 opencode는 추론 강도 옵션이 없다. */
export const DEFAULT_AGENT_EFFORT: Record<StaticAgentName, string> = {
  rau: 'medium',
  claude: 'high',
  codex: 'medium',
  grok: 'high',
  cursor: '',
  opencode: '',
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
 * OpenCode는 연결된 제공자에 따라 카탈로그가 달라진다. 허브가 `opencode models`
 * 결과를 agent-setup-status의 statuses.opencode.models로 보내면 이 레지스트리를
 * 갱신한다. 모든 id는 `provider/model` 형태 그대로 보존해 같은 모델 이름을 가진
 * 서로 다른 제공자를 구분한다.
 */
let openCodeModelRegistry: readonly string[] = [];

function isProviderQualifiedModelId(id: string): boolean {
  return /^[^/\s]+\/\S+$/.test(id);
}

/** 허브의 `agent-setup-status` 를 받을 때마다 브리지가 호출한다. */
export function setOpenCodeModels(ids: readonly string[]): void {
  const seen = new Set<string>();
  openCodeModelRegistry = ids.flatMap((raw) => {
    const id = raw.trim();
    if (!isProviderQualifiedModelId(id) || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
}

export function openCodeModels(): readonly string[] {
  return openCodeModelRegistry;
}

/** CLI 목록이 오기 전에는 Big Pickle을 쓰고, 이후에는 실제 목록만 보여 준다. */
function openCodeModelOptions(): readonly AgentModelOption[] {
  if (openCodeModelRegistry.length === 0) return AGENT_MODELS.opencode;
  return openCodeModelRegistry.map((id) => ({
    id,
    label: AGENT_MODELS.opencode.find((model) => model.id === id)?.label ?? id,
  }));
}

/*
 * Cursor 모델은 과금 풀이 둘이다 — auto·composer(·cheetah)·grok 계열은 Cursor
 * 구독의 포함 사용량에서 차감되고, 나머지 프런티어 모델은 토큰당 API 사용량으로
 * 따로 과금된다. CLI 의 --list-models 출력엔 이 구분이 없어서 여기서 나눈다.
 */
const CURSOR_PLAN_MODEL_PATTERN = /^(?:auto$|composer|cheetah|grok)/;
const CURSOR_PLAN_GROUP_LABEL = '구독 사용량';
const CURSOR_API_GROUP_LABEL = 'API 사용량';

/** OpenCode의 provider/model 목록을 provider별 optgroup으로 묶는다. */
function openCodeModelGroups(): readonly AgentModelGroup[] {
  const byProvider = new Map<string, AgentModelOption[]>();
  for (const option of openCodeModelOptions()) {
    const provider = option.id.slice(0, option.id.indexOf('/'));
    const group = byProvider.get(provider) ?? [];
    group.push(option);
    byProvider.set(provider, group);
  }
  return [...byProvider].map(([label, options]) => ({ label, options }));
}

/** provider/과금 풀 기준 그룹 목록. 그 외 프로바이더는 머리글 없는 단일 그룹이다. */
export function modelGroupsForAgent(agent: AgentName): readonly AgentModelGroup[] {
  if (agent === 'opencode') return openCodeModelGroups();
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
  if (agent === 'opencode') return openCodeModelRegistry.length === 0;
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
  if (agent === 'opencode') return openCodeModelOptions();
  return AGENT_MODELS[agent];
}

export function defaultModelForAgent(agent: AgentName): string {
  if (agent === 'pi') return piModelRegistry[0]?.id ?? '';
  if (agent === 'opencode') {
    const fallback = DEFAULT_AGENT_MODEL.opencode;
    return openCodeModelRegistry.includes(fallback)
      ? fallback
      : openCodeModelRegistry[0] ?? fallback;
  }
  return DEFAULT_AGENT_MODEL[agent];
}

export function isModelForAgent(agent: AgentName, model: string): boolean {
  if (agent === 'pi') return piModelRegistry.some((m) => m.id === model);
  if (agent === 'cursor') return cursorModelOptions().some((m) => m.id === model);
  if (agent === 'opencode') return openCodeModelOptions().some((m) => m.id === model);
  return AGENT_MODELS[agent].some((m) => m.id === model);
}

const RAU_IMAGE_MODELS = new Set(['qwen/qwen3.8-flash']);

export function modelSupportsImages(agent: AgentName, model?: string | null): boolean {
  if (agent === 'pi') return findPiModel(resolveModelForAgent('pi', model))?.supportsImages === true;
  if (agent === 'rau') return RAU_IMAGE_MODELS.has(resolveModelForAgent('rau', model));
  // OpenCode 모델 목록에는 입력 모달리티가 없다. 실제 라우팅된 모델이 거부할 수
  // 있으므로 capability 메타데이터가 오기 전에는 첨부를 보수적으로 막는다.
  if (agent === 'opencode') return false;
  return true;
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
  // 동적 목록이 아직 없으면(설정 상태 도착 전) 저장된 모델을 지킨다. 다만 다른
  // 프로바이더 모델은 유예하지 않는다. OpenCode 값은 provider/model 형태여야 한다.
  const looksNative = agent !== 'opencode' || (model != null && isProviderQualifiedModelId(model));
  if (model && looksNative && dynamicCatalogPending(agent) && !isModelOfOtherAgent(agent, model)) return model;
  return defaultModelForAgent(agent);
}

export function labelForModel(agent: AgentName, modelId: string): string {
  if (agent === 'pi') return findPiModel(modelId)?.name ?? modelId;
  if (agent === 'cursor') return cursorModelOptions().find((m) => m.id === modelId)?.label ?? modelId;
  if (agent === 'opencode') return openCodeModelOptions().find((m) => m.id === modelId)?.label ?? modelId;
  return AGENT_MODELS[agent].find((m) => m.id === modelId)?.label ?? modelId;
}

/** 프로바이더(+모델)가 지원하는 effort 목록. */
export function effortsForAgent(
  agent: AgentName,
  model?: string | null,
): readonly AgentEffortOption[] {
  switch (agent) {
    case 'rau':
      return PI_EFFORTS_STRONG_TO_WEAK.map((id) => ({ id, label: PI_EFFORT_LABELS[id] ?? id }));
    case 'pi': {
      const cfg = findPiModel(resolveModelForAgent('pi', model));
      if (!cfg) return [];
      const allowed = new Set(cfg.efforts);
      return PI_EFFORTS_STRONG_TO_WEAK
        .filter((id) => allowed.has(id))
        .map((id) => ({ id, label: PI_EFFORT_LABELS[id] ?? id }));
    }
    // cursor-agent와 opencode는 추론 강도 플래그를 받지 않는다.
    case 'cursor':
    case 'opencode':
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
  // cursor와 opencode는 어떤 모델이든 effort 자체가 없어 이 유예가 필요 없다.
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

export function isServiceTier(value: unknown): value is ServiceTier {
  return value === 'standard' || value === 'fast';
}

/** Fast 티어는 Codex exec 의 service_tier 만 이해한다. */
export function agentSupportsFast(agent: AgentName): boolean {
  return agent === 'codex';
}

export function resolveServiceTier(
  agent: AgentName,
  requested?: string | null,
): ServiceTier {
  if (!agentSupportsFast(agent)) return 'standard';
  return requested === 'fast' ? 'fast' : 'standard';
}
