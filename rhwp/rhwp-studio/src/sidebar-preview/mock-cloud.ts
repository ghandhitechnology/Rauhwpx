import { createCloudController, type CloudDesktopApi } from '../cloud/desktop-cloud.ts';
import type { CloudLinkKind, CloudSessionScope, CloudSnapshot, CloudTransferRequest, CloudCheckpointPayload } from '../cloud/types.ts';
import type { AgentStreamEvent } from '../agent/types.ts';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Local failure fixtures that exercise the production IPC adapter and sidebar. */
export function createMockCloud() {
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
  const calls = { merges, downloads: 0, reconnect: 0, recreate: 0, stop: 0, display: 0, inputs: 0, transfers: [] as CloudTransferRequest[] };
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
      scope = next;
      if (refreshBlocked) await new Promise<void>((resolve) => { releaseRefresh = resolve; });
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
      calls.transfers.push(structuredClone(request));
      state.timeline = structuredClone(request.timeline);
      state.session = { kind: 'running', sessionId: `preview-session-${++sessionNumber}`, version: 1,
        threadId: request.threadId, documentId: request.documentId, documentName: request.documentName,
        startedAt: new Date().toISOString(), turn: 0, turnLimit: 100, elapsedMs: 0, timeLimitMs: 3600000,
        currentActivity: '문서 검토 중', phase: 'waiting', wait: null };
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
    cloudCommand: async () => snapshot(),
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
    getScope: () => scope,
    blockRefresh(blocked: boolean) {
      refreshBlocked = blocked;
      if (!blocked) { releaseRefresh?.(); releaseRefresh = null; }
    },
    publish,
  };
}
