import type { CloudController } from '../cloud/desktop-cloud.ts';
import { decodedCloudDisplayFrameMatches } from '../cloud/display.ts';
import type { CloudWorkspace, CloudDisplayState } from '../cloud/workspace.ts';
import type {
  CloudDisplayEvent,
  CloudDisplayFrame,
  CloudDisplayInputEvent,
  CloudLinkState,
  CloudSessionState,
} from '../cloud/types.ts';

const MIN_ZOOM = 0.1;
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
  const zoomFit = doc.createElement('button');
  zoomFit.type = 'button';
  zoomFit.dataset.cloudZoom = 'fit';
  zoomFit.setAttribute('aria-label', 'Cloud 화면에 맞추기');
  zoomFit.textContent = '맞춤';
  controls.append(zoomOut, zoomReset, zoomIn, zoomFit);
  toolbar.append(status, controls);

  const viewport = doc.createElement('div');
  viewport.className = 'cloud-workspace-viewport';
  const canvas = doc.createElement('div');
  canvas.className = 'cloud-workspace-canvas';
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Cloud 문서 원격 제어 화면');
  const image = doc.createElement('img');
  image.className = 'cloud-workspace-image';
  image.alt = 'Cloud 문서 화면 미리보기';
  image.draggable = false;
  image.hidden = true;
  const inputSink = doc.createElement('textarea');
  inputSink.className = 'cloud-workspace-input';
  inputSink.setAttribute('aria-label', 'Cloud 문서 키보드 입력');
  inputSink.autocapitalize = 'off';
  inputSink.autocomplete = 'off';
  inputSink.spellcheck = false;
  canvas.append(image, inputSink);
  viewport.appendChild(canvas);
  const connectionNotice = doc.createElement('div');
  connectionNotice.className = 'cloud-workspace-connection-notice';
  connectionNotice.setAttribute('role', 'status');
  connectionNotice.setAttribute('aria-live', 'polite');
  connectionNotice.hidden = true;
  const recoveredInput = doc.createElement('textarea');
  recoveredInput.hidden = true;
  recoveredInput.value = '';
  const recoveryNotes = new Map<string, string>();
  recoveredInput.readOnly = true;
  recoveredInput.setAttribute('aria-label', '전달 여부를 확인하지 못한 입력, 복사해서 보관하세요');
  recoveredInput.style.cssText = 'width:100%;min-height:64px;box-sizing:border-box;resize:vertical';
  root.append(toolbar, recoveredInput, viewport, connectionNotice);

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
  let profileEpoch = 0;
  let linkKind: CloudLinkState['kind'] = 'ready';
  let failedSessionId: string | null = null;
  let activeDecode: DecodeCandidate | null = null;
  let pendingDecode: DecodeCandidate | null = null;
  let disposed = false;
  let zoom = 1;
  let fitToViewport = true;
  let controlling = false;
  let pendingMove: Extract<CloudDisplayInputEvent, { kind: 'pointer'; action: 'move' }> | null = null;
  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  const pressedKeys = new Set<string>();
  type PointerPress = { button: 'left' | 'middle' | 'right' | 'back' | 'forward'; clickCount: number; x: number; y: number; time: number; dragged: boolean };
  const pressedPointers = new Map<number, PointerPress>();
  let lastClick: PointerPress | null = null;
  const listeners = new Set<(value: CloudDisplayState) => void>();

  const renderZoom = (): void => {
    if (fitToViewport && lastFrame && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
      const style = doc.defaultView?.getComputedStyle(viewport);
      const width = viewport.clientWidth - (parseFloat(style?.paddingLeft ?? '') || 0)
        - (parseFloat(style?.paddingRight ?? '') || 0);
      const height = viewport.clientHeight - (parseFloat(style?.paddingTop ?? '') || 0)
        - (parseFloat(style?.paddingBottom ?? '') || 0);
      zoom = Math.max(0.01, Math.min(1, width / lastFrame.width, height / lastFrame.height));
    }
    root.dataset.zoom = String(zoom);
    zoomFit.setAttribute('aria-pressed', String(fitToViewport));
    zoomReset.textContent = `${Math.round(zoom * 100)}%`;
    if (lastFrame) {
      canvas.style.width = `${Math.floor(lastFrame.width * zoom)}px`;
      canvas.style.height = `${Math.floor(lastFrame.height * zoom)}px`;
    }
    zoomOut.disabled = zoom <= MIN_ZOOM;
    zoomIn.disabled = zoom >= MAX_ZOOM;
  };

  const publish = (next: CloudDisplayState, text: string): void => {
    state = next;
    root.dataset.displayState = next.kind;
    const paused = next.kind === 'stalled' || next.kind === 'unavailable';
    const toolbarText = paused && lastFrame ? '마지막 수신 화면' : text;
    if (status.textContent !== toolbarText) status.textContent = toolbarText;
    connectionNotice.hidden = !paused;
    if (paused && connectionNotice.textContent !== text) connectionNotice.textContent = text;
    for (const listener of listeners) listener(next);
  };

  const reportInputError = (error: unknown): void => {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code === 'DISPLAY_STREAM_REPLACED' || code === 'DISPLAY_INPUT_UNAVAILABLE'
      || error instanceof DOMException && error.name === 'AbortError') return;
    controlling = false;
    root.dataset.cloudControl = code === 'DISPLAY_CONTROL_CONFLICT' ? 'conflict' : 'error';
    status.textContent = code === 'DISPLAY_CONTROL_CONFLICT'
      ? '다른 창에서 이 Cloud 화면을 제어하고 있습니다.'
      : 'Cloud 입력을 전달하지 못했습니다. 다시 클릭해 주세요.';
  };

  const sendInput = (event: CloudDisplayInputEvent): Promise<void> => {
    const target = connection;
    if (linkKind !== 'ready' || state.kind === 'stalled' || state.kind === 'unavailable' || state.kind === 'ended'
      || !target || target.capability.kind !== 'available' || currentSessionId !== contextSessionId) {
      return Promise.reject(Object.assign(new Error('Cloud display input is unavailable'), {
        code: 'DISPLAY_INPUT_UNAVAILABLE',
      }));
    }
    return target.sendInput(event).then(() => {
      if (!controlling) {
        controlling = true;
        root.dataset.cloudControl = 'active';
        status.textContent = 'Cloud 화면 연결됨 · 원격 제어 중';
      }
    }, (error) => {
      reportInputError(error);
      throw error;
    });
  };

  const flushMove = (): void => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = null;
    if (!pendingMove) return;
    const event = pendingMove;
    pendingMove = null;
    // The transport queue owns network ordering. Never wait for a round trip here:
    // doing so lets pointerup overtake the final movement of a drag.
    void sendInput(event).catch(() => {});
  };

  const sendText = (text: string): void => {
    const encoder = new TextEncoder();
    let chunk = '';
    let chunkBytes = 0;
    const flush = (): void => {
      if (chunk) {
        const attempted = chunk;
        const attemptedSession = contextSessionId;
        void sendInput({ kind: 'text', text: attempted }).catch(() => {
          if (!attemptedSession) return;
          recoveryNotes.set(attemptedSession, (recoveryNotes.get(attemptedSession) ?? '') + attempted);
          if (contextSessionId !== attemptedSession) return;
          recoveredInput.hidden = false;
          recoveredInput.value = recoveryNotes.get(attemptedSession)!;
          status.textContent = '입력 적용 여부를 확인하지 못했습니다. 아래 텍스트를 복사하고 문서와 비교해 주세요.';
        });
      }
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
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = null;
    pressedKeys.clear();
    pressedPointers.clear();
    lastClick = null;
    if (active) void active.close().catch(() => {});
  };

  const clearFrame = (): void => {
    cancelDecodes();
    lastFrame = null;
    if (frameUrl) objectUrls.revoke(frameUrl);
    frameUrl = null;
    image.hidden = true;
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
    image.hidden = false;
    renderZoom();
    publish(
      { kind: 'live', sessionId: candidate.sessionId, frame: candidate.frame },
      controlling ? 'Cloud 화면 연결됨 · 원격 제어 중' : 'Cloud 화면 연결됨 · 클릭하여 제어',
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
      const retained = retainedFrame(sessionId);
      publish(retained ? { kind: 'stalled', sessionId, lastFrame: retained }
        : { kind: 'unavailable', reason: event.reason, message: event.message }, unavailableStatus(event));
      return;
    }
    switch (event.state) {
      case 'connecting':
        if (!retainedFrame(sessionId)) publish({ kind: 'connecting', sessionId }, 'Cloud 화면에 연결하는 중…');
        break;
      case 'connected':
        if (retainedFrame(sessionId)) {
          publish({ kind: 'stalled', sessionId, lastFrame: retainedFrame(sessionId) }, 'Cloud 연결 복구됨 · 최신 화면 기다리는 중');
        } else {
          publish({ kind: 'connecting', sessionId }, 'Cloud 화면 연결됨 · 첫 화면 기다리는 중');
        }
        break;
      case 'reconnecting':
        publish({ kind: 'stalled', sessionId, lastFrame: retainedFrame(sessionId) }, '연결이 잠시 끊겼습니다. 다시 연결하는 중…');
        break;
      case 'failed':
        failedSessionId = sessionId;
        openingSessionId = null;
        closeConnection();
        publish({ kind: 'stalled', sessionId, lastFrame: retainedFrame(sessionId) }, '화면 연결이 멈췄습니다. Cloud에서 다시 연결해 주세요.');
        break;
    }
  };

  const open = (sessionId: string): void => {
    const openGeneration = ++generation;
    openingSessionId = sessionId;
    closeConnection();
    failedSessionId = null;
    publish(retainedFrame(sessionId)
      ? { kind: 'stalled', sessionId, lastFrame: retainedFrame(sessionId) }
      : { kind: 'connecting', sessionId }, 'Cloud 화면에 연결하는 중…');
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
        failedSessionId = sessionId;
        closeConnection();
        const message = error instanceof Error ? error.message : String(error);
        publish(retainedFrame(sessionId)
          ? { kind: 'stalled', sessionId, lastFrame: retainedFrame(sessionId) }
          : { kind: 'unavailable', reason: 'stream-unavailable', message },
        '화면 연결이 멈췄습니다. Cloud에서 다시 연결해 주세요.');
      },
    );
  };

  const setZoom = (next: number): void => {
    fitToViewport = false;
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
  zoomFit.addEventListener('click', () => {
    fitToViewport = true;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    renderZoom();
  });
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => renderZoom());
  resizeObserver?.observe(viewport);

  canvas.addEventListener('pointermove', (event) => {
    const press = pressedPointers.get(event.pointerId);
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) press.dragged = true;
    const point = displayPoint(event);
    if (!point) return;
    pendingMove = { kind: 'pointer', action: 'move', ...point };
    // Leave room under the server's 60 events/second limit for clicks and keys.
    if (!moveTimer) moveTimer = setTimeout(flushMove, 50);
  });
  canvas.addEventListener('pointerdown', (event) => {
    const point = displayPoint(event);
    const button = pointerButton(event.button);
    if (!point || !button) return;
    event.preventDefault();
    inputSink.focus({ preventScroll: true });
    canvas.setPointerCapture?.(event.pointerId);
    // PointerEvent.detail is zero in Chromium, so count clicks before network batching.
    const time = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
    const repeated = lastClick && lastClick.button === button && time >= lastClick.time
      && time - lastClick.time <= 500 && Math.hypot(event.clientX - lastClick.x, event.clientY - lastClick.y) <= 5;
    const clickCount = event.detail > 0 ? Math.min(3, event.detail)
      : repeated ? lastClick!.clickCount % 3 + 1 : 1;
    pressedPointers.set(event.pointerId, { button, clickCount, x: event.clientX, y: event.clientY, time, dragged: false });
    lastClick = null;
    pendingMove = null;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = null;
    void sendInput({ kind: 'pointer', action: 'down', ...point, button, clickCount }).catch(() => {});
  });
  canvas.addEventListener('pointerup', (event) => {
    const point = displayPoint(event);
    const press = pressedPointers.get(event.pointerId);
    const button = press?.button ?? pointerButton(event.button);
    if (!point || !button) return;
    event.preventDefault();
    flushMove();
    void sendInput({ kind: 'pointer', action: 'up', ...point, button, clickCount: press?.clickCount ?? 1 }).catch(() => {});
    const time = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
    lastClick = press && !press.dragged && time - press.time <= 500
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 5 ? press : null;
    pressedPointers.delete(event.pointerId);
    canvas.releasePointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointercancel', (event) => {
    const point = displayPoint(event);
    const press = pressedPointers.get(event.pointerId);
    if (!point || !press) return;
    flushMove();
    pressedPointers.delete(event.pointerId);
    lastClick = null;
    void sendInput({ kind: 'pointer', action: 'up', ...point, button: press.button, clickCount: press.clickCount }).catch(() => {});
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => {
    const point = displayPoint(event);
    if (!point) return;
    event.preventDefault();
    flushMove();
    const deltaX = Math.max(-32_768, Math.min(32_768, Math.round(event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1))));
    const deltaY = Math.max(-32_768, Math.min(32_768, Math.round(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1))));
    void sendInput({ kind: 'wheel', ...point, deltaX, deltaY }).catch(() => {});
  }, { passive: false });
  inputSink.addEventListener('keydown', (event) => {
    // The local textarea owns IME mode changes; only committed text goes to Chromium.
    if (event.isComposing || ['Dead', 'Process', 'Compose', 'HangulMode', 'HanjaMode',
      'KanjiMode', 'Hiragana', 'Katakana', 'HiraganaKatakana', 'Zenkaku', 'Hankaku',
      'ZenkakuHankaku', 'Eisu', 'EisuShift', 'Alphanumeric', 'ModeChange',
      'Convert', 'NonConvert', 'JunjaMode', 'FinalMode'].includes(event.key)) return;
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
  renderZoom();

  return {
    root,
    setContext({ visible: nextVisible, session, link, profileEpoch: nextEpoch = 0 }) {
      if (disposed) return;
      const nextLinkKind = link?.kind ?? 'ready';
      const recovered = nextLinkKind === 'ready' && linkKind !== 'ready';
      if (recovered || nextEpoch !== profileEpoch) {
        generation += 1;
        openingSessionId = null;
        failedSessionId = null;
        closeConnection();
        cancelDecodes();
      }
      profileEpoch = nextEpoch;
      linkKind = nextLinkKind;
      const nextSessionId = displaySessionId(session);
      const nextContextSessionId = sessionId(session);
      const terminalId = terminalSessionId(session);
      if (nextContextSessionId !== contextSessionId && !(linkKind === 'recreating' && !nextContextSessionId)) {
        generation += 1;
        openingSessionId = null;
        closeConnection();
        clearFrame();
        failedSessionId = null;
        recoveredInput.value = nextContextSessionId ? recoveryNotes.get(nextContextSessionId) ?? '' : '';
        recoveredInput.hidden = !recoveredInput.value;
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
      if (linkKind !== 'ready') {
        if (openingSessionId || connection) {
          generation += 1;
          openingSessionId = null;
          closeConnection();
          cancelDecodes();
        }
        publish({ kind: 'stalled', sessionId: nextContextSessionId ?? '', lastFrame },
          linkKind === 'recreating' ? '새 서버가 준비되면 화면을 다시 표시합니다.'
            : linkKind === 'reconnecting' ? '연결 중입니다. 마지막 화면을 표시하고 있습니다.'
            : '연결이 끊겨 마지막 화면을 표시하고 있습니다.');
        return;
      }
      if (!nextSessionId) {
        failedSessionId = null;
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
      if (failedSessionId === nextSessionId) return;
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
      resizeObserver?.disconnect();
      clearFrame();
    },
  };
}
