import type { CloudController } from '../cloud/desktop-cloud.ts';
import { decodedCloudDisplayFrameMatches } from '../cloud/display.ts';
import type { CloudWorkspace, CloudDisplayState } from '../cloud/workspace.ts';
import type {
  CloudDisplayEvent,
  CloudDisplayFrame,
  CloudSessionState,
} from '../cloud/types.ts';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;

type ObjectUrls = {
  create(blob: Blob): string;
  revoke(url: string): void;
};

type FrameDecoder = (url: string) => Promise<{ width: number; height: number }>;

type DecodeCandidate = {
  generation: number;
  sessionId: string;
  frame: CloudDisplayFrame;
  url: string;
  cancelled: boolean;
  revoked: boolean;
};

function displaySessionId(session: CloudSessionState): string | null {
  return session.kind === 'running' ? session.sessionId : null;
}

function sessionId(session: CloudSessionState): string | null {
  return session.kind === 'idle' ? null : session.sessionId;
}

function terminalSessionId(session: CloudSessionState): string | null {
  return session.kind === 'completed' || session.kind === 'failed' || session.kind === 'cancelled'
    ? session.sessionId
    : null;
}

function unavailableStatus(event: Extract<CloudDisplayEvent, { kind: 'unavailable' }>): string {
  switch (event.reason) {
    case 'server-unsupported': return '이 Cloud 서버는 화면 미리보기를 지원하지 않습니다.';
    case 'client-unsupported': return '이 앱 버전은 Cloud 화면 미리보기를 지원하지 않습니다.';
    case 'stream-unavailable': return event.retryable
      ? 'Cloud 화면을 준비하는 중입니다.'
      : 'Cloud 화면을 사용할 수 없습니다.';
    default: return 'Cloud 작업 화면이 아직 시작되지 않았습니다.';
  }
}

export function createCloudWorkspace({
  display,
  doc = document,
  objectUrls = {
    create: (blob: Blob) => URL.createObjectURL(blob),
    revoke: (url: string) => URL.revokeObjectURL(url),
  },
  decodeFrame,
}: {
  display: Pick<CloudController, 'openDisplay'>;
  doc?: Document;
  objectUrls?: ObjectUrls;
  decodeFrame?: FrameDecoder;
}): CloudWorkspace {
  const root = doc.createElement('section');
  root.id = 'cloud-workspace';
  root.setAttribute('aria-label', 'Cloud 문서 화면');

  const toolbar = doc.createElement('div');
  toolbar.className = 'cloud-workspace-toolbar';
  const status = doc.createElement('div');
  status.className = 'cloud-workspace-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const controls = doc.createElement('div');
  controls.className = 'cloud-workspace-zoom';
  const zoomOut = doc.createElement('button');
  zoomOut.type = 'button';
  zoomOut.dataset.cloudZoom = 'out';
  zoomOut.setAttribute('aria-label', 'Cloud 화면 축소');
  zoomOut.textContent = '−';
  const zoomReset = doc.createElement('button');
  zoomReset.type = 'button';
  zoomReset.dataset.cloudZoom = 'reset';
  zoomReset.setAttribute('aria-label', 'Cloud 화면 배율 초기화');
  const zoomIn = doc.createElement('button');
  zoomIn.type = 'button';
  zoomIn.dataset.cloudZoom = 'in';
  zoomIn.setAttribute('aria-label', 'Cloud 화면 확대');
  zoomIn.textContent = '+';
  controls.append(zoomOut, zoomReset, zoomIn);
  toolbar.append(status, controls);

  const viewport = doc.createElement('div');
  viewport.className = 'cloud-workspace-viewport';
  const canvas = doc.createElement('div');
  canvas.className = 'cloud-workspace-canvas';
  const image = doc.createElement('img');
  image.className = 'cloud-workspace-image';
  image.alt = 'Cloud 문서 화면 미리보기';
  image.draggable = false;
  canvas.appendChild(image);
  viewport.appendChild(canvas);
  root.append(toolbar, viewport);

  const decode = decodeFrame ?? (async (url: string) => {
    const candidate = doc.createElement('img');
    candidate.src = url;
    if (typeof candidate.decode === 'function') {
      await candidate.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        candidate.addEventListener('load', () => resolve(), { once: true });
        candidate.addEventListener('error', () => reject(new Error('Cloud frame decode failed')), { once: true });
      });
    }
    return { width: candidate.naturalWidth, height: candidate.naturalHeight };
  });

  let state: CloudDisplayState = {
    kind: 'unavailable',
    reason: 'session-not-running',
    message: '선택된 Cloud 작업이 없습니다.',
  };
  let lastFrame: CloudDisplayFrame | null = null;
  let frameUrl: string | null = null;
  let connection: Awaited<ReturnType<CloudController['openDisplay']>> | null = null;
  let visible = false;
  let contextSessionId: string | null = null;
  let currentSessionId: string | null = null;
  let openingSessionId: string | null = null;
  let generation = 0;
  let activeDecode: DecodeCandidate | null = null;
  let pendingDecode: DecodeCandidate | null = null;
  let disposed = false;
  let zoom = 1;
  const listeners = new Set<(value: CloudDisplayState) => void>();

  const renderZoom = (): void => {
    root.dataset.zoom = String(zoom);
    zoomReset.textContent = `${Math.round(zoom * 100)}%`;
    if (lastFrame) {
      canvas.style.width = `${Math.round(lastFrame.width * zoom)}px`;
      canvas.style.height = `${Math.round(lastFrame.height * zoom)}px`;
    }
    zoomOut.disabled = zoom <= MIN_ZOOM;
    zoomIn.disabled = zoom >= MAX_ZOOM;
  };

  const publish = (next: CloudDisplayState, text: string): void => {
    state = next;
    root.dataset.displayState = next.kind;
    status.textContent = text;
    for (const listener of listeners) listener(next);
  };

  const retainedFrame = (sessionId: string): CloudDisplayFrame | null =>
    lastFrame?.sessionId === sessionId ? lastFrame : null;

  const revokeCandidate = (candidate: DecodeCandidate): void => {
    if (candidate.revoked) return;
    candidate.revoked = true;
    objectUrls.revoke(candidate.url);
  };

  const cancelDecodes = (): void => {
    if (activeDecode) {
      activeDecode.cancelled = true;
      revokeCandidate(activeDecode);
    }
    if (pendingDecode) {
      pendingDecode.cancelled = true;
      revokeCandidate(pendingDecode);
      pendingDecode = null;
    }
  };

  const closeConnection = (): void => {
    const active = connection;
    connection = null;
    currentSessionId = null;
    if (active) void active.close().catch(() => {});
  };

  const clearFrame = (): void => {
    cancelDecodes();
    lastFrame = null;
    if (frameUrl) objectUrls.revoke(frameUrl);
    frameUrl = null;
    image.removeAttribute('src');
    canvas.style.width = '';
    canvas.style.height = '';
  };

  const candidateIsCurrent = (candidate: DecodeCandidate): boolean =>
    !candidate.cancelled && !disposed && visible && candidate.generation === generation
    && openingSessionId === candidate.sessionId && contextSessionId === candidate.sessionId
    && candidate.frame.sessionId === candidate.sessionId;

  const finishDecode = (
    candidate: DecodeCandidate,
    dimensions: { width: number; height: number } | null,
    decodeError: unknown,
  ): void => {
    if (activeDecode !== candidate) {
      revokeCandidate(candidate);
      return;
    }
    activeDecode = null;
    const next = pendingDecode;
    pendingDecode = null;
    if (next) {
      revokeCandidate(candidate);
      startDecode(next);
      return;
    }
    if (!candidateIsCurrent(candidate)) {
      revokeCandidate(candidate);
      return;
    }

    let failure = decodeError;
    if (!failure && dimensions && !decodedCloudDisplayFrameMatches(candidate.frame, dimensions)) {
      failure = new Error('Cloud frame dimensions do not match signed metadata');
    }
    if (failure || !dimensions) {
      revokeCandidate(candidate);
      const retained = retainedFrame(candidate.sessionId);
      if (retained) {
        publish({ kind: 'stalled', sessionId: candidate.sessionId, lastFrame: retained }, 'Cloud 화면을 갱신하지 못했습니다.');
      } else {
        publish({
          kind: 'unavailable',
          reason: 'stream-unavailable',
          message: failure instanceof Error ? failure.message : 'Cloud frame decode failed',
        }, 'Cloud 화면을 표시할 수 없습니다.');
      }
      return;
    }

    const previousUrl = frameUrl;
    frameUrl = candidate.url;
    lastFrame = candidate.frame;
    image.src = candidate.url;
    renderZoom();
    publish({ kind: 'live', sessionId: candidate.sessionId, frame: candidate.frame }, 'Cloud 화면 연결됨');
    if (previousUrl) objectUrls.revoke(previousUrl);
  };

  function startDecode(candidate: DecodeCandidate): void {
    activeDecode = candidate;
    void decode(candidate.url).then(
      (dimensions) => finishDecode(candidate, dimensions, null),
      (error) => finishDecode(candidate, null, error),
    );
  }

  const decodeAndCommitFrame = (
    eventGeneration: number,
    targetSessionId: string,
    frame: CloudDisplayFrame,
  ): void => {
    const bytes = new Uint8Array(frame.bytes.byteLength);
    bytes.set(frame.bytes);
    const candidateUrl = objectUrls.create(new Blob([bytes.buffer], { type: 'image/jpeg' }));
    const candidate: DecodeCandidate = {
      generation: eventGeneration,
      sessionId: targetSessionId,
      frame,
      url: candidateUrl,
      cancelled: false,
      revoked: false,
    };
    if (!activeDecode) {
      startDecode(candidate);
      return;
    }
    if (pendingDecode) revokeCandidate(pendingDecode);
    pendingDecode = candidate;
  };

  const acceptEvent = (eventGeneration: number, sessionId: string, event: CloudDisplayEvent): void => {
    if (disposed || !visible || eventGeneration !== generation || openingSessionId !== sessionId
      || event.sessionId !== sessionId) return;
    if (event.kind === 'frame') {
      decodeAndCommitFrame(eventGeneration, sessionId, event);
      return;
    }
    if (event.kind === 'unavailable') {
      publish({ kind: 'unavailable', reason: event.reason, message: event.message }, unavailableStatus(event));
      return;
    }
    switch (event.state) {
      case 'connecting':
        publish({ kind: 'connecting', sessionId }, 'Cloud 화면에 연결하는 중…');
        break;
      case 'connected':
        if (retainedFrame(sessionId)) {
          publish({ kind: 'live', sessionId, frame: retainedFrame(sessionId)! }, 'Cloud 화면 연결됨');
        } else {
          publish({ kind: 'connecting', sessionId }, 'Cloud 화면 연결됨 · 첫 화면 기다리는 중');
        }
        break;
      case 'reconnecting':
        publish({ kind: 'stalled', sessionId, lastFrame: retainedFrame(sessionId) }, '연결이 잠시 끊겼습니다. 다시 연결하는 중…');
        break;
      case 'failed':
        openingSessionId = null;
        closeConnection();
        publish({ kind: 'unavailable', reason: 'stream-unavailable', message: event.message }, 'Cloud 화면을 표시할 수 없습니다.');
        break;
    }
  };

  const open = (sessionId: string): void => {
    const openGeneration = ++generation;
    openingSessionId = sessionId;
    closeConnection();
    publish({ kind: 'connecting', sessionId }, 'Cloud 화면에 연결하는 중…');
    void display.openDisplay(sessionId, (event) => acceptEvent(openGeneration, sessionId, event)).then(
      (opened) => {
        if (disposed || !visible || openGeneration !== generation || openingSessionId !== sessionId) {
          void opened.close().catch(() => {});
          return;
        }
        connection = opened;
        currentSessionId = sessionId;
        if (opened.capability.kind === 'unavailable') {
          acceptEvent(openGeneration, sessionId, opened.capability);
        }
      },
      (error) => {
        if (disposed || !visible || openGeneration !== generation || openingSessionId !== sessionId) return;
        openingSessionId = null;
        closeConnection();
        const message = error instanceof Error ? error.message : String(error);
        publish({ kind: 'unavailable', reason: 'stream-unavailable', message }, 'Cloud 화면을 표시할 수 없습니다.');
      },
    );
  };

  const setZoom = (next: number): void => {
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    renderZoom();
  };
  zoomOut.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
  zoomIn.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
  zoomReset.addEventListener('click', () => {
    setZoom(1);
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  });
  renderZoom();

  return {
    root,
    setContext({ visible: nextVisible, session }: { visible: boolean; session: CloudSessionState }) {
      if (disposed) return;
      const nextSessionId = displaySessionId(session);
      const nextContextSessionId = sessionId(session);
      const terminalId = terminalSessionId(session);
      if (nextContextSessionId !== contextSessionId) {
        generation += 1;
        openingSessionId = null;
        closeConnection();
        clearFrame();
        contextSessionId = nextContextSessionId;
      }
      if (!nextVisible) {
        visible = false;
        openingSessionId = null;
        generation += 1;
        closeConnection();
        cancelDecodes();
        return;
      }
      visible = true;
      if (!nextSessionId) {
        openingSessionId = null;
        generation += 1;
        closeConnection();
        if (terminalId) {
          publish({ kind: 'ended', sessionId: terminalId, lastFrame: retainedFrame(terminalId) }, 'Cloud 작업이 끝났습니다.');
        } else if (nextContextSessionId) {
          publish({
            kind: 'stalled',
            sessionId: nextContextSessionId,
            lastFrame: retainedFrame(nextContextSessionId),
          }, 'Cloud 작업이 실행되면 화면을 다시 연결합니다.');
        } else {
          publish({
            kind: 'unavailable',
            reason: 'session-not-running',
            message: '선택된 Cloud 작업이 없습니다.',
          }, '표시할 Cloud 작업이 없습니다.');
        }
        return;
      }
      if (openingSessionId === nextSessionId && (currentSessionId === nextSessionId || !connection)) return;
      open(nextSessionId);
    },
    getState: () => state,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      openingSessionId = null;
      generation += 1;
      closeConnection();
      listeners.clear();
      clearFrame();
    },
  };
}
