import type { SidebarBridge } from '../agent/bridge.ts';
import type * as T from '../agent/types.ts';
import { deriveAgentEditingLease } from '../agent/editing-lease.ts';
import {
  defaultModelForAgent,
  setModelCatalog,
  setPiModels,
} from '../agent/models.ts';
import type { CatalogAgent, ModelCatalogEntry } from '../agent/models.ts';
import { loadAgentPrefs } from '../agent/agent-prefs.ts';
import { createFixtures, samplePlan, timestamp, agents } from './fixtures.ts';
import { requestLiveUsage, consumeLiveCodexReset } from './live-usage.ts';
import { createBrowserbaseFixture, type BrowserbaseFixtureState } from './fixtures.ts';

export const scenarios = [
  'chat',
  'tools',
  'rich',
  'plan',
  'question',
  'review',
  'fleet',
  'error',
] as const;
export type Scenario = (typeof scenarios)[number];

const sampleModelCatalogs: Record<CatalogAgent, ModelCatalogEntry[]> = {
  claude: [
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', description: 'Complex reasoning and long-form work', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Balanced speed and depth', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Fast everyday assistance', supportedEfforts: ['low', 'medium', 'high'] },
  ],
  codex: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: 'Deep reasoning for demanding work', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', description: 'Coding and everyday work', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', description: 'Quick answers and simple tasks', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced general reasoning', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Coding model', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
  ],
};

/** 편집 결과 그림 흉내 — 문단 두 줄과 강조 띠를 그린 작은 PNG. */
function sampleCropPng(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 520;
  canvas.height = 150;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(47, 125, 79, 0.14)';
  ctx.fillRect(16, 56, 330, 34);
  ctx.fillStyle = '#171b22';
  ctx.font = '600 22px sans-serif';
  ctx.fillText('2. 추진 일정', 16, 38);
  ctx.font = '18px sans-serif';
  ctx.fillText('2026년 10월 착수, 12월 중간 점검', 22, 80);
  ctx.fillText('사업 기간은 총 6개월입니다.', 22, 124);
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

interface ToolScenarioCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** tools 시나리오 — 실제 rhwp 도구 이름·인자·결과 모양으로 사이드바 표시를 확인한다. */
function toolScenarioCalls(): ToolScenarioCall[] {
  return [
    {
      id: 'batch',
      tool: 'mcp__rhwp__read_batch',
      args: { reads: [{ tool: 'get_structure', args: { range: { sectionIdx: 0, fromPara: 0, toPara: 24 } } }, { tool: 'find_text', args: { query: '추진 일정' } }] },
      result: { revision: 12, results: [{ tool: 'get_structure', pageCount: 3, truncated: false }, { tool: 'find_text', matches: [{ sectionIdx: 0, paraIdx: 8 }, { sectionIdx: 0, paraIdx: 19 }] }] },
    },
    {
      id: 'edit',
      tool: 'mcp__rhwp__apply_edits',
      args: {
        expectedRevision: 12,
        render: 'crop',
        edits: [
          { tool: 'replace_range', args: { anchor: { text: '2026년 11월 착수' }, text: '2026년 10월 착수' } },
          { tool: 'insert_text', args: { anchor: { text: '중간 점검', position: 'after' }, text: '\n사업 기간은 총 6개월입니다.' } },
          { tool: 'apply_char_format', args: { anchor: { text: '추진 일정' }, bold: true, fontSizePt: 13 } },
        ],
      },
      result: {
        revision: 13,
        applied: 3,
        results: [{ tool: 'replace_range' }, { tool: 'insert_text' }, { tool: 'apply_char_format' }],
        after: { pages: [1], pageCount: { before: 3, after: 3 }, warnings: [] },
        image: { data: sampleCropPng(), mimeType: 'image/png' },
      },
    },
    {
      id: 'table',
      tool: 'mcp__rhwp__set_table_props',
      args: { expectedRevision: 13, sectionIdx: 0, paraIdx: 21, controlIdx: 0, tableProps: { repeatHeader: true, textWrap: 'topAndBottom' } },
      error: { code: 'REVISION_MISMATCH', message: 'expectedRevision 13 does not match current revision 14 — re-read with get_structure({sinceRevision:13})' },
    },
  ];
}

/** Implements the actual UI contract: new bridge methods produce a type error here. */
export function createMockBridge(report: (message: string) => void, onApproved?: () => void) {
  const data = createFixtures();
  const liveUsage = new URLSearchParams(location.search).get('usage') === 'live';
  if (liveUsage) {
    delete data.usage.limits;
    delete data.usage.balances;
    delete data.usage.rau;
    delete data.usage.openrouter;
    for (const provider of Object.values(data.usage.providers)) {
      provider.updatedAt = null;
      provider.byModel = {};
      for (const key of ['session', 'day', 'week'] as const) {
        provider[key] = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          cacheCreationTokens: 0, weightedTokens: 0, percent: null };
      }
    }
  }
  let browserbaseState: BrowserbaseFixtureState = 'connected';
  let browserbase = createBrowserbaseFixture(browserbaseState);
  const listeners = new Set<(event: T.SidebarEvent) => void>();
  const pendingListeners = new Set<
    (event: T.PendingEditsChangeEvent) => void
  >();
  const leaseListeners = new Set<(lease: T.AgentEditingLease) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let connection: ReturnType<SidebarBridge['getConnectionState']> = 'connected';
  let agent: T.AgentName = loadAgentPrefs().defaultAgent;
  let running = false;
  let usageRefreshFailed = false;
  let generation = 0;
  let threadId = '';
  let scenario: Scenario = 'chat';
  let holdReply = false;
  let permission: T.PermissionProfile = 'safe';
  let tier: T.ServiceTier = 'standard';
  let workflow: T.AgentWorkflowState = {
    workflow: 'direct',
    phase: 'direct',
    capabilityEpoch: 1,
    latestPlan: null,
  };
  let question: T.UserQuestionInteraction | null = null;
  let activeTemplate: T.DocumentTemplate | null = null;
  let changes: T.PendingChangeSet[] = [];
  const changeEvents: T.PendingEditsChangeEvent['type'][] = [];
  const reviewMode = new URLSearchParams(location.search).get('review');
  const fullReview = reviewMode === 'full';
  const references: T.ReferenceFile[] = [
    {
      id: 'reference-sample',
      scope: 'global',
      scopeId: 'global',
      name: '브랜드 가이드.pdf',
      mimeType: 'application/pdf',
      size: 42800,
      status: 'ready',
      createdAt: timestamp,
      chunkCount: 8,
      kind: 'document',
    },
  ];
  const staged = new Map<string, T.StagedReference>();
  const emit = (event: T.SidebarEvent) =>
    listeners.forEach((listener) => listener(event));
  const later = (fn: () => void, delay = 20) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delay);
    timers.add(timer);
  };
  const request = (fn: (id: string) => void) => {
    const id = crypto.randomUUID();
    later(() => fn(id));
    return id;
  };
  const stream = (event: T.AgentStreamEvent) => emit({ type: 'agent', event });
  const setRunning = (value: boolean) => {
    running = value;
    leaseListeners.forEach((listener) => listener(bridge.getEditingLease()));
  };
  const finish = (stopReason = 'completed') => {
    setRunning(false);
    stream({ type: 'turn-end', agent, stopReason });
  };
  const updatePlanExecution = (execution: NonNullable<T.StructuredPlan['execution']>) => {
    if (!workflow.latestPlan) return;
    const latestPlan = { ...workflow.latestPlan, execution };
    workflow = { ...workflow, latestPlan };
    emit({ type: 'plan-progress', planId: latestPlan.planId, ...workflow });
  };
  const setupChanged = () =>
    emit({ type: 'agent-setup-status', statuses: data.setups });
  const skillTrash = new Map();
  // Bodies live separately from catalog metadata so refreshes exercise the same
  // read/save path as the real bridge. Imported/bundled rows intentionally have
  // no editable body in the preview.
  const skillBodies = new Map<string, string>([
    ['proofread-korean', '# proofread-korean\n\n한국어 문서의 맞춤법과 문장을 다듬습니다.\n'],
    ['summarize-document', '# summarize-document\n\n문서의 핵심 내용을 요약합니다.\n'],
    ['draft-document', '# draft-document\n\n요청에 맞는 새 문서의 초안을 작성합니다.\n'],
  ]);
  const skillsChanged = () => {
    emit({ type: 'skills-catalog', catalog: data.skills });
  };
  const templateChanged = () => {
    data.templates.revision++;
    emit({ type: 'templates-catalog', catalog: data.templates });
  };
  const writingResult = () =>
    request((requestId) =>
      emit({ type: 'writing-style-result', requestId, status: data.writing }),
    );
  const terminalOptions = ['Anthropic', 'OpenAI'];
  let terminalRun: { id: string; agent: T.AgentName; step: number; choice: number } | null = null;
  const terminalMenu = () => `\x1b[2J\x1b[H\x1b[36m◆  ${terminalRun?.agent ?? 'CLI'} 로그인\x1b[0m\r\n\r\n`
    + terminalOptions.map((name, index) => `  ${index === terminalRun?.choice ? '❯' : ' '} ${name}`).join('\r\n')
    + '\r\n\r\n  Enter 키로 선택하세요.';
  const authenticate = (provider: T.AgentName) => {
    if (provider === 'pi') {
      data.pi.keyConfigured = true;
      data.pi.setupComplete = true;
      emit({ type: 'pi-status', status: data.pi });
    }
    Object.assign(data.setups[provider], {
      connected: true,
      authenticated: true,
      authenticating: false,
      authOwnedByThisSession: false,
      authRunId: undefined,
      setupComplete: true,
    });
    setupChanged();
    if (provider === 'rau') {
      Object.assign(data.account, { state: 'signed-in', signedIn: true,
        account: { email: 'designer@example.test' }, authenticating: false });
      emit({ type: 'account-status', status: data.account });
    }
    report(`${provider}: connected to a local sample account`);
  };
  const signIn = () => {
    authenticate('rau');
    Object.assign(data.account, {
      state: 'signed-in',
      signedIn: true,
      account: { email: 'designer@example.test' },
      authenticating: false,
    });
    emit({ type: 'account-status', status: data.account });
    report('Sample account connected');
  };
  const completeQuestion = (outcome: T.UserQuestionOutcome) => {
    if (!question) return;
    emit({
      type: 'user-question-resolved',
      interactionId: question.interactionId,
      outcome,
    });
    question = null;
  };
  const bridge: SidebarBridge = {
    pendingEdits: {
      getChangeSets: () => changes,
      onChange: (listener) => {
        pendingListeners.add(listener);
        return () => pendingListeners.delete(listener);
      },
      approve: (id) => {
        changes = changes.filter((change) => change.id !== id);
        if (workflow.latestPlan?.execution?.status === 'awaiting-review') {
          updatePlanExecution({ ...workflow.latestPlan.execution, status: 'completed' });
        }
        onApproved?.();
        changeEvents.push('approved');
        pendingListeners.forEach((listener) =>
          listener({ type: 'approved', changeSetId: id }),
        );
        report('Sample document changes accepted');
        return true;
      },
      reject: (id) => {
        changes = changes.filter((change) => change.id !== id);
        changeEvents.push('rejected');
        pendingListeners.forEach((listener) =>
          listener({ type: 'rejected', changeSetId: id }),
        );
        report('Sample document changes rejected');
      },
    },
    getDocumentSelectionIdentity: () => ({ documentId: 'sidebar-preview', revision: 0 }),
    getConnectionState: () => connection,
    getActiveAgent: () => agent,
    isTurnRunning: () => running,
    getPendingUserQuestion: () => question,
    getEditingLease: () =>
      deriveAgentEditingLease({
        turnRunning: running,
        activeToolRequests: 0,
        agent,
        ...workflow,
        waitingForUser: question !== null,
      }),
    onEditingLeaseChange: (listener) => {
      leaseListeners.add(listener);
      return () => leaseListeners.delete(listener);
    },
    getPermissionProfile: () => permission,
    getServiceTier: () => tier,
    getWorkflowState: () => workflow,
    takeOverConnection: () => setConnection('connected'),
    reconnectNow: async () => setConnection('connected'),
    requestProviderStatus: async () => data.providers,
    requestModelCatalog: async (modelAgent) => {
      const models = sampleModelCatalogs[modelAgent];
      setModelCatalog(modelAgent, models);
      emit({ type: 'model-catalog', agent: modelAgent, requestId: crypto.randomUUID(), models });
      return models;
    },
    requestAgentSetupStatus: async () => data.setups,
    requestAccountStatus: async () => data.account,
    requestBrowserbaseStatus: async () => {
      if (browserbaseState === 'error') {
        emit({ type: 'browserbase-error', requestId: 'preview-browserbase-status', code: 'preview-unavailable', message: '미리보기 원격 브라우저 연결을 확인하지 못했어요.' });
        return null;
      }
      const status = structuredClone(browserbase);
      emit({ type: 'browserbase-status', status });
      return status;
    },
    setBrowserbaseCredentials: async (override) => {
      if (browserbaseState === 'error' || !override.apiKey.trim()) {
        emit({ type: 'browserbase-error', requestId: 'preview-browserbase-credentials', code: 'preview-invalid-key', message: '미리보기 키를 확인하지 못했어요.' });
        return null;
      }
      // 입력한 키/프로젝트는 보관하지 않고 샘플 상태만 표시한다.
      browserbase = {
        ...createBrowserbaseFixture('connected'),
        keySource: 'studio',
        keyTail: 'demo',
        projectSource: 'studio',
        geminiSource: override.geminiApiKey?.trim() ? 'studio' : 'env',
      };
      browserbaseState = 'connected';
      const status = structuredClone(browserbase);
      emit({ type: 'browserbase-status', status });
      return status;
    },
    clearBrowserbaseCredentials: async () => {
      browserbaseState = 'connected';
      browserbase = createBrowserbaseFixture('connected');
      const status = structuredClone(browserbase);
      emit({ type: 'browserbase-status', status });
      return status;
    },
    loginAccount: async () => {
      const authRunId = crypto.randomUUID();
      Object.assign(data.account, {
        authenticating: true,
        state: 'pending',
        authRunId,
      });
      emit({ type: 'account-status', status: data.account });
      later(() => {
        if (data.account.authenticating) signIn();
      }, 800);
      return {
        authRunId,
        authUrl: 'https://accounts.example.invalid/preview',
        pairingCode: 'PREVIEW',
        expiresAt: null,
      };
    },
    submitAccountAuthCode: () => signIn(),
    cancelAccountLogin: () => {
      Object.assign(data.account, {
        state: 'signed-out',
        authenticating: false,
      });
      emit({ type: 'account-status', status: data.account });
    },
    logoutAccount: async () => {
      Object.assign(data.setups.rau, { connected: false, authenticated: false,
        authenticating: false, setupComplete: false });
      setupChanged();
      Object.assign(data.account, {
        state: 'signed-out',
        signedIn: false,
        account: null,
        authenticating: false,
      });
      emit({ type: 'account-status', status: data.account });
      return data.account;
    },
    installAgent: async (provider) => {
      data.setups[provider].installing = true;
      setupChanged();
      emit({
        type: 'agent-setup-progress',
        agent: provider,
        state: 'installing',
        phase: 'installing',
        percent: 30,
      });
      await new Promise<void>((resolve) => later(resolve, 600));
      Object.assign(data.setups[provider], {
        installing: false,
        installed: true,
        available: true,
      });
      data.providers[provider].available = true;
      if (provider === 'pi') data.pi.installed = true;
      emit({
        type: 'agent-setup-progress',
        agent: provider,
        state: 'done',
        phase: 'done',
        percent: 100,
      });
      setupChanged();
      return data.setups;
    },
    authenticateAgent: async (provider, method) => {
      if (!['rau', 'pi'].includes(provider) && method === 'oauth') {
        terminalRun = { id: crypto.randomUUID(), agent: provider, step: 0, choice: 0 };
        const id = terminalRun.id;
        Object.assign(data.setups[provider], { authenticating: true, authOwnedByThisSession: true, authRunId: id, authMethod: method });
        setupChanged();
        later(() => {
          if (terminalRun?.id !== id) return;
          emit({ type: 'agent-setup-terminal', agent: provider, authRunId: id, ready: true });
          emit({ type: 'agent-setup-terminal', agent: provider, authRunId: id,
            data: terminalMenu() });
        }, 150);
        return { agent: provider, authRunId: id, authUrl: null };
      }
      Object.assign(data.setups[provider], {
        authenticating: true,
        authMethod: method,
      });
      setupChanged();
      later(() => {
        if (data.setups[provider].authenticating) authenticate(provider);
      }, 800);
      return {
        agent: provider,
        authRunId: crypto.randomUUID(),
        authUrl: null,
        pairingCode: 'PREVIEW',
      };
    },
    resumeSetupTerminal: (agent, authRunId) => {
      if (agent === terminalRun?.agent && terminalRun?.id === authRunId) emit({ type: 'agent-setup-terminal', agent, authRunId, ready: true });
    },
    sendSetupTerminalInput: (provider, authRunId, input) => {
      if (provider !== terminalRun?.agent || terminalRun?.id !== authRunId) return;
      if (input.includes('\x03')) { bridge.cancelAgentSetup(provider, authRunId); return; }
      if (terminalRun.step === 0 && /\x1b\[[AB]/.test(input)) {
        const direction = input.includes('\x1b[B') ? 1 : terminalOptions.length - 1;
        terminalRun.choice = (terminalRun.choice + direction) % terminalOptions.length;
        emit({ type: 'agent-setup-terminal', agent: provider, authRunId, data: terminalMenu() });
        return;
      }
      if (!input.includes('\r')) return;
      terminalRun.step += 1;
      if (terminalRun.step === 1) {
        emit({ type: 'agent-setup-terminal', agent: provider, authRunId,
          data: '\x1b[2J\x1b[H브라우저에서 계정 연결을 완료하세요.\r\n\r\n미리보기: Enter 키를 누르면 연결이 완료됩니다.' });
      } else {
        terminalRun = null;
        authenticate(provider);
      }
    },
    resizeSetupTerminal: () => {},
    submitAgentAuthCode: (provider) => authenticate(provider),
    cancelAgentSetup: (provider) => {
      if (provider === terminalRun?.agent) terminalRun = null;
      data.setups[provider].authenticating = false;
      data.setups[provider].authOwnedByThisSession = false;
      delete data.setups[provider].authRunId;
      setupChanged();
    },
    disconnectAgent: async (provider) => {
      if (provider === 'rau') await bridge.logoutAccount();
      if (provider === 'pi') {
        data.pi.keyConfigured = false;
        data.pi.setupComplete = false;
        emit({ type: 'pi-status', status: data.pi });
      }
      Object.assign(data.setups[provider], {
        connected: false,
        authenticated: false,
        setupComplete: false,
      });
      setupChanged();
      return data.setups;
    },
    requestUsage: async (refresh) => {
      if (liveUsage) {
        data.usage = await requestLiveUsage(refresh);
        return data.usage;
      }
      await new Promise((resolve) => later(() => resolve(undefined), 120));
      if (refresh && !usageRefreshFailed && new URLSearchParams(location.search).get('quota') === 'refresh-error') {
        usageRefreshFailed = true;
        throw new Error('연결이 일시적으로 끊겼어요.');
      }
      return data.usage;
    },
    consumeCodexReset: async (_key, accountKey) => {
      if (liveUsage) {
        const result = await consumeLiveCodexReset(_key, accountKey);
        data.usage = result.usage;
        return result;
      }
      report('Codex reset requested');
      await new Promise((resolve) => later(() => resolve(undefined), 250));
      const quota = data.usage.limits!.codex;
      if (accountKey !== quota.accountKey) throw new Error('계정이 변경됐어요.');
      if (!quota.resetCredits?.availableCount) return { outcome: 'noCredit', usage: data.usage };
      quota.resetCredits.availableCount -= 1;
      quota.session.percent = 0;
      quota.week.percent = 0;
      quota.updatedAt = Date.now();
      return { outcome: 'reset', usage: data.usage };
    },
    setUsagePlan: async (provider, plan) => {
      data.usage.plans[provider] = plan;
      return data.usage;
    },
    connectCliproxy: async () => {
      data.usage.cliproxy = {
        configured: true,
        connected: true,
        url: 'https://usage.example.test',
        error: null,
        checkedAt: Date.now(),
        accounts: [],
      };
      report('Sample usage account connected');
      return data.usage;
    },
    disconnectCliproxy: async () => {
      delete data.usage.cliproxy;
      return data.usage;
    },
    requestPiStatus: async () => data.pi,
    installPi: async () => {
      await bridge.installAgent('pi');
      emit({ type: 'pi-status', status: data.pi });
      return data.pi;
    },
    setPiKey: async () => {
      authenticate('pi');
      data.pi.keyTail = 'demo';
      return data.pi;
    },
    requestPiCatalog: async () => [
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
      { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', provider: 'anthropic' },
      { id: 'openai/gpt-5.2', name: 'GPT-5.2', provider: 'openai' },
      { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro', provider: 'google' },
      { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', provider: 'deepseek' },
    ].map((model) => ({
      ...model,
      contextLength: 200000,
      pricing: { prompt: 0.000003, completion: 0.000015 },
      reasoning: true,
      supportsImages: true,
    })),
    setPiModels: async (models) => {
      data.pi.models = models.map((model) => ({
        ...model,
        defaultEffort: model.defaultEffort ?? 'medium',
        reasoning: true,
        supportsImages: true,
        efforts: ['low', 'medium', 'high'],
        contextLength: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
      }));
      data.pi.defaultModelId = models[0]?.id ?? null;
      setPiModels(data.pi.models);
      emit({ type: 'pi-status', status: data.pi });
      return data.pi;
    },
    startChat: (
      provider,
      model,
      effort,
      force,
      profile,
      mode,
      id,
      documentId,
      documentName,
    ) => {
      const continuing = !force && id === threadId && (mode ?? 'direct') === workflow.workflow;
      const startGeneration = ++generation;
      completeQuestion({ status: 'expired', reason: 'request-invalidated' });
      setRunning(false);
      agent = provider;
      threadId = id ?? threadId;
      permission = profile ?? permission;
      workflow = continuing ? workflow : {
        workflow: mode ?? 'direct',
        phase:
          mode === 'plan'
            ? 'planning'
            : mode === 'question'
              ? 'questioning'
              : 'direct',
        capabilityEpoch: 1,
        latestPlan: null,
      };
      const started: T.SidebarEvent = {
        type: 'chat-started',
        agent,
        sessionId: 'preview-session',
        model: model ?? defaultModelForAgent(agent),
        effort,
        permissionProfile: permission,
        serviceTier: tier,
        threadId,
        documentId,
        documentName,
        ...workflow,
      };
      later(() => {
        if (generation === startGeneration) emit(started);
      });
    },
    stopChat: () => {
      generation++;
      completeQuestion({ status: 'cancelled', reason: 'user-stop' });
      setRunning(false);
      emit({ type: 'chat-stopped' });
    },
    requestTitle: (id, preview) =>
      request((requestId) =>
        emit({
          type: 'title-result',
          requestId,
          threadId: id,
          title: preview.slice(0, 32),
        }),
      ),
    requestCheckpointTitle: async () => null,
    sendUserMessage: async (_text, _skill, referenceIds = []) => {
      const messageId = crypto.randomUUID();
      const turnGeneration = ++generation;
      const reply =
        scenario === 'chat' && workflow.workflow !== 'direct'
          ? workflow.workflow
          : scenario;
      later(() => {
        if (generation !== turnGeneration) return;
        setRunning(true);
        stream({ type: 'turn-start', agent, turnId: `turn-${turnGeneration}` });
        if (referenceIds.length)
          emit({
            type: 'reference-status',
            messageId,
            attachments: referenceIds.map((stageId) => {
              const file = staged.get(stageId)!;
              const reference: T.ReferenceFile = {
                ...file,
                id: stageId,
                kind: file.mimeType.startsWith('image/') ? 'image' : 'document',
                chunkCount: 3,
              };
              references.push(reference);
              staged.delete(stageId);
              return { stageId, status: 'ready', file: reference };
            }),
          });
        if (reply === 'question') {
          question = {
            interactionId: crypto.randomUUID(),
            providerRequestId: 'preview-request',
            threadId,
            turnId: `turn-${turnGeneration}`,
            agent,
            source: 'native',
            createdAt: timestamp,
            updatedAt: timestamp,
            questions: [
              {
                id: 'tone',
                header: '문체',
                question: '어떤 문체로 다듬을까요?',
                mode: 'single',
                allowOther: true,
                options: [
                  {
                    id: 'formal',
                    label: '공식적인 문체',
                    description: '제안서와 보고서에 적합합니다.',
                  },
                  {
                    id: 'friendly',
                    label: '친근한 문체',
                    description: '쉽고 자연스럽게 전달합니다.',
                  },
                ],
              },
            ],
          };
          emit({ type: 'user-question-requested', interaction: question });
          return;
        }
        stream({
          type: 'tool-call',
          agent,
          callId: `read-${turnGeneration}`,
          tool: 'read_document',
          argsJson: '{"section":0}',
        });
        if (reply === 'tools') {
          for (const call of toolScenarioCalls()) {
            stream({ type: 'tool-call', agent, callId: `${call.id}-${turnGeneration}`, tool: call.tool, argsJson: JSON.stringify(call.args) });
          }
        }
        if (reply === 'fleet') {
          stream({
            type: 'task-start',
            agent,
            taskId: `task-${turnGeneration}`,
            title: '문장과 용어 검토',
            taskKind: 'agent',
            role: '교정',
          });
          for (const [suffix, title] of [['layout', '표 구조와 문서 서식'], ['facts', '일정과 수치 검증']]) {
            stream({ type: 'task-start', agent, taskId: `${suffix}-${turnGeneration}`, title, taskKind: 'agent' });
          }
          let frame = 0;
          const activities = ['문서의 문장 구조를 읽고 있습니다.', '반복되는 용어를 비교하고 있습니다.', '긴 문장을 나누고 표현을 정리하고 있습니다.'];
          const updateFleet = () => {
            if (generation !== turnGeneration) return;
            stream({ type: 'text-delta', agent, parentTaskId: `task-${turnGeneration}`, text: activities[frame % activities.length] + '\n' });
            stream({ type: 'task-progress', agent, taskId: `task-${turnGeneration}`, usage: { totalTokens: 2400 + frame * 120, toolUses: 3 } });
            frame += 1;
            if (holdReply) later(updateFleet, 1600);
          };
          later(updateFleet, 500);
          stream({ type: 'tool-call', agent, parentTaskId: `layout-${turnGeneration}`, callId: `layout-read-${turnGeneration}`, tool: 'read_document', argsJson: '{"section":1}' });
        }

        later(() => {
          if (generation !== turnGeneration) return;
          stream({
            type: 'tool-result',
            agent,
            callId: `read-${turnGeneration}`,
            ok: true,
            resultPreview:
              '사업 개요, 추진 일정, 기대 효과 — 3개 절을 확인했습니다.',
          });
          if (reply === 'tools') {
            // 스튜디오 실행기가 먼저 끝나고, 프로바이더의 잘린 미리보기가 뒤따른다.
            for (const call of toolScenarioCalls()) {
              if (call.result !== undefined) emit({ type: 'tool-executed', tool: call.tool.replace(/^mcp__rhwp__/, ''), args: call.args, ok: true, result: call.result });
              if (call.error) emit({ type: 'tool-executed', tool: call.tool.replace(/^mcp__rhwp__/, ''), args: call.args, ok: false, error: call.error });
            }
            for (const call of toolScenarioCalls()) {
              stream({
                type: 'tool-result',
                agent,
                callId: `${call.id}-${turnGeneration}`,
                ok: !call.error,
                resultPreview: call.error
                  ? `${call.error.code}: ${call.error.message}`
                  : JSON.stringify([{ type: 'text', text: JSON.stringify(call.result ?? {}) }]).slice(0, 2000),
              });
            }
          }
          if (reply === 'error') {
            stream({
              type: 'error',
              agent,
              message: '앗, 오류에요! 네트워크 연결을 확인하세요!',
            });
            finish('failed');
            return;
          }
          if (reply === 'plan') {
            if (workflow.latestPlan) {
              stream({ type: 'text-delta', agent, text: '현재 계획은 개요와 일정을 확인한 뒤 문서를 수정합니다. 바꾸고 싶은 점을 알려주시면 새 계획을 만들겠습니다.' });
              finish();
              return;
            }
            const plan = samplePlan();
            workflow = {
              workflow: 'plan',
              phase: 'awaiting-approval',
              capabilityEpoch: 1,
              latestPlan: plan,
            };
            emit({ type: 'plan-ready', plan, ...workflow });
            finish();
            return;
          }
          if (reply === 'fleet') {
            stream({ type: 'tool-result', agent, parentTaskId: `layout-${turnGeneration}`, callId: `layout-read-${turnGeneration}`, ok: true, resultPreview: '표 3개와 문단 12개의 서식을 확인했습니다.' });
            stream({ type: 'task-end', agent, taskId: `facts-${turnGeneration}`, status: 'failed', summary: '참조 자료에 접근할 수 없어 수치 검증을 마치지 못했습니다.' });
            stream({ type: 'task-end', agent, taskId: `layout-${turnGeneration}`, status: 'completed', summary: '표 너비와 제목 서식을 확인했습니다.' });
            stream({
              type: 'task-progress',
              agent,
              taskId: `task-${turnGeneration}`,
              activity: '용어와 문장 길이를 검토했습니다.',
              usage: { totalTokens: 2400, toolUses: 3 },
            });
            if (!holdReply) stream({
              type: 'task-end',
              agent,
              taskId: `task-${turnGeneration}`,
              status: 'completed',
              summary: '용어를 통일하고 긴 문장을 정리했습니다.',
            });
          }
          const chunks = [
            '문서를 검토했습니다.\n\n',
            '**핵심 제안**을 첫 문단에 배치하고, ',
            '실행 일정을 간결하게 정리하면 전달력이 좋아집니다.\n\n',
            '1. 사업의 목적과 기대 효과를 명확히 작성합니다.\n',
            '2. 단계별 일정과 담당자를 확인합니다.\n\n',
            '필요한 부분을 선택해 주시면 이어서 다듬겠습니다.',
          ];
          if (reply === 'rich') chunks.splice(chunks.length - 1, 0,
            '\n\n## 실행 계획\n\n| 단계 | 담당 | 일정 |\n| --- | --- | --- |\n| 초안 검토 | 기획팀 | 9월 10일 |\n| 예산 승인 | 운영팀 | 9월 15일 |\n\n',
            '> 승인 전에는 원본 문서를 보존하고 변경 사항을 검토합니다.\n\n',
            '```json\n{ "status": "review", "sections": 3 }\n```\n\n',
            '[브랜드 가이드](#preview-reference)를 참고해 **용어**와 *문체*를 통일했습니다.\n\n');
          chunks.forEach((text, index) =>
            later(() => {
              if (generation !== turnGeneration) return;
              stream({ type: 'text-delta', agent, text });
              if (index === chunks.length - 1) {
                if (reply === 'review') addReview();
                if (!holdReply) finish();
              }
            }, index * 140),
          );
        }, 650);
      });
      return messageId;
    },
    listTemplates: async () => data.templates,
    addTemplate: async (file, name) => {
      const template: T.DocumentTemplate = {
        ...data.templates.templates[0],
        id: crypto.randomUUID(),
        name: name ?? file.name.replace(/\.[^.]+$/, ''),
        originalName: file.name,
        format: file.name.endsWith('.hwp') ? 'hwp' : 'hwpx',
        size: file.size,
        pageCount: 1,
        sectionCount: 1,
        contentHash: 'preview',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.templates.templates.push(template);
      templateChanged();
      return template;
    },
    renameTemplate: async (id, name) => {
      const template = data.templates.templates.find((item) => item.id === id)!;
      template.name = name;
      templateChanged();
      return template;
    },
    replaceTemplate: async (id, file) => {
      const template = data.templates.templates.find((item) => item.id === id)!;
      Object.assign(template, {
        originalName: file.name,
        size: file.size,
        revision: template.revision + 1,
      });
      templateChanged();
      return template;
    },
    deleteTemplate: async (id) => {
      data.templates.templates = data.templates.templates.filter(
        (item) => item.id !== id,
      );
      if (activeTemplate?.id === id) bridge.setActiveTemplate(null);
      templateChanged();
    },
    setActiveTemplate: (id) => {
      activeTemplate =
        data.templates.templates.find((item) => item.id === id) ?? null;
      emit({ type: 'chat-template-changed', template: activeTemplate });
    },
    getActiveTemplate: () => activeTemplate,
    stageReference: async (scopeId, file) => {
      const reference: T.StagedReference = {
        id: crypto.randomUUID(),
        scope: 'chat',
        scopeId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        status: 'ready',
        createdAt: timestamp,
        expiresAt: '2099-01-01T00:00:00Z',
      };
      staged.set(reference.id, reference);
      return reference;
    },
    discardStagedReference: async (_scopeId, id) => {
      staged.delete(id);
    },
    uploadReference: async (scope, scopeId, file) => {
      const reference: T.ReferenceFile = {
        id: crypto.randomUUID(),
        scope,
        scopeId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        status: 'ready',
        createdAt: timestamp,
        kind: file.type.startsWith('image/') ? 'image' : 'document',
        chunkCount: 3,
      };
      references.push(reference);
      return reference;
    },
    listReferences: async (scope, scopeId) =>
      references.filter(
        (file) =>
          file.scope === scope &&
          (scope === 'global' || file.scopeId === scopeId),
      ),
    downloadReference: async (file) => {
      const reference = references.find((item) =>
        item.id === file.id && item.scope === file.scope && item.scopeId === file.scopeId,
      );
      if (!reference) throw new Error('미리보기 참고자료를 찾을 수 없습니다.');
      return new TextEncoder().encode(`${reference.name}의 샘플 참고자료입니다.`);
    },
    searchReferences: async (query, scope, scopeId) =>
      references
        .filter(
          (file) =>
            file.scope === scope &&
            (scope === 'global' || file.scopeId === scopeId) &&
            file.name.toLowerCase().includes(query.toLowerCase()),
        )
        .map((file) => ({
          referenceId: file.id,
          name: file.name,
          scope,
          scopeId,
          score: 1,
          snippet: `${file.name}의 샘플 참고자료입니다.`,
          page: 1,
        })),
    deleteReference: async (file) => {
      const index = references.findIndex((item) => item.id === file.id);
      if (index >= 0) references.splice(index, 1);
    },
    setWorkflow: (mode) => {
      workflow = {
        workflow: mode,
        phase:
          mode === 'plan'
            ? 'planning'
            : mode === 'question'
              ? 'questioning'
              : 'direct',
        capabilityEpoch: 1,
        latestPlan: null,
      };
      emit({ type: 'workflow-changed', ...workflow });
    },
    approvePlan: (planId) => {
      if (connection !== 'connected' || workflow.latestPlan?.planId !== planId)
        return false;
      const planGeneration = ++generation;
      later(() => {
        if (generation !== planGeneration) return;
        workflow.phase = 'switching';
        emit({ type: 'plan-approved', planId, ...workflow });
        later(() => {
          if (generation !== planGeneration) return;
          workflow.phase = 'implementing';
          updatePlanExecution({
            status: 'running',
            steps: workflow.latestPlan!.steps.map((step) => ({ stepId: step.id!, status: 'pending' })),
          });
          emit({ type: 'implementation-started', planId, ...workflow });
          setRunning(true);
          stream({ type: 'turn-start', agent });
          later(() => {
            if (generation !== planGeneration) return;
            updatePlanExecution({ status: 'running', steps: [
              { stepId: workflow.latestPlan!.steps[0].id!, status: 'in-progress' },
              ...workflow.latestPlan!.steps.slice(1).map((step) => ({ stepId: step.id!, status: 'pending' as const })),
            ] });
            later(() => {
              if (generation !== planGeneration) return;
              updatePlanExecution({ status: 'running', steps: [
                { stepId: workflow.latestPlan!.steps[0].id!, status: 'completed' },
                ...workflow.latestPlan!.steps.slice(1).map((step) => ({ stepId: step.id!, status: 'in-progress' as const })),
              ] });
            }, 350);
          }, 350);
          later(() => {
            if (generation !== planGeneration) return;
            stream({
              type: 'text-delta',
              agent,
              text: '계획에 따라 개요와 추진 일정을 정리했습니다.',
            });
            updatePlanExecution({ status: 'awaiting-review', steps: workflow.latestPlan!.steps.map((step) => ({ stepId: step.id!, status: 'completed' })) });
            addReview();
            finish();
          }, 1700);
        }, 200);
      });
      return true;
    },
    requestPlanChanges: (planId, feedback) => {
      if (connection !== 'connected' || workflow.latestPlan?.planId !== planId)
        return false;
      const previous = workflow.latestPlan;
      const planGeneration = ++generation;
      later(() => {
        if (generation !== planGeneration) return;
        workflow.phase = 'planning';
        emit({ type: 'workflow-changed', ...workflow });
        setRunning(true);
        stream({ type: 'turn-start', agent, turnId: `revision-${planGeneration}` });
        stream({ type: 'text-delta', agent, text: `피드백을 확인했습니다: ${feedback?.trim() || '계획을 다시 검토합니다.'}` });
        later(() => {
          if (generation !== planGeneration) return;
          const plan = samplePlan((previous.revision ?? 1) + 1, previous.planId);
          workflow = { ...workflow, phase: 'awaiting-approval', latestPlan: plan, capabilityEpoch: workflow.capabilityEpoch! + 1 };
          emit({ type: 'plan-ready', plan, ...workflow });
          finish();
        }, 300);
      });
      return true;
    },
    setPermissionProfile: (profile) => {
      permission = profile;
      emit({ type: 'permission-changed', permissionProfile: profile });
    },
    setServiceTier: (serviceTier) => {
      tier = serviceTier;
      emit({ type: 'service-tier-changed', serviceTier });
    },
    listSkills: () =>
      later(() => emit({ type: 'skills-catalog', catalog: data.skills })),
    listHarnessSkills: () =>
      request((requestId) =>
        emit({
          type: 'harness-list-result',
          requestId,
          rows: [
            {
              harness: 'claude',
              name: 'meeting-notes',
              description: '회의 메모를 실행 항목으로 정리합니다.',
            },
          ],
        }),
      ),
    readSkillEditor: async (name: string) => {
      const row = data.skills.rows.find((item) => item.name === name);
      if (!row || row.kind !== 'skill' || row.editable !== true)
        throw new Error('This skill is read-only.');
      const body = skillBodies.get(name) ?? `# ${name}\n\n${row.description}\n`;
      return { name, body, digest: row.digest };
    },
    saveSkillEditor: async (name: string, body: string, base: string) => {
      const row = data.skills.rows.find((item) => item.name === name);
      if (!row || row.kind !== 'skill' || row.editable !== true)
        return { ok: false, code: 'read-only', message: 'This skill is read-only.', digest: row?.digest ?? null };
      if (row.digest !== base)
        return { ok: false, code: 'conflict', message: 'Skill changed. Reopen and try again.', digest: row.digest };
      // The failure sentinel makes async error handling testable without adding
      // a second preview-only control to the production UI.
      if (body.includes('__FAIL_SAVE__'))
        return { ok: false, code: 'preview-failure', message: 'Preview save failed.', digest: row.digest };
      const unchanged = body === skillBodies.get(name);
      const digest = `${name}:${body}`.split('').reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0), 2166136261).toString(16).padStart(64, '0');
      skillBodies.set(name, body);
      row.digest = digest;
      skillsChanged();
      return { ok: true, name, digest, unchanged, notice: null };
    },
    commitSkill: (change) =>
      request((requestId) => {
        let outcome: T.SkillCommitOutcome = {
          ok: true,
          name: change.name,
          digest: 'a'.repeat(64),
          unchanged: false,
          notice: null,
        };
        if (change.action === 'create') {
          const exists = data.skills.rows.some((item) => item.name === change.name);
          if (exists) {
            outcome = {
              ok: false,
              code: 'exists',
              message: '같은 이름의 스킬이 이미 있습니다.',
              digest: data.skills.rows.find((item) => item.name === change.name)?.digest ?? null,
            };
          } else {
            const digest = `${change.name}:${change.description}:${change.body}`
              .split('')
              .reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0), 2166136261)
              .toString(16)
              .padStart(64, '0');
            data.skills.rows.unshift({
              kind: 'skill',
              name: change.name,
              description: change.description,
              origin: 'user',
              icon: change.icon ?? 'pencil',
              enabled: true,
              digest,
              editable: true,
            });
            skillBodies.set(change.name, change.body);
            outcome = { ok: true, name: change.name, digest, unchanged: false, notice: null };
          }
        } else if (change.action === 'icon') {
          const row = data.skills.rows.find((item) => item.name === change.name);
          if (!row || row.kind !== 'skill' || row.editable !== true) {
            outcome = { ok: false, code: 'read-only', message: 'This skill is read-only.', digest: row?.digest ?? null };
          } else if (row.digest !== change.base) {
            outcome = { ok: false, code: 'STALE', message: 'Skill changed. Reopen and try again.', digest: row.digest };
          } else {
            const digest = `${change.name}:${change.icon}`
              .split('')
              .reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0), 2166136261)
              .toString(16)
              .padStart(64, '0');
            row.icon = change.icon;
            row.digest = digest;
            outcome = { ok: true, name: change.name, digest, unchanged: false, notice: null };
          }
        } else if (change.action === 'enable') {
          const row = data.skills.rows.find(
            (item) => item.name === change.name && item.kind === 'skill',
          );
          if (row && row.kind === 'skill') row.enabled = change.enabled;
        } else if (change.action === 'delete') {
          const row = data.skills.rows.find((item) => item.name === change.name);
          if (row) skillTrash.set(change.name, row);
          data.skills.rows = data.skills.rows.filter(
            (item) => item.name !== change.name,
          );
        } else if (change.action === 'restore') {
          const row = skillTrash.get(change.name);
          if (row && !data.skills.rows.some((item) => item.name === change.name)) {
            data.skills.rows.push(row);
            data.skills.rows.sort((left, right) => left.name.localeCompare(right.name));
            skillTrash.delete(change.name);
          }
        } else if (change.action === 'import') {
          if (!data.skills.rows.some((item) => item.name === change.name)) {
            data.skills.rows.unshift({
              kind: 'skill',
              name: change.name,
              description: '가져온 스킬',
              origin: 'user',
              icon: 'system',
              enabled: true,
              digest: 'a'.repeat(64),
            });
          }
        }
        emit({ type: 'skill-commit-result', requestId, outcome });
        if (outcome.ok) skillsChanged();
      }),
    requestWritingStyleStatus: () =>
      request((requestId) =>
        emit({ type: 'writing-style-status', requestId, status: data.writing }),
      ),
    requestAgentInstructions: async () => data.instructions,
    saveAgentInstructions: async (content, expectedRevision) => {
      if (expectedRevision !== data.instructions.revision)
        throw new Error('Instructions changed. Reopen and try again.');
      Object.assign(data.instructions, {
        content,
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
      });
      emit({
        type: 'agent-instructions',
        status: data.instructions,
        changedBy: 'preview',
      });
      return data.instructions;
    },
    confirmAgentInstructionsDraft: (draft) =>
      bridge.saveAgentInstructions(draft.content, draft.expectedRevision),
    rejectAgentInstructionsDraft: async (draft) => {
      emit({
        type: 'agent-instructions-draft-cleared',
        draftId: draft.id,
        outcome: 'rejected',
      });
      return true;
    },
    requestWritingStyleCatalog: async () => data.writingCatalog,
    calibrateWritingStyle: (input) =>
      request((requestId) => {
        emit({
          type: 'writing-style-progress',
          requestId,
          state: 'analyzing',
          completed: 0,
          total: input.files.length,
        });
        later(() => {
          Object.assign(data.writing, {
            active: true,
            language: input.language,
            agent: input.agent,
            model: input.model,
            updatedAt: timestamp,
            sourceCount:
              (input.append ? data.writing.sourceCount : 0) +
              input.files.length,
            pageEstimate: input.files.length * 3,
            summary: input.language === 'en'
              ? 'You explain the point plainly, then add context where the reader needs it. The tone is calm and direct.'
              : '요점을 먼저 전하고, 독자가 궁금해할 부분을 차근차근 풀어 쓰는 편이에요. 차분하고 담백한 말투예요.',
            sources: input.files.map((file) => ({
              name: file.name,
              size: file.size,
              addedAt: timestamp,
            })),
          });
          emit({
            type: 'writing-style-result',
            requestId,
            status: data.writing,
          });
        }, 700);
      }),
    setWritingStyleInstruction: (instruction) => {
      data.writing.additionalInstruction = instruction;
      return writingResult();
    },
    answerUserQuestion: (interactionId, answers) =>
      request((responseId) => {
        emit({
          type: 'user-question-answer-result',
          interactionId,
          responseId,
          ok: true,
        });
        completeQuestion({ status: 'answered', answers });
        stream({
          type: 'text-delta',
          agent,
          text: '선택한 문체에 맞춰 문서를 다듬겠습니다.',
        });
        finish();
      }),
    interruptIfIdle: () => {
      if (!running) return false;
      bridge.interrupt();
      return true;
    },
    interrupt: () => {
      generation++;
      completeQuestion({ status: 'cancelled', reason: 'user-stop' });
      if (running) finish('interrupted');
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      generation++;
      timers.forEach(clearTimeout);
      timers.clear();
      listeners.clear();
      pendingListeners.clear();
      leaseListeners.clear();
    },
  };
  function setConnection(state: typeof connection) {
    if (state !== 'connected') {
      generation++;
      completeQuestion({ status: 'expired', reason: 'provider-disconnected' });
      if (running) finish('failed');
    }
    connection = state;
    emit({
      type: 'connection',
      state,
      attempt: state === 'disconnected' ? 4 : 0,
    });
  }
  function addReview() {
    const range = (paragraph: number): T.DocRange => ({
      sectionIdx: 0, startParaIdx: paragraph, startCharOffset: 0,
      endParaIdx: paragraph, endCharOffset: 23,
    });
    const ops: T.PendingOp[] = fullReview ? [
      {
        kind: 'replace', id: crypto.randomUUID(), agent, range: range(0),
        deletedText: '이번 사업은 업무 효율을 높이는 것을 목표로 합니다.',
        text: '이번 사업은 지역 소상공인의 주문과 예약 업무를 줄이는 것을 목표로 합니다.',
        charShapeId: null, paraShapeIds: [], snapshotId: null,
      },
      { kind: 'insert', id: crypto.randomUUID(), agent, range: range(2),
        text: '현장 인터뷰 결과를 실행 계획에 반영합니다.' },
      { kind: 'replace', id: crypto.randomUUID(), agent, range: range(4),
        deletedText: '시범 운영은 3월 첫째 주에 시작합니다.', text: '',
        charShapeId: null, paraShapeIds: [], snapshotId: null },
    ] : [
      { kind: 'insert', id: crypto.randomUUID(), agent, range: range(0),
        text: '이번 사업은 업무 효율을 높이는 것을 목표로 합니다.' },
    ];
    changes = [
      {
        id: crypto.randomUUID(),
        agent,
        status: 'awaiting-review',
        createdAt: Date.now(),
        ops,
        ...(reviewMode === 'stopped' ? { turnStopped: true } : {}),
      },
    ];
    changeEvents.push('set-finalized');
    pendingListeners.forEach((listener) =>
      listener({ type: 'set-finalized', changeSetId: changes[0].id }),
    );
    if (permission === 'unrestricted' && reviewMode !== 'stopped') bridge.pendingEdits.approve(changes[0].id);
  }
  function setServices(configured: boolean) {
    for (const provider of agents) {
      Object.assign(data.setups[provider], {
        available: configured,
        installed: configured,
        connected: configured,
        authenticated: configured,
        setupComplete: configured,
      });
      data.providers[provider].available = configured;
    }
    Object.assign(data.pi, {
      installed: configured,
      keyConfigured: configured,
      setupComplete: configured,
    });
    emit({ type: 'pi-status', status: data.pi });
    emit({ type: 'provider-status', providers: data.providers });
    setupChanged();
  }
  return {
    bridge,
    setConnection,
    setServices,
    setBrowserbaseState: (value: BrowserbaseFixtureState) => {
      browserbaseState = value;
      browserbase = createBrowserbaseFixture(value);
      emit({ type: 'browserbase-status', status: structuredClone(browserbase) });
      if (value === 'error') {
        emit({ type: 'browserbase-error', requestId: 'preview-browserbase-state', code: 'preview-unavailable', message: '미리보기 원격 브라우저 연결을 확인하지 못했어요.' });
      }
    },
    setScenario: (value: Scenario) => {
      scenario = value;
    },
    setHold: (value: boolean) => { holdReply = value; },
    boot: () => {
      setPiModels(data.pi.models);
      emit({ type: 'pi-status', status: data.pi });
      emit({ type: 'provider-status', providers: data.providers });
      setupChanged();
      emit({ type: 'usage-report', usage: data.usage });
      bridge.listSkills();
    },
    snapshot: () => ({
      scenario,
      connection,
      running,
      workflow,
      pendingChanges: changes.length,
      changeEvents: [...changeEvents],
      references: references.length,
      account: data.account.state,
      browserbase: browserbaseState,
    }),
  };
}
