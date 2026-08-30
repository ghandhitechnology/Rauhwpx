import { DocumentPreviewPane } from '../merge/document-preview-pane.ts';
import type { CloudCheckpointPayload, CloudDownloadResult } from './types.ts';
import type { WorkspaceBinding } from './workspace-state.ts';
import './cloud-document-preview.css';

type CloudBinding = Extract<WorkspaceBinding, { kind: 'cloud' }>;

export interface CloudPreviewStage {
  readonly token: symbol;
}

interface CloudPreviewStageRecord {
  pane: DocumentPreviewPane;
  bindingKey: string;
  epoch: number;
  source: { fileName: string; status: string };
  settled: boolean;
  cancelled: boolean;
  disposed: boolean;
}

function bindingKey(binding: CloudBinding): string {
  return `${binding.sessionId}:${binding.generation}`;
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 14 ? `${sessionId.slice(0, 7)}…${sessionId.slice(-5)}` : sessionId;
}

export class CloudDocumentPreview {
  readonly element: HTMLElement;
  private pane: DocumentPreviewPane;
  private readonly stagingHost: HTMLElement;
  private readonly metadata: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly localScroll: HTMLElement | null;
  private epoch = 0;
  private latestStageToken: symbol | null = null;
  private readonly stages = new Map<symbol, CloudPreviewStageRecord>();
  private localScrollWasInert = false;
  private localScrollAriaHidden: string | null = null;
  private localScrollObscured = false;

  constructor(editorArea: HTMLElement) {
    this.element = document.createElement('section');
    this.element.className = 'cloud-document-preview';
    this.element.hidden = true;
    this.element.tabIndex = -1;
    this.element.setAttribute('aria-label', '클라우드 문서 미리보기');
    this.metadata = document.createElement('div');
    this.metadata.className = 'cloud-document-preview-meta';
    this.loading = document.createElement('div');
    this.loading.className = 'cloud-document-preview-loading';
    this.loading.textContent = '클라우드 문서를 불러오는 중입니다…';
    this.loading.hidden = true;
    this.pane = new DocumentPreviewPane({
      role: 'comparison-left',
      title: '클라우드 문서',
      variant: 'comparison',
    });
    this.stagingHost = document.createElement('div');
    this.stagingHost.className = 'cloud-document-preview-staging';
    this.stagingHost.setAttribute('aria-hidden', 'true');
    this.localScroll = editorArea.querySelector<HTMLElement>('#scroll-container');
    this.element.append(this.metadata, this.pane.element, this.loading);
    editorArea.append(this.element, this.stagingHost);
  }

  async stageCheckpoint(
    checkpoint: CloudCheckpointPayload,
    binding: CloudBinding,
  ): Promise<CloudPreviewStage | null> {
    return this.stage(
      checkpoint.bytes,
      checkpoint.fileName,
      `Cloud · ${shortSessionId(binding.sessionId)} · revision ${checkpoint.revision} · ${checkpoint.turn}턴`,
      binding,
    );
  }

  async stageResult(result: CloudDownloadResult, binding: CloudBinding): Promise<CloudPreviewStage | null> {
    return this.stage(
      result.bytes,
      result.fileName,
      `Cloud · ${shortSessionId(binding.sessionId)} · 완료 결과`,
      binding,
    );
  }

  canCommit(stage: CloudPreviewStage, binding: CloudBinding): boolean {
    const record = this.stages.get(stage.token);
    return Boolean(record
      && !record.cancelled
      && record.settled
      && record.epoch === this.epoch
      && record.bindingKey === bindingKey(binding)
      && this.latestStageToken === stage.token);
  }

  commit(stage: CloudPreviewStage, binding: CloudBinding): boolean {
    if (!this.canCommit(stage, binding)) return false;
    const record = this.stages.get(stage.token)!;
    const previousPane = this.pane;
    const restoreFocus = previousPane.element.contains(document.activeElement);
    previousPane.element.replaceWith(record.pane.element);
    this.pane = record.pane;
    this.stages.delete(stage.token);
    this.latestStageToken = null;
    previousPane.dispose();
    this.metadata.textContent = record.source.status;
    this.element.hidden = false;
    this.loading.hidden = true;
    this.setLocalScrollObscured(true);
    if (restoreFocus) {
      const target = this.pane.element.querySelector<HTMLElement>('button, input, [tabindex]');
      (target ?? this.element).focus({ preventScroll: true });
    }
    return true;
  }

  cancel(stage: CloudPreviewStage): void {
    const record = this.stages.get(stage.token);
    if (!record) return;
    record.cancelled = true;
    this.stages.delete(stage.token);
    if (this.latestStageToken === stage.token) this.latestStageToken = null;
    if (record.settled) this.disposeStageRecord(record);
  }

  hide(): void {
    const restoreFocus = this.element.contains(document.activeElement);
    this.epoch += 1;
    this.cancelStages();
    this.element.hidden = true;
    this.loading.hidden = true;
    this.setLocalScrollObscured(false);
    if (restoreFocus) this.localScroll?.focus({ preventScroll: true });
  }

  dispose(): void {
    this.hide();
    this.pane.dispose();
    this.element.remove();
    this.stagingHost.remove();
  }

  private async stage(
    bytes: Uint8Array,
    fileName: string,
    status: string,
    binding: CloudBinding,
  ): Promise<CloudPreviewStage | null> {
    if (this.latestStageToken) this.cancel({ token: this.latestStageToken });
    const stage = { token: Symbol('cloud-preview-stage') } satisfies CloudPreviewStage;
    const pane = new DocumentPreviewPane({
      role: 'comparison-left',
      title: fileName,
      variant: 'comparison',
    });
    const record: CloudPreviewStageRecord = {
      pane,
      bindingKey: bindingKey(binding),
      epoch: this.epoch,
      source: { fileName, status },
      settled: false,
      cancelled: false,
      disposed: false,
    };
    this.latestStageToken = stage.token;
    this.stages.set(stage.token, record);
    this.stagingHost.appendChild(pane.element);
    let loaded = false;
    try {
      loaded = await pane.load({ bytes, fileName, label: fileName });
    } catch (error) {
      record.settled = true;
      this.releaseStage(stage.token, record);
      throw error;
    }
    record.settled = true;
    if (!loaded || record.cancelled || record.epoch !== this.epoch
      || this.latestStageToken !== stage.token || !this.stages.has(stage.token)) {
      this.releaseStage(stage.token, record);
      return null;
    }
    return stage;
  }

  private cancelStages(): void {
    this.latestStageToken = null;
    for (const [token, record] of this.stages) {
      record.cancelled = true;
      this.stages.delete(token);
      if (record.settled) this.disposeStageRecord(record);
    }
  }

  private releaseStage(token: symbol, record: CloudPreviewStageRecord): void {
    this.stages.delete(token);
    if (this.latestStageToken === token) this.latestStageToken = null;
    this.disposeStageRecord(record);
  }

  private disposeStageRecord(record: CloudPreviewStageRecord): void {
    if (record.disposed) return;
    record.disposed = true;
    record.pane.dispose();
    record.pane.element.remove();
  }

  private setLocalScrollObscured(obscured: boolean): void {
    if (!this.localScroll) return;
    if (obscured) {
      if (this.localScrollObscured) return;
      this.localScrollObscured = true;
      this.localScrollWasInert = this.localScroll.inert;
      this.localScrollAriaHidden = this.localScroll.getAttribute('aria-hidden');
      this.localScroll.inert = true;
      this.localScroll.setAttribute('aria-hidden', 'true');
      return;
    }
    if (!this.localScrollObscured) return;
    this.localScrollObscured = false;
    this.localScroll.inert = this.localScrollWasInert;
    if (this.localScrollAriaHidden === null) this.localScroll.removeAttribute('aria-hidden');
    else this.localScroll.setAttribute('aria-hidden', this.localScrollAriaHidden);
  }
}
