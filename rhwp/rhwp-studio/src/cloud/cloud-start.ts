import type { AgentName, AgentWorkflow } from '../agent/types.ts';
import type { ChatThread } from '../agent/threads.ts';
import { exportCloudTimeline, initialMessageMatchesTimeline } from './timeline.ts';
import type {
  CloudDocumentPayload,
  CloudInitialMessage,
  CloudSessionState,
  CloudSnapshot,
  CloudTransferReference,
  CloudTransferRequest,
} from './types.ts';

export const CLOUD_UNSAVED_MESSAGE = '클라우드 사용 전 문서를 저장해주세요';

export const CLOUD_SUPPORTED_FORMATS = ['hwp', 'hwpx', 'hml'] as const;
export type CloudSupportedFormat = (typeof CLOUD_SUPPORTED_FORMATS)[number];

export type CloudStartPhase =
  | 'preparing-document'
  | 'uploading'
  | 'starting'
  | 'queued'
  | 'streaming'
  | 'failed';

export type CloudStartDocumentState = {
  hasDocument: boolean;
  isNew: boolean;
  isDirty: boolean;
  format: string | null;
};

export type CloudStartDocumentResult =
  | { ok: true; format: CloudSupportedFormat }
  | { ok: false; reason: 'unsaved' | 'unsupported' | 'missing'; message: string };

export type CloudDocumentOwner = { sessionId: string; threadId: string };

export function isCloudSupportedFormat(format: string | null): format is CloudSupportedFormat {
  return format === 'hwp' || format === 'hwpx' || format === 'hml';
}

export function validateCloudStartDocument(state: CloudStartDocumentState): CloudStartDocumentResult {
  if (!state.hasDocument) {
    return { ok: false, reason: 'missing', message: '먼저 클라우드에서 작업할 문서를 여세요.' };
  }
  if (state.isNew || state.isDirty) {
    return { ok: false, reason: 'unsaved', message: CLOUD_UNSAVED_MESSAGE };
  }
  if (!isCloudSupportedFormat(state.format)) {
    return {
      ok: false,
      reason: 'unsupported',
      message: `클라우드에서 지원하지 않는 문서 형식입니다: ${state.format ?? 'unknown'}`,
    };
  }
  return { ok: true, format: state.format };
}

export function goalFromInitialMessage(text: string): string {
  return text.trim().slice(0, 64 * 1024);
}

export function cloudDocumentOwner(
  snapshot: Pick<CloudSnapshot, 'lease' | 'sessions' | 'session'>,
  documentId: string | null,
): CloudDocumentOwner | null {
  if (!documentId) return null;
  const activeSession = snapshot.session;
  const sessions = activeSession.kind === 'idle'
    ? snapshot.sessions
    : [activeSession, ...snapshot.sessions.filter((session) => session.sessionId !== activeSession.sessionId)];
  const owned = sessions.find((session) => (
    session.documentId === documentId
    && session.kind !== 'completed'
    && session.kind !== 'failed'
    && session.kind !== 'cancelled'
  ));
  if (owned) return { sessionId: owned.sessionId, threadId: owned.threadId };
  const lease = snapshot.lease;
  if (lease.owner === 'cloud') {
    const leased = sessions.find((session) => session.sessionId === lease.sessionId);
    if (leased?.documentId === documentId) {
      return { sessionId: leased.sessionId, threadId: leased.threadId };
    }
  }
  return null;
}

export function cloudStartPhaseFromSession(session: CloudSessionState): CloudStartPhase | null {
  switch (session.kind) {
    case 'transferring':
      return session.stage === 'uploading' || session.stage === 'committing'
        ? 'uploading'
        : session.stage === 'starting' ? 'starting' : 'preparing-document';
    case 'queued':
    case 'waiting-local-turn':
      return 'queued';
    case 'running':
      return 'streaming';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

export function cloudStartPhaseLabel(phase: CloudStartPhase): string {
  switch (phase) {
    case 'preparing-document': return '문서를 준비하는 중';
    case 'uploading': return 'Cloud로 올리는 중';
    case 'starting': return 'Cloud를 시작하는 중';
    case 'queued': return '메시지 대기 중';
    case 'streaming': return '응답을 받는 중';
    case 'failed': return 'Cloud를 시작하지 못했습니다';
  }
}

export function buildCloudStartTransfer(input: {
  startId: string;
  thread: ChatThread;
  initialMessage: CloudInitialMessage;
  document: CloudDocumentPayload;
  references: CloudTransferReference[];
  agent: AgentName;
  model: string;
  effort: string;
  workflow: AgentWorkflow;
}): CloudTransferRequest {
  const timeline = exportCloudTimeline(input.thread);
  if (!initialMessageMatchesTimeline(timeline, input.initialMessage.id)) {
    throw new Error('첫 메시지가 대화에 한 번만 기록되지 않았습니다.');
  }
  if (goalFromInitialMessage(input.initialMessage.text) !== goalFromInitialMessage(
    timeline.thread.messages.find((message) => message.messageId === input.initialMessage.id)?.text ?? '',
  )) {
    throw new Error('첫 메시지와 Cloud 목표가 일치하지 않습니다.');
  }
  return {
    startId: input.startId,
    threadId: input.thread.id,
    documentId: input.thread.documentId,
    documentName: input.document.fileName,
    agent: input.agent,
    model: input.model,
    effort: input.effort,
    workflow: input.workflow,
    permissionProfile: 'unrestricted',
    timeline,
    initialMessage: input.initialMessage,
    document: input.document,
    references: input.references,
    limits: {
      maxDurationMs: 8 * 60 * 60 * 1000,
      maxTurns: 100,
    },
  };
}
