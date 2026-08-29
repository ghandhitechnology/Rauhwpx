/**
 * 프로바이더 표시 규칙 한 곳 — 라벨·순서·아이콘.
 *
 * 사이드바(index.ts), 설정 탭(settings.ts), 글쓰기 보정(writing-style-calibration.ts)
 * 이 같은 표를 각자 베껴 두면 프로바이더가 하나 늘 때 한 화면에서만 조용히 빠진다.
 * 세 화면이 이 모듈만 본다.
 */
import type { AgentName } from '../../agent/types.ts';

export const AGENT_LABEL: Record<AgentName, string> = {
  rau: 'Rau',
  claude: 'Claude',
  codex: 'Codex',
  pi: 'Pi',
  grok: 'Grok',
  cursor: 'Cursor',
};

/** 프로바이더가 서는 정식 순서 — 연결 목록과 입력기 피커가 같이 쓴다. */
export const PROVIDER_ORDER = [
  'rau',
  'claude',
  'codex',
  'pi',
  'grok',
  'cursor',
] as const satisfies readonly AgentName[];

/* 새 프로바이더가 순서에서 빠지면 여기서 컴파일이 깨진다. */
type ProviderOrderGap = Exclude<AgentName, (typeof PROVIDER_ORDER)[number]>;
const providerOrderIsComplete: ProviderOrderGap extends never ? true : ProviderOrderGap = true;
void providerOrderIsComplete;

/** 단색 로고는 마스크로 그린다 — currentColor 를 타고 테마에 맞는다. */
export const MASK_ICON_AGENTS: readonly AgentName[] = ['rau', 'codex', 'pi', 'grok', 'cursor'];

export const PROVIDER_ICON_SRC: Partial<Record<AgentName, string>> = {
  claude: '/icons/provider-claude.png',
  codex: '/icons/provider-codex.png',
};

export function createProviderIcon(agent: AgentName): HTMLElement {
  if (MASK_ICON_AGENTS.includes(agent)) {
    // 단색 로고 — currentColor 마스크로 라이트/다크에 맞춤
    const mark = document.createElement('span');
    mark.className = 'ag-provider-icon ag-provider-icon-mask';
    mark.dataset.agent = agent;
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
  const img = document.createElement('img');
  img.className = 'ag-provider-icon';
  img.dataset.agent = agent;
  img.src = PROVIDER_ICON_SRC[agent] ?? '';
  img.alt = '';
  img.draggable = false;
  img.setAttribute('aria-hidden', 'true');
  return img;
}
