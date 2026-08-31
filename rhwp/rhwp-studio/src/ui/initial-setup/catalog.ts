import { AGENT_MODELS, modelsForAgent } from '../../agent/models.ts';
import type { AccountSessionStatus, AgentName, AgentSetupStatusMap } from '../../agent/types.ts';

export const PROVIDER_VENDOR: Record<AgentName, string> = {
  rau: 'Rau',
  claude: 'Anthropic',
  codex: 'OpenAI',
  pi: 'OpenRouter',
  grok: 'xAI',
  cursor: 'Cursor',
};

/** 기본 프로바이더 — 설정되지 않았을 때 흰 CTA 를 준다. */
export const SUGGESTED_AGENT: AgentName = 'rau';

/** Rau 로그인/민트가 실패했을 때 같은 화면에서 고를 수 있는 키 연결 모델. */
export const BYOK_AGENTS = [
  'claude',
  'codex',
  'pi',
  'grok',
  'cursor',
] as const satisfies readonly AgentName[];

type ByokGap = Exclude<Exclude<AgentName, 'rau'>, (typeof BYOK_AGENTS)[number]>;
const byokIsComplete: ByokGap extends never ? true : ByokGap = true;
void byokIsComplete;

/** 잘못된 반환 코드는 모달 안에서 다시 입력하면 되므로 마법사 실패 경로로 접지 않는다. */
export const RAU_RETRY_IN_MODAL_CODES = new Set(['DEVICE_PROOF_INVALID']);

export const RAU_FAILURE_FORWARD_COPY = {
  title: '다른 모델로 이어갈 수 있습니다',
  body: 'Rau 로그인이나 체험 크레딧 연결을 마치지 못했습니다. Claude, Codex, Pi, Grok, Cursor를 연결하거나, 모델 없이 편집기로 바로 가세요. 문서는 그대로 열고 저장할 수 있습니다.',
  skip: '편집기로 계속',
  retry: '다시 시도',
  status: 'Rau 없이 계속할 수 있습니다',
} as const;

export function isByokAgent(agent: AgentName): boolean {
  return (BYOK_AGENTS as readonly AgentName[]).includes(agent);
}

export function isRauFirstRunFailure(info: { agent?: AgentName | null; code?: string }): boolean {
  if (info.agent != null && info.agent !== 'rau') return false;
  if (info.code && RAU_RETRY_IN_MODAL_CODES.has(info.code)) return false;
  return info.agent === 'rau';
}

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

export interface RauSignInFeedback {
  state: 'idle' | 'pending' | 'signed-in';
  label: string;
  ariaLabel: string;
  title: string;
}

/** Generic account state controls only the Rau card's sign-in feedback. */
export function rauSignInFeedback(
  account: AccountSessionStatus | null,
  idleLabel: string,
): RauSignInFeedback {
  if (account?.signedIn === true) {
    return {
      state: 'signed-in',
      label: '로그인됨',
      ariaLabel: '로그인됨. 다음 단계로 계속',
      title: '다음 단계로 계속',
    };
  }
  if (account?.authenticating === true || account?.state === 'pending') {
    return {
      state: 'pending',
      label: '로그인 확인 중…',
      ariaLabel: '로그인 확인 중…',
      title: '',
    };
  }
  return {
    state: 'idle',
    label: idleLabel,
    ariaLabel: idleLabel,
    title: '',
  };
}
