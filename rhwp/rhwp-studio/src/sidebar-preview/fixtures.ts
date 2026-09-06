import type * as T from '../agent/types.ts';
import { defaultModelForAgent, labelForModel } from '../agent/models.ts';

export const agents: T.AgentName[] = [
  'claude',
  'codex',
  'pi',
  'grok',
  'cursor',
  'opencode',
  'rau',
];
export const timestamp = new Date().toISOString();
export function agentMap<TValue>(
  make: (agent: T.AgentName) => TValue,
): Record<T.AgentName, TValue> {
  return Object.fromEntries(
    agents.map((agent) => [agent, make(agent)]),
  ) as Record<T.AgentName, TValue>;
}
export function createFixtures() {
  const providers: T.ProviderStatusMap = agentMap(() => ({
    available: true,
    version: 'preview',
    error: null,
    checkedAt: Date.parse(timestamp),
  }));
  const setups: T.AgentSetupStatusMap = agentMap((agent) => ({
    agent,
    available: true,
    connected: true,
    installed: true,
    installing: false,
    version: 'preview',
    authenticated: true,
    authMethod: 'oauth',
    keyTail: null,
    authenticating: false,
    setupComplete: true,
    latestVersion: 'preview',
    updateRequired: false,
    error: null,
  }));
  const window: T.UsageWindow = {
    turns: 12,
    inputTokens: 18400,
    outputTokens: 3200,
    cacheReadTokens: 8400,
    cacheCreationTokens: 0,
    weightedTokens: 21600,
    percent: 24,
  };
  const usage: T.UsageSummary = {
    plans: agentMap((agent) =>
      agent === 'codex' ? 'plus' : agent === 'claude' ? 'pro' : 'api',
    ),
    providers: agentMap(() => ({
      session: { ...window },
      day: { ...window },
      week: { ...window, percent: 42 },
      byModel: {},
      limit: { session5h: 90000, week: 500000 },
      updatedAt: Date.parse(timestamp),
      source: 'estimate',
    })),
    rau: {
      balanceUsd: 4.25,
      totalCreditsUsd: 5,
      totalUsageUsd: 0.75,
      checkedAt: Date.parse(timestamp),
      error: null,
    },
  };
  const quotaScenario = new URLSearchParams(location.search).get('quota');
  const now = Date.now();
  usage.limits = {
    claude: {
      status: 'ok', session: { percent: 24, resetsAt: now + 3600000 },
      week: { percent: 72, resetsAt: now + 86400000 }, updatedAt: now,
      error: null, accountKey: 'preview-claude', planType: 'Pro', resetCredits: null,
    },
    codex: {
      status: 'ok', session: { percent: 92, resetsAt: now + 7200000 },
      week: { percent: 42, resetsAt: now + 172800000 }, updatedAt: now,
      error: null, accountKey: 'preview-codex', planType: 'Plus',
      resetCredits: { availableCount: 2, nextExpiresAt: now + 604800000 },
    },
  };
  if (quotaScenario === 'error') {
    usage.limits.claude.status = 'error';
    usage.limits.claude.error = '제공자가 응답하지 않아요.';
    usage.limits.claude.updatedAt = now - 600000;
    usage.limits.codex.status = 'unavailable';
    usage.limits.codex.session.percent = null;
    usage.limits.codex.week.percent = null;
    usage.limits.codex.resetCredits = null;
  }
  if (quotaScenario === 'empty') usage.limits.codex.resetCredits!.availableCount = 0;
  if (quotaScenario === 'pro') usage.limits.codex.planType = 'Pro';
  const pi: T.PiStatus = {
    installed: true,
    installing: false,
    version: 'preview',
    keyConfigured: true,
    keyTail: 'demo',
    models: [],
    defaultModelId: null,
    setupComplete: true,
    latestVersion: 'preview',
    updateRequired: false,
    error: null,
  };
  pi.models = [
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      reasoning: true,
      supportsImages: true,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      contextLength: 200000,
      pricing: { prompt: 0.000003, completion: 0.000015 },
    },
  ];
  pi.defaultModelId = pi.models[0].id;
  setups.cursor.models = ['auto', 'sonnet-4.6', 'gpt-5.4'];
  setups.opencode.models = ['anthropic/claude-sonnet-4-6', 'openai/gpt-5.4'];
  setups.rau.account = 'designer@example.test';
  usage.openrouter = {
    balanceUsd: 18.5,
    totalCreditsUsd: 20,
    totalUsageUsd: 1.5,
    checkedAt: Date.parse(timestamp),
    error: null,
  };
  usage.balances = {
    openrouter: { status: 'ok', balanceUsd: 18.5, totalCreditsUsd: 20, totalUsageUsd: 1.5, updatedAt: now, source: '샘플', error: null },
    grok: { status: 'ok', balanceUsd: 4.25, totalCreditsUsd: null, totalUsageUsd: null, updatedAt: now, source: '샘플', error: null },
    opencode: { status: 'unavailable', balanceUsd: null, totalCreditsUsd: null, totalUsageUsd: null, updatedAt: null, source: '샘플', error: '연결된 계정의 잔액 정보를 사용할 수 없어요.' },
  };
  const templates: T.TemplateCatalog = {
    revision: 1,
    templates: ['사업 제안서', '회의록'].map((name, i) => ({
      id: `template-${i}`,
      name,
      originalName: `${name}.hwpx`,
      format: 'hwpx',
      size: 24576,
      pageCount: i ? 2 : 5,
      sectionCount: 1,
      contentHash: `preview-${i}`,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  };
  const skills: T.SkillCatalog = {
    revision: 1,
    skills: [
      ['proofread-korean', '한국어 문서의 맞춤법과 문장을 다듬습니다.'],
      ['summarize-document', '문서의 핵심 내용을 요약합니다.'],
      ['draft-document', '요청에 맞는 새 문서의 초안을 작성합니다.'],
    ].map(([name, description]) => ({
      name,
      description,
      origin: 'user',
      icon: 'pencil',
      enabled: true,
      hasScripts: false,
      hasAssets: false,
      fileCount: 1,
      files: [
        {
          path: 'SKILL.md',
          encoding: 'utf8',
          content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
        },
      ],
    })),
  };
  const writing: T.WritingStyleStatus = {
    active: false,
    language: 'ko',
    updatedAt: null,
    sourceCount: 0,
    pageEstimate: 0,
    summary: '',
    additionalInstruction: '',
  };
  const writingCatalog: T.WritingStyleCatalog = {
    providers: agents.map((id) => ({
      id,
      name: id,
      available: true,
      error: null,
      models:
        id === 'pi'
          ? pi.models
          : [
              {
                id: defaultModelForAgent(id),
                name: labelForModel(id, defaultModelForAgent(id)),
                efforts: ['medium'],
                defaultEffort: 'medium',
              },
            ],
    })),
    defaultSelection: { agent: 'codex', model: defaultModelForAgent('codex') },
  };
  const instructions: T.AgentInstructionsStatus = {
    fileName: 'AGENTS.md',
    content: '한국어 문서를 간결하고 자연스럽게 작성합니다.',
    revision: 1,
    updatedAt: timestamp,
    maxChars: 20000,
    scope: 'rauhwpx-app',
  };
  const account: T.AccountSessionStatus = {
    state: 'signed-out',
    signedIn: false,
    account: null,
    updatedAt: timestamp,
    authenticating: false,
  };
  return {
    providers,
    setups,
    usage,
    pi,
    templates,
    skills,
    writing,
    writingCatalog,
    instructions,
    account,
  };
}

export function samplePlan(): T.StructuredPlan {
  return {
    planId: crypto.randomUUID(),
    title: '사업 제안서 개선 계획',
    goal: '제안의 핵심과 실행 일정을 명확히 전달합니다.',
    summary: '문서 구조를 정리하고 문장을 다듬습니다.',
    assumptions: ['기존 목차를 유지합니다.'],
    decisions: ['핵심 내용을 첫 문단에 배치합니다.'],
    steps: [
      {
        title: '개요 정리',
        details: '목적과 기대 효과를 간결하게 작성합니다.',
      },
      {
        title: '일정 검토',
        details: '단계별 산출물과 일정을 표로 정리합니다.',
      },
    ],
    files: ['사업 제안서.hwpx'],
    validation: ['용어와 날짜를 확인합니다.'],
    risks: [],
    exclusions: [],
    createdAt: timestamp,
    epoch: 1,
  };
}
