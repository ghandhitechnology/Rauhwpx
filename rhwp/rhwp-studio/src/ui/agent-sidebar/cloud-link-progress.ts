import './cloud-link-progress.css';

type LinkProgressKind = 'reconnecting' | 'recreating';

const TICK_MS = 1000;
const COMPLETION_LINGER_MS = 600;

export interface LinkProgress {
  readonly element: HTMLElement;
  start(kind: LinkProgressKind): void;
  settle(outcome: 'done' | 'failed'): void;
  dispose(): void;
}

/** 서버가 진행률을 보내지 않으므로 경과 시간만 표시한다. */
export function createLinkProgress(): LinkProgress {
  const element = document.createElement('div');
  element.className = 'ag-cloud-link-progress';
  element.hidden = true;
  // 경과 시간 갱신은 부모 상태 영역의 낭독을 따라가지 않는다.
  element.setAttribute('aria-live', 'off');
  const track = document.createElement('div');
  track.className = 'ag-cloud-link-progress-track';
  track.setAttribute('role', 'progressbar');
  const fill = document.createElement('div');
  fill.className = 'ag-cloud-link-progress-fill';
  track.append(fill);
  const eta = document.createElement('span');
  eta.className = 'ag-cloud-link-progress-eta';
  eta.setAttribute('aria-hidden', 'true');
  element.append(track, eta);

  let kind: LinkProgressKind | null = null;
  let startedAt = 0;
  let tickTimer = 0;
  let lingerTimer = 0;

  function paint(elapsedMs: number): void {
    const seconds = Math.floor(elapsedMs / 1000);
    const label = seconds < 60 ? `${seconds}초 경과` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초 경과`;
    eta.textContent = label;
    if (track.getAttribute('aria-valuetext') !== label) track.setAttribute('aria-valuetext', label);
  }

  function tick(): void {
    paint(performance.now() - startedAt);
  }

  return {
    element,
    start(next) {
      if (kind === next) return;
      window.clearTimeout(lingerTimer);
      kind = next;
      startedAt = performance.now();
      delete element.dataset.state;
      element.hidden = false;
      track.setAttribute('aria-label', next === 'reconnecting' ? 'Cloud 서버 연결 진행' : 'Cloud 서버 다시 만들기 진행');
      // 완료 뒤 다시 연결할 때 불확정 진행 표시로 되돌린다.
      fill.style.transition = 'none';
      fill.style.width = '30%';
      void fill.offsetWidth;
      fill.style.transition = '';
      tick();
      window.clearInterval(tickTimer);
      tickTimer = window.setInterval(tick, TICK_MS);
    },
    settle(outcome) {
      if (!kind) return;
      kind = null;
      window.clearInterval(tickTimer);
      tickTimer = 0;
      if (outcome === 'failed') {
        delete element.dataset.state;
        element.hidden = true;
        return;
      }
      element.dataset.state = 'done';
      fill.style.width = '100%';
      eta.textContent = '완료';
      track.setAttribute('aria-valuetext', '완료');
      lingerTimer = window.setTimeout(() => {
        delete element.dataset.state;
        element.hidden = true;
      }, COMPLETION_LINGER_MS);
    },
    dispose() {
      kind = null;
      window.clearInterval(tickTimer);
      window.clearTimeout(lingerTimer);
    },
  };
}
