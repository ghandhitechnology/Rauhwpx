import { AGENT_MODELS, modelsForAgent } from '../../agent/models.ts';
import type { AgentName, AgentSetupStatusMap } from '../../agent/types.ts';

export const PROVIDER_VENDOR: Record<AgentName, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  pi: 'OpenRouter',
  grok: 'xAI',
  cursor: 'Cursor',
};

/** 기본 프로바이더 — 설정되지 않았을 때 흰 CTA 를 준다. */
export const SUGGESTED_AGENT: AgentName = 'codex';

export function previewModelLabels(agent: AgentName): string[] {
  if (agent === 'pi') {
    const live = modelsForAgent('pi').map((model) => model.label).filter(Boolean);
    return live.length > 0 ? live.slice(0, 3) : ['OpenRouter에서 고름', '최대 3개'];
  }
  if (agent === 'cursor') {
    const live = modelsForAgent('cursor').map((model) => model.label).filter(Boolean);
    if (live.length > 1) return live.slice(0, 4);
    return ['Auto', '구독 · API 모델'];
  }
  return AGENT_MODELS[agent].map((model) => model.label);
}

export function isProviderConfigured(
  agent: AgentName,
  statuses: AgentSetupStatusMap | null,
): boolean {
  const setup = statuses?.[agent];
  return setup?.connected === true || setup?.setupComplete === true || setup?.authenticated === true;
}
