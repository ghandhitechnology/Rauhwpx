import { formatDiffLocationCombined, isComparePreviewAbsent } from '@/compare/diff-location-label';
import type { CompareSessionStore } from '@/compare/session';
import type { CompareSession, DiffItem } from '@/compare/types';
import { DocumentPreviewPane } from '@/merge/document-preview-pane.ts';

type CompareSourceDocument = {
  bytes: Uint8Array;
  fileName: string;
};

export class CompareResultWindow {
  private _open = false;
  private wrap!: HTMLDivElement;
  private titleEl!: HTMLSpanElement;
  private leftPane!: HTMLDivElement;
  private rightPane!: HTMLDivElement;
  private metaEl!: HTMLDivElement;
  private session: CompareSession | null = null;
  private store: CompareSessionStore | null = null;
  private leftDocumentPreview!: DocumentPreviewPane;
  private rightDocumentPreview!: DocumentPreviewPane;
  private leftSource: CompareSourceDocument | null = null;
  private rightSource: CompareSourceDocument | null = null;

  isOpen(): boolean {
    return this._open;
  }

  show(
    session: CompareSession,
    store: CompareSessionStore,
    initialIndex = 0,
    docs?: { left: CompareSourceDocument; right: CompareSourceDocument },
  ): void {
    this.session = session;
    this.store = store;
    if (docs) {
      this.leftSource = docs.left;
      this.rightSource = docs.right;
    }
    if (!this._open) {
      this._open = true;
      this.build();
      document.body.appendChild(this.wrap);
    }
    this.titleEl.textContent = `문서 비교 상세 · ${session.left.name} ↔ ${session.right.name}`;
    this.leftDocumentPreview.setTitle(`왼쪽 문서: ${session.left.name}`);
    this.rightDocumentPreview.setTitle(`오른쪽 문서: ${session.right.name}`);
    void this.focusDiff(initialIndex);
  }

  hide(): void {
    this._open = false;
    this.wrap?.remove();
    this.leftDocumentPreview?.dispose();
    this.rightDocumentPreview?.dispose();
    this.leftSource = null;
    this.rightSource = null;
    this.session = null;
    this.store = null;
  }

  async focusDiff(index: number): Promise<void> {
    if (!this.session) return;
    const item = this.session.diffItems[index];
    if (!item) return;
    await this.ensureCompareDocumentsLoaded();
    const locCombined = formatDiffLocationCombined(item);
    this.metaEl.textContent = locCombined
      ? `[${item.kind}] ${item.title}\n${locCombined}`
      : `[${item.kind}] ${item.title}`;
    this.leftPane.innerHTML = this.highlightPreview(item, 'left');
    this.rightPane.innerHTML = this.highlightPreview(item, 'right');
    this.renderRealDocumentPreview(item);
  }

  private build(): void {
    this.wrap = document.createElement('div');
    this.wrap.className = 'compare-inspector-window';

    const head = document.createElement('div');
    head.className = 'compare-inspector-head';
    this.titleEl = document.createElement('span');
    this.titleEl.textContent = '문서 비교 상세';
    const close = document.createElement('button');
    close.className = 'dialog-close';
    close.textContent = '\u00D7';
    close.addEventListener('click', () => this.hide());
    head.append(this.titleEl, close);

    const body = document.createElement('div');
    body.className = 'compare-inspector-body';
    this.metaEl = document.createElement('div');
    this.metaEl.className = 'compare-inspector-meta';
    this.metaEl.style.whiteSpace = 'pre-line';

    const panes = document.createElement('div');
    panes.className = 'compare-inspector-panes';
    const leftWrap = document.createElement('div');
    leftWrap.className = 'compare-inspector-pane';
    this.leftDocumentPreview = new DocumentPreviewPane({
      role: 'comparison-left',
      title: '왼쪽 문서',
      variant: 'comparison',
    });
    this.leftPane = document.createElement('div');
    this.leftPane.className = 'compare-inspector-content';
    leftWrap.append(this.leftDocumentPreview.element, this.leftPane);

    const rightWrap = document.createElement('div');
    rightWrap.className = 'compare-inspector-pane';
    this.rightDocumentPreview = new DocumentPreviewPane({
      role: 'comparison-right',
      title: '오른쪽 문서',
      variant: 'comparison',
    });
    this.rightPane = document.createElement('div');
    this.rightPane.className = 'compare-inspector-content';
    rightWrap.append(this.rightDocumentPreview.element, this.rightPane);
    panes.append(leftWrap, rightWrap);

    const nav = document.createElement('div');
    nav.className = 'compare-inspector-nav';
    const prev = document.createElement('button');
    prev.className = 'dialog-btn';
    prev.textContent = '이전 차이';
    prev.addEventListener('click', () => {
      const item = this.store?.prevDiff();
      if (!item || !this.session) return;
      void this.focusDiff(this.session.currentDiffIndex);
    });
    const next = document.createElement('button');
    next.className = 'dialog-btn';
    next.textContent = '다음 차이';
    next.addEventListener('click', () => {
      const item = this.store?.nextDiff();
      if (!item || !this.session) return;
      void this.focusDiff(this.session.currentDiffIndex);
    });
    nav.append(prev, next);

    body.append(this.metaEl, panes, nav);
    this.wrap.append(head, body);
  }

  private highlightPreview(item: DiffItem, side: 'left' | 'right'): string {
    const severity = item.severity;
    let leftText: string;
    let rightText: string;
    if (item.kind === 'table' && severity === 'modified') {
      const narrowed = this.formatTableCprevChangedCellsOnly(
        item.leftPreview || '',
        item.rightPreview || '',
      );
      if (narrowed) {
        leftText = narrowed.left;
        rightText = narrowed.right;
      } else {
        leftText = this.formatInspectorText(item.leftPreview || '(없음)');
        rightText = this.formatInspectorText(item.rightPreview || '(없음)');
      }
    } else {
      leftText = this.formatInspectorText(item.leftPreview || '(없음)');
      rightText = this.formatInspectorText(item.rightPreview || '(없음)');
    }
    const raw = side === 'left' ? item.leftPreview : item.rightPreview;
    const text = side === 'left' ? leftText : rightText;
    if (isComparePreviewAbsent(raw)) {
      return `<pre>${this.escape(text)}</pre>`;
    }
    if (severity === 'added' && side === 'right') {
      return `<pre><mark>${this.escape(text)}</mark></pre>`;
    }
    if (severity === 'removed' && side === 'left') {
      return `<pre><mark>${this.escape(text)}</mark></pre>`;
    }
    if (severity !== 'modified') return `<pre>${this.escape(text)}</pre>`;

    const a = leftText;
    const b = rightText;
    let start = 0;
    const minLen = Math.min(a.length, b.length);
    while (start < minLen && a.charCodeAt(start) === b.charCodeAt(start)) start += 1;
    let enda = a.length - 1;
    let endb = b.length - 1;
    while (enda >= start && endb >= start && a.charCodeAt(enda) === b.charCodeAt(endb)) {
      enda -= 1;
      endb -= 1;
    }
    const source = side === 'left' ? a : b;
    const end = side === 'left' ? enda : endb;
    const before = source.slice(0, start);
    const changed = source.slice(start, end + 1);
    const after = source.slice(end + 1);
    if (!changed) return `<pre>${this.escape(source)}</pre>`;
    return this.renderFocusedDiff(before, changed, after);
  }

  /**
   * 표 텍스트 변경: `cprev`/`tprev` 셀 맵을 비교해 **값이 달라진 셀만** 좌·우 각각 한 줄씩 만든다.
   * (기존 `formatInspectorText`는 앞 5셀만 잘라 노이즈가 컸음.)
   */
  private formatTableCprevChangedCellsOnly(
    leftRaw: string,
    rightRaw: string,
  ): { left: string; right: string } | null {
    const lk = this.parseKvSummary(leftRaw);
    const rk = this.parseKvSummary(rightRaw);
    const pick = (kv: Record<string, string>) => {
      const cp = kv.cprev;
      if (cp && cp !== '(없음)') return cp;
      const tp = kv.tprev;
      if (tp && tp !== '(없음)') return tp;
      return '';
    };
    const lc = pick(lk);
    const rc = pick(rk);
    if (!lc && !rc) return null;
    const Lm = this.parseCellPreviewToMap(lc);
    const Rm = this.parseCellPreviewToMap(rc);
    if (Lm.size === 0 && Rm.size === 0) return null;
    const keys = new Set<string>([...Lm.keys(), ...Rm.keys()]);
    const changed: string[] = [];
    for (const k of keys) {
      if ((Lm.get(k) ?? '') !== (Rm.get(k) ?? '')) changed.push(k);
    }
    changed.sort((ka, kb) => {
      const ma = ka.match(/^r(\d+)c(\d+)$/i);
      const mb = kb.match(/^r(\d+)c(\d+)$/i);
      if (!ma || !mb) return ka.localeCompare(kb);
      const ra = Number(ma[1]);
      const ca = Number(ma[2]);
      const rb = Number(mb[1]);
      const cb = Number(mb[2]);
      return ra !== rb ? ra - rb : ca - cb;
    });
    if (changed.length === 0) return { left: '(셀 텍스트 동일)', right: '(셀 텍스트 동일)' };
    const cellLabel = (k: string) => k.replace(/^r(\d+)c(\d+)$/i, '$1행$2열');
    const left = changed.map((k) => `${cellLabel(k)}: ${Lm.get(k) ?? '(없음)'}`).join('\n');
    const right = changed.map((k) => `${cellLabel(k)}: ${Rm.get(k) ?? '(없음)'}`).join('\n');
    return { left, right };
  }

  private parseCellPreviewToMap(raw: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const [k, v] of this.parseCellPreview(raw)) m.set(k, v);
    return m;
  }

  private formatInspectorText(raw: string): string {
    if (!raw) return '(없음)';
    if (!raw.includes('=')) return raw;

    const kv = this.parseKvSummary(raw);
    if (Object.keys(kv).length === 0) return raw;

    const lines: string[] = [];
    const push = (label: string, value?: string) => {
      if (!value || value === '(없음)' || value === 'nopix' || value === 'nobox') return;
      lines.push(`${label}: ${value}`);
    };

    const cprev = kv.cprev;
    if (cprev && cprev !== '(없음)') {
      const cells = this.parseCellPreview(cprev);
      if (cells.length > 0) {
        for (const [cell, text] of cells.slice(0, 5)) {
          lines.push(`${cell.replace(/^r(\d+)c(\d+)$/i, '$1행$2열')}: ${text}`);
        }
        if (cells.length > 5) lines.push(`... 외 ${cells.length - 5}개 셀`);
      } else {
        push('셀 텍스트', cprev);
      }
    }

    push('행', kv.r);
    push('열', kv.c);
    push('크기', kv.box?.replace(/^(-?\d+)x(-?\d+)$/, '$1px × $2px'));
    push('텍스트', kv.text);
    push('자르기', kv.crop);
    push('효과', kv.effect);
    push('밝기/대비', kv.bc);
    push('회전', kv.rot ? `${kv.rot}도` : undefined);
    push('대칭', kv.flip);
    push('배치', kv.wrap);
    push('기준', kv.rel);

    if (lines.length === 0) return raw;
    return lines.join('\n');
  }

  private parseKvSummary(summary: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of summary.matchAll(/([a-z]+)=("([^"]*)"|[^\s]+)/g)) {
      const raw = m[2] ?? '';
      const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
      out[m[1]] = unquoted;
    }
    return out;
  }

  private parseCellPreview(raw: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const parts = raw.includes('&') ? raw.split('&') : raw.split(';');
    for (const p of parts) {
      const part = p.trim();
      if (!part) continue;
      const idx = part.indexOf('=');
      const legacyIdx = part.indexOf(':');
      const cut = idx > 0 ? idx : legacyIdx;
      if (cut <= 0) continue;
      const key = part.slice(0, cut).trim();
      const valRaw = part.slice(cut + 1).trim();
      let val = valRaw;
      try { val = decodeURIComponent(valRaw); } catch { val = valRaw; }
      out.push([key, val]);
    }
    return out;
  }

  private renderFocusedDiff(before: string, changed: string, after: string): string {
    const sideContext = 90;
    const hasBeforeTrim = before.length > sideContext;
    const hasAfterTrim = after.length > sideContext;
    const beforeSlice = hasBeforeTrim ? before.slice(before.length - sideContext) : before;
    const afterSlice = hasAfterTrim ? after.slice(0, sideContext) : after;
    const lead = hasBeforeTrim ? '…' : '';
    const tail = hasAfterTrim ? '…' : '';
    return `<pre>${this.escape(lead + beforeSlice)}<mark>${this.escape(changed)}</mark>${this.escape(afterSlice + tail)}</pre>`;
  }

  private escape(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  private async ensureCompareDocumentsLoaded(): Promise<void> {
    if (!this.leftSource || !this.rightSource) return;
    await Promise.all([
      this.leftDocumentPreview.load(this.leftSource),
      this.rightDocumentPreview.load(this.rightSource),
    ]);
  }

  private renderRealDocumentPreview(item: DiffItem): void {
    // Added/removed items often only carry an anchor on one side. The shared
    // pane resolves each side's alignment context through that document's own
    // layout, preserving the comparison window's pagination-safe fallback.
    this.leftDocumentPreview.focus(item.leftAnchor ?? null, item.contextOnLeft);
    this.rightDocumentPreview.focus(item.rightAnchor ?? null, item.contextOnRight);
  }

}
