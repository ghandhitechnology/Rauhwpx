import { createCloudController, type CloudDesktopApi } from '../cloud/desktop-cloud.ts';
import type { CloudSessionState, CloudLinkKind, CloudSessionScope, CloudSnapshot, CloudTransferRequest, CloudCheckpointPayload, CloudCommandRequest } from '../cloud/types.ts';
import type { AgentStreamEvent } from '../agent/types.ts';
import { recordCloudUsage } from '../cloud/usage-history.ts';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Local failure fixtures that exercise the production IPC adapter and sidebar. */
export function createMockCloud(options: { dashboard?: boolean } = {}) {
  let listener: ((event: unknown) => void) | null = null;
  let displayListener: ((event: unknown) => void) | null = null;
  let scope: CloudSessionScope = { threadId: '', documentId: null };
  let sessionNumber = 0;
  let recoveryGeneration = 0;
  let releaseRefresh: (() => void) | null = null;
  let refreshBlocked = false;
  let sequence = 0;
  const checkpoints = new Map<string, CloudCheckpointPayload>();
  const merges: Array<{ startId: string; checkpoint: CloudCheckpointPayload }> = [];
  const calls = { commands: [] as CloudCommandRequest[], merges, downloads: 0, refresh: 0, referenceReads: 0, prepareRestart: 0, reconnect: 0, recreate: 0, stop: 0, display: 0, inputs: 0, transfers: [] as CloudTransferRequest[] };
  let refreshFails = false;
  let restartArchiveAvailable = true;
  let rejectRestartTransfer = false;
  const sandbox = { providerId: 'raucloud', sandboxId: 'preview-worker', displayName: 'Raucloud',
    region: 'preview', host: 'preview.invalid', createdAt: new Date().toISOString() };
  const state: CloudSnapshot = {
    revision: 0, profileEpoch: 0, available: true,
    profile: { kind: 'configured', mode: 'app-hosted', name: 'Raucloud', sandbox,
      connection: 'ready', message: null, serviceVersion: 'preview' },
    server: { mode: 'app-hosted', preferredMode: 'app-hosted', lifecycle: 'ready', message: null,
      providers: [{ providerId: 'raucloud', displayName: 'Raucloud', configured: true, missingConfig: [] }] },
    account: { signedIn: true, account: { id: 'preview', email: 'preview@example.invalid' }, quota: null,
      raucloud: { kind: 'available' }, updatedAt: new Date().toISOString() },
    session: { kind: 'idle' }, sessions: [], lease: { owner: 'local' }, timeline: null,
    queuedMessages: [], updatedAt: new Date().toISOString(),
    link: { kind: 'ready', error: null, attempt: 0, canRecreate: true },
  };
  // Explicit preview-only observations. Production never invents usage history.
  if (options.dashboard) {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    state.profile = { kind: 'configured', mode: 'app-hosted', name: 'My Raucloud',
      sandbox: { ...sandbox, region: 'Seoul', host: 'my-workspace.raucloud.example' },
      connection: 'ready', message: null, serviceVersion: '1.1.0' };
    state.account!.account!.id = 'dashboard-preview';
    const values = [18, 32, 24, 51, 38, 62, 36];
    values.forEach((used, index) => {
      const day = new Date(today.getTime() - (6 - index) * 86_400_000);
      state.account!.updatedAt = new Date(day.getTime() + 3_600_000).toISOString();
      state.account!.quota = { usedMs: used * 60_000, remainingMs: (120 - used) * 60_000,
        dailyLimitMs: 120 * 60_000, resetAt: new Date(day.getTime() + 86_400_000).toISOString(),
        timeZone: 'UTC', debtMs: 0, graceUsedMs: 0, activeRun: null,
        coldStarts: { usedToday: 2, dailyLimit: 10, recent: 1, recentLimit: 5 } };
      recordCloudUsage(state);
    });
    const names = ['사업 제안서.hwpx', '9월 제품 기획.hwpx', '팀 회의록.hwpx', '리서치 노트.hwpx'];
    state.sessions = names.map((documentName, index) => ({ kind: 'suspended',
      sessionId: `dashboard-session-${index}`, threadId: `dashboard-chat-${index}`, documentId: `dashboard-doc-${index}`,
      documentName, version: 1, reason: '사용자가 일시 정지했습니다.', resumable: true,
      selection: { agent: index % 2 === 0 ? 'codex' : 'claude', model: index % 2 === 0 ? 'gpt-5.4' : 'claude-sonnet-4-6', effort: 'high' } }));
  }
  function snapshot(): CloudSnapshot {
    state.revision++;
    const selected = scope.selectedSessionId
      ? state.sessions.find((session) => session.sessionId === scope.selectedSessionId)
      : state.sessions.find((session) => session.threadId === scope.threadId && session.documentId === scope.documentId);
    return structuredClone({ ...state,
      session: selected ?? { kind: 'idle' },
      timeline: selected ? state.timeline : null,
    });
  }
  function publish() { listener?.({ snapshot: snapshot() }); }
  function emitAgentEvent(event: AgentStreamEvent) {
    if (state.session.kind === 'idle') return;
    listener?.({ sessionId: state.session.sessionId,
      event: { type: 'agent.event', seq: ++sequence, payload: { type: 'agent', event } } });
  }
  function setLink(kind: CloudLinkKind) {
    state.link = { kind, error: kind === 'failed' ? 'ECONNRESET from preview fixture' : null,
      attempt: kind === 'ready' ? 0 : 1, canRecreate: true };
    publish();
  }
  function idle() {
    state.profileEpoch++;
    state.session = { kind: 'idle' };
    state.sessions = [];
    state.timeline = null;
    state.lease = { owner: 'local' };
  }
  const api: CloudDesktopApi = {
    async cloudGetState(next) {
      calls.refresh++;
      scope = next;
      if (refreshBlocked) await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      if (refreshFails) throw new Error('Preview connection unavailable');
      return snapshot();
    },
    async cloudDownloadCheckpoint({ sessionId, operationId }) {
      calls.downloads++;
      const checkpoint = checkpoints.get(sessionId);
      if (!checkpoint || (operationId && checkpoint.operationId !== operationId)) throw new Error('완료된 턴이 없습니다.');
      return structuredClone(checkpoint);
    },
    cloudSetTransferIntent: async () => snapshot(),
    async cloudTransfer(request) {
      if (request.document.restartToken && rejectRestartTransfer) throw new Error('Preview restart transfer interrupted.');
      calls.transfers.push(structuredClone(request));
      state.timeline = structuredClone(request.timeline);
      state.session = { kind: 'running', sessionId: `preview-session-${++sessionNumber}`, version: 1,
        threadId: request.threadId, documentId: request.documentId, documentName: request.documentName,
        startedAt: new Date().toISOString(), turn: 0, turnLimit: 100, elapsedMs: 0, timeLimitMs: 3600000,
        currentActivity: '문서 검토 중', phase: 'waiting', wait: null,
        selection: { agent: request.timeline.thread.agent, model: request.timeline.thread.model, effort: request.timeline.thread.effort },
        configurationPending: false, configurationEditable: true };
      state.sessions = [state.session];
      scope = { threadId: request.threadId, documentId: request.documentId, selectedSessionId: state.session.sessionId };
      state.lease = { owner: 'cloud', sessionId: state.session.sessionId, threadId: request.threadId, acquiredAt: new Date().toISOString() };
      publish();
      return snapshot();
    },
    async cloudReconnectLink() {
      calls.reconnect++;
      const generation = ++recoveryGeneration;
      setLink('reconnecting');
      await wait(300);
      if (generation !== recoveryGeneration) throw new DOMException('Cancelled', 'AbortError');
      setLink('ready');
      return snapshot();
    },
    async cloudReadReference() {
      calls.referenceReads++;
      return { bytes: new Uint8Array(42800).fill(7) };
    },
    async cloudPrepareRestartDocument({ sessionId }) {
      calls.prepareRestart++;
      if (!restartArchiveAvailable) throw new Error('최신 Cloud 문서 보관본을 확인할 수 없습니다.');
      const transfer = calls.transfers.at(-1) ?? JSON.parse(sessionStorage.getItem('preview-cloud-restart-transfer') ?? 'null');
      if (!transfer) {
        throw new Error('Cloud 복구 세션을 찾을 수 없습니다.');
      }
      sessionStorage.setItem('preview-cloud-restart-transfer', JSON.stringify(transfer));
      const bytes = new TextEncoder().encode('Archived Cloud edits after the original transfer.');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return { bytes, fileName: transfer.document.fileName,
        sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        originSha256: transfer.document.originSha256 ?? null, restartToken: `preview-restart-${sessionId}` };
    },
    async cloudRecreateLink() {
      calls.recreate++;
      recoveryGeneration++;
      setLink('recreating');
      await wait(200);
      idle();
      setLink('ready');
      return snapshot();
    },
    async cloudForceQuitAccount() {
      calls.stop++;
      recoveryGeneration++;
      idle();
      setLink('ready');
      return snapshot();
    },
    cloudSpawnSandbox: async () => snapshot(),
    cloudSandboxStatus: async () => snapshot(),
    async cloudCommand(request) {
      calls.commands.push(structuredClone(request));
      if (request.command === 'configure') {
        const session = state.session;
        if (session.kind === 'idle' || request.sessionId !== session.sessionId
          || request.expectedVersion !== session.version || session.configurationEditable !== true) {
          throw new Error('Provider settings can only change between turns');
        }
        const payload = request.payload!;
        session.selection = { agent: payload.provider as import('../agent/types.ts').AgentName,
          model: String(payload.model), effort: String(payload.effort) };
        session.version++;
        publish();
      }
      return snapshot();
    },
    async cloudOpenDisplay({ sessionId }) {
      calls.display++;
      const connectionId = `display-${calls.display}`;
      const streamId = `stream-${sessionId}`;
      const capability = { kind: 'available', protocol: 'rauhwpx-frame-v1', inputProtocol: 'rauhwpx-input-v1',
        sessionId, streamId, width: 680, height: 840, maxFrameBytes: 524288, maxFps: 12, maxInputEventsPerSecond: 60 };
      const canvas = document.createElement('canvas');
      canvas.width = 680; canvas.height = 840;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 680, 840);
      ctx.fillStyle = '#26323d'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('사업 제안서', 64, 100);
      ctx.font = '16px sans-serif'; ctx.fillText('Cloud 문서 미리보기', 64, 142);
      ctx.fillStyle = '#dce3e8';
      for (let row = 0; row < 16; row++) ctx.fillRect(64, 208 + row * 28, row % 4 === 3 ? 360 : 552, 9);
      const jpeg = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg'));
      const bytes = new Uint8Array(await jpeg.arrayBuffer());
      setTimeout(() => displayListener?.({ connectionId, event: {
        kind: 'frame', sessionId, streamId, sequence: 1, capturedAt: new Date().toISOString(), width: 680, height: 840,
        mimeType: 'image/jpeg', byteLength: bytes.length, sha256: 'a'.repeat(64),
        framePath: `/v1/sessions/${sessionId}/display/frames/${streamId}/1`, bytes,
      } }), 30);
      return { connectionId, capability };
    },
    cloudCloseDisplay: async () => ({}),
    cloudDisplayInput: async () => { calls.inputs++; return {}; },
    onCloudEvent(callback) { listener = callback; return () => { listener = null; }; },
    onCloudDisplayEvent(callback) { displayListener = callback; return () => { displayListener = null; }; },
  };
  return {
    controller: createCloudController(api), calls, setLink,
    setAccount(signedIn: boolean, email: string | null) {
      state.account = signedIn
        ? { signedIn: true, account: { id: state.account?.account?.id ?? 'preview', email: email ?? 'designer@example.test' }, quota: state.account?.quota ?? null,
            raucloud: { kind: 'available' }, updatedAt: new Date().toISOString() }
        : { signedIn: false, account: null, quota: null,
            raucloud: { kind: 'logged-out' }, updatedAt: new Date().toISOString() };
      publish();
    },
    emitAgentEvent,
    finishReply(text: string) {
      if (!state.timeline) throw new Error('Start a Cloud conversation first');
      state.timeline.thread.messages.push({ role: 'assistant', text, agent: state.timeline.thread.agent });
      state.timeline.thread.updatedAt = Date.now();
      state.timeline.exportedAt = new Date().toISOString();
      emitAgentEvent({ type: 'text-delta', agent: state.timeline.thread.agent, text });
      emitAgentEvent({ type: 'turn-end', agent: state.timeline.thread.agent, stopReason: 'completed' });
      publish();
    },
    commitTurn() {
      const session = state.session;
      if (session.kind !== 'running') throw new Error('Start a Cloud conversation first');
      session.turn++;
      session.phase = 'waiting';
      const operationId = `preview-turn-${session.turn}`;
      checkpoints.set(session.sessionId, { sessionId: session.sessionId, documentId: session.documentId,
        fileName: '사업 제안서.hwpx', kind: 'turn', revision: session.turn, turn: session.turn, operationId,
        bytes: new Uint8Array([1, 2, 3]), byteLength: 3, sha256: 'a'.repeat(64) });
      state.sessions = state.sessions.map((item) => item.sessionId === session.sessionId ? session : item);
      listener?.({ sessionId: session.sessionId,
        event: { type: 'boundary.committed', payload: { kind: 'turn', operationId } } });
      publish();
    },
    setConversationPhase(phase: 'working' | 'waiting' | 'suspended') {
      const session = state.session;
      if (session.kind === 'idle') throw new Error('Start a Cloud conversation first');
      const base = { sessionId: session.sessionId, threadId: session.threadId, documentId: session.documentId,
        documentName: session.documentName, version: session.version + 1, selection: session.selection,
        configurationPending: false, configurationEditable: phase !== 'working' };
      const next: Exclude<CloudSessionState, { kind: 'idle' }> = phase === 'suspended'
        ? { ...base, kind: 'suspended', reason: '사용자가 일시 정지했습니다.', resumable: true }
        : { ...base, kind: 'running', phase, wait: null, currentActivity: '문서 검토',
            startedAt: new Date().toISOString(), turn: checkpoints.get(session.sessionId)?.turn ?? 0, turnLimit: 100, elapsedMs: 0, timeLimitMs: 3600000 };
      state.session = next;
      state.sessions = state.sessions.map((item) => item.sessionId === session.sessionId ? next : item);
      publish();
    },
    getScope: () => scope,
    requireReference(id: string | null) {
      const message = state.timeline?.thread.messages.find((item) => item.role === 'user');
      if (!message || !state.timeline) return;
      message.attachments = id ? [{ stageId: id, fileId: id, name: '브랜드 가이드.pdf', mimeType: 'application/pdf', size: 42800, status: 'ready' }] : [];
      state.timeline.exportedAt = new Date().toISOString();
      state.timeline.thread.updatedAt = Date.now();
      publish();
    },
    setRestartArchiveAvailable(available: boolean) { restartArchiveAvailable = available; },
    rejectRestartTransfer(reject: boolean) { rejectRestartTransfer = reject; },
    blockRefresh(blocked: boolean) {
      refreshBlocked = blocked;
      if (!blocked) { releaseRefresh?.(); releaseRefresh = null; }
    },
    publish,
    setRefreshFailure(failed: boolean) { refreshFails = failed; },
    setDashboardState(kind: 'logged-out' | 'exhausted' | 'self-hosted' | 'unknown' | 'unconfigured' | 'unavailable') {
      if (kind === 'logged-out') {
        state.account = { signedIn: false, account: null, quota: null, raucloud: { kind: 'logged-out' }, updatedAt: new Date().toISOString() };
        state.profile = { kind: 'unconfigured' };
        state.sessions = [];
      } else if (kind === 'exhausted' && state.account?.quota) {
        state.account.quota.usedMs = state.account.quota.dailyLimitMs;
        state.account.quota.remainingMs = 0;
        state.account.updatedAt = new Date().toISOString();
        state.account.raucloud = { kind: 'exhausted', resetAt: state.account.quota.resetAt };
      } else if (kind === 'self-hosted') {
        state.profile = { kind: 'configured', mode: 'self-hosted', connection: 'ready', message: null, serviceVersion: '1.1.0',
          profile: { name: 'My VPS', host: 'studio.example', sshUser: 'worker', sshPort: 22, auth: { kind: 'ssh-agent' }, transport: { kind: 'ssh-tunnel' } } };
        state.server.mode = 'self-hosted';
      } else if (kind === 'unknown' && state.profile.kind === 'configured') {
        state.profile.connection = 'unknown';
      } else if (kind === 'unconfigured') {
        state.profile = { kind: 'unconfigured' };
        state.sessions = [];
      } else if (kind === 'unavailable') {
        state.available = false;
        state.profile = { kind: 'unconfigured' };
        state.sessions = [];
        delete state.account;
      }
      publish();
    },
  };
}
