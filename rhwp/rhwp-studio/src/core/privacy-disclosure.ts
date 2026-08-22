/**
 * 보안·개인정보 안내 문구.
 *
 * 사무실에서 "이 프로그램이 한글 파일을 클라우드에 올리나요?"에 답하려고 둔다.
 * 실제 구조만 말한다. 망분리·완전 오프라인 AI를 주장하지 않는다.
 *
 * 구조:
 *  - 문서 파일은 디스크 또는 이 기기 WASM 편집기에 있다.
 *  - 한글 처리(열기·편집·쪽 나누기)는 로컬 엔진이다.
 *  - 모델은 사용자가 고른 CLI(Claude, Codex, Grok, Cursor, Pi)다.
 *  - API 토큰은 그 CLI → 그 제공자로 간다.
 *  - Rauhwpx 자체는 문서 파일을 몰래 업로드하지 않는다.
 *  - 에이전트 허브는 localhost 라우터다.
 */
import { labelForModel } from '../agent/models.ts';
import type { AgentName } from '../agent/types.ts';

const AGENT_LABEL: Record<AgentName, string> = {
  claude: 'Claude',
  codex: 'Codex',
  pi: 'Pi',
  grok: 'Grok',
  cursor: 'Cursor',
};

export type PrivacyShell = 'desktop' | 'browser';

export type PrivacySectionId =
  | 'file'
  | 'hangul'
  | 'provider'
  | 'credentials'
  | 'upload'
  | 'limit';

export interface PrivacyDocumentLocation {
  hasDocument: boolean;
  fileName: string;
  isUntitled: boolean;
  sourcePath: string | null;
}

export interface PrivacySnapshot {
  shell: PrivacyShell;
  location: PrivacyDocumentLocation;
  defaultAgent: AgentName;
  defaultModel: string;
  /** 지금 대화가 기본 제공자와 다를 때만 넣는다. */
  conversationAgent?: AgentName;
  conversationModel?: string;
}

export interface PrivacySection {
  id: PrivacySectionId;
  title: string;
  body: string;
}

export interface PrivacyDisclosure {
  lead: string;
  sections: readonly PrivacySection[];
}

/** 토큰이 실제로 향하는 제공자. CLI 이름이 아니라 네트워크 상대. */
export interface ProviderCredentialTarget {
  cliLabel: string;
  networkTarget: string;
  envName: string | null;
}

const CREDENTIAL_TARGET: Record<AgentName, ProviderCredentialTarget> = {
  claude: {
    cliLabel: 'Claude CLI',
    networkTarget: 'Anthropic',
    envName: 'ANTHROPIC_API_KEY',
  },
  codex: {
    cliLabel: 'Codex CLI',
    networkTarget: 'OpenAI',
    envName: 'OPENAI_API_KEY',
  },
  grok: {
    cliLabel: 'Grok CLI',
    networkTarget: 'xAI',
    envName: 'XAI_API_KEY',
  },
  cursor: {
    cliLabel: 'Cursor CLI',
    networkTarget: 'Cursor',
    envName: 'CURSOR_API_KEY',
  },
  pi: {
    cliLabel: 'Pi',
    networkTarget: 'OpenRouter',
    envName: null,
  },
};

export const PRIVACY_LIMIT_DISCLAIMER = '망분리나 완전 오프라인 AI가 아닙니다.';

export const PRIVACY_NO_SILENT_UPLOAD =
  'Rauhwpx는 문서 파일을 몰래 업로드하지 않습니다.';

/**
 * 허위 주장으로 읽히는 표현. 부정 문장("…가 아닙니다")은 여기 넣지 않는다.
 * 안내 문구가 이 패턴에 걸리면 과대 광고다.
 */
export const FORBIDDEN_PRIVACY_CLAIMS: readonly RegExp[] = [
  /에어갭/,
  /air[\s-]?gap/i,
  /완전히 오프라인/,
  /fully offline/i,
  /인터넷 없이 동작/,
  /완전히 로컬인 AI/,
  /망분리되어 있습니다/,
];

export function credentialTargetFor(agent: AgentName): ProviderCredentialTarget {
  return CREDENTIAL_TARGET[agent];
}

export function buildPrivacyDisclosure(snapshot: PrivacySnapshot): PrivacyDisclosure {
  const defaultAgent = snapshot.defaultAgent;
  const defaultLabel = AGENT_LABEL[defaultAgent];
  const defaultModel = labelForModel(defaultAgent, snapshot.defaultModel) || snapshot.defaultModel || 'CLI 기본값';
  const conversationDiffers = Boolean(
    snapshot.conversationAgent
    && (
      snapshot.conversationAgent !== defaultAgent
      || (snapshot.conversationModel && snapshot.conversationModel !== snapshot.defaultModel)
    ),
  );

  return {
    lead: '한글 문서는 이 기기에서 엽니다. AI를 쓰면 사용자가 고른 CLI가 그 제공자와 대화합니다. '
      + PRIVACY_LIMIT_DISCLAIMER,
    sections: [
      { id: 'file', title: '파일 위치', body: describeFileLocation(snapshot.shell, snapshot.location) },
      { id: 'hangul', title: '한글 처리', body: describeHangulProcessing() },
      {
        id: 'provider',
        title: '선택한 제공자',
        body: describeProvider({
          defaultLabel,
          defaultModel,
          conversation: conversationDiffers && snapshot.conversationAgent
            ? {
              label: AGENT_LABEL[snapshot.conversationAgent],
              model: labelForModel(
                snapshot.conversationAgent,
                snapshot.conversationModel ?? '',
              ) || snapshot.conversationModel || 'CLI 기본값',
            }
            : null,
        }),
      },
      {
        id: 'credentials',
        title: '토큰과 로그인',
        body: describeCredentials(snapshot.shell, defaultAgent),
      },
      { id: 'upload', title: '파일 전송', body: describeUploadPolicy() },
      { id: 'limit', title: 'AI를 쓸 때', body: describeLimit() },
    ],
  };
}

export function privacyDisclosureText(disclosure: PrivacyDisclosure): string {
  return [disclosure.lead, ...disclosure.sections.map((section) => `${section.title}\n${section.body}`)].join('\n\n');
}

export function forbiddenPrivacyClaim(text: string): string | null {
  for (const pattern of FORBIDDEN_PRIVACY_CLAIMS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

function describeFileLocation(shell: PrivacyShell, location: PrivacyDocumentLocation): string {
  if (!location.hasDocument) {
    return '지금 열린 문서가 없습니다. 파일을 열면 이 기기 편집기에만 올라갑니다.';
  }
  if (location.sourcePath) {
    return `문서 파일은 이 컴퓨터 디스크에 있습니다. ${location.sourcePath}`;
  }
  if (location.isUntitled || !location.fileName.trim()) {
    return '아직 저장하지 않은 문서입니다. 이 기기 편집기 메모리에만 있습니다.';
  }
  if (shell === 'desktop') {
    return `데스크톱 편집기에 열린 문서입니다. 파일 이름: ${location.fileName}. `
      + '원본은 이 컴퓨터에 있고, Rauhwpx가 클라우드로 올리지 않습니다.';
  }
  return `브라우저의 로컬 WASM 편집기에 열려 있습니다. 파일 이름: ${location.fileName}. `
    + '디스크에 저장한 파일은 이 기기에 남습니다.';
}

function describeHangulProcessing(): string {
  return '한글 파일의 열기, 편집, 쪽 나누기는 이 기기의 WASM 엔진이 합니다. '
    + '한컴 서버나 Rauhwpx 클라우드로 원본 파일을 보내지 않습니다.';
}

function describeProvider(input: {
  defaultLabel: string;
  defaultModel: string;
  conversation: { label: string; model: string } | null;
}): string {
  const base = `지금 기본 제공자는 ${input.defaultLabel}입니다. `
    + `모델은 그 CLI가 쓰는 값입니다 (${input.defaultModel}).`;
  if (!input.conversation) return base;
  return `${base} 이 대화는 ${input.conversation.label} / ${input.conversation.model}을 씁니다.`;
}

function describeCredentials(shell: PrivacyShell, agent: AgentName): string {
  const target = CREDENTIAL_TARGET[agent];
  const env = target.envName ? ` API 키 환경 변수는 ${target.envName}입니다.` : ' OpenRouter 키를 사용합니다.';
  const storage = shell === 'desktop'
    ? '데스크톱에서는 OS 자격 증명 저장소에 암호화해 둔 뒤, 그 CLI에만 건넵니다.'
    : '브라우저에서는 이 컴퓨터의 localhost 에이전트 허브와 해당 CLI가 자격 증명을 다룹니다.';
  return `API 토큰과 로그인 정보는 선택한 ${target.cliLabel}로 갑니다. `
    + `그 CLI가 ${target.networkTarget} 쪽으로 보냅니다.`
    + env
    + ` ${storage} `
    + 'Rauhwpx 자체 클라우드에 토큰을 올리지 않습니다.';
}

function describeUploadPolicy(): string {
  return `${PRIVACY_NO_SILENT_UPLOAD} `
    + '에이전트 허브는 127.0.0.1에서 스튜디오와 선택한 CLI를 잇는 로컬 라우터입니다. '
    + '문서 클라우드 파이프라인은 없습니다.';
}

function describeLimit(): string {
  return `${PRIVACY_LIMIT_DISCLAIMER} `
    + 'AI를 쓰면 선택한 CLI가 대화와, 도구로 읽은 문서 일부를 그 제공자에게 보낼 수 있습니다. '
    + '웹 조사나 Browserbase를 쓰면 그 서비스로도 나갑니다. '
    + '클라우드 파일 업로드를 금지하는 곳에서는 AI를 끄거나, 반출이 허용된 제공자만 쓰세요.';
}
