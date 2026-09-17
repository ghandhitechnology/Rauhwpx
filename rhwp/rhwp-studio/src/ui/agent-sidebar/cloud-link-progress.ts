import './cloud-link-progress.css';

import {
  formatLinkEta,
  linkEstimateMs,
  linkProgressRatio,
  rememberLinkDuration,
  type LinkProgressKind,
} from './cloud-link-estimate.ts';

const TICK_MS = 200;
const COMPLETION_LINGER_MS = 600;

export interface LinkProgress {
  readonly element: HTMLElement;
  start(kind: LinkProgressKind): void;
  settle(outcome: 'done' | 'failed'): void;
  dispose(): void;
}

/** 다시 연결과 서버 다시 만들기 동안 남은 시간을 보여 주는 진행 막대. */
export function createLinkProgress(): LinkProgress {
  const element = document.createElement('div');
  element.className = 'ag-cloud-link-progress';
  element.hidden = true;
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
  let estimateMs = 0;
  let tickTimer = 0;
  let lingerTimer = 0;

  function paint(elapsedMs: number): void {
    fill.style.width = `${(linkProgressRatio(elapsedMs, estimateMs) * 100).toFixed(1)}%`;
    const label = formatLinkEta(estimateMs - elapsedMs);
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
      estimateMs = linkEstimateMs(next);
      if (element.dataset.state === 'done') {
        fill.style.transition = 'none';
        window.requestAnimationFrame(() => { fill.style.transition = ''; });
      }
      delete element.dataset.state;
      element.hidden = false;
      track.setAttribute('aria-label', next === 'reconnecting' ? 'Cloud 서버 연결 진행' : 'Cloud 서버 다시 만들기 진행');
      fill.style.width = '0%';
      tick();
      window.clearInterval(tickTimer);
      tickTimer = window.setInterval(tick, TICK_MS);
    },
    settle(outcome) {
      if (!kind) return;
      const finished = kind;
      const elapsedMs = performance.now() - startedAt;
      kind = null;
      window.clearInterval(tickTimer);
      tickTimer = 0;
      if (outcome === 'failed') {
        delete element.dataset.state;
        element.hidden = true;
        return;
      }
      rememberLinkDuration(finished, elapsedMs);
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
