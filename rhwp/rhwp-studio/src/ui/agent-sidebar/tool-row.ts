/**
 * 도구 호출 한 줄 — 라이브 활동, 저장된 대화, 서브에이전트 드릴인이 같은 모양을 쓴다.
 *
 * 머리: 상태 · 동작 이름 · 인자 요약 · 소요 시간. 결과가 오면 머리 아래에 결과 한 줄과
 * (있으면) 작은 그림을 둔다. 펼치면 항목 목록·알림이 보이고, 원본 인자/결과는
 * 그 아래 접힌 “원본” 안에 고정폭으로 남는다.
 */
import { createChevron } from '../chevron.ts';
import { createIcon } from './icons.ts';
import {
  presentToolCall,
  type ToolCallView,
  type ToolOutcomeView,
} from './tool-presentation.ts';

export type ToolRowState = 'running' | 'completed' | 'failed' | 'stopped';

export interface ToolRowOptions {
  agent: string;
  tool: string;
  argsJson: string;
  /** 왼쪽 거터의 op 번호 (라이브 활동만) */
  opNumber?: number;
  /** 가짜 DOM 테스트용 */
  doc?: Pick<Document, 'createElement'>;
}

export interface ToolRowHandle {
  readonly root: HTMLElement;
  readonly view: ToolCallView;
  readonly elapsed: HTMLElement;
  /** 원본 결과 칸 — 프로바이더 미리보기를 그대로 담는다 */
  readonly result: HTMLElement;
  setState(state: ToolRowState): void;
  setOutcome(outcome: ToolOutcomeView | null): void;
  setRawResult(text: string): void;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export function createToolRow(options: ToolRowOptions): ToolRowHandle {
  const doc = options.doc ?? document;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag) as HTMLElementTagNameMap[K];
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const view = presentToolCall(options.tool, options.argsJson);

  const root = el('div', `ag-tool-row ag-${options.agent}${view.known ? '' : ' ag-tool-foreign'}`);
  root.setAttribute('data-tool', view.name);
  const head = el('button', 'ag-tool-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');
  head.setAttribute('title', view.name);
  const status = el('span', 'ag-tool-status ag-pending');
  status.setAttribute('role', 'img');
  status.setAttribute('aria-label', '실행 중');
  const label = el('span', 'ag-tool-label', view.label);
  const summary = el('span', 'ag-tool-summary', view.summary);
  const elapsed = el('span', 'ag-tool-elapsed');
  if (options.opNumber !== undefined) {
    const opId = el('span', 'ag-op-id', String(options.opNumber).padStart(2, '0'));
    opId.setAttribute('aria-hidden', 'true');
    head.append(opId);
  }
  head.append(status, label, summary, elapsed, createChevron('ag-tool-chevron'));

  const outcomeLine = el('div', 'ag-tool-outcome');
  outcomeLine.hidden = true;
  const outcomeText = el('span', 'ag-tool-outcome-text');
  outcomeLine.append(outcomeText);

  const body = el('div', 'ag-tool-body');
  body.hidden = true;
  const items = el('ol', 'ag-tool-items');
  const itemRows: Array<{ status: HTMLElement; outcome: HTMLElement; row: HTMLElement }> = [];
  for (const item of view.items) {
    const row = el('li', 'ag-tool-item');
    const itemStatus = el('span', 'ag-tool-item-status');
    const itemOutcome = el('span', 'ag-tool-item-outcome');
    row.append(
      itemStatus,
      el('span', 'ag-tool-item-label', item.label),
      el('span', 'ag-tool-item-summary', item.summary),
      itemOutcome,
    );
    items.appendChild(row);
    itemRows.push({ status: itemStatus, outcome: itemOutcome, row });
  }
  items.hidden = view.items.length === 0;
  const detail = el('p', 'ag-tool-detail');
  detail.hidden = true;
  const notices = el('ul', 'ag-tool-notices');
  notices.hidden = true;
  const raw = el('details', 'ag-tool-raw');
  const rawSummary = el('summary', 'ag-tool-raw-toggle', '원본');
  const args = el('pre', 'ag-tool-args', prettyJson(options.argsJson));
  const result = el('pre', 'ag-tool-result');
  raw.append(rawSummary, args, result);
  body.append(items, detail, notices, raw);

  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    root.classList.toggle('ag-tool-open', !body.hidden);
    head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
  });

  root.append(head, outcomeLine, body);

  let thumb: HTMLButtonElement | null = null;

  const setState = (state: ToolRowState): void => {
    status.classList.remove('ag-pending', 'ag-ok', 'ag-err');
    if (state === 'running') {
      status.classList.add('ag-pending');
      status.setAttribute('aria-label', '실행 중');
      status.replaceChildren();
      return;
    }
    const ok = state === 'completed';
    status.classList.add(ok ? 'ag-ok' : 'ag-err');
    status.setAttribute('aria-label', ok ? '완료' : state === 'stopped' ? '중단' : '오류');
    status.replaceChildren(createIcon(ok ? 'check' : 'close'));
  };

  const setOutcome = (outcome: ToolOutcomeView | null): void => {
    if (outcome?.label) label.textContent = outcome.label;
    outcomeText.textContent = outcome?.text ?? '';
    outcomeLine.classList.toggle('ag-err', outcome ? !outcome.ok : false);
    if (thumb) {
      thumb.remove();
      thumb = null;
    }
    if (outcome?.image) {
      const src = outcome.image;
      const button = el('button', 'ag-tool-thumb');
      button.type = 'button';
      button.setAttribute('aria-label', `${label.textContent ?? ''} 결과 그림 크게 보기`);
      const img = el('img', '');
      img.src = src;
      img.alt = '';
      img.setAttribute('decoding', 'async');
      button.appendChild(img);
      button.addEventListener('click', () => openToolImage(src, button));
      outcomeLine.appendChild(button);
      thumb = button;
    }
    outcomeLine.hidden = !(outcome?.text || outcome?.image);

    detail.textContent = outcome?.detail ?? '';
    detail.hidden = !outcome?.detail;
    notices.replaceChildren();
    for (const notice of outcome?.notices ?? []) notices.appendChild(el('li', 'ag-tool-notice', notice));
    notices.hidden = !(outcome?.notices.length);

    const itemOutcomes = outcome?.items ?? [];
    itemRows.forEach((item, index) => {
      const itemOutcome = itemOutcomes[index];
      item.status.classList.remove('ag-ok', 'ag-err');
      item.row.classList.remove('ag-err');
      if (!itemOutcome) {
        item.outcome.textContent = '';
        return;
      }
      item.status.classList.add(itemOutcome.ok ? 'ag-ok' : 'ag-err');
      item.row.classList.toggle('ag-err', !itemOutcome.ok);
      item.outcome.textContent = itemOutcome.text;
    });
  };

  return {
    root,
    view,
    elapsed,
    result,
    setState,
    setOutcome,
    setRawResult: (text: string) => { result.textContent = text; },
  };
}

// ─── 결과 그림 크게 보기 ─────────────────────────────

/** 결과 그림을 사이드바 위에 크게 띄운다. 아무 데나 누르거나 Esc 로 닫힌다. */
export function openToolImage(src: string, anchor: HTMLElement): void {
  const host = (anchor.closest('.ag-root') as HTMLElement | null) ?? document.body;
  host.querySelector('.ag-image-viewer')?.remove();
  const layer = document.createElement('div');
  layer.className = 'ag-image-viewer';
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-label', '결과 그림');
  layer.tabIndex = -1;
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  layer.appendChild(img);
  const close = (): void => {
    layer.classList.add('ag-closing');
    document.removeEventListener('keydown', onKey, true);
    const done = () => layer.remove();
    layer.addEventListener('animationend', done, { once: true });
    window.setTimeout(done, 400);
    anchor.focus({ preventScroll: true });
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  layer.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  host.appendChild(layer);
  layer.focus({ preventScroll: true });
}
