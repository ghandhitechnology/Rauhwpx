import type { CloudController } from '../cloud/desktop-cloud.ts';
import { decodedCloudDisplayFrameMatches } from '../cloud/display.ts';
import type { CloudWorkspace, CloudDisplayState } from '../cloud/workspace.ts';
import type {
  CloudDisplayEvent,
  CloudDisplayFrame,
  CloudDisplayInputEvent,
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
    case 'server-unsupported': return '이 Cloud 서버는 실시간 문서 화면을 지원하지 않습니다.';
    case 'client-unsupported': return '이 앱 버전은 실시간 문서 화면을 지원하지 않습니다.';
    case 'stream-unavailable': return event.retryable
      ? 'Cloud 문서 화면을 준비하는 중입니다.'
      : 'Cloud 문서 화면을 열 수 없습니다.';
    default: return 'Cloud 작업이 시작되면 문서 화면이 열립니다.';
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
  root.setAttribute('aria-label', 'Cloud 에이전트의 실시간 문서 화면');

  const toolbar = doc.createElement('div');
  toolbar.className = 'cloud-workspace-toolbar';
  const status = doc.createElement('div');
  status.className = 'cloud-workspace-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const statusSignal = doc.createElement('span');
  statusSignal.className = 'cloud-workspace-status-signal';
  statusSignal.setAttribute('aria-hidden', 'true');
  const statusText = doc.createElement('span');
  statusText.className = 'cloud-workspace-status-text';
  status.append(statusSignal, statusText);
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
  const empty = doc.createElement('div');
  empty.className = 'cloud-workspace-empty';
  const emptyVisual = doc.createElement('div');
  emptyVisual.className = 'cloud-workspace-empty-visual';
  emptyVisual.setAttribute('aria-hidden', 'true');
  const emptyLive = doc.createElement('span');
  emptyLive.className = 'cloud-workspace-empty-live';
  emptyLive.textContent = '실시간 문서';
  const emptyPage = doc.createElement('span');
  emptyPage.className = 'cloud-workspace-empty-page';
  for (const className of ['cloud-workspace-empty-line cloud-workspace-empty-line-title', 'cloud-workspace-empty-line', 'cloud-workspace-empty-line cloud-workspace-empty-line-short']) {
    const line = doc.createElement('span');
    line.className = className;
    emptyPage.appendChild(line);
  }
  const emptyCaret = doc.createElement('span');
  emptyCaret.className = 'cloud-workspace-empty-caret';
  emptyPage.appendChild(emptyCaret);
  emptyVisual.append(emptyLive, emptyPage);
  const emptyCopy = doc.createElement('div');
  emptyCopy.className = 'cloud-workspace-empty-copy';
  const emptyTitle = doc.createElement('h2');
  emptyTitle.className = 'cloud-workspace-empty-title';
  const emptyDetail = doc.createElement('p');
  emptyDetail.className = 'cloud-workspace-empty-detail';
  emptyCopy.append(emptyTitle, emptyDetail);
  empty.append(emptyVisual, emptyCopy);
  const canvas = doc.createElement('div');
  canvas.className = 'cloud-workspace-canvas';
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Cloud 문서 실시간 원격 제어');
  const image = doc.createElement('img');
  image.className = 'cloud-workspace-image';
  image.alt = 'Cloud 에이전트가 편집 중인 문서 화면';
  image.draggable = false;
  const inputSink = doc.createElement('textarea');
  inputSink.className = 'cloud-workspace-input';
  inputSink.setAttribute('aria-label', 'Cloud 문서 키보드 입력');
  inputSink.autocapitalize = 'off';
  inputSink.autocomplete = 'off';
  inputSink.spellcheck = false;
  canvas.append(image, inputSink);
  viewport.append(empty, canvas);
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
  let controlling = false;
  let pendingMove: Extract<CloudDisplayInputEvent, { kind: 'pointer'; action: 'move' }> | null = null;
  let moveSending = false;
  const pressedKeys = new Set<string>();
  const pressedPointers = new Map<number, 'left' | 'middle' | 'right' | 'back' | 'forward'>();
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

  const renderEmptyState = (next: CloudDisplayState): void => {
    empty.hidden = next.kind === 'live' || lastFrame !== null;
    if (empty.hidden) return;
    switch (next.kind) {
      case 'connecting':
        emptyTitle.textContent = '실시간 문서 화면을 여는 중입니다';
        emptyDetail.textContent = '첫 화면이 오면 에이전트가 문서를 고치는 과정을 바로 볼 수 있습니다.';
        break;
      case 'stalled':
        emptyTitle.textContent = '문서 화면에 다시 연결하는 중입니다';
        emptyDetail.textContent = '에이전트 작업은 Cloud에서 계속됩니다.';
        break;
      case 'ended':
        emptyTitle.textContent = 'Cloud 작업이 끝났습니다';
        emptyDetail.textContent = 'Cloud 상태에서 결과 문서를 확인하세요.';
        break;
      case 'unavailable':
        if (next.reason === 'session-not-running') {
          emptyTitle.textContent = 'Cloud 작업을 시작하면 문서 화면이 열립니다';
          emptyDetail.textContent = '편집 과정을 실시간으로 보고, 필요하면 화면을 직접 제어할 수 있습니다.';
        } else {
          emptyTitle.textContent = '실시간 문서 화면을 열 수 없습니다';
          emptyDetail.textContent = 'Cloud 상태에서 연결을 확인하거나 이 기기에서 작업을 이어받으세요.';
        }
        break;
      case 'live':
        break;
    }
  };

  const publish = (next: CloudDisplayState, text: string): void => {
    state = next;
    root.dataset.displayState = next.kind;
    statusText.textContent = text;
    renderEmptyState(next);
    for (const listener of listeners) listener(next);
  };

  const reportInputError = (error: unknown): void => {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code === 'DISPLAY_STREAM_REPLACED' || code === 'DISPLAY_INPUT_UNAVAILABLE'
      || error instanceof DOMException && error.name === 'AbortError') return;
    controlling = false;
    root.dataset.cloudControl = code === 'DISPLAY_CONTROL_CONFLICT' ? 'conflict' : 'error';
    statusText.textContent = code === 'DISPLAY_CONTROL_CONFLICT'
      ? '다른 창에서 이 문서 화면을 제어하고 있습니다.'
      : 'Cloud에 입력을 보내지 못했습니다. 화면을 다시 클릭해 주세요.';
  };

  const sendInput = (event: CloudDisplayInputEvent): Promise<void> => {
    const target = connection;
    if (!target || target.capability.kind !== 'available' || currentSessionId !== contextSessionId) {
      return Promise.reject(Object.assign(new Error('Cloud display input is unavailable'), {
        code: 'DISPLAY_INPUT_UNAVAILABLE',
      }));
    }
    return target.sendInput(event).then(() => {
      if (!controlling) {
        controlling = true;
        root.dataset.cloudControl = 'active';
        statusText.textContent = '실시간 문서 화면이 연결됐습니다. 직접 제어 중입니다.';
      }
    }, (error) => {
      reportInputError(error);
      throw error;
    });
  };

  const flushMove = (): void => {
    if (moveSending || !pendingMove) return;
    const event = pendingMove;
    pendingMove = null;
    moveSending = true;
    void sendInput(event).catch(() => {}).finally(() => {
      moveSending = false;
      flushMove();
    });
  };

  const sendText = (text: string): void => {
    const encoder = new TextEncoder();
    let chunk = '';
    let chunkBytes = 0;
    const flush = (): void => {
      if (chunk) void sendInput({ kind: 'text', text: chunk }).catch(() => {});
      chunk = '';
      chunkBytes = 0;
    };
    for (const character of text) {
      const bytes = encoder.encode(character).byteLength;
      if (chunkBytes + bytes > 4 * 1024) flush();
      chunk += character;
      chunkBytes += bytes;
    }
    flush();
  };

  const displayPoint = (event: PointerEvent | WheelEvent): { x: number; y: number } | null => {
    const capability = connection?.capability;
    if (!capability || capability.kind !== 'available') return null;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(capability.width - 1, Math.floor(
        (event.clientX - bounds.left) * capability.width / bounds.width,
      ))),
      y: Math.max(0, Math.min(capability.height - 1, Math.floor(
        (event.clientY - bounds.top) * capability.height / bounds.height,
      ))),
    };
  };

  const pointerButton = (button: number): 'left' | 'middle' | 'right' | 'back' | 'forward' | null => {
    switch (button) {
      case 0: return 'left';
      case 1: return 'middle';
      case 2: return 'right';
      case 3: return 'back';
      case 4: return 'forward';
      default: return null;
    }
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
    controlling = false;
    root.dataset.cloudControl = 'inactive';
    pendingMove = null;
    pressedKeys.clear();
    pressedPointers.clear();
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
    publish(
      { kind: 'live', sessionId: candidate.sessionId, frame: candidate.frame },
      controlling
        ? '실시간 문서 화면이 연결됐습니다. 직접 제어 중입니다.'
        : '실시간 문서 화면이 연결됐습니다. 클릭해서 직접 제어하세요.',
    );
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
        publish({ kind: 'connecting', sessionId }, 'Cloud 문서 화면에 연결하는 중입니다.');
        break;
      case 'connected':
        if (retainedFrame(sessionId)) {
          publish({ kind: 'live', sessionId, frame: retainedFrame(sessionId)! }, '실시간 문서 화면이 연결됐습니다.');
        } else {
          publish({ kind: 'connecting', sessionId }, 'Cloud에 연결했습니다. 첫 문서 화면을 기다리는 중입니다.');
        }
        break;
      case 'reconnecting':
        publish({ kind: 'stalled', sessionId, lastFrame: retainedFrame(sessionId) }, '연결이 끊겼습니다. 문서 화면에 다시 연결하는 중입니다.');
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
    publish({ kind: 'connecting', sessionId }, 'Cloud 문서 화면에 연결하는 중입니다.');
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

  canvas.addEventListener('pointermove', (event) => {
    const point = displayPoint(event);
    if (!point) return;
    pendingMove = { kind: 'pointer', action: 'move', ...point };
    flushMove();
  });
  canvas.addEventListener('pointerdown', (event) => {
    const point = displayPoint(event);
    const button = pointerButton(event.button);
    if (!point || !button) return;
    event.preventDefault();
    inputSink.focus({ preventScroll: true });
    canvas.setPointerCapture?.(event.pointerId);
    pressedPointers.set(event.pointerId, button);
    pendingMove = null;
    void sendInput({ kind: 'pointer', action: 'down', ...point, button }).catch(() => {});
  });
  canvas.addEventListener('pointerup', (event) => {
    const point = displayPoint(event);
    const button = pressedPointers.get(event.pointerId) ?? pointerButton(event.button);
    if (!point || !button) return;
    event.preventDefault();
    void sendInput({ kind: 'pointer', action: 'up', ...point, button }).catch(() => {});
    pressedPointers.delete(event.pointerId);
    canvas.releasePointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointercancel', (event) => {
    const point = displayPoint(event);
    const button = pressedPointers.get(event.pointerId);
    if (!point || !button) return;
    pressedPointers.delete(event.pointerId);
    void sendInput({ kind: 'pointer', action: 'up', ...point, button }).catch(() => {});
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => {
    const point = displayPoint(event);
    if (!point) return;
    event.preventDefault();
    const deltaX = Math.max(-32_768, Math.min(32_768, Math.round(event.deltaX)));
    const deltaY = Math.max(-32_768, Math.min(32_768, Math.round(event.deltaY)));
    void sendInput({ kind: 'wheel', ...point, deltaX, deltaY }).catch(() => {});
  }, { passive: false });
  inputSink.addEventListener('keydown', (event) => {
    if (event.isComposing || event.key === 'Dead' || event.key === 'Process') return;
    const localText = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
      && !event.isComposing;
    if (localText) return;
    event.preventDefault();
    pressedKeys.add(event.key);
    void sendInput({ kind: 'key', action: 'down', key: event.key }).catch(() => {});
  });
  inputSink.addEventListener('keyup', (event) => {
    if (!pressedKeys.delete(event.key)) return;
    event.preventDefault();
    void sendInput({ kind: 'key', action: 'up', key: event.key }).catch(() => {});
  });
  inputSink.addEventListener('input', (event) => {
    if (event.isComposing) return;
    const text = inputSink.value;
    inputSink.value = '';
    if (text) sendText(text);
  });
  inputSink.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    event.preventDefault();
    inputSink.value = '';
    sendText(text);
  });
  inputSink.addEventListener('blur', () => {
    for (const key of pressedKeys) void sendInput({ kind: 'key', action: 'up', key }).catch(() => {});
    pressedKeys.clear();
  });
  statusText.textContent = '표시할 Cloud 작업이 없습니다.';
  renderEmptyState(state);
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
