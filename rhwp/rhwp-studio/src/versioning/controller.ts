import type { CloudCheckpointPayload } from '../cloud/types.ts';
import type { AgentBridge } from '../agent/bridge.ts';
import type { CheckpointTitleSummary } from '../agent/types.ts';
import { CompareSessionStore } from '../compare/session.ts';
import { compareDocuments, compareSnapshots } from '../compare/diff-engine.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { DocumentDirtyState } from '../core/document-dirty-state.ts';
import { INSERTED_IMAGE_MAX_BYTES, readBlobBytesWithLimit } from '../core/document-input-limits.ts';
import { WasmBridge } from '../core/wasm-bridge.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import {
  MergeResolverWindow,
  MergeWorkerClient,
  type MergeAnalysis,
  type MergeApplicationRequest,
  type MergeAppliedReceipt,
  type MaterializedMergeResult,
} from '../merge/index.ts';
import { MERGE_ANALYSIS_VERSION, MERGE_MANIFEST_VERSION } from '../merge/manifest.ts';
import { getHistoryPayload, listHistoryMeta } from '../history/idb-store.ts';
import { showPendingAgentEditsDialog } from '../ui/pending-agent-edits-dialog.ts';
import { prepareUncommittedMerge } from '../ui/version-merge-preparation.ts';
import { CompareResultWindow } from '../ui/compare-result-window.ts';
import type {
  LegacyVersionView,
  VersionBranchView,
  VersionCommitView,
  VersionManagerController,
  VersionManagerState,
  VersionMergeDraftView,
  VersionShelfView,
} from '../ui/agent-sidebar/version-manager.ts';
import {
  VersionGraphStore,
  branchName,
  commitId,
  createPortableHistoryArchive,
  documentId,
  layoutCommitGraph,
  orderBranchHeadFrontier,
  type PortableHistoryArchive,
  shelfId,
  mergeDraftId,
  tagName,
  VersionError,
  type BranchName,
  type BranchRef,
  type CommitId,
  type VersionCommit,
  type VersionRef,
  type VersionRepository,
  type VersionShelf,
  type VersionMergeDraft,
  type VersionMergeManifest,
  type VersionBlob,
  type MergeResolution,
} from './index.ts';
import { hashBytes, fingerprintBytes } from './hash.ts';
import {
  commitCompositeMerge,
  reconcileCompositeEditor,
  reconcileCompositeHistoryTransition,
} from './composite-merge.ts';
import { mergeResourceDependencyErrors } from './merge-validation.ts';
import { retainedMergeDraftLocalState } from './merge-draft.ts';
import {
  VERSION_COMPARE_OPTIONS,
  analyzeVersionDiff,
  captureVersionSnapshot,
  fingerprintVersionContent,
  type CapturedVersionSnapshot,
} from './snapshot.ts';

const PAGE_SIZE = 100;
const ACTIVE_BRANCH_PREFIX = 'rhwp-versions-active-branch-v1:';
const AI_TITLES_KEY = 'rhwp-versions-ai-titles-v1';

type CheckpointReason = 'manual' | 'save' | 'export' | 'agent' | 'pre-restore' | 'pre-switch' | 'pre-merge' | 'merge' | 'restore' | 'adopt';

interface VersionControllerDeps {
  store?: VersionGraphStore;
  wasm: WasmBridge;
  eventBus: EventBus;
  documentState: DocumentDirtyState;
  getInputHandler: () => InputHandler | null;
  getDocumentId: () => string | null;
  agentBridge: AgentBridge;
  autoEnable?: () => boolean;
}

interface CreateCheckpointOptions {
  reason: CheckpointReason;
  message?: string;
  allowSameContent?: boolean;
  parents?: readonly [CommitId] | readonly [CommitId, CommitId];
  lastSaved?: boolean;
  author?: { kind: 'user' | 'system' | 'agent'; label: string };
  merge?: import('./types.ts').VersionMergeMetadata;
  onPersisted?: () => void;
}

interface WorkspaceToken {
  documentId: string;
  editorRevision: number;
  repositoryId: string | null;
  repositoryRevision: number | null;
}

function emptyState(): VersionManagerState {
  return {
    documentId: null,
    documentName: null,
    saved: false,
    enabled: false,
    dirty: false,
    mutationBlockedReason: null,
    activeBranch: null,
    commits: [],
    branches: [],
    shelves: [],
    mergeDrafts: [],
    legacy: [],
    hasMoreCommits: false,
    loading: false,
    storageBytes: 0,
    storageQuotaBytes: null,
    aiTitlesEnabled: readAiTitlesEnabled(),
  };
}

function readAiTitlesEnabled(): boolean {
  try {
    return localStorage.getItem(AI_TITLES_KEY) !== '0';
  } catch {
    return true;
  }
}

function timestampTitle(now = Date.now()): string {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(now));
}

function errorMessage(error: unknown): string {
  if (!(error instanceof VersionError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const messages: Partial<Record<VersionError['code'], string>> = {
    SAVE_REQUIRED: '먼저 문서를 저장하세요.',
    VERSIONING_DISABLED: '이 문서에서 버전 기록을 먼저 켜세요.',
    ACTIVE_AGENT_TURN: '에이전트가 응답 중일 때는 버전을 바꿀 수 없습니다.',
    PENDING_AGENT_REVIEW: '대기 중인 에이전트 편집을 먼저 처리하세요.',
    STALE_WORKSPACE: '다른 작업이 버전 기록을 바꿨습니다. 새로 고친 뒤 다시 시도하세요.',
    BRANCH_EXISTS: '같은 이름의 브랜치가 이미 있습니다.',
    TAG_EXISTS: '같은 이름의 태그가 이미 있습니다.',
    INVALID_REF_NAME: '사용할 수 없는 이름입니다.',
    CURRENT_BRANCH: '현재 브랜치는 삭제할 수 없습니다.',
    LAST_BRANCH: '마지막 브랜치는 삭제할 수 없습니다.',
    NO_CHANGES: '이미 커밋한 내용입니다.',
    CORRUPT_BLOB: '저장된 버전 데이터가 손상되어 작업을 중단했습니다.',
    RESTORE_PARSE_FAILED: '이 버전을 안전하게 읽지 못해 현재 문서를 바꾸지 않았습니다.',
    STORAGE_QUOTA: '버전 저장 공간이 부족합니다. 사용하지 않는 데이터를 정리하세요.',
  };
  return messages[error.code] ?? error.message;
}

function branchStorageKey(id: string): string {
  return `${ACTIVE_BRANCH_PREFIX}${id}`;
}

function readActiveBranch(id: string): string | null {
  try {
    return localStorage.getItem(branchStorageKey(id));
  } catch {
    return null;
  }
}

export function persistActiveBranch(id: string, branch: string): void {
  try {
    localStorage.setItem(branchStorageKey(id), branch);
  } catch {
    // The active branch still survives for this session in controller state.
  }
}

function tagForMessage(message: string, refs: readonly VersionRef[]): string {
  const base = message.normalize('NFC').trim().replace(/[\u0000-\u001f\u007f/\\]/g, ' ').slice(0, 64).trim()
    || timestampTitle();
  const occupied = new Set(refs.filter((ref) => ref.kind === 'tag').map((ref) => ref.name.toLowerCase()));
  if (!occupied.has(base.toLowerCase())) return base;
  const suffix = ` ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
  return `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
}

function mergeDocumentFormat(bytes: Uint8Array): 'hwp' | 'hwpx' {
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length >= ole.length && ole.every((value, index) => bytes[index] === value)) return 'hwp';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'hwpx';
  throw new VersionError('MERGE_VALIDATION_FAILED', 'HWP와 HWPX 문서만 병합할 수 있습니다.');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function manualAssetIds(resolutions: Readonly<Record<string, MergeResolution>>): VersionBlob['id'][] {
  const ids = new Set<VersionBlob['id']>();
  for (const resolution of Object.values(resolutions)) {
    if (resolution.kind !== 'manual' || !resolution.payload || typeof resolution.payload !== 'object') continue;
    const id = (resolution.payload as Record<string, unknown>).assetBlobId;
    if (typeof id === 'string') ids.add(id as VersionBlob['id']);
  }
  return [...ids];
}

function createMergeDraftId(): ReturnType<typeof mergeDraftId> {
  return mergeDraftId(globalThis.crypto?.randomUUID?.()
    ?? `merge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`);
}

export class DocumentVersionController implements VersionManagerController {
  readonly #store: VersionGraphStore;
  readonly #wasm: WasmBridge;
  readonly #eventBus: EventBus;
  readonly #documentState: DocumentDirtyState;
  readonly #getInputHandler: () => InputHandler | null;
  readonly #getDocumentId: () => string | null;
  readonly #agentBridge: AgentBridge;
  readonly #autoEnable: () => boolean;
  readonly #ownsStore: boolean;
  readonly #listeners = new Set<(state: VersionManagerState) => void>();
  readonly #unsubscribers: Array<() => void> = [];
  readonly #compareStore: CompareSessionStore;
  readonly #compareWindow = new CompareResultWindow();
  readonly #mergeWorker = new MergeWorkerClient();
  readonly #mergeResolver = new MergeResolverWindow();
  #state = emptyState();
  #repository: VersionRepository | null = null;
  #savedBaseline: { documentId: string; capture: CapturedVersionSnapshot } | null = null;
  #refs: VersionRef[] = [];
  #commits: VersionCommit[] = [];
  #shelves: VersionShelf[] = [];
  #mergeDrafts: VersionMergeDraft[] = [];
  #activeBranch: BranchName | null = null;
  readonly #activeBranches = new Map<string, BranchName>();
  #editorRevision = 0;
  #semanticDirty = false;
  #semanticDirtyRevision = -1;
  #refreshEpoch = 0;
  #operation = Promise.resolve();
  #mergeResolverActive = false;
  #mergeCompletion: Promise<boolean> | null = null;
  #mergeLockedHandler: InputHandler | null = null;
  #mergePreviousUserEditingLocked = false;
  readonly #pendingMergeFinalizers = new WeakMap<
    MergeAppliedReceipt,
    (disposition: 'keep' | 'delete') => Promise<void>
  >();

  constructor(deps: VersionControllerDeps) {
    this.#store = deps.store ?? new VersionGraphStore();
    this.#ownsStore = !deps.store;
    this.#wasm = deps.wasm;
    this.#eventBus = deps.eventBus;
    this.#documentState = deps.documentState;
    this.#getInputHandler = deps.getInputHandler;
    this.#getDocumentId = deps.getDocumentId;
    this.#agentBridge = deps.agentBridge;
    this.#autoEnable = deps.autoEnable ?? (() => false);
    this.#compareStore = new CompareSessionStore(this.#eventBus);

    const documentChanged = () => {
      this.#editorRevision += 1;
      this.#syncTransientState();
    };
    this.#unsubscribers.push(
      this.#eventBus.on('document-mutated', documentChanged),
      this.#eventBus.on('document-changed', documentChanged),
      this.#eventBus.on('document-dirty-changed', () => this.#syncTransientState()),
      this.#eventBus.on('document-context-changed', () => {
        this.#editorRevision += 1;
        void this.refresh();
      }),
      this.#eventBus.on('document-saved', () => {
        // A file save updates disk state; only an explicit commit advances HEAD.
        const id = this.#getDocumentId();
        const capture = this.#wasm.hasLoadedDocument() ? captureVersionSnapshot(this.#wasm) : null;
        if (id && capture) this.#savedBaseline = { documentId: id, capture };
        void this.#enqueue(async () => {
          if (!capture || id !== this.#getDocumentId()) return;
          await this.#refreshData(false);
          if (!this.#repository || id !== this.#getDocumentId()) return;
          this.#repository = await this.#store.markSaved(
            this.#repository.id, capture.fingerprint, this.#repository.revision,
          );
          await this.#refreshData(false);
        }).catch((error) => console.warn('Version save state could not be updated', error));
      }),
      this.#agentBridge.onEvent(() => this.#syncTransientState()),
      this.#agentBridge.pendingEdits.onChange(() => this.#syncTransientState()),
    );
  }

  getState(): VersionManagerState {
    return structuredClone(this.#state);
  }

  subscribe(listener: (state: VersionManagerState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async documentLoaded(): Promise<void> {
    const id = this.#getDocumentId();
    if (id && !this.#wasm.isNewDocument && !this.#documentState.isDirty()) {
      this.#savedBaseline = { documentId: id, capture: captureVersionSnapshot(this.#wasm) };
    } else {
      this.#savedBaseline = null;
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    await this.#enqueue(() => this.#refreshData(true));
  }

  async whenIdle(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.#operation;
      await pending;
    } while (pending !== this.#operation);
  }

  async enable(): Promise<void> {
    await this.#enqueue(() => this.#enableVersioning());
  }

  async #enableVersioning(): Promise<void> {
      this.#guardSaved();
      await this.#guardMutation();
      const baseline = this.#savedBaseline?.documentId === this.#getDocumentId() ? this.#savedBaseline.capture : null;
      if (this.#documentState.isDirty() && !baseline) {
        throw new VersionError('SAVE_REQUIRED', 'Save the document before enabling version history');
      }
      const id = this.#getDocumentId();
      if (!id) throw new VersionError('SAVE_REQUIRED', 'A saved document ID is required');
      const workspace = this.#captureWorkspaceToken();
      const existing = await this.#store.findRepositoryByDocumentId(documentId(id));
      this.#assertWorkspaceToken(workspace, { editor: false });
      if (existing) {
        await this.#refreshData(true);
        return;
      }
      const capture = baseline ?? captureVersionSnapshot(this.#wasm);
      const mergeManifestEntries = await this.#mergeWorker.buildDocumentManifest(capture.bytes);
      this.#assertWorkspaceToken(workspace, { editor: false });
      const analysis = analyzeVersionDiff(null, capture.compareSnapshot);
      const createdAt = Date.now();
      const result = await this.#store.createRepository({
        documentId: documentId(id),
        initialBranch: branchName('main'),
        lastSavedFingerprint: capture.fingerprint,
        initial: {
          bytes: capture.bytes,
          compareSnapshot: capture.compareSnapshot,
          contentFingerprint: capture.fingerprint,
          title: timestampTitle(createdAt),
          titleOrigin: 'timestamp',
          titleRevision: 0,
          author: { kind: 'user', label: '사용자' },
          stats: analysis.stats,
          createdAt,
          mergeManifestEntries,
        },
      });
      if (!this.#isWorkspaceTokenCurrent(workspace, { editor: false })) return;
      this.#repository = result.repository;
      this.#activeBranch = result.branch.name;
      this.#activeBranches.set(id, result.branch.name);
      persistActiveBranch(id, result.branch.name);
      await this.#refreshData(true);
      this.#requestGeneratedTitle(result.commit, analysis.titleSummary);
  }

  /** Persist the exact handoff without committing or replacing the local working tree. */
  async prepareCloudBranch(startId: string, bytes: Uint8Array, fileName: string): Promise<Uint8Array> {
    return this.#enqueue(async () => {
      await this.#refreshData(false);
      if (!this.#repository) await this.#enableVersioning();
      await this.#guardMutation();
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      const anchorId = commitId(`cloud-base:${repository.id}:${startId}`);
      const existing = await this.#store.getCommit(anchorId);
      if (existing) {
        const blob = await this.#store.getBlob(existing.blobId);
        this.#assertWorkspaceToken(workspace);
        if (!blob) throw new VersionError('CORRUPT_BLOB', 'Cloud 시작 문서를 찾을 수 없습니다.');
        return blob.bytes;
      }
      const capture = await this.#captureIncoming(bytes, fileName);
      this.#assertWorkspaceToken(workspace);
      const name = this.#cloudBranchName(startId);
      let branch = await this.#store.getBranch(repository.id, name);
      if (!branch) {
        const created = await this.#store.createBranch({
          repositoryId: repository.id, name, target: this.#requireActiveBranch().target,
          expectedRepositoryRevision: repository.revision,
        });
        this.#repository = created.repository;
        branch = created.branch;
      }
      await this.#appendBranchSnapshot(branch, capture, 'Cloud 시작 문서', 'agent', anchorId);
      return bytes;
    });
  }

  async mergeCloudCheckpoint(startId: string, checkpoint: CloudCheckpointPayload): Promise<boolean> {
    const source = await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation(true);
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      if (checkpoint.documentId !== workspace.documentId || checkpoint.kind !== 'turn'
        || !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1) {
        throw new Error('이 문서의 완료된 Cloud 작업만 병합할 수 있습니다.');
      }
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', checkpoint.bytes.slice().buffer))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== checkpoint.sha256 || checkpoint.bytes.length !== checkpoint.byteLength) {
        throw new VersionError('CORRUPT_BLOB', 'Cloud 문서 검증에 실패했습니다. 다시 다운로드하세요.');
      }
      const name = this.#cloudBranchName(startId);
      const anchor = await this.#store.getCommit(commitId(`cloud-base:${repository.id}:${startId}`));
      const branch = await this.#store.getBranch(repository.id, name);
      if (!anchor || !branch) {
        throw new Error('이 기기에 병합에 필요한 Cloud 시작 기록이 없습니다. Cloud 상태에서 완료 문서를 사본으로 저장할 수 있습니다.');
      }
      if (branch.name === this.#requireActiveBranch().name) {
        throw new Error('Cloud 결과를 받을 로컬 브랜치를 먼저 선택하세요.');
      }
      const id = commitId(`cloud:${repository.id}:${checkpoint.sessionId}:${checkpoint.revision}`);
      const existing = await this.#store.getCommit(id);
      if (existing) {
        if (existing.blobId !== hashBytes(checkpoint.bytes)) {
          throw new VersionError('CORRUPT_BLOB', '같은 Cloud 버전의 문서 내용이 달라졌습니다.');
        }
        if (existing.id !== branch.target) {
          const relation = await this.#store.getMergeRelation(repository.id, this.#requireActiveBranch().target, existing.id);
          this.#assertWorkspaceToken(workspace);
          if (relation.relation === 'already-integrated') return { name, integrated: true };
          throw new VersionError('STALE_WORKSPACE', '더 최신 Cloud 변경을 이미 가져왔습니다. 최신 작업을 선택하세요.');
        }
      } else {
        // Pin the source head. An old or replayed boundary must never move it backwards.
        const head = await this.#requireCommit(branch.target);
        const prefix = `cloud:${repository.id}:${checkpoint.sessionId}:`;
        if (head.id.startsWith(prefix) && Number(head.id.slice(prefix.length)) >= checkpoint.revision) {
          throw new VersionError('STALE_WORKSPACE', '더 최신 Cloud 변경을 이미 가져왔습니다.');
        }
        const capture = await this.#captureIncoming(checkpoint.bytes, checkpoint.fileName);
        this.#assertWorkspaceToken(workspace);
        await this.#appendBranchSnapshot(branch, capture, `Cloud · ${checkpoint.turn}턴`, 'agent', id);
      }
      const latest = await this.#store.getBranch(repository.id, name);
      const relation = await this.#store.getMergeRelation(repository.id, this.#requireActiveBranch().target, latest!.target);
      return { name, integrated: relation.relation === 'already-integrated' };
    });
    if (source.integrated) return true;
    this.#mergeCompletion = null;
    await this.startMerge(source.name);
    return this.#mergeCompletion ? await this.#mergeCompletion : false;
  }

  #cloudBranchName(startId: string): BranchName {
    return branchName(`Cloud ${hashBytes(new TextEncoder().encode(startId)).slice(7, 23)}`);
  }

  async #captureIncoming(bytes: Uint8Array, fileName: string): Promise<CapturedVersionSnapshot> {
    const parsed = new WasmBridge();
    await parsed.initialize();
    try {
      parsed.loadDocument(bytes, fileName);
      const snapshot = captureVersionSnapshot(parsed);
      // Keep authenticated transfer bytes, even when the parser normalizes an export.
      return { ...snapshot, bytes, fingerprint: fingerprintBytes(bytes) };
    } finally {
      parsed.releaseDocument();
    }
  }

  async checkpoint(message?: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation();
      await this.#createCheckpoint({ reason: 'manual', message });
    });
  }

  async loadMore(): Promise<void> {
    await this.#enqueue(async () => {
      if (!this.#repository || this.#commits.length === 0) return;
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#repository;
      this.#state.loading = true;
      this.#emit();
      try {
        const beforeOrdinal = Math.min(...this.#commits.map((commit) => commit.ordinal));
        const next = await this.#store.listCommits(repository.id, { beforeOrdinal, limit: PAGE_SIZE });
        this.#assertWorkspaceToken(workspace, { editor: false });
        const existing = new Set(this.#commits.map((commit) => commit.id));
        this.#commits.push(...next.filter((commit) => !existing.has(commit.id)));
        await this.#buildState(next.length === PAGE_SIZE);
      } finally {
        if (this.#state.loading) {
          this.#state.loading = false;
          this.#emit();
        }
      }
    });
  }

  async restore(id: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation(true);
      await this.#checkpointDirty('pre-restore');
      const workspace = this.#captureWorkspaceToken();
      const target = await this.#requireCommit(id);
      const [blob, stored] = await Promise.all([
        this.#store.getBlob(target.blobId),
        this.#store.getCompareSnapshot(target.compareSnapshotId),
      ]);
      this.#assertWorkspaceToken(workspace);
      if (!blob || !stored) throw new VersionError('CORRUPT_BLOB', 'Version data is missing');
      const handler = this.#requireInputHandler();
      const original = captureVersionSnapshot(this.#wasm);
      const wasDirty = this.#documentState.isDirty();
      handler.prepareSnapshotCapacity(4);
      try {
        handler.replaceContentFromBytes(blob.bytes);
      } catch (error) {
        throw new VersionError('RESTORE_PARSE_FAILED', 'Version bytes could not be restored', {
          cause: error instanceof Error ? error : undefined,
        });
      }
      this.#setDirtyForFingerprint(target.contentFingerprint, 'version-restore');
      const replacementWorkspace = this.#captureWorkspaceToken();
      let persisted = false;
      try {
        await this.#createCheckpoint({
          reason: 'restore',
          allowSameContent: true,
          onPersisted: () => { persisted = true; },
        }, {
          bytes: blob.bytes,
          fingerprint: target.contentFingerprint,
          compareSnapshot: stored.snapshot,
        });
      } catch (error) {
        if (!persisted) this.#rollbackReplacement(handler, original, wasDirty, replacementWorkspace);
        throw error;
      }
      this.#eventBus.emit('document-context-changed');
    });
  }

  async adopt(id: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation(true);
      await this.#checkpointDirty('pre-restore');
      const workspace = this.#captureWorkspaceToken();
      const branch = this.#requireActiveBranch();
      const target = await this.#requireCommit(id);
      if (target.id === branch.target) return;
      const [blob, stored] = await Promise.all([
        this.#store.getBlob(target.blobId),
        this.#store.getCompareSnapshot(target.compareSnapshotId),
      ]);
      this.#assertWorkspaceToken(workspace);
      if (!blob || !stored) throw new VersionError('CORRUPT_BLOB', 'Version data is missing');
      const handler = this.#requireInputHandler();
      const original = captureVersionSnapshot(this.#wasm);
      const wasDirty = this.#documentState.isDirty();
      handler.prepareSnapshotCapacity(4);
      try {
        handler.replaceContentFromBytes(blob.bytes);
      } catch (error) {
        throw new VersionError('RESTORE_PARSE_FAILED', 'Version bytes could not be adopted', {
          cause: error instanceof Error ? error : undefined,
        });
      }
      this.#setDirtyForFingerprint(target.contentFingerprint, 'version-adopt');
      const replacementWorkspace = this.#captureWorkspaceToken();
      let persisted = false;
      try {
        await this.#createCheckpoint({
          reason: 'adopt',
          allowSameContent: true,
          parents: [branch.target, target.id],
          onPersisted: () => { persisted = true; },
        }, {
          bytes: blob.bytes,
          fingerprint: target.contentFingerprint,
          compareSnapshot: stored.snapshot,
        });
      } catch (error) {
        if (!persisted) this.#rollbackReplacement(handler, original, wasDirty, replacementWorkspace);
        throw error;
      }
      this.#eventBus.emit('document-context-changed');
    });
  }

  async compare(id: string): Promise<void> {
    await this.#enqueue(async () => {
      const workspace = this.#captureWorkspaceToken();
      const target = await this.#requireCommit(id);
      const [stored, blob] = await Promise.all([
        this.#store.getCompareSnapshot(target.compareSnapshotId),
        this.#store.getBlob(target.blobId),
      ]);
      this.#assertWorkspaceToken(workspace);
      if (!stored || !blob) throw new VersionError('CORRUPT_BLOB', 'Version comparison data is missing');
      const current = captureVersionSnapshot(this.#wasm);
      const session = compareSnapshots(stored.snapshot, current.compareSnapshot, VERSION_COMPARE_OPTIONS);
      this.#assertWorkspaceToken(workspace);
      this.#compareStore.set(session);
      this.#compareWindow.show(session, this.#compareStore, 0, {
        left: { bytes: blob.bytes, fileName: `${target.title}.hwp` },
        right: { bytes: current.bytes, fileName: this.#wasm.fileName },
      });
    });
  }

  async amendTitle(id: string, title: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation();
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      const branch = this.#requireActiveBranch();
      const commit = await this.#requireCommit(id);
      this.#assertWorkspaceToken(workspace);
      if (commit.id !== branch.target) throw new Error('현재 커밋의 메시지만 수정할 수 있습니다.');
      await this.#store.updateCommitTitle({
        repositoryId: repository.id,
        commitId: commit.id,
        expectedTitleRevision: commit.titleRevision,
        title: title.trim(),
        titleOrigin: 'manual',
        titleRevision: commit.titleRevision,
      });
      await this.#refreshData(true);
    });
  }

  async createBranch(name: string, fromCommit?: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation(true);
      await this.#checkpointDirty('pre-switch');
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      const current = this.#requireActiveBranch();
      const target = fromCommit ? await this.#requireCommit(fromCommit) : await this.#requireCommit(current.target);
      const [blob, previousCommit] = await Promise.all([
        this.#store.getBlob(target.blobId),
        this.#requireCommit(current.target),
      ]);
      this.#assertWorkspaceToken(workspace);
      if (!blob) throw new VersionError('CORRUPT_BLOB', 'Branch bytes are missing');
      const handler = this.#requireInputHandler();
      handler.prepareSnapshotCapacity(2);
      const created = await this.#store.createBranch({
        repositoryId: repository.id,
        name: branchName(name),
        target: target.id,
        expectedRepositoryRevision: repository.revision,
      });
      try {
        this.#assertWorkspaceToken(workspace);
        this.#repository = created.repository;
        this.#applyBranchContent(handler, blob.bytes, target, created.branch, current, previousCommit);
      } catch (error) {
        const compensated = await this.#store.deleteBranch({
          repositoryId: created.repository.id,
          branch: created.branch.name,
          currentBranch: current.name,
          expectedRepositoryRevision: created.repository.revision,
          expectedBranchRevision: created.branch.revision,
        }).catch(() => created.repository);
        if (this.#isWorkspaceTokenCurrent(workspace, { editor: false, repository: false })) {
          this.#repository = compensated;
        }
        throw error;
      }
      await this.#refreshData(true);
    });
  }

  async switchBranch(name: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation(true);
      await this.#checkpointDirty('pre-switch');
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      const previous = this.#requireActiveBranch();
      const next = await this.#store.getBranch(repository.id, branchName(name));
      if (!next) throw new VersionError('REF_NOT_FOUND', 'Branch was not found');
      if (next.name === previous.name) return;
      const [target, previousCommit] = await Promise.all([
        this.#requireCommit(next.target),
        this.#requireCommit(previous.target),
      ]);
      const blob = await this.#store.getBlob(target.blobId);
      this.#assertWorkspaceToken(workspace);
      if (!blob) throw new VersionError('CORRUPT_BLOB', 'Branch bytes are missing');
      const [freshRepository, freshNext, freshPrevious] = await Promise.all([
        this.#store.getRepository(repository.id),
        this.#store.getBranch(repository.id, next.name),
        this.#store.getBranch(repository.id, previous.name),
      ]);
      this.#assertWorkspaceToken(workspace);
      if (
        !freshRepository
        || freshRepository.revision !== repository.revision
        || !freshNext
        || freshNext.revision !== next.revision
        || freshNext.target !== next.target
        || !freshPrevious
        || freshPrevious.revision !== previous.revision
        || freshPrevious.target !== previous.target
      ) {
        throw new VersionError('STALE_WORKSPACE', 'A branch changed before it could be switched');
      }
      const handler = this.#requireInputHandler();
      handler.prepareSnapshotCapacity(2);
      this.#applyBranchContent(handler, blob.bytes, target, next, previous, previousCommit);
      await this.#refreshData(true);
    });
  }

  async renameBranch(name: string, nextName: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation();
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      const branch = await this.#store.getBranch(repository.id, branchName(name));
      this.#assertWorkspaceToken(workspace);
      if (!branch) throw new VersionError('REF_NOT_FOUND', 'Branch was not found');
      const result = await this.#store.renameBranch({
        repositoryId: repository.id,
        branch: branch.name,
        name: branchName(nextName),
        expectedRepositoryRevision: repository.revision,
        expectedBranchRevision: branch.revision,
      });
      if (this.#isWorkspaceTokenCurrent(workspace, { editor: false }) && this.#activeBranch === branch.name) {
        this.#setActiveBranch(result.branch.name);
      }
      await this.#refreshData(true);
    });
  }

  async deleteBranch(name: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation();
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      const active = this.#requireActiveBranch();
      const branch = await this.#store.getBranch(repository.id, branchName(name));
      this.#assertWorkspaceToken(workspace, { editor: false });
      if (!branch) throw new VersionError('REF_NOT_FOUND', 'Branch was not found');
      await this.#store.deleteBranch({
        repositoryId: repository.id,
        branch: branch.name,
        currentBranch: active.name,
        expectedRepositoryRevision: repository.revision,
        expectedBranchRevision: branch.revision,
      });
      await this.#refreshData(true);
    });
  }

  async startMerge(sourceBranch: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation(true);
      if (!await this.#prepareMergeWorkingTree()) return;
      await this.#refreshData(false);
      await this.#openMergeResolver(branchName(sourceBranch));
    });
  }

  async resumeMerge(id: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation(true);
      const repository = this.#requireRepository();
      const draft = await this.#store.getMergeDraft(mergeDraftId(id));
      if (!draft || draft.repositoryId !== repository.id) {
        throw new VersionError('MERGE_DRAFT_NOT_FOUND', '병합 초안을 찾을 수 없습니다.');
      }
      if (draft.targetBranch !== this.#requireActiveBranch().name) {
        throw new VersionError('STALE_WORKSPACE', `병합을 이어가려면 먼저 ${draft.targetBranch} 브랜치로 전환하세요.`);
      }
      if (!await this.#prepareMergeWorkingTree()) return;
      await this.#refreshData(false);
      await this.#openMergeResolver(draft.sourceBranch, draft);
    });
  }

  async discardMergeDraft(id: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation();
      const repository = this.#requireRepository();
      const draft = await this.#store.getMergeDraft(mergeDraftId(id));
      if (!draft || draft.repositoryId !== repository.id) {
        throw new VersionError('MERGE_DRAFT_NOT_FOUND', '병합 초안을 찾을 수 없습니다.');
      }
      await this.#store.deleteMergeDraft(repository.id, draft.id, draft.updatedAt);
      await this.#refreshData(true);
    });
  }

  async createTag(name: string, target: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation();
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      await this.#store.createTag({
        repositoryId: repository.id,
        name: tagName(name),
        target: commitId(target),
        expectedRepositoryRevision: repository.revision,
      });
      await this.#refreshData(true);
    });
  }

  async createShelf(title?: string): Promise<void> {
    await this.#enqueue(() => this.#createShelf(title));
  }

  async #createShelf(title?: string): Promise<void> {
      await this.#refreshData(false);
      await this.#guardMutation(true);
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      const branch = this.#requireActiveBranch();
      const capture = captureVersionSnapshot(this.#wasm);
      const head = await this.#requireCommit(branch.target);
      if (capture.fingerprint === head.contentFingerprint) {
        throw new VersionError('NO_CHANGES', 'There are no changes to shelf');
      }
      const blob = await this.#store.getBlob(head.blobId);
      this.#assertWorkspaceToken(workspace);
      if (!blob) throw new VersionError('CORRUPT_BLOB', 'Branch head bytes are missing');
      const handler = this.#requireInputHandler();
      handler.prepareSnapshotCapacity(2);
      const result = await this.#store.createShelf({
        repositoryId: repository.id,
        baseCommitId: branch.target,
        branch: branch.name,
        bytes: capture.bytes,
        compareSnapshot: capture.compareSnapshot,
        contentFingerprint: capture.fingerprint,
        title: title?.trim() || `보관 · ${timestampTitle()}`,
        expectedRepositoryRevision: repository.revision,
      });
      try {
        this.#assertWorkspaceToken(workspace);
        handler.replaceContentFromBytes(blob.bytes);
      } catch (error) {
        const compensated = await this.#store.deleteShelf({
          repositoryId: result.repository.id,
          shelfId: result.shelf.id,
          expectedRepositoryRevision: result.repository.revision,
        }).catch(() => result.repository);
        if (this.#isWorkspaceTokenCurrent(workspace, { editor: false, repository: false })) {
          this.#repository = compensated;
        }
        throw error;
      }
      this.#repository = result.repository;
      this.#setDirtyForFingerprint(head.contentFingerprint, 'version-shelf', head.contentFingerprint);
      await this.#refreshData(true);
  }

  async applyShelf(id: string, remove: boolean): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation(true);
      if (!await this.#prepareMergeWorkingTree()) return;
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      const shelf = await this.#store.getShelf(shelfId(id));
      if (!shelf || shelf.repositoryId !== repository.id) throw new VersionError('SHELF_NOT_FOUND', '보관한 변경을 찾을 수 없습니다.');
      const [blob, compared] = await Promise.all([
        this.#store.getBlob(shelf.blobId), this.#store.getCompareSnapshot(shelf.compareSnapshotId),
      ]);
      this.#assertWorkspaceToken(workspace);
      if (!blob || !compared) throw new VersionError('CORRUPT_BLOB', '보관한 문서를 찾을 수 없습니다.');
      const name = branchName(`보관 ${hashBytes(new TextEncoder().encode(id)).slice(7, 23)}`);
      const sourceId = commitId(`shelf:${repository.id}:${id}`);
      let branch = await this.#store.getBranch(repository.id, name);
      if (!branch) {
        const existing = await this.#store.getCommit(sourceId);
        const created = await this.#store.createBranch({
          repositoryId: repository.id, name, target: existing?.id ?? shelf.baseCommitId,
          expectedRepositoryRevision: repository.revision,
        });
        this.#repository = created.repository;
        branch = created.branch;
      }
      if (branch.target !== sourceId) {
        await this.#appendBranchSnapshot(branch, {
          bytes: blob.bytes, fingerprint: shelf.contentFingerprint, compareSnapshot: compared.snapshot,
        }, shelf.title, 'manual', sourceId);
      }
      await this.#refreshData(false);
      await this.#openMergeResolver(name, undefined, { id: shelf.id, remove });
    });
  }

  async deleteShelf(id: string): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation();
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      await this.#store.deleteShelf({
        repositoryId: repository.id,
        shelfId: shelfId(id),
        expectedRepositoryRevision: repository.revision,
      });
      await this.#refreshData(true);
    });
  }

  async compareLegacy(id: string): Promise<void> {
    await this.#enqueue(async () => {
      const workspace = this.#captureWorkspaceToken();
      const payload = await getHistoryPayload(id);
      this.#assertWorkspaceToken(workspace);
      if (!payload) throw new Error('이전 기록을 읽지 못했습니다.');
      const current = captureVersionSnapshot(this.#wasm);
      const legacy = this.#state.legacy.find((item) => item.id === id);
      const leftName = legacy?.title ?? '이전 기록';
      const session = payload.kind === 'ir'
        ? compareSnapshots(payload.snapshot, current.compareSnapshot, VERSION_COMPARE_OPTIONS)
        : await compareDocuments(payload.bytes, leftName, current.bytes, this.#wasm.fileName, VERSION_COMPARE_OPTIONS);
      this.#assertWorkspaceToken(workspace);
      this.#compareStore.set(session);
      this.#compareWindow.show(
        session,
        this.#compareStore,
        0,
        payload.kind === 'legacy'
          ? {
              left: { bytes: payload.bytes, fileName: leftName },
              right: { bytes: current.bytes, fileName: this.#wasm.fileName },
            }
          : undefined,
      );
    });
  }

  setAiTitlesEnabled(enabled: boolean): void {
    this.#state.aiTitlesEnabled = enabled;
    try {
      localStorage.setItem(AI_TITLES_KEY, enabled ? '1' : '0');
    } catch {
      // Keep the session preference when storage is unavailable.
    }
    this.#emit();
  }

  async collectGarbage(): Promise<void> {
    await this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation();
      // A composite merge Redo may be the only remaining owner of its merge
      // commit after Undo. Do not collect that commit out from under history.
      if (this.#getInputHandler()?.canRedo()) {
        throw new VersionError('VERSION_STORE_FAILED', 'Redo or replace pending editor history before garbage collection');
      }
      const workspace = this.#captureWorkspaceToken();
      const repository = this.#requireRepository();
      await this.#store.collectGarbage(repository.id, repository.revision);
      await this.#refreshData(true);
    });
  }

  async createPortableHistoryBundle(): Promise<PortableHistoryArchive> {
    return this.#enqueue(async () => {
      await this.#refreshData(false);
      await this.#guardMutation();
      const id = this.#getDocumentId();
      if (!id) throw new VersionError('SAVE_REQUIRED', 'A saved document ID is required');
      const capture = captureVersionSnapshot(this.#wasm);
      if (!this.#repository) {
        const workspace = this.#captureWorkspaceToken();
        const mergeManifestEntries = await this.#mergeWorker.buildDocumentManifest(capture.bytes);
        this.#assertWorkspaceToken(workspace);
        const analysis = analyzeVersionDiff(null, capture.compareSnapshot);
        const createdAt = Date.now();
        const result = await this.#store.createRepository({
          documentId: documentId(id),
          initialBranch: branchName('main'),
          lastSavedFingerprint: capture.fingerprint,
          initial: {
            bytes: capture.bytes,
            compareSnapshot: capture.compareSnapshot,
            contentFingerprint: capture.fingerprint,
            title: timestampTitle(createdAt),
            titleOrigin: 'timestamp',
            titleRevision: 0,
            author: { kind: 'user', label: '사용자' },
            stats: analysis.stats,
            createdAt,
            mergeManifestEntries,
          },
        });
        this.#assertWorkspaceToken(workspace, { editor: false, repository: false });
        this.#repository = result.repository;
        this.#activeBranch = result.branch.name;
        this.#activeBranches.set(id, result.branch.name);
        persistActiveBranch(id, result.branch.name);
        await this.#refreshData(true);
      } else {
        const branch = this.#requireActiveBranch();
        const head = await this.#requireCommit(branch.target);
        if (capture.fingerprint !== head.contentFingerprint) {
          await this.#createCheckpoint({ reason: 'export' }, capture);
        }
      }

      const repository = this.#requireRepository();
      const activeBranch = this.#requireActiveBranch();
      const head = await this.#requireCommit(activeBranch.target);
      const snapshot = await this.#store.exportRepositorySnapshot(repository.id);
      const sourceFormat = this.#wasm.getSourceFormat();
      if (sourceFormat !== 'hwp' && sourceFormat !== 'hwpx' && sourceFormat !== 'hml') {
        throw new VersionError('VERSION_STORE_FAILED', 'The document format cannot be bundled');
      }
      return createPortableHistoryArchive({
        documentFileName: this.#wasm.fileName,
        sourceFormat,
        activeBranch: activeBranch.name,
        currentBlobId: head.blobId,
        snapshot,
      });
    });
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#listeners.clear();
    this.#compareWindow.hide();
    this.#mergeWorker.dispose();
    if (this.#mergeResolver.isOpen()) void this.#mergeResolver.close();
    this.#setMergeResolverLock(false);
    if (this.#ownsStore) void this.#store.close();
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#operation.catch(() => undefined).then(operation);
    this.#operation = next.then(() => undefined, () => undefined);
    try {
      return await next;
    } catch (error) {
      throw new Error(errorMessage(error), { cause: error instanceof Error ? error : undefined });
    }
  }

  #captureWorkspaceToken(): WorkspaceToken {
    const id = this.#getDocumentId();
    if (!id) throw new VersionError('SAVE_REQUIRED', 'A saved document ID is required');
    return {
      documentId: id,
      editorRevision: this.#editorRevision,
      repositoryId: this.#repository?.id ?? null,
      repositoryRevision: this.#repository?.revision ?? null,
    };
  }

  #assertWorkspaceToken(
    token: WorkspaceToken,
    options: { editor?: boolean; repository?: boolean } = {},
  ): void {
    if (!this.#isWorkspaceTokenCurrent(token, options)) {
      throw new VersionError('STALE_WORKSPACE', 'The active document or workspace changed');
    }
  }

  #isWorkspaceTokenCurrent(
    token: WorkspaceToken,
    options: { editor?: boolean; repository?: boolean } = {},
  ): boolean {
    const editor = options.editor ?? true;
    const repository = options.repository ?? true;
    const currentRepository = this.#repository;
    return !(
      this.#getDocumentId() !== token.documentId
      || (editor && this.#editorRevision !== token.editorRevision)
      || (repository && (
        (currentRepository?.id ?? null) !== token.repositoryId
        || (currentRepository?.revision ?? null) !== token.repositoryRevision
      ))
    );
  }

  #guardSaved(): void {
    if (!this.#getDocumentId() || this.#wasm.pageCount === 0 || this.#wasm.isNewDocument) {
      throw new VersionError('SAVE_REQUIRED', 'The document must be saved first');
    }
  }

  async #guardMutation(resolvePending = false): Promise<void> {
    this.#guardSaved();
    if (this.#mergeResolverActive) {
      throw new VersionError('MERGE_IN_PROGRESS', 'Finish or close the open merge review first');
    }
    const documentAtStart = this.#getDocumentId();
    if (this.#agentBridge.isTurnRunning()) {
      throw new VersionError('ACTIVE_AGENT_TURN', 'An agent turn is still running');
    }
    if (!this.#agentBridge.pendingEdits.hasPending()) return;
    if (!resolvePending) throw new VersionError('PENDING_AGENT_REVIEW', 'Agent edits are awaiting review');
    const sets = () => this.#agentBridge.pendingEdits.getChangeSets().filter((set) => set.ops.length > 0);
    const opCount = sets().reduce((count, set) => count + set.ops.length, 0);
    if (opCount === 0) return;
    const choice = await showPendingAgentEditsDialog(opCount);
    if (this.#getDocumentId() !== documentAtStart) {
      throw new VersionError('STALE_WORKSPACE', 'The active document changed during version review');
    }
    if (choice === 'cancel') throw new VersionError('PENDING_AGENT_REVIEW', 'The version action was cancelled');
    if (choice === 'approve') {
      if (!sets().every((set) => this.#agentBridge.pendingEdits.approve(set.id))) {
        throw new VersionError('PENDING_AGENT_REVIEW', 'Some agent edits could not be approved');
      }
    } else {
      for (const set of sets()) this.#agentBridge.pendingEdits.reject(set.id);
    }
  }

  async #openMergeResolver(
    sourceName: BranchName,
    previousDraft?: VersionMergeDraft,
    shelfApply = previousDraft?.shelfApply,
  ): Promise<void> {
    const workspace = this.#captureWorkspaceToken();
    const repository = this.#requireRepository();
    const targetBranch = this.#requireActiveBranch();
    const sourceBranch = await this.#store.getBranch(repository.id, sourceName);
    if (!sourceBranch) throw new VersionError('REF_NOT_FOUND', '병합할 소스 브랜치를 찾을 수 없습니다.');
    if (sourceBranch.name === targetBranch.name) {
      throw new VersionError('CURRENT_BRANCH', '현재 브랜치는 자기 자신과 병합할 수 없습니다.');
    }
    const relation = await this.#store.getMergeRelation(repository.id, targetBranch.target, sourceBranch.target);
    this.#assertWorkspaceToken(workspace);
    if (relation.relation === 'already-integrated') throw new Error('이미 병합된 브랜치입니다.');
    const [currentCommit, incomingCommit] = await Promise.all([
      this.#requireCommit(targetBranch.target),
      this.#requireCommit(sourceBranch.target),
    ]);
    const baseCommits = await Promise.all(relation.baseCommitIds.map((id) => this.#requireCommit(id)));
    if (baseCommits.length === 0) {
      throw new VersionError('MERGE_VALIDATION_FAILED', '공통 조상을 찾을 수 없습니다.');
    }
    const loadCommit = async (commit: VersionCommit) => {
      const [snapshot, blob] = await Promise.all([
        this.#store.getCompareSnapshot(commit.compareSnapshotId),
        this.#store.getBlob(commit.blobId),
      ]);
      if (!snapshot || !blob) throw new VersionError('CORRUPT_BLOB', `${commit.id} 커밋의 병합 데이터가 없습니다.`);
      return { commit, snapshot: snapshot.snapshot, blob };
    };
    const [current, incoming, ...bases] = await Promise.all([
      loadCommit(currentCommit),
      loadCommit(incomingCommit),
      ...baseCommits.map(loadCommit),
    ]);
    this.#assertWorkspaceToken(workspace);
    const manifestMemo = new Map<CommitId, Promise<VersionMergeManifest>>();
    const [currentManifest, incomingManifest, ...baseManifests] = await Promise.all([
      this.#ensureFullMergeManifest(repository.id, currentCommit.id, manifestMemo),
      this.#ensureFullMergeManifest(repository.id, incomingCommit.id, manifestMemo),
      ...baseCommits.map((commit) => this.#ensureFullMergeManifest(repository.id, commit.id, manifestMemo)),
    ]);
    const currentFormat = mergeDocumentFormat(current.blob.bytes);
    const baseBytes = bases.length === 1
      ? bases[0].blob.bytes
      : await this.#mergeWorker.synthesizeVirtualBaseDocument(
        bases.map((base) => base.blob.bytes),
        currentFormat,
        {
          onProgress: (progress) => this.#eventBus.emit('merge-progress', progress),
        },
      );
    const analysis = await this.#mergeWorker.analyzeDocument(
      baseBytes,
      current.blob.bytes,
      incoming.blob.bytes,
      {
        manifests: {
          // 합성한 가상 문서에는 단일 소스 경로 맵이 없다. 빈 Base 힌트로 보수적으로
          // 일치시키고, 각 HEAD 매니페스트는 이전 기록의 안정적인 식별자를 계속 전달한다.
          base: baseManifests.length === 1 ? baseManifests[0] : { entries: [] },
          current: currentManifest,
          incoming: incomingManifest,
        },
        onProgress: (progress) => this.#eventBus.emit('merge-progress', progress),
      },
    );
    this.#assertWorkspaceToken(workspace);

    const priorByFingerprint = new Map<string, MergeResolution>();
    if (previousDraft) {
      for (const conflict of previousDraft.conflicts) {
        const resolution = previousDraft.resolutions[conflict.id];
        if (resolution) priorByFingerprint.set(conflict.fingerprint, resolution);
      }
    }
    const resolutions = Object.fromEntries(analysis.conflicts.flatMap((conflict) => {
      const resolution = priorByFingerprint.get(conflict.fingerprint);
      return resolution ? [[conflict.id, resolution] as const] : [];
    }));
    const retainedLocalState = retainedMergeDraftLocalState(
      previousDraft,
      targetBranch,
      sourceBranch,
      resolutions,
    );
    const now = Date.now();
    const draft: VersionMergeDraft = {
      ...(shelfApply ? { shelfApply } : {}),
      id: previousDraft?.id ?? createMergeDraftId(),
      repositoryId: repository.id,
      targetBranch: targetBranch.name,
      sourceBranch: sourceBranch.name,
      baseCommitIds: [...relation.baseCommitIds],
      currentHead: targetBranch.target,
      sourceHead: sourceBranch.target,
      targetBranchRevision: targetBranch.revision,
      sourceBranchRevision: sourceBranch.revision,
      targetBranchGeneration: targetBranch.generation,
      sourceBranchGeneration: sourceBranch.generation,
      mode: relation.relation === 'fast-forward'
        ? previousDraft?.mode === 'explicit-checkpoint' ? 'explicit-checkpoint' : 'fast-forward'
        : 'diverged',
      analysisVersion: MERGE_ANALYSIS_VERSION,
      conflicts: analysis.conflicts,
      resolutions,
      automaticResult: analysis.result,
      ...retainedLocalState,
      createdAt: previousDraft?.createdAt ?? now,
      updatedAt: now,
    };
    const storedDraft = await this.#store.putMergeDraft({
      draft,
      expectedUpdatedAt: previousDraft ? previousDraft.updatedAt : null,
    });
    const materialize = async (
      mergeAnalysis: MergeAnalysis,
      mergeResolutions: Readonly<Record<string, MergeResolution>>,
      signal: AbortSignal,
    ): Promise<MaterializedMergeResult> => {
      const hydratedResolutions = await this.#hydrateMergeAssetResolutions(mergeResolutions);
      const output = await this.#mergeWorker.materializeDocument(
        baseBytes,
        current.blob.bytes,
        incoming.blob.bytes,
        hydratedResolutions,
        {
          manifests: {
            base: baseManifests.length === 1 ? baseManifests[0] : { entries: [] },
            current: currentManifest,
            incoming: incomingManifest,
          },
          signal,
          onProgress: (progress) => this.#eventBus.emit('merge-progress', progress),
        },
      );
      // Fast-forward adopts the source commit itself, so retain its exact bytes.
      // The structural engine still materializes and validates above.
      const bytes = relation.relation === 'fast-forward' ? incoming.blob.bytes : output.bytes;
      try {
        await this.#validateMergeDocument(bytes, this.#wasm.fileName);
        return {
          tree: mergeAnalysis.result,
          document: { bytes, fileName: this.#wasm.fileName, label: '병합 결과' },
          validation: {
            valid: true,
            errors: [],
            checks: {
              parsed: true,
              exported: true,
              reloaded: true,
              structurallyValid: true,
              format: mergeDocumentFormat(bytes),
            },
          },
        };
      } catch (error) {
        return {
          tree: mergeAnalysis.result,
          document: { bytes, fileName: this.#wasm.fileName, label: '병합 결과' },
          validation: {
            valid: false,
            errors: [error instanceof Error ? error.message : String(error)],
            checks: {
              parsed: false,
              exported: false,
              reloaded: false,
              structurallyValid: false,
              format: mergeDocumentFormat(bytes),
            },
          },
        };
      }
    };
    this.#setMergeResolverLock(true);
    try {
      let applied = false;
      let resolveCompletion!: (applied: boolean) => void;
      this.#mergeCompletion = new Promise<boolean>((resolve) => { resolveCompletion = resolve; });
      this.#mergeResolver.open({
        draft: storedDraft,
        analysis,
        sourceBranch: sourceBranch.name,
        currentBranch: targetBranch.name,
        mode: storedDraft.mode,
        title: shelfApply ? '보관한 변경 적용' : `${sourceBranch.name} → ${targetBranch.name} 병합`,
        documents: {
          base: { bytes: baseBytes, fileName: this.#wasm.fileName, label: '기준' },
          current: { bytes: current.blob.bytes, fileName: this.#wasm.fileName, label: '현재' },
          incoming: { bytes: incoming.blob.bytes, fileName: this.#wasm.fileName, label: '가져올 변경' },
        },
        canDeleteSource: !shelfApply && sourceBranch.name !== repository.defaultBranch && !sourceBranch.name.startsWith('Cloud '),
        materialize: ({ analysis: nextAnalysis, resolutions: nextResolutions, signal }) => (
          materialize(nextAnalysis, nextResolutions, signal)
        ),
        saveDraft: async (nextDraft) => {
          await this.#enqueue(async () => {
            const existing = await this.#store.getMergeDraft(nextDraft.id);
            const assetIds = new Set([
              ...(existing?.manualAssetBlobIds ?? []),
              ...manualAssetIds(nextDraft.resolutions),
            ]);
            await this.#store.putMergeDraft({
              draft: { ...nextDraft, manualAssetBlobIds: [...assetIds] },
              expectedUpdatedAt: existing?.updatedAt ?? null,
            });
            await this.#refreshData(true);
          });
        },
        discardDraft: async (draftId) => {
          await this.#enqueue(async () => {
            const existing = await this.#store.getMergeDraft(draftId);
            if (existing) await this.#store.deleteMergeDraft(existing.repositoryId, existing.id, existing.updatedAt);
            await this.#refreshData(true);
          });
        },
        uploadAsset: async (file, conflict) => {
          const bytes = await readBlobBytesWithLimit(file, INSERTED_IMAGE_MAX_BYTES, '병합 대체 이미지');
          const asset: VersionBlob = { id: hashBytes(bytes), byteLength: bytes.byteLength, bytes };
          await this.#enqueue(async () => {
            const existing = await this.#store.getMergeDraft(storedDraft.id);
            if (!existing) throw new VersionError('MERGE_DRAFT_NOT_FOUND', '병합 초안을 찾을 수 없습니다.');
            await this.#store.putMergeDraft({
              draft: {
                ...existing,
                manualAssetBlobIds: [...new Set([...existing.manualAssetBlobIds, asset.id])],
                updatedAt: Date.now(),
              },
              expectedUpdatedAt: existing.updatedAt,
              assetBlobs: [asset],
            });
          });
          const currentValue = conflict.current && typeof conflict.current === 'object'
            ? conflict.current as Record<string, unknown>
            : {};
          const extension = file.name.includes('.') ? file.name.split('.').pop()! : 'bin';
          return {
            kind: 'image-bytes',
            id: typeof currentValue.id === 'number' ? currentValue.id : undefined,
            extension,
            assetBlobId: asset.id,
          };
        },
        complete: (request) => this.#enqueue(() => this.#completeMerge(request)),
        finalizeSourceDisposition: (receipt, disposition) => this.#enqueue(
          async () => { await this.#finalizeMergeSource(receipt, disposition); applied = true; },
        ),
        onClosed: () => { this.#setMergeResolverLock(false); resolveCompletion(applied); },
      });
    } catch (error) {
      this.#setMergeResolverLock(false);
      throw error;
    }
  }

  async #hydrateMergeAssetResolutions(
    resolutions: Readonly<Record<string, MergeResolution>>,
  ): Promise<Record<string, MergeResolution>> {
    const hydrated: Record<string, MergeResolution> = {};
    for (const [conflictId, resolution] of Object.entries(resolutions)) {
      if (resolution.kind !== 'manual' || !resolution.payload || typeof resolution.payload !== 'object') {
        hydrated[conflictId] = resolution;
        continue;
      }
      const payload = resolution.payload as Record<string, unknown>;
      const assetId = payload.assetBlobId;
      if (typeof assetId !== 'string') {
        hydrated[conflictId] = resolution;
        continue;
      }
      const asset = await this.#store.getBlob(assetId as VersionBlob['id']);
      if (!asset) throw new VersionError('CORRUPT_BLOB', `병합에 필요한 자산 ${assetId}을(를) 찾을 수 없습니다.`);
      const { assetBlobId: _assetBlobId, ...value } = payload;
      hydrated[conflictId] = {
        kind: 'manual',
        payload: { ...value, bytesBase64: bytesToBase64(asset.bytes) },
      };
    }
    return hydrated;
  }

  #setMergeResolverLock(locked: boolean): void {
    if (locked === this.#mergeResolverActive) return;
    this.#mergeResolverActive = locked;
    if (locked) {
      this.#mergeLockedHandler = this.#getInputHandler();
      this.#mergePreviousUserEditingLocked = this.#mergeLockedHandler?.isUserEditingLocked() ?? false;
      this.#mergeLockedHandler?.setUserEditingLocked(true);
    } else {
      this.#mergeLockedHandler?.setUserEditingLocked(this.#mergePreviousUserEditingLocked);
      this.#mergeLockedHandler = null;
      this.#mergePreviousUserEditingLocked = false;
    }
    this.#eventBus.emit('merge-resolver-lock-changed', locked);
    this.#syncTransientState();
  }

  async #completeMerge(request: MergeApplicationRequest): Promise<MergeAppliedReceipt> {
    if (!request.materialized.validation.valid || !request.materialized.document) {
      throw new VersionError('MERGE_VALIDATION_FAILED', '해결한 병합 결과가 올바른 문서가 아닙니다.');
    }
    // 리졸버 편집은 완료 전까지 로컬 Undo 대상으로 유지한다. 저장소 트랜잭션이 모든
    // 충돌의 명시적 해결을 검사하기 전에 완료할 상태를 그대로 저장해, 이후 검증이나
    // ref CAS가 실패해도 완전히 재개할 수 있는 초안을 남긴다.
    const persistedDraft = await this.#store.getMergeDraft(request.draft.id);
    if (!persistedDraft || persistedDraft.repositoryId !== request.draft.repositoryId) {
      throw new VersionError('MERGE_DRAFT_NOT_FOUND', '병합 초안을 찾을 수 없습니다.');
    }
    const completionAssetIds = new Set([
      ...persistedDraft.manualAssetBlobIds,
      ...request.draft.manualAssetBlobIds,
      ...manualAssetIds(request.resolutions),
    ]);
    const completionDraft = await this.#store.putMergeDraft({
      draft: { ...request.draft, manualAssetBlobIds: [...completionAssetIds] },
      expectedUpdatedAt: persistedDraft.updatedAt,
    });
    const repository = await this.#store.getRepository(request.draft.repositoryId);
    if (!repository) throw new VersionError('REPOSITORY_NOT_FOUND', '버전 저장소를 찾을 수 없습니다.');
    const [targetBranch, sourceBranch] = await Promise.all([
      this.#store.getBranch(repository.id, request.draft.targetBranch),
      this.#store.getBranch(repository.id, request.draft.sourceBranch),
    ]);
    if (!targetBranch || !sourceBranch) throw new VersionError('REF_NOT_FOUND', '병합할 브랜치를 찾을 수 없습니다.');
    if (
      targetBranch.target !== request.draft.currentHead
      || sourceBranch.target !== request.draft.sourceHead
      || targetBranch.revision !== request.draft.targetBranchRevision
      || sourceBranch.revision !== request.draft.sourceBranchRevision
      || (
        request.draft.targetBranchGeneration !== undefined
        && targetBranch.generation !== request.draft.targetBranchGeneration
      )
      || (
        request.draft.sourceBranchGeneration !== undefined
        && sourceBranch.generation !== request.draft.sourceBranchGeneration
      )
    ) {
      throw new VersionError('STALE_WORKSPACE', '병합하는 동안 브랜치가 변경되었습니다. 결과를 다시 계산하세요.');
    }
    const captured = await this.#validateMergeDocument(
      request.materialized.document.bytes,
      request.materialized.document.fileName,
    );
    if (completionDraft.shelfApply) {
      const workspace = this.#captureWorkspaceToken();
      if (this.#activeBranch !== targetBranch.name) throw new VersionError('STALE_WORKSPACE', '현재 브랜치가 달라졌습니다.');
      const handler = this.#requireInputHandler();
      const original = captureVersionSnapshot(this.#wasm);
      const head = await this.#requireCommit(targetBranch.target);
      this.#assertWorkspaceToken(workspace);
      if (original.fingerprint !== head.contentFingerprint) {
        throw new VersionError('STALE_WORKSPACE', '보관한 변경을 검토하는 동안 문서가 바뀌었습니다.');
      }
      const wasDirty = this.#documentState.isDirty();
      handler.prepareSnapshotCapacity(4);
      const updated = await commitCompositeMerge({
        applyEditor: () => handler.replaceContentFromBytes(captured.bytes),
        commitRefs: () => this.#store.completeShelfMerge({
          repositoryId: repository.id, expectedRepositoryRevision: repository.revision, draftId: completionDraft.id,
        }),
        rollbackEditor: () => {
          reconcileCompositeEditor({
            undoAppliedMerge: () => handler.performUndo(true),
            discardMergeRedo: () => handler.discardRedoHistory(),
            matchesExpectedDocument: () => fingerprintVersionContent(this.#wasm) === original.fingerprint,
            replaceWithExpectedDocument: () => { handler.replaceContentFromBytes(original.bytes); },
            discardFallbackUndo: () => handler.discardLatestUndoHistory(),
          });
          if (wasDirty) this.#documentState.markDirty('version-shelf-rollback');
          else this.#documentState.markClean('version-shelf-rollback');
        },
      });
      this.#repository = updated;
      this.#setDirtyForFingerprint(captured.fingerprint, 'version-shelf-apply');
      await this.#refreshData(true);
      const receipt = {} as MergeAppliedReceipt;
      this.#pendingMergeFinalizers.set(receipt, async () => {});
      return receipt;
    }
    const mergeManifestEntries = request.mode === 'fast-forward'
      ? null
      : await this.#mergeWorker.buildDocumentManifest(captured.bytes);
    const currentCommit = await this.#requireCommit(targetBranch.target);
    const currentSnapshot = await this.#store.getCompareSnapshot(currentCommit.compareSnapshotId);
    if (!currentSnapshot) throw new VersionError('CORRUPT_BLOB', '현재 브랜치의 병합 스냅샷을 찾을 수 없습니다.');
    const analysis = analyzeVersionDiff(currentSnapshot.snapshot, captured.compareSnapshot);
    const handler = this.#requireInputHandler();
    const original = captureVersionSnapshot(this.#wasm);
    const wasDirty = this.#documentState.isDirty();
    handler.prepareSnapshotCapacity(4);
    let mergeCommitted = false;
    let compensating = false;
    let transitionRefs: (direction: 'undo' | 'redo') => void = () => undefined;

    const completed = await commitCompositeMerge({
      applyEditor: () => {
        handler.replaceContentFromBytes(captured.bytes, {
          afterUndo: () => {
            if (mergeCommitted && !compensating) queueMicrotask(() => transitionRefs('undo'));
          },
          afterRedo: () => {
            if (mergeCommitted && !compensating) queueMicrotask(() => transitionRefs('redo'));
          },
        });
      },
      commitRefs: async () => request.mode === 'fast-forward'
        ? await this.#store.completeFastForwardMerge({
          repositoryId: repository.id,
          branch: targetBranch.name,
          target: sourceBranch.target,
          expectedRepositoryRevision: repository.revision,
          expectedBranchRevision: targetBranch.revision,
          expectedHead: targetBranch.target,
          sourceBranch: sourceBranch.name,
          expectedSourceRevision: sourceBranch.revision,
          deleteSource: false,
          draftId: completionDraft.id,
        })
        : await this.#store.completeMergeCheckpoint({
          repositoryId: repository.id,
          branch: targetBranch.name,
          expectedRepositoryRevision: repository.revision,
          expectedBranchRevision: targetBranch.revision,
          expectedHead: targetBranch.target,
          sourceBranch: sourceBranch.name,
          expectedSourceRevision: sourceBranch.revision,
          deleteSource: false,
          draftId: completionDraft.id,
          bytes: captured.bytes,
          compareSnapshot: captured.compareSnapshot,
          contentFingerprint: captured.fingerprint,
          mergeManifestEntries: mergeManifestEntries!,
          title: request.title.trim() || `${sourceBranch.name} → ${targetBranch.name} 병합`,
          titleOrigin: 'manual',
          titleRevision: 0,
          author: { kind: 'user', label: '사용자' },
          stats: analysis.stats,
          merge: {
            sourceBranchAtMerge: sourceBranch.name,
            targetBranchAtMerge: targetBranch.name,
            baseCommitIds: [...request.draft.baseCommitIds],
            conflictCount: request.draft.conflicts.length,
          },
        }),
      rollbackEditor: () => {
        compensating = true;
        try {
          try {
            reconcileCompositeEditor({
              undoAppliedMerge: () => handler.performUndo(true),
              discardMergeRedo: () => handler.discardRedoHistory(),
              matchesExpectedDocument: () => (
                fingerprintVersionContent(this.#wasm) === original.fingerprint
              ),
              replaceWithExpectedDocument: () => { handler.replaceContentFromBytes(original.bytes); },
              discardFallbackUndo: () => handler.discardLatestUndoHistory(),
            });
          } catch (rollbackError) {
            throw new VersionError(
              'MERGE_VALIDATION_FAILED',
              '병합 결과 저장에 실패했고 편집기 상태도 복원하지 못했습니다.',
              { cause: rollbackError instanceof Error ? rollbackError : undefined },
            );
          }
          this.#recordSemanticDirty(original.fingerprint);
          if (wasDirty) this.#documentState.markDirty('version-merge-rollback');
          else this.#documentState.markClean('version-merge-rollback');
        } finally {
          compensating = false;
        }
      },
    });
    const postTarget = completed.branch;
    let postSource = completed.sourceBranch;
    let refState = {
      repository: completed.repository,
      target: postTarget,
      source: postSource,
    };
    transitionRefs = (direction: 'undo' | 'redo'): void => {
      if (compensating) return;
      this.#setMergeResolverLock(true);
      void this.#enqueue(async () => {
        let reconciled = true;
        try {
          const [latestRepository, latestTarget, latestSource] = await Promise.all([
            this.#store.getRepository(repository.id),
            this.#store.getBranch(repository.id, targetBranch.name),
            this.#store.getBranch(repository.id, sourceBranch.name),
          ]);
          if (!latestRepository || !latestTarget) {
            throw new VersionError('STALE_WORKSPACE', '병합 기록에 필요한 브랜치 참조가 더 이상 존재하지 않습니다.');
          }
          if (
            latestTarget.target !== refState.target.target
            || latestTarget.generation !== refState.target.generation
          ) {
            throw new VersionError('STALE_WORKSPACE', '병합 대상 브랜치의 최신 커밋이 변경되었습니다.');
          }
          if (
            Boolean(latestSource) !== Boolean(refState.source)
            || (latestSource && refState.source && (
              latestSource.target !== refState.source.target
              || latestSource.generation !== refState.source.generation
            ))
          ) {
            throw new VersionError('STALE_WORKSPACE', '소스 브랜치의 최신 커밋이 변경되었습니다.');
          }
          const restore = await this.#store.restoreCompositeRefs({
            repositoryId: repository.id,
            expectedRepositoryRevision: latestRepository.revision,
            allowRepositoryRevisionAdvance: true,
            targetBranch: targetBranch.name,
            expectedTarget: {
              target: latestTarget.target,
              revision: latestTarget.revision,
              generation: latestTarget.generation,
            },
            restoreTarget: direction === 'undo' ? targetBranch.target : postTarget.target,
            sourceBranch: sourceBranch.name,
            expectedSource: latestSource
              ? {
                target: latestSource.target,
                revision: latestSource.revision,
                generation: latestSource.generation,
              }
              : null,
            restoreSource: direction === 'undo'
              ? {
                target: sourceBranch.target,
                minimumRevision: sourceBranch.revision,
                generation: sourceBranch.generation,
              }
              : postSource
                ? {
                  target: postSource.target,
                  minimumRevision: postSource.revision,
                  generation: postSource.generation,
                }
                : null,
          });
          refState = {
            repository: restore.repository,
            target: restore.targetBranch,
            source: restore.sourceBranch,
          };
          this.#repository = restore.repository;
          this.#setDirtyForFingerprint(
            direction === 'undo' ? original.fingerprint : captured.fingerprint,
            direction === 'undo' ? 'version-merge-undo' : 'version-merge-redo',
            direction === 'undo' ? currentCommit.contentFingerprint : captured.fingerprint,
          );
          await this.#refreshData(true);
        } catch (error) {
          // Restore the document snapshot if its matching ref transition failed.
          compensating = true;
          try {
            const expected = direction === 'undo' ? captured : original;
            reconcileCompositeHistoryTransition({
              restoreFromHistory: () => {
                if (direction === 'undo') handler.performRedo(true);
                else handler.performUndo(true);
              },
              matchesExpectedDocument: () => (
                fingerprintVersionContent(this.#wasm) === expected.fingerprint
              ),
              replaceWithExpectedDocument: () => { handler.replaceContentFromBytes(expected.bytes); },
              discardFallbackUndo: () => handler.discardLatestUndoHistory(),
            });
          } catch (compensationError) {
            reconciled = false;
            console.error('[Versions] Merge history compensation failed:', compensationError);
          } finally {
            compensating = false;
          }
          throw error;
        } finally {
          // A double failure leaves the editor in an unknown state. Keep every
          // mutation path locked instead of allowing content and refs to drift
          // farther apart; successful reconciliation releases the short lock.
          if (reconciled) this.#setMergeResolverLock(false);
        }
      }).catch((error) => console.error('[Versions] Merge history ref transition failed:', error));
    };
    mergeCommitted = true;
    this.#repository = completed.repository;
    this.#setDirtyForFingerprint(captured.fingerprint, 'version-merge', captured.fingerprint);
    this.#eventBus.emit('document-context-changed');
    await this.#refreshData(true);
    const receipt = {} as MergeAppliedReceipt;
    this.#pendingMergeFinalizers.set(receipt, async (disposition) => {
      if (disposition === 'delete') {
        const source = refState.source;
        if (!source) return;
        const [latestRepository, latestTarget, latestSource] = await Promise.all([
          this.#store.getRepository(repository.id),
          this.#store.getBranch(repository.id, targetBranch.name),
          this.#store.getBranch(repository.id, sourceBranch.name),
        ]);
        if (
          !latestRepository
          || !latestTarget
          || !latestSource
          || latestTarget.target !== refState.target.target
          || latestTarget.generation !== refState.target.generation
          || latestSource.target !== source.target
          || latestSource.generation !== source.generation
        ) {
          throw new VersionError('STALE_WORKSPACE', '소스 브랜치를 정리하기 전에 병합 참조가 변경되었습니다.');
        }
        const finalized = await this.#store.restoreCompositeRefs({
          repositoryId: repository.id,
          expectedRepositoryRevision: latestRepository.revision,
          allowRepositoryRevisionAdvance: true,
          targetBranch: targetBranch.name,
          expectedTarget: {
            target: latestTarget.target,
            revision: latestTarget.revision,
            generation: latestTarget.generation,
          },
          restoreTarget: refState.target.target,
          sourceBranch: sourceBranch.name,
          expectedSource: {
            target: latestSource.target,
            revision: latestSource.revision,
            generation: latestSource.generation,
          },
          restoreSource: null,
        });
        refState = {
          repository: finalized.repository,
          target: finalized.targetBranch,
          source: finalized.sourceBranch,
        };
        postSource = null;
        this.#repository = finalized.repository;
        await this.#refreshData(true);
      }
    });
    return receipt;
  }

  async #finalizeMergeSource(
    receipt: MergeAppliedReceipt,
    disposition: 'keep' | 'delete',
  ): Promise<void> {
    const finalize = this.#pendingMergeFinalizers.get(receipt);
    if (!finalize) throw new VersionError('STALE_WORKSPACE', '이 병합 작업은 이미 마무리되었습니다.');
    await finalize(disposition);
    this.#pendingMergeFinalizers.delete(receipt);
  }

  async #validateMergeDocument(bytes: Uint8Array, fileName: string): Promise<CapturedVersionSnapshot> {
    const first = new WasmBridge();
    const second = new WasmBridge();
    try {
      await Promise.all([first.initialize(), second.initialize()]);
      first.loadDocument(bytes, fileName);
      const captured = captureVersionSnapshot(first);
      second.loadDocument(captured.bytes, fileName);
      const reloaded = captureVersionSnapshot(second);
      if (captured.fingerprint !== reloaded.fingerprint) {
        throw new VersionError('MERGE_VALIDATION_FAILED', '병합 문서가 내보내기와 다시 열기 과정에서 달라졌습니다.');
      }
      const missingResources = [
        ...mergeResourceDependencyErrors(first.getExternalImageReferences()),
        ...mergeResourceDependencyErrors(second.getExternalImageReferences()),
      ];
      if (missingResources.length > 0) {
        throw new VersionError(
          'MERGE_VALIDATION_FAILED',
          [...new Set(missingResources)].join(' '),
        );
      }
      if (mergeDocumentFormat(captured.bytes) === 'hwp') {
        const verification = JSON.parse(second.exportHwpVerify()) as {
          recovered?: boolean;
          structureMatches?: boolean;
          serializationLosses?: string[];
        };
        if (!verification.recovered || !verification.structureMatches) {
          throw new VersionError(
            'MERGE_VALIDATION_FAILED',
            `병합한 HWP 문서를 다시 열어 검증하지 못했습니다: ${(verification.serializationLosses ?? []).join(' ')}`,
          );
        }
      }
      // Force layout validation after reload. These warnings are non-fatal;
      // dangling resource dependencies above are always a hard gate.
      second.getValidationWarnings();
      return captured;
    } catch (error) {
      if (error instanceof VersionError) throw error;
      throw new VersionError('MERGE_VALIDATION_FAILED', '병합 문서의 분석, 내보내기 또는 다시 열기 검증에 실패했습니다.', {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      first.releaseDocument();
      second.releaseDocument();
    }
  }

  async #ensureFullMergeManifest(
    repositoryId: VersionRepository['id'],
    id: CommitId,
    memo: Map<CommitId, Promise<VersionMergeManifest>>,
  ): Promise<VersionMergeManifest> {
    const pending = memo.get(id);
    if (pending) return pending;
    const building = (async () => {
      const commit = await this.#store.getCommit(id);
      if (!commit || commit.repositoryId !== repositoryId) {
        throw new VersionError('COMMIT_NOT_FOUND', `병합 식별 정보를 만들 커밋 ${id}을(를) 찾을 수 없습니다.`);
      }
      const persisted = commit.mergeManifestId
        ? await this.#store.getMergeManifest(commit.mergeManifestId)
        : null;
      if (
        persisted
        && persisted.repositoryId === repositoryId
        && persisted.commitId === id
        && persisted.analysisVersion === MERGE_MANIFEST_VERSION
        && persisted.coverage === 'full-document'
        && persisted.parentManifestIds.length === commit.parents.length
      ) {
        const attachedParents = await Promise.all(commit.parents.map(async (parentId, index) => {
          const parentCommit = await this.#store.getCommit(parentId);
          if (!parentCommit || parentCommit.repositoryId !== repositoryId || !parentCommit.mergeManifestId) return false;
          const parentManifest = await this.#store.getMergeManifest(parentCommit.mergeManifestId);
          return parentManifest?.repositoryId === repositoryId
            && parentManifest.commitId === parentId
            && parentManifest.analysisVersion === MERGE_MANIFEST_VERSION
            && parentManifest.coverage === 'full-document'
            && persisted.parentManifestIds[index] === parentManifest.id;
        }));
        if (attachedParents.every(Boolean)) return persisted;
      }
      const parents: VersionMergeManifest[] = [];
      for (const parent of commit.parents) {
        parents.push(await this.#ensureFullMergeManifest(repositoryId, parent, memo));
      }
      const latest = await this.#store.getCommit(id);
      if (!latest) throw new VersionError('COMMIT_NOT_FOUND', `병합 식별 정보를 만드는 동안 커밋 ${id}이(가) 사라졌습니다.`);
      const existing = latest.mergeManifestId
        ? await this.#store.getMergeManifest(latest.mergeManifestId)
        : null;
      if (
        existing
        && existing.analysisVersion === MERGE_MANIFEST_VERSION
        && existing.coverage === 'full-document'
        && existing.parentManifestIds.length === parents.length
        && existing.parentManifestIds.every((parentId, index) => parentId === parents[index]?.id)
      ) return existing;
      const blob = await this.#store.getBlob(latest.blobId);
      if (!blob) throw new VersionError('CORRUPT_BLOB', `커밋 ${id}의 문서 데이터를 찾을 수 없습니다.`);
      const entries = await this.#mergeWorker.buildDocumentManifest(blob.bytes, {
        onProgress: (progress) => this.#eventBus.emit('merge-progress', progress),
      });
      return this.#store.putFullMergeManifest(repositoryId, id, entries);
    })();
    memo.set(id, building);
    try {
      return await building;
    } catch (error) {
      memo.delete(id);
      throw error;
    }
  }

  async #refreshData(includeLegacy: boolean): Promise<void> {
    const epoch = ++this.#refreshEpoch;
    const id = this.#getDocumentId();
    this.#state.documentId = id;
    this.#state.documentName = this.#wasm.pageCount > 0 ? this.#wasm.fileName : null;
    this.#state.saved = Boolean(id && this.#wasm.pageCount > 0 && !this.#wasm.isNewDocument);
    if (!id || !this.#state.saved) {
      this.#repository = null;
      this.#refs = [];
      this.#commits = [];
      this.#shelves = [];
      this.#mergeDrafts = [];
      this.#activeBranch = null;
      this.#semanticDirty = false;
      this.#semanticDirtyRevision = this.#editorRevision;
      await this.#buildState(false, includeLegacy);
      return;
    }
    const repository = await this.#store.findRepositoryByDocumentId(documentId(id));
    if (epoch !== this.#refreshEpoch || this.#getDocumentId() !== id) return;
    this.#repository = repository;
    if (repository) this.#savedBaseline = null;
    if (!repository && this.#autoEnable() && (!this.#documentState.isDirty() || this.#savedBaseline?.documentId === id)
      && !this.#agentBridge.isTurnRunning()) {
      await this.#enableVersioning();
      return;
    }
    if (!repository) {
      this.#refs = [];
      this.#commits = [];
      this.#shelves = [];
      this.#mergeDrafts = [];
      this.#activeBranch = null;
      this.#semanticDirty = false;
      this.#semanticDirtyRevision = this.#editorRevision;
      await this.#buildState(false, includeLegacy, id);
      return;
    }
    const [refs, commits, shelves, mergeDrafts] = await Promise.all([
      this.#store.listRefs(repository.id),
      this.#store.listCommits(repository.id, { limit: PAGE_SIZE }),
      this.#store.listShelves(repository.id),
      this.#store.listMergeDrafts(repository.id),
    ]);
    if (epoch !== this.#refreshEpoch || this.#getDocumentId() !== id) return;
    this.#refs = refs;
    this.#commits = commits;
    this.#shelves = shelves;
    this.#mergeDrafts = mergeDrafts;
    const branches = refs.filter((ref): ref is BranchRef => ref.kind === 'branch');
    const storedBranch = readActiveBranch(id);
    const memoryBranch = this.#activeBranches.get(id);
    this.#activeBranch = branches.find((branch) => branch.name === storedBranch)?.name
      ?? branches.find((branch) => branch.name === memoryBranch)?.name
      ?? branches.find((branch) => branch.name === repository.defaultBranch)?.name
      ?? branches[0]?.name
      ?? null;
    if (this.#activeBranch) persistActiveBranch(id, this.#activeBranch);
    if (this.#activeBranch) this.#activeBranches.set(id, this.#activeBranch);
    await this.#refreshSemanticDirty(id, epoch);
    if (epoch !== this.#refreshEpoch || this.#getDocumentId() !== id) return;
    await this.#buildState(commits.length === PAGE_SIZE && commits.at(-1)!.ordinal > 1, includeLegacy, id);
  }

  async #buildState(
    hasMore: boolean,
    includeLegacy = false,
    expectedDocumentId = this.#getDocumentId(),
  ): Promise<void> {
    const branchRefs = this.#refs.filter((ref): ref is BranchRef => ref.kind === 'branch');
    const tagRefs = this.#refs.filter((ref) => ref.kind === 'tag');
    const loadedCommitIds = new Set(this.#commits.map((commit) => commit.id));
    const preferredHeads = orderBranchHeadFrontier(
      branchRefs,
      this.#repository?.defaultBranch ?? null,
      this.#activeBranch,
    ).filter((id) => loadedCommitIds.has(id));
    const graphRows = layoutCommitGraph(this.#commits, [], preferredHeads);
    const rowById = new Map(graphRows.map((row) => [row.commitId, row]));
    const blobLengths = await this.#store.getBlobSizes([...new Set([
      ...this.#commits.map((commit) => commit.blobId),
      ...this.#shelves.map((shelf) => shelf.blobId),
    ])]);

    const active = branchRefs.find((branch) => branch.name === this.#activeBranch) ?? null;
    const commitViews: VersionCommitView[] = this.#commits.map((commit) => {
      const graph = rowById.get(commit.id);
      return {
        id: commit.id,
        shortId: commit.id.slice(0, 8),
        title: commit.title,
        createdAt: commit.createdAt,
        reason: commit.reason,
        parentIds: [...commit.parents],
        branchLabels: branchRefs.filter((ref) => ref.target === commit.id).map((ref) => ref.name),
        tagLabels: tagRefs.filter((ref) => ref.target === commit.id).map((ref) => ref.name),
        lane: graph?.lane ?? 0,
        laneCount: graph?.laneCount ?? 1,
        startsLane: graph?.startsLane ?? true,
        lanesBefore: graph ? [...graph.lanesBefore] : [commit.id],
        lanesAfter: graph ? [...graph.lanesAfter] : [...commit.parents],
        activeLanesBefore: graph ? [...graph.activeLanesBefore] : [],
        parentLanes: graph?.edges.map((edge) => edge.toLane) ?? [],
        isHead: active?.target === commit.id,
        byteLength: blobLengths.get(commit.blobId) ?? 0,
      };
    });
    const commitById = new Map(this.#commits.map((commit) => [commit.id, commit]));
    const branches: VersionBranchView[] = branchRefs.map((branch) => ({
      name: branch.name,
      headId: branch.target,
      isActive: branch.name === this.#activeBranch,
      isDefault: branch.name === this.#repository?.defaultBranch,
      updatedAt: commitById.get(branch.target)?.createdAt ?? this.#repository?.enabledAt ?? Date.now(),
    }));
    const shelves: VersionShelfView[] = this.#shelves.map((shelf) => ({
      id: shelf.id,
      title: shelf.title,
      createdAt: shelf.createdAt,
      baseCommitId: shelf.baseCommitId,
      byteLength: blobLengths.get(shelf.blobId) ?? 0,
    }));
    const mergeDrafts: VersionMergeDraftView[] = this.#mergeDrafts.map((draft) => ({
      id: draft.id,
      sourceBranch: draft.sourceBranch,
      targetBranch: draft.targetBranch,
      conflictCount: draft.conflicts.length,
      resolvedCount: Object.keys(draft.resolutions).length,
      updatedAt: draft.updatedAt,
    }));
    let legacy: LegacyVersionView[] = this.#state.legacy;
    if (includeLegacy) {
      legacy = (await listHistoryMeta()).map((entry) => ({
        id: entry.id,
        title: entry.label,
        createdAt: entry.createdAt,
        byteLength: entry.byteLength,
      }));
    }
    const [estimate, repositoryUsage] = await Promise.all([
      typeof navigator !== 'undefined' && navigator.storage?.estimate
        ? navigator.storage.estimate().catch(() => ({} as StorageEstimate))
        : Promise.resolve({} as StorageEstimate),
      this.#repository
        ? this.#store.getRepositoryStorageUsage(this.#repository.id).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (this.#getDocumentId() !== expectedDocumentId) return;
    this.#state = {
      documentId: this.#getDocumentId(),
      documentName: this.#wasm.pageCount > 0 ? this.#wasm.fileName : null,
      saved: Boolean(this.#getDocumentId() && this.#wasm.pageCount > 0 && !this.#wasm.isNewDocument),
      enabled: this.#repository !== null,
      dirty: this.#isSemanticDirty(),
      mutationBlockedReason: this.#mutationBlockedReason(),
      activeBranch: this.#activeBranch,
      commits: commitViews,
      branches,
      shelves,
      mergeDrafts,
      legacy,
      hasMoreCommits: hasMore,
      loading: false,
      storageBytes: repositoryUsage?.totalBytes ?? 0,
      storageQuotaBytes: typeof estimate.quota === 'number' ? estimate.quota : null,
      aiTitlesEnabled: readAiTitlesEnabled(),
    };
    this.#emit();
  }

  #syncTransientState(): void {
    this.#state.dirty = this.#isSemanticDirty();
    this.#state.mutationBlockedReason = this.#mutationBlockedReason();
    this.#emit();
  }

  async #refreshSemanticDirty(expectedDocumentId: string, epoch: number): Promise<void> {
    const branch = this.#refs.find((ref): ref is BranchRef => (
      ref.kind === 'branch' && ref.name === this.#activeBranch
    ));
    if (!branch) {
      this.#semanticDirty = false;
      this.#semanticDirtyRevision = this.#editorRevision;
      return;
    }
    const revision = this.#editorRevision;
    const head = this.#commits.find((commit) => commit.id === branch.target)
      ?? await this.#store.getCommit(branch.target);
    if (
      epoch !== this.#refreshEpoch
      || this.#getDocumentId() !== expectedDocumentId
      || this.#editorRevision !== revision
    ) return;
    const currentFingerprint = fingerprintVersionContent(this.#wasm);
    if (
      epoch !== this.#refreshEpoch
      || this.#getDocumentId() !== expectedDocumentId
      || this.#editorRevision !== revision
    ) return;
    this.#semanticDirty = !head || currentFingerprint !== head.contentFingerprint;
    this.#semanticDirtyRevision = revision;
  }

  #isSemanticDirty(): boolean {
    if (!this.#repository) return this.#documentState.isDirty();
    return this.#semanticDirtyRevision === this.#editorRevision ? this.#semanticDirty : true;
  }

  #mutationBlockedReason(): string | null {
    if (this.#mergeResolverActive) return '병합 검토가 열려 있습니다.';
    if (this.#agentBridge.isTurnRunning()) return '에이전트가 응답 중입니다.';
    if (this.#agentBridge.pendingEdits.hasPending()) return '대기 중인 에이전트 편집을 먼저 처리하세요.';
    return null;
  }

  #emit(): void {
    const state = this.getState();
    for (const listener of this.#listeners) listener(state);
  }

  #requireRepository(): VersionRepository {
    if (!this.#repository) throw new VersionError('VERSIONING_DISABLED', 'Versioning is not enabled');
    return this.#repository;
  }

  #requireActiveBranch(): BranchRef {
    const active = this.#refs.find((ref): ref is BranchRef => (
      ref.kind === 'branch' && ref.name === this.#activeBranch
    ));
    if (!active) throw new VersionError('REF_NOT_FOUND', 'The active branch was not found');
    return active;
  }

  #requireInputHandler(): InputHandler {
    const handler = this.#getInputHandler();
    if (!handler) throw new VersionError('RESTORE_PARSE_FAILED', 'The editor is not ready');
    return handler;
  }

  async #requireCommit(id: string): Promise<VersionCommit> {
    const commit = await this.#store.getCommit(commitId(id));
    if (!commit || commit.repositoryId !== this.#repository?.id) {
      throw new VersionError('COMMIT_NOT_FOUND', 'Commit was not found');
    }
    return commit;
  }

  async #createCheckpoint(
    options: CreateCheckpointOptions,
    captured?: CapturedVersionSnapshot,
  ): Promise<VersionCommit | null> {
    const workspace = this.#captureWorkspaceToken();
    const repository = this.#requireRepository();
    const branch = this.#requireActiveBranch();
    const capture = captured ?? captureVersionSnapshot(this.#wasm);
    const head = await this.#requireCommit(branch.target);
    this.#assertWorkspaceToken(workspace);
    const message = options.message?.trim() ?? '';
    if (capture.fingerprint === head.contentFingerprint && !options.allowSameContent) {
      if (options.lastSaved && repository.lastSavedFingerprint !== capture.fingerprint) {
        const updated = await this.#store.markSaved(
          repository.id,
          capture.fingerprint,
          repository.revision,
        );
        options.onPersisted?.();
        if (!this.#isWorkspaceTokenCurrent(workspace, { editor: false })) return null;
        this.#repository = updated;
        await this.#refreshData(true);
        return null;
      }
      if (options.reason === 'manual' && message) {
        const name = tagForMessage(message, this.#refs);
        await this.#store.createTag({
          repositoryId: repository.id,
          name: tagName(name),
          target: head.id,
          expectedRepositoryRevision: repository.revision,
        });
        options.onPersisted?.();
        if (!this.#isWorkspaceTokenCurrent(workspace, { editor: false })) return null;
        await this.#refreshData(true);
        return null;
      }
      if (options.reason === 'manual') throw new VersionError('NO_CHANGES', '이미 커밋한 내용입니다.');
      return null;
    }
    const before = await this.#store.getCompareSnapshot(head.compareSnapshotId);
    this.#assertWorkspaceToken(workspace);
    const analysis = analyzeVersionDiff(before?.snapshot ?? null, capture.compareSnapshot);
    // Upgrade legacy ancestry before attaching the new full manifest so stable
    // identities propagate oldest-to-newest instead of starting at this head.
    const manifestParents = options.parents ?? [head.id];
    const manifestMemo = new Map<CommitId, Promise<VersionMergeManifest>>();
    for (const parent of manifestParents) {
      await this.#ensureFullMergeManifest(repository.id, parent, manifestMemo);
    }
    const mergeManifestEntries = await this.#mergeWorker.buildDocumentManifest(capture.bytes);
    this.#assertWorkspaceToken(workspace);
    const createdAt = Date.now();
    const result = await this.#store.createCheckpoint({
      repositoryId: repository.id,
      branch: branch.name,
      expectedRepositoryRevision: repository.revision,
      expectedBranchRevision: branch.revision,
      expectedHead: branch.target,
      parents: options.parents,
      reason: options.reason,
      bytes: capture.bytes,
      compareSnapshot: capture.compareSnapshot,
      contentFingerprint: capture.fingerprint,
      mergeManifestEntries,
      title: message || timestampTitle(createdAt),
      titleOrigin: message ? 'manual' : 'timestamp',
      titleRevision: 0,
      author: options.author ?? (options.reason === 'manual'
        ? { kind: 'user', label: '사용자' }
        : { kind: 'system', label: '버전 관리자' }),
      stats: analysis.stats,
      createdAt,
      ...(options.merge ? { merge: options.merge } : {}),
      ...(options.lastSaved ? { lastSavedFingerprint: capture.fingerprint } : {}),
    });
    options.onPersisted?.();
    if (!this.#isWorkspaceTokenCurrent(workspace, { editor: false })) return result.commit;
    this.#repository = result.repository;
    await this.#refreshData(true);
    if (!message) {
      this.#requestGeneratedTitle(
        result.commit,
        analysis.titleSummary,
      );
    }
    return result.commit;
  }

  async #prepareMergeWorkingTree(): Promise<boolean> {
    const workspace = this.#captureWorkspaceToken();
    const branch = this.#requireActiveBranch();
    const capture = captureVersionSnapshot(this.#wasm);
    const head = await this.#requireCommit(branch.target);
    this.#assertWorkspaceToken(workspace);
    if (capture.fingerprint === head.contentFingerprint) return true;
    this.#setMergeResolverLock(true);
    let choice: Awaited<ReturnType<typeof prepareUncommittedMerge>>;
    try {
      choice = await prepareUncommittedMerge(branch.name);
      this.#assertWorkspaceToken(workspace);
    } finally {
      this.#setMergeResolverLock(false);
    }
    if (choice.kind === 'cancel') return false;
    if (choice.kind === 'stash') {
      await this.#createShelf('병합 전 내 변경');
    } else if (choice.kind === 'commit') {
      await this.#createCheckpoint({ reason: 'manual', message: '병합 전 내 변경' }, capture);
    } else if (choice.kind === 'branch') {
      const repository = this.#requireRepository();
      const blob = await this.#store.getBlob(head.blobId);
      if (!blob) throw new VersionError('CORRUPT_BLOB', '현재 브랜치 문서를 찾을 수 없습니다.');
      const handler = this.#requireInputHandler();
      handler.prepareSnapshotCapacity(2);
      this.#assertWorkspaceToken(workspace);
      const created = await this.#store.createBranch({
        repositoryId: repository.id,
        name: branchName(choice.name),
        target: head.id,
        expectedRepositoryRevision: repository.revision,
      });
      this.#repository = created.repository;
      await this.#appendBranchSnapshot(created.branch, capture, '내 변경', 'manual');
      // The new branch owns the edits. Keep the original target selected.
      this.#assertWorkspaceToken(workspace, { repository: false });
      handler.replaceContentFromBytes(blob.bytes);
      this.#setDirtyForFingerprint(head.contentFingerprint, 'version-merge-prepare', head.contentFingerprint);
      await this.#refreshData(true);
    }
    return true;
  }

  async #appendBranchSnapshot(
    branch: BranchRef,
    capture: CapturedVersionSnapshot,
    title: string,
    reason: 'manual' | 'agent',
    id?: CommitId,
  ): Promise<VersionCommit> {
    const workspace = this.#captureWorkspaceToken();
    const repository = this.#requireRepository();
    await this.#ensureFullMergeManifest(repository.id, branch.target, new Map());
    const mergeManifestEntries = await this.#mergeWorker.buildDocumentManifest(capture.bytes);
    this.#assertWorkspaceToken(workspace);
    const result = await this.#store.createCheckpoint({
      id, repositoryId: repository.id, branch: branch.name,
      expectedRepositoryRevision: repository.revision,
      expectedBranchRevision: branch.revision, expectedHead: branch.target,
      reason, bytes: capture.bytes, compareSnapshot: capture.compareSnapshot,
      contentFingerprint: capture.fingerprint, mergeManifestEntries,
      title, titleOrigin: 'manual', titleRevision: 0,
      author: reason === 'agent' ? { kind: 'agent', label: 'Cloud' } : { kind: 'user', label: '사용자' },
    });
    this.#repository = result.repository;
    await this.#refreshData(true);
    return result.commit;
  }

  async #checkpointDirty(reason: 'pre-restore' | 'pre-switch' | 'pre-merge'): Promise<void> {
    const workspace = this.#captureWorkspaceToken();
    const branch = this.#requireActiveBranch();
    const capture = captureVersionSnapshot(this.#wasm);
    const head = await this.#requireCommit(branch.target);
    this.#assertWorkspaceToken(workspace);
    if (capture.fingerprint === head.contentFingerprint) {
      this.#setDirtyForFingerprint(capture.fingerprint, 'version-head-match');
      return;
    }
    await this.#createCheckpoint({ reason }, capture);
  }

  #requestGeneratedTitle(commit: VersionCommit, summary: CheckpointTitleSummary): void {
    if (!readAiTitlesEnabled()) return;
    void this.#agentBridge.requestCheckpointTitle({
      commitId: commit.id,
      titleRevision: commit.titleRevision,
      appLanguage: document.documentElement.lang || navigator.language || 'ko-KR',
      summary,
    }).then(async (result) => {
      if (!result || result.commitId !== commit.id || result.titleRevision !== commit.titleRevision) return;
      try {
        await this.#store.updateCommitTitle({
          repositoryId: commit.repositoryId,
          commitId: commit.id,
          expectedTitleRevision: commit.titleRevision,
          title: result.title,
          titleOrigin: 'generated',
          titleRevision: commit.titleRevision,
          generatedBy: { provider: result.provider, model: result.model },
        });
        await this.refresh();
      } catch {
        // A manual title or another checkpoint won the compare-and-swap.
      }
    }).catch(() => undefined);
  }

  #applyBranchContent(
    handler: InputHandler,
    bytes: Uint8Array,
    target: VersionCommit,
    next: BranchRef,
    previous: BranchRef,
    previousCommit: VersionCommit | null = null,
  ): void {
    handler.replaceContentFromBytes(bytes, {
      afterUndo: () => {
        queueMicrotask(() => {
          this.#setActiveBranch(previous.name);
          if (previousCommit) {
            this.#setDirtyForFingerprint(
              previousCommit.contentFingerprint,
              'version-branch-undo',
              previousCommit.contentFingerprint,
            );
          }
          void this.refresh();
        });
      },
      afterRedo: () => {
        queueMicrotask(() => {
          this.#setActiveBranch(next.name);
          this.#setDirtyForFingerprint(
            target.contentFingerprint,
            'version-branch-redo',
            target.contentFingerprint,
          );
          void this.refresh();
        });
      },
    });
    this.#setActiveBranch(next.name);
    this.#setDirtyForFingerprint(
      target.contentFingerprint,
      'version-branch-switch',
      target.contentFingerprint,
    );
  }

  #rollbackReplacement(
    handler: InputHandler,
    original: CapturedVersionSnapshot,
    wasDirty: boolean,
    replacementWorkspace: WorkspaceToken,
  ): void {
    try {
      this.#assertWorkspaceToken(replacementWorkspace, { repository: false });
    } catch {
      // Never undo across intervening user input or a document switch.
      return;
    }
    try {
      handler.performUndo();
      // Recording the restored state as a no-op clears the failed replacement from redo.
      handler.replaceContentFromBytes(original.bytes);
      this.#recordSemanticDirty(original.fingerprint);
      if (wasDirty) this.#documentState.markDirty('version-operation-rollback');
      else this.#documentState.markClean('version-operation-rollback');
      this.#syncTransientState();
    } catch (error) {
      console.error('[Versions] Failed to roll back an uncommitted content replacement:', error);
    }
  }

  #setActiveBranch(name: BranchName): void {
    this.#activeBranch = name;
    const id = this.#getDocumentId();
    if (id) {
      this.#activeBranches.set(id, name);
      persistActiveBranch(id, name);
    }
  }

  #setDirtyForFingerprint(
    fingerprint: string,
    reason: string,
    semanticHeadFingerprint?: string,
  ): void {
    this.#recordSemanticDirty(fingerprint, semanticHeadFingerprint);
    if (fingerprint === this.#repository?.lastSavedFingerprint) this.#documentState.markClean(reason);
    else this.#documentState.markDirty(reason);
  }

  #recordSemanticDirty(fingerprint: string, headFingerprint?: string): void {
    const active = this.#refs.find((ref): ref is BranchRef => (
      ref.kind === 'branch' && ref.name === this.#activeBranch
    ));
    const head = headFingerprint
      ?? this.#commits.find((commit) => commit.id === active?.target)?.contentFingerprint;
    this.#semanticDirty = head ? fingerprint !== head : true;
    this.#semanticDirtyRevision = this.#editorRevision;
    this.#state.dirty = this.#semanticDirty;
  }
}
