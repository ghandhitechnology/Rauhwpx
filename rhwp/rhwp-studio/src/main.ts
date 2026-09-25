import { WasmBridge, type PreparedWasmDocument } from '@/core/wasm-bridge';
import { installDocumentTitle } from '@/ui/document-title';
import { FALLBACK_DOCUMENT_FILE_NAME } from '@/core/document-names';
import type { DocumentInfo } from '@/core/types';
import { browserOriginSyncDigest, browserOriginPublishedRevision, setBrowserOriginSyncDigest } from '@/cloud/browser-cloud';
import { EventBus } from '@/core/event-bus';
import { assertRemoteDocumentBytes } from '@/core/document-signature';
import { consumeExactLocalFileRead } from '@/core/local-file-grant';
import {
  EXACT_LOCAL_DOCUMENT_MAX_BYTES,
  INSERTED_IMAGE_MAX_BYTES,
  UNTRUSTED_DOCUMENT_MAX_BYTES,
  cancelResponseBody,
  readBlobBytesWithLimit,
  readResponseBytesWithLimit,
} from '@/core/document-input-limits';
import { RemoteDocumentUrlError, validateRemoteDocumentUrl } from '@/core/remote-document-url';
import { ExtensionRemoteProxyUnavailableError } from '@/core/extension-file-transfer';
import { CanvasView } from '@/view/canvas-view';
import {
  assertEncodedImageDecodeDimensions,
  assertImageDecodeDimensions,
} from '@/view/canvaskit/image-header';
import { InputHandler } from '@/engine/input-handler';
import { Toolbar } from '@/ui/toolbar';
import { EditorToolbarOverflow } from '@/ui/editor-toolbar-overflow';
import { setupTableRibbonMenus, type TableRibbonMenusController } from '@/ui/table-ribbon-menu';
import { EditorStyleOverflow } from '@/ui/editor-style-overflow';
import { setupStatusZoomSlider } from '@/ui/status-zoom';
import { describePaperSize } from '@/ui/status-paper-size';
import { StatusCharacterCounter } from '@/ui/status-character-count';
import { MenuBar } from '@/ui/menu-bar';
import { loadWebFonts, resolveCanvasKitFontPlan } from '@/core/font-loader';
import { withCanvasKitSurfaceBlockers } from '@/core/canvaskit-document-preflight';
import { loadExtensionViewerSettings, type ExtensionViewerSettings } from '@/core/extension-settings';
import { CommandRegistry } from '@/command/registry';
import { CommandDispatcher } from '@/command/dispatcher';
import { defaultShortcuts, matchShortcut } from '@/command/shortcut-map';
import { detectPlatformKind } from '@/engine/navigation-keymap';
import { allowsDocumentShortcut, isEditorInput, ownsTextInput } from '@/command/shortcut-target';
import type { EditorContext, CommandServices, EditorEditMode } from '@/command/types';
import {
  confirmSaveBeforeReplacingDocument,
  fileCommands,
  runLibraryMove,
  saveCurrentDocument,
} from '@/command/commands/file';
import { exportDocumentForFormat } from '@/command/save-document-format';
import { editCommands, openClassicDocumentHistory } from '@/command/commands/edit';
import {
  setBasicToolboxExpanded,
  syncClipMenu,
  syncTextMarkMenu,
  viewCommands,
} from '@/command/commands/view';
import { formatCommands } from '@/command/commands/format';
import { insertCommands } from '@/command/commands/insert';
import { tableCommands } from '@/command/commands/table';
import { pageCommands } from '@/command/commands/page';
import { toolCommands } from '@/command/commands/tool';
import { installPwaFileHandling, type FileHandlingWindowLike } from '@/command/pwa-file-handling';
import {
  captureDroppedFileHandle,
  isSupportedDocumentFileName,
  readFileFromHandle,
  type FileSystemFileHandleLike,
} from '@/command/file-system-access';
import { forgetConvertedHmlSaveHandle } from '@/command/save-target';
import { ContextMenu } from '@/ui/context-menu';
import { CommandPalette } from '@/ui/command-palette';
import { showHmlImportWarning } from '@/ui/hml-import-warning';
import { showLocalFontsModalIfNeeded } from '@/ui/local-fonts-modal';
import { showToast } from '@/ui/toast';
import { documentSourceDigest, resolveDocumentPreflight, type DocumentPreflightIdentity, type OpenDocumentBytesEvent, type VerifiedDocumentGrant } from '@/recent/document-preflight';
import { addRecentDoc, listRecentDocs } from '@/recent/recent-store';
import { showDropConfirmDialog } from '@/ui/drop-confirm-dialog';
import { initRhwpDev } from '@/core/rhwp-dev';
import { DocumentDirtyState } from '@/core/document-dirty-state';
import {
  applyTheme,
  getEffectiveTheme,
  getThemeMode,
  initThemeSync,
  setThemeMode,
  syncThemeMenu,
} from '@/core/theme';
import { analyzeDocumentFonts } from '@/core/document-font-status';
import {
  detectLocalFonts, getLocalFontState, getLocalFonts, importLocalFontFiles, localFontImportMessage, loadStoredLocalFonts,
  repairLocalFontFacesFor, setActiveDocumentFonts,
} from '@/core/local-fonts';
import { userSettings, type EditorScalarSettings } from '@/core/user-settings';
import { AutosaveManager, type AutosaveScheduleSettings, type AutosaveStatus } from '@/recovery/autosave-manager';
import {
  clearRecoverableAutosaveDrafts,
  deleteAutosaveDraft,
  listRecoverableAutosaveDrafts,
  type AutosaveDraft,
} from '@/recovery/autosave-store';
import { recoveryFileName } from '@/recovery/recovery-format';
import { showAutosaveRecoveryDialog } from '@/recovery/recovery-ui';
import { isPinnedDocumentEnabled, startPinnedDocument } from '@/recovery/pinned-document';
import { CellSelectionRenderer } from '@/engine/cell-selection-renderer';
import { TableObjectRenderer } from '@/engine/table-object-renderer';
import { TableResizeRenderer } from '@/engine/table-resize-renderer';
import { Ruler } from '@/view/ruler';
import {
  headerFooterApplyToLabel,
  parseHeaderFooterModeChanged,
} from '@/engine/header-footer-mode';
import { RendererSession, type RendererSessionDiagnostics } from '@/view/renderer-session';
import {
  resolveCanvasKitRenderModeRequest,
  resolveCanvasKitSurfaceRequest,
  resolveRenderBackendRequest,
  resolveRenderProfile,
  type RenderBackendFallbackReason,
} from '@/view/render-backend';
import { calculateFitPageZoom, calculateFitWidthZoom } from '@/view/zoom-fit';
import { installEmbedRuntime } from '@/embed/runtime';
import {
  bindNativeFileHandleIdentity,
  cancelDesktopDocument,
  captureDesktopNativeDroppedFile,
  commitDesktopDocument,
  getNativeFileHandleVerifiedDocumentId,
  getRendererSessionContext,
  installDesktopCloseHandling,
  installDesktopCloudEditDraftSaveHandling,
  installDesktopFileHandling,
  installDesktopGeneratedDocumentHandling,
  installDesktopPlainTextPasteHandling,
  installDesktopEditCommandHandling,
  installDesktopWindowChrome,
  installWebAppShell,
  isLegacyPortableHistoryFolderHandle,
  pickDesktopNativeOpenFile,
  pickDesktopNativeSaveFile,
  persistDesktopCloudEditDraft,
  releaseDesktopDocument,
  releaseReplacedNativeFileHandle,
  rememberNativeDocument,
  reserveDesktopDocument,
} from '@/desktop-integration';
import { initAgentBridge, type AgentBridge, type ChatHistoryEntry } from './agent/bridge.ts';
import type { AgentName } from './agent/types.ts';
import { initAgentSidebar } from './ui/agent-sidebar/index.ts';
import { showEditingSettingsFallback } from './ui/agent-sidebar/settings-editing-fallback.ts';
import { AGENT_LABEL } from './ui/agent-sidebar/providers.ts';
import { initInlinePrompt } from './agent/inline-prompt.ts';
import { DocumentVersionController, persistActiveBranch } from './versioning/controller.ts';
import {
  VersionGraphStore,
  documentId as versionDocumentId,
  isPortableHistoryBytes,
  isPortableHistoryFileName,
  openPortableHistoryBundle,
} from './versioning/index.ts';
import type { AgentEditingLease } from './agent/types.ts';
import { agentLeaseBlocksUserEditing } from './agent/editing-lease.ts';
import type { EmbedRendererRuntimeRequestV1 } from '@/embed/rpc-router';
import type {
  CloudCheckpointPayload,
  CloudDocumentPayload,
  CloudDownloadResult,
  CloudResultResolution,
  CloudTakeoverPayload,
} from './cloud/types.ts';
import {
  captureCloudOriginSha256,
  checkpointMatchesActiveDocument,
  persistCheckpointToBrowserOrigin,
} from './cloud/checkpoint-origin.ts';
import {
  contextualEditingToolbarMode,
  contextualObjectCommandEnabled,
  type ContextualEditingToolbarMode,
} from '@/ui/contextual-editing-toolbar';
import {
  canGroupTopLevelBodyObjects,
  canUngroupTopLevelBodyObject,
  isTopLevelBodyObject,
  isTopLevelLayerOrderTarget,
  objectAddressScope,
} from '@/core/object-address';

const wasm = new WasmBridge();
installDocumentTitle(wasm);
const eventBus = new EventBus();
const documentState = new DocumentDirtyState(eventBus);
documentState.installBeforeUnload(window);
const rendererSessionContextPromise = getRendererSessionContext();
let disposeAgentSidebar = (): void => {};
let cloudEditDraftIdentity: import('@/desktop-integration').CloudEditDraftIdentity | null = null;
let cloudEditDraftSaveTimer: ReturnType<typeof setTimeout> | null = null;

async function persistCloudEditDraft(requestId?: string): Promise<void> {
  if (!cloudEditDraftIdentity || wasm.pageCount < 1) return;
  inputHandler?.finalizeCompositionBeforeCursorMove();
  const sourceFormat = wasm.getSourceFormat();
  if (sourceFormat !== 'hwp' && sourceFormat !== 'hwpx') {
    throw new Error('Cloud edit drafts require HWP or HWPX');
  }
  await persistDesktopCloudEditDraft({
    ...cloudEditDraftIdentity,
    bytes: exportDocumentForFormat(wasm, sourceFormat),
    fileName: wasm.fileName,
    ...(requestId ? { requestId } : {}),
  });
}

function scheduleCloudEditDraftSave(): void {
  if (!cloudEditDraftIdentity) return;
  if (cloudEditDraftSaveTimer) clearTimeout(cloudEditDraftSaveTimer);
  cloudEditDraftSaveTimer = setTimeout(() => {
    cloudEditDraftSaveTimer = null;
    void persistCloudEditDraft().catch((error) => {
      console.warn('[cloud-edit] draft persistence failed:', error);
    });
  }, 900);
}

const disposeCloudEditDraftSaveHandling = installDesktopCloudEditDraftSaveHandling(async (requestId) => {
  if (cloudEditDraftSaveTimer) {
    clearTimeout(cloudEditDraftSaveTimer);
    cloudEditDraftSaveTimer = null;
  }
  await persistCloudEditDraft(requestId);
});
const autosaveManager = new AutosaveManager({
  exportBytes: () => wasm.exportHwp(),
  schedule: autosaveScheduleFromUserSettings(),
  onStatus: handleAutosaveStatus,
});
void rendererSessionContextPromise.then((context) => {
  if (context) {
    autosaveManager.setOwner({ launchId: context.launchId, sessionId: context.sessionId });
  }
});
autosaveManager.connect(eventBus);
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    disposeCloudEditDraftSaveHandling();
    disposeAgentSidebar();
    autosaveManager.dispose();
  }
});
initThemeSync((effective, mode) => {
  eventBus.emit('theme-changed', { mode, effective });
  eventBus.emit('command-state-changed');
});

/**
 * 호스트 저장 완료 통지 (#2660).
 *
 * 호스트가 내보내기 바이트의 영속화(업로드/핸드오프)를 마친 뒤 호출한다.
 * draft 삭제 "완료"까지 await하므로, resolve 이후 팝업을 닫아도 IndexedDB
 * 삭제가 잘리지 않는다. export 시점에는 호출하지 않는다(실패 시 백업 보존).
 */
async function completeHostSave(fileName?: string): Promise<{ ok: true; wasDirty: boolean }> {
  const wasDirty = documentState.isDirty();
  if (fileName) wasm.fileName = fileName;
  documentState.markClean('host-save');
  eventBus.emit('document-context-changed');
  eventBus.emit('document-saved', {
    reason: 'host-save',
    fileName: wasm.fileName,
    sourceFormat: wasm.getSourceFormat(),
  });
  await autosaveManager.discardCurrentDraft('host-save');
  return { ok: true, wasDirty };
}

// 호스트 통합용 공개 API — 팝업/포크 등 SDK 없이 스튜디오 페이지 안에서 통합하는
// 호스트를 위해 프로덕션 빌드에도 항상 노출한다 (iframe 호스트는 embed RPC 사용).
(window as any).rhwpStudio = {
  notifySaved: (fileName?: string) => completeHostSave(fileName),
};

// E2E 테스트용 전역 노출 (개발 모드 전용)
if (import.meta.env.DEV) {
  (window as any).__wasm = wasm;
  (window as any).__eventBus = eventBus;
  (window as any).__documentState = documentState;
  (window as any).__autosaveManager = autosaveManager;
  (window as any).__theme = { getThemeMode, getEffectiveTheme, setThemeMode };
  initRhwpDev(wasm);
}
let canvasView: CanvasView | null = null;
let inputHandler: InputHandler | null = null;
let commandPalette: CommandPalette | null = null;
let toolbar: Toolbar | null = null;
let editorToolbarOverflow: EditorToolbarOverflow | null = null;
let tableRibbonMenus: TableRibbonMenusController | null = null;
let editorStyleOverflow: EditorStyleOverflow | null = null;
let ruler: Ruler | null = null;
let rendererSession: RendererSession | null = null;
let editMode: EditorEditMode = 'normal';
let documentReadOnly = new URLSearchParams(window.location.search).get('templatePreview') === '1';
let agentEditingLease: AgentEditingLease = { active: false, agent: 'codex' };
let previewDocumentReadOnly = documentReadOnly;
let cloudAuthorityTransitionCount = 0;
let rendererRuntimeRequest: EmbedRendererRuntimeRequestV1 | null = null;
let renderBackendFallbackReason: RenderBackendFallbackReason | null = null;
let rendererInitializationError: string | null = null;
let rendererInitialized = false;
/**
 * 현재 편집 세션의 논리 문서 ID. 파일명/Save As 대상과 분리되어 문서가 열린
 * 동안 유지되고, 재열기 시 recent-store가 handle/digest로 이전 ID를 복원한다.
 */
let activeDocumentId: string | null = null;

class DocumentOwnedElsewhereError extends Error {
  constructor() {
    super('다른 창에서 이미 열려 있는 문서입니다.');
    this.name = 'DocumentOwnedElsewhereError';
  }
}

let extensionViewerSettings: ExtensionViewerSettings = {
  disableExternalWebFonts: false,
};

function createActiveDocumentId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `document_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}


// ─── 커맨드 시스템 ─────────────────────────────
const registry = new CommandRegistry();

function getContext(): EditorContext {
  const hasDoc = wasm.pageCount > 0;
  const canEditFormField = inputHandler?.canEditCurrentFormField() ?? false;
  const isFormMode = editMode === 'form';
  const selectedObject = inputHandler?.getSelectedPictureRef() ?? null;
  const selectedObjects = inputHandler?.getSelectedPictureRefs() ?? [];
  return {
    hasDocument: hasDoc,
    hasSelection: inputHandler?.hasSelection() ?? false,
    hasCopiedFormat: inputHandler?.hasCopiedFormat() ?? false,
    inTable: inputHandler?.isInTable() ?? false,
    inCellSelectionMode: inputHandler?.isInCellSelectionMode() ?? false,
    hasMultiCellSelection: inputHandler?.hasMultiCellSelection() ?? false,
    hasTableTransposeClipboard: wasm.hasTableTransposeClipboard(),
    inTableObjectSelection: inputHandler?.isInTableObjectSelection() ?? false,
    inPictureObjectSelection: inputHandler?.isInPictureObjectSelection() ?? false,
    canArrangeSelectedObject: !!selectedObject && isTopLevelLayerOrderTarget(selectedObject),
    canGroupSelectedObjects: canGroupTopLevelBodyObjects(selectedObjects),
    canUngroupSelectedObject: canUngroupTopLevelBodyObject(selectedObject),
    inField: inputHandler?.isInField() ?? false,
    isEditable: !documentReadOnly && !agentUserEditingLocked() && (!isFormMode || canEditFormField),
    readOnly: documentReadOnly,
    userEditingLocked: agentUserEditingLocked(),
    editMode,
    isFormMode,
    canEditFormField,
    canUndo: inputHandler?.canUndo() ?? false,
    canRedo: inputHandler?.canRedo() ?? false,
    zoom: canvasView?.getViewportManager().getZoom() ?? 1.0,
    showControlCodes: wasm.getShowControlCodes(),
    showParagraphMarks: wasm.getShowParagraphMarks(),
    isDirty: documentState.isDirty(),
    sourceFormat: hasDoc ? (wasm.getSourceFormat() as 'hwp' | 'hwpx' | 'hml') : undefined,
  };
}

function setEditMode(mode: EditorEditMode): void {
  editMode = mode;
  inputHandler?.setEditMode(mode);
  document.documentElement.dataset.editMode = mode;
  document.querySelectorAll('[data-cmd="view:form-mode"]').forEach(el => {
    el.classList.toggle('active', mode === 'form');
  });
  sbMessage().textContent = mode === 'form' ? '양식 모드' : '기본 편집 모드';
  eventBus.emit('edit-mode-changed', mode);
  eventBus.emit('command-state-changed');
}

function setDocumentReadOnly(readOnly: boolean): void {
  previewDocumentReadOnly = readOnly;
  syncDocumentReadOnly();
}

function setCloudDocumentLease(cloudOwned: boolean): void {
  document.documentElement.dataset.cloudLease = cloudOwned ? 'cloud' : 'local';
  syncDocumentReadOnly();
}

function beginCloudAuthorityTransition(): { release(): void } {
  cloudAuthorityTransitionCount += 1;
  document.documentElement.dataset.cloudAuthorityTransition = 'true';
  syncDocumentReadOnly();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      cloudAuthorityTransitionCount = Math.max(0, cloudAuthorityTransitionCount - 1);
      document.documentElement.dataset.cloudAuthorityTransition = cloudAuthorityTransitionCount > 0 ? 'true' : 'false';
      syncDocumentReadOnly();
    },
  };
}

function syncDocumentReadOnly(): void {
  documentReadOnly = previewDocumentReadOnly
    || cloudAuthorityTransitionCount > 0;
  document.documentElement.dataset.documentReadOnly = documentReadOnly ? 'true' : 'false';
  inputHandler?.setReadOnly(documentReadOnly);
  toolbar?.setEnabled(wasm.pageCount > 0 && !documentReadOnly && !agentUserEditingLocked());
  eventBus.emit('command-state-changed');
}

function setAgentEditingLease(lease: AgentEditingLease): void {
  agentEditingLease = lease;
  document.documentElement.dataset.agentEditing = lease.active ? 'true' : 'false';
  const editorArea = document.getElementById('editor-area');
  const frame = document.getElementById('agent-editing-frame');
  const status = document.getElementById('agent-editing-status');
  const statusLabel = document.getElementById('agent-editing-status-label');
  if (editorArea) editorArea.dataset.editingAgent = lease.agent;
  editorArea?.setAttribute('aria-busy', lease.active ? 'true' : 'false');
  if (frame) frame.hidden = !lease.active;
  if (status) status.hidden = !lease.active;
  if (statusLabel) {
    statusLabel.textContent = `${AGENT_LABEL[lease.agent]}가 문서를 편집 중이에요`;
    if (lease.waitingForUser) statusLabel.textContent = `${AGENT_LABEL[lease.agent]}가 답변을 기다리고 있어요`;
  }
  inputHandler?.setUserEditingLocked(agentUserEditingLocked());
  toolbar?.setEnabled(wasm.pageCount > 0 && !documentReadOnly && !agentUserEditingLocked());
  eventBus.emit('command-state-changed');
}

function bytesToSha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return crypto.subtle.digest('SHA-256', copy.buffer).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
}

async function prepareCloudTransferDocument(startId: string, restart?: { document: CloudDocumentPayload; sourceStartId?: string }) {
  if (!wasm.hasLoadedDocument()) return null;
  if (wasm.isNewDocument) return null;
  if (restart) {
    // Older sessions may have no local history. They can still recover and
    // download copies, but must not invent an ancestor from current local edits.
    if (!restart.sourceStartId) return restart.document;
    if (!versionControllerRef) throw new Error('문서 버전 기록을 준비하는 중입니다.');
    const bytes = await versionControllerRef.prepareCloudBranch(
      startId, restart.document.bytes, restart.document.fileName, restart.sourceStartId,
    );
    return { ...restart.document, bytes, sha256: await bytesToSha256(bytes) };
  }
  const sourceFormat = wasm.getSourceFormat();
  if (sourceFormat !== 'hwp' && sourceFormat !== 'hwpx' && sourceFormat !== 'hml') {
    throw new Error(`클라우드에서 지원하지 않는 문서 형식입니다: ${sourceFormat}`);
  }
  const format = sourceFormat;
  let bytes = exportDocumentForFormat(wasm, format);
  if (!versionControllerRef) throw new Error('문서 버전 기록을 준비하는 중입니다.');
  bytes = await versionControllerRef.prepareCloudBranch(startId, bytes, wasm.fileName);
  // The Cloud snapshot may include unsaved edits. Keep the current saved origin
  // digest separate so later publication can still detect external file changes.
  const originSha256 = await captureCloudOriginSha256({
    handle: wasm.currentFileHandle,
    loadedDigest: wasm.documentDigest,
    sourceDigest: documentSourceDigest,
    digest: bytesToSha256,
  });
  return {
    bytes,
    fileName: wasm.fileName,
    sha256: await bytesToSha256(bytes),
    ...(originSha256 !== undefined ? { originSha256 } : {}),
  };
}

/**
 * Worker-only browser control surface for the cloud document runtime.
 *
 * The dedicated worker build must enable this at compile time. It then still
 * requires loopback origin, an explicit query flag, and a per-session 256-bit
 * bootstrap secret. Normal web and desktop builds therefore expose nothing.
 */
let cloudDocumentPublishingEnabled = false;

function agentUserEditingLocked(): boolean {
  return agentLeaseBlocksUserEditing(agentEditingLease, cloudDocumentPublishingEnabled);
}

function installCloudDocumentRuntimeApi(agentBridge: AgentBridge): boolean {
  const cloudBuild = (import.meta as ImportMeta & { env?: Record<string, string | undefined> })
    .env?.['VITE_RHWP_CLOUD_RUNTIME'] === '1';
  const loopback = window.location.hostname === '127.0.0.1'
    || window.location.hostname === 'localhost'
    || window.location.hostname === '[::1]'
    || window.location.hostname === '::1';
  const params = new URLSearchParams(window.location.search);
  const bootstrap = params.get('bootstrap') ?? '';
  if (!cloudBuild || !loopback || params.get('cloudRuntime') !== '1' || bootstrap.length < 43) return false;
  cloudDocumentPublishingEnabled = true;

  let eventSequence = 0;
  let exportedBytes: Uint8Array | null = null;
  let exportedFormat: 'hwp' | 'hwpx' | 'hml' | null = null;
  const events: Array<{ seq: number; event: unknown }> = [];
  const requireSecret = (candidate: unknown): void => {
    if (typeof candidate !== 'string' || candidate !== bootstrap) {
      throw new Error('Cloud runtime bootstrap authentication failed');
    }
  };
  const runtimeUrl = (raw: unknown): URL => {
    const url = new URL(String(raw ?? ''), window.location.origin);
    if (url.origin !== window.location.origin
      || !url.pathname.startsWith('/_runtime/resource/')
      || url.searchParams.get('bootstrap') !== bootstrap) {
      throw new Error('Cloud runtime resource URL is outside the authenticated loopback origin');
    }
    return url;
  };
  const fetchRuntimeFile = async (raw: unknown, name: unknown, mimeType: unknown): Promise<File> => {
    const response = await fetch(runtimeUrl(raw), { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error(`Cloud runtime resource fetch failed (${response.status})`);
    return new File([await response.blob()], String(name ?? 'resource.bin').slice(0, 255), {
      type: typeof mimeType === 'string' && mimeType ? mimeType : 'application/octet-stream',
    });
  };

  agentBridge.onEvent((event) => {
    events.push({ seq: ++eventSequence, event: structuredClone(event) });
    if (events.length > 2_000) events.splice(0, events.length - 2_000);
  });

  let documentRevision = 0;
  eventBus.on('document-mutated', () => { documentRevision += 1; });
  eventBus.on('document-changed', () => { documentRevision += 1; });
  const api = Object.freeze({
    status(secret: unknown) {
      requireSecret(secret);
      return {
        connection: agentBridge.getConnectionState(),
        activeAgent: agentBridge.getActiveAgent(),
        turnRunning: agentBridge.isTurnRunning(),
        documentLoaded: wasm.hasLoadedDocument(),
        documentRevision,
        latestEventSeq: eventSequence,
      };
    },
    async loadDocument(secret: unknown, input: { url?: unknown; name?: unknown; mimeType?: unknown }) {
      requireSecret(secret);
      const file = await fetchRuntimeFile(input?.url, input?.name, input?.mimeType);
      if (!/\.(?:hwp|hwpx|hml)$/i.test(file.name)) throw new Error('Cloud runtime document format is unsupported');
      if (!(await loadFile(file, { skipUnsavedGuard: true, suppressDialogs: true }))) {
        throw new Error('Cloud runtime could not load the document');
      }
      return {
        fileName: wasm.fileName,
        sourceFormat: wasm.getSourceFormat(),
        pageCount: wasm.pageCount,
        sectionCount: wasm.getSectionCount(),
        digest: wasm.documentDigest,
      };
    },
    async uploadReference(secret: unknown, input: {
      url?: unknown;
      name?: unknown;
      mimeType?: unknown;
      scopeId?: unknown;
    }) {
      requireSecret(secret);
      const scopeId = String(input?.scopeId ?? '');
      if (!scopeId || scopeId.length > 256) throw new Error('Cloud runtime reference scope is invalid');
      const file = await fetchRuntimeFile(input?.url, input?.name, input?.mimeType);
      return agentBridge.uploadReference('chat', scopeId, file);
    },
    startChat(secret: unknown, input: {
      agent?: AgentName;
      model?: unknown;
      effort?: unknown;
      workflow?: unknown;
      permissionProfile?: unknown;
      threadId?: unknown;
      documentId?: unknown;
      documentName?: unknown;
      history?: ChatHistoryEntry[];
    }) {
      requireSecret(secret);
      const agent = input?.agent;
      if (agent !== 'claude' && agent !== 'codex' && agent !== 'pi') throw new Error('Cloud runtime provider is unsupported');
      const threadId = String(input?.threadId ?? '');
      if (!threadId || threadId.length > 256) throw new Error('Cloud runtime thread id is invalid');
      const workflow = input?.workflow === 'plan' || input?.workflow === 'question' ? input.workflow : 'direct';
      if (input?.permissionProfile !== 'unrestricted') {
        throw new Error('Cloud runtime requires the unrestricted permission profile');
      }
      agentBridge.startChat(
        agent,
        String(input?.model ?? ''),
        String(input?.effort ?? ''),
        true,
        'unrestricted',
        workflow,
        threadId,
        typeof input?.documentId === 'string' && input.documentId ? input.documentId : null,
        typeof input?.documentName === 'string' && input.documentName ? input.documentName : wasm.fileName,
        Array.isArray(input?.history) ? input.history : [],
      );
      return { started: true };
    },
    async sendUserMessage(secret: unknown, text: unknown) {
      requireSecret(secret);
      const prompt = String(text ?? '').trim();
      if (!prompt || prompt.length > 64 * 1024) throw new Error('Cloud runtime prompt is invalid');
      return { messageId: await agentBridge.sendUserMessage(prompt) };
    },
    approvePlan(secret: unknown, planId: unknown) {
      requireSecret(secret);
      const id = String(planId ?? '');
      if (!id || id.length > 256) throw new Error('Cloud runtime plan id is invalid');
      agentBridge.approvePlan(id);
      return { approved: true };
    },
    requestPlanChanges(secret: unknown, planId: unknown, feedback: unknown) {
      requireSecret(secret);
      const id = String(planId ?? '');
      const text = String(feedback ?? '').trim();
      if (!id || id.length > 256 || !text || text.length > 64 * 1024) {
        throw new Error('Cloud runtime plan feedback is invalid');
      }
      agentBridge.requestPlanChanges(id, text);
      return { requested: true };
    },
    setWorkflow(secret: unknown, workflow: unknown) {
      requireSecret(secret);
      if (workflow !== 'direct' && workflow !== 'plan' && workflow !== 'question') throw new Error('Cloud runtime workflow is invalid');
      agentBridge.setWorkflow(workflow);
      return { workflow };
    },
    interruptIfIdle(secret: unknown, lastObservedSequence: unknown) {
      requireSecret(secret);
      // No await between checking the event cursor, checking live tool requests,
      // and fencing the provider turn. Events received after the worker's last
      // drain must be handled before it can interrupt at a safe boundary.
      if (!Number.isSafeInteger(lastObservedSequence) || lastObservedSequence !== eventSequence) {
        return { interrupted: false };
      }
      return { interrupted: agentBridge.interruptIfIdle() };
    },
    drainEvents(secret: unknown, afterSequence: unknown) {
      requireSecret(secret);
      const after = Number.isSafeInteger(Number(afterSequence)) ? Number(afterSequence) : 0;
      return events.filter((entry) => entry.seq > after).slice(0, 250);
    },
    async prepareExport(secret: unknown, format: unknown) {
      requireSecret(secret);
      if (format !== 'hwp' && format !== 'hwpx' && format !== 'hml') {
        throw new Error('Cloud runtime export format is unsupported');
      }
      exportedFormat = format;
      exportedBytes = exportDocumentForFormat(wasm, format);
      const exportedRevision = documentRevision;
      return {
        format,
        size: exportedBytes.byteLength,
        fileName: wasm.fileName,
        sha256: await bytesToSha256(exportedBytes),
        documentRevision: exportedRevision,
      };
    },
    readExportChunk(secret: unknown, offset: unknown, length: unknown) {
      requireSecret(secret);
      if (!exportedBytes || !exportedFormat) throw new Error('Cloud runtime export is not prepared');
      const start = Number(offset);
      const size = Number(length);
      if (!Number.isSafeInteger(start) || start < 0 || start > exportedBytes.byteLength
        || !Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024) {
        throw new Error('Cloud runtime export chunk is invalid');
      }
      const chunk = exportedBytes.subarray(start, Math.min(exportedBytes.byteLength, start + size));
      let binary = '';
      for (let index = 0; index < chunk.length; index += 0x8000) {
        binary += String.fromCharCode(...chunk.subarray(index, index + 0x8000));
      }
      return { offset: start, size: chunk.length, dataBase64: btoa(binary) };
    },
    stop(secret: unknown) {
      requireSecret(secret);
      agentBridge.stopChat();
      exportedBytes = null;
      exportedFormat = null;
      return { stopped: true };
    },
  });
  Object.defineProperty(window, 'rauhwpxCloudRuntime', {
    value: api,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  document.documentElement.dataset.cloudDocumentRuntime = 'true';
  return true;
}

async function applyCloudResult(result: CloudDownloadResult, resolution: CloudResultResolution): Promise<{
  documentId: string;
  fileName: string;
} | null> {
  if (resolution.action !== 'replace') {
    if (resolution.action === 'keep-both') {
      const copy = resolution.preservedCopyName ?? result.preservedCopyName ?? resolution.path ?? result.fileName;
      const reason = resolution.conflict === 'external-change' ? '원본 변경을 감지해 ' : '';
      showToast({ message: `${reason}두 파일을 모두 보관했습니다: 원본, ${copy}`, durationMs: 4500 });
      return null;
    }
    showToast({ message: '클라우드 결과를 버렸습니다.', durationMs: 3000 });
    return null;
  }
  const requestId = `cloud-result-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const opened = new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const off = eventBus.on('open-document-bytes:done', (payload) => {
      const outcome = payload as { requestId?: string; ok: boolean; error?: string };
      if (outcome.requestId !== requestId) return;
      off();
      if (timeout) clearTimeout(timeout);
      if (outcome.ok) resolve();
      else reject(new Error(outcome.error || '클라우드 결과 열기가 취소되었습니다.'));
    });
    timeout = setTimeout(() => {
      off();
      reject(new Error('클라우드 결과 열기 시간이 초과되었습니다.'));
    }, 90_000);
  });
  eventBus.emit('open-document-bytes', {
    bytes: resolution.bytes ?? result.bytes,
    fileName: result.fileName,
    fileHandle: null,
    requestId,
    skipUnsavedGuard: true,
  });
  try {
    await opened;
    if (!activeDocumentId) throw new Error('Cloud 결과에 로컬 문서 ID를 할당하지 못했습니다.');
    showToast({ message: `${result.fileName}에 클라우드 결과를 반영했습니다.`, durationMs: 3500 });
    return { documentId: activeDocumentId, fileName: result.fileName };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast({ message: `클라우드 결과를 열지 못했습니다: ${message}`, durationMs: 4500 });
    throw error;
  }
}

async function applyCloudTakeover(takeover: CloudTakeoverPayload): Promise<{
  documentId: string;
  fileName: string;
} | null> {
  if (!takeover.document) {
    showToast({ message: '클라우드 작업을 중단하고 이 기기로 편집 권한을 가져왔습니다.', durationMs: 3500 });
    return null;
  }
  const requestId = `cloud-takeover-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const opened = new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const off = eventBus.on('open-document-bytes:done', (payload) => {
      const result = payload as { requestId?: string; ok: boolean; error?: string };
      if (result.requestId !== requestId) return;
      off();
      if (timeout) clearTimeout(timeout);
      if (result.ok) resolve();
      else reject(new Error(result.error || '클라우드 체크포인트 열기가 취소되었습니다.'));
    });
    timeout = setTimeout(() => {
      off();
      reject(new Error('클라우드 체크포인트 열기 시간이 초과되었습니다.'));
    }, 90_000);
  });
  eventBus.emit('open-document-bytes', {
    bytes: takeover.document.bytes,
    fileName: takeover.document.fileName,
    fileHandle: null,
    requestId,
    skipUnsavedGuard: true,
  });
  await opened;
  if (!activeDocumentId) throw new Error('클라우드 체크포인트에 로컬 문서 ID를 할당하지 못했습니다.');
  showToast({
    message: `${takeover.document.fileName}의 최신 클라우드 체크포인트를 열었습니다.`,
    durationMs: 4000,
  });
  return { documentId: activeDocumentId, fileName: takeover.document.fileName };
}

async function publishCloudCheckpoint(checkpoint: CloudCheckpointPayload): Promise<void> {
  let outcome = checkpoint.publication;
  if (!outcome) {
    if (!activeDocumentId || wasm.pageCount === 0
      || !checkpointMatchesActiveDocument(checkpoint, activeDocumentId)) {
      throw new Error('원본 문서를 연 기기에서 Cloud 버전을 반영해 주세요.');
    }
    const lastPublishedRevision = browserOriginPublishedRevision(checkpoint.sessionId);
    if (lastPublishedRevision !== null && checkpoint.revision <= lastPublishedRevision) return;
    const saved = await persistCheckpointToBrowserOrigin({
      handle: wasm.currentFileHandle,
      bytes: checkpoint.bytes,
      sha256: checkpoint.sha256,
      expectedSha256: browserOriginSyncDigest(checkpoint.sessionId) ?? checkpoint.expectedOriginSha256 ?? null,
      digest: bytesToSha256,
    });
    if (saved === 'permission-denied') {
      throw new Error('원본 파일의 쓰기 권한을 허용한 뒤 다시 반영해 주세요.');
    }
    outcome = saved;
    if (outcome === 'unchanged' || outcome === 'written') {
      setBrowserOriginSyncDigest(checkpoint.sessionId, checkpoint.sha256, checkpoint.revision);
    }
  }
  const message = outcome === 'conflict'
    ? '원본이 다른 곳에서 변경되었습니다. Cloud 버전은 별도 사본으로 보관했습니다.'
    : outcome === 'archive-only'
      ? 'Cloud 버전을 보관했습니다. 원본 파일을 열어 반영해 주세요.'
      : 'Cloud 버전을 원본에 반영했습니다.';
  showToast({ message, durationMs: 4000 });
}

/** 렌더러 초기화 후에 생성되는 에이전트 브리지 — 저장 가드가 대기 편집을 조회한다. */
let agentBridgeRef: AgentBridge | null = null;
let awaitPendingCloudTransferForClose: () => Promise<void> = () => Promise.resolve();
let versionControllerRef: DocumentVersionController | null = null;
let agentSidebarReady = false;

eventBus.on('settings:open', (payload) => {
  if (agentSidebarReady) return;
  const destination = (payload as { destination?: unknown } | undefined)?.destination;
  if (destination !== undefined && destination !== 'editing') return;
  showEditingSettingsFallback({
    eventBus,
    runtime: {
      preview: applyEditorSettingsPreview,
      committed: commitEditorSettingsRuntime,
    },
  });
});

const commandServices: CommandServices = {
  eventBus,
  wasm,
  documentState,
  getContext,
  getInputHandler: () => inputHandler,
  getViewportManager: () => canvasView?.getViewportManager() ?? null,
  pickOpenHandle: pickDesktopNativeOpenFile,
  pickSaveHandle: pickDesktopNativeSaveFile,
  validateSaveHandle: reserveSaveHandleForWrite,
  createPortableHistoryBundle: async () => {
    if (!versionControllerRef) throw new Error('버전 기록 서비스를 사용할 수 없습니다.');
    return versionControllerRef.createPortableHistoryBundle();
  },
  setEditMode,
  getPendingAgentEdits: () => {
    const pending = agentBridgeRef?.pendingEdits;
    if (!pending || !pending.hasPending()) return null;
    const sets = () => pending.getChangeSets().filter((set) => set.ops.length > 0);
    return {
      opCount: sets().reduce((sum, set) => sum + set.ops.length, 0),
      approveAll: () => sets().every((set) => pending.approve(set.id)),
      rejectAll: () => { for (const set of sets()) pending.reject(set.id); },
    };
  },
};

installDesktopCloseHandling(async () => {
  try {
    await awaitPendingCloudTransferForClose();
    if (cloudEditDraftIdentity) await persistCloudEditDraft();
  } catch {
    return false;
  }
  const allowClose = await canReplaceCurrentDocument();
  if (allowClose) documentState.permitNextUnload();
  return allowClose;
});

const dispatcher = new CommandDispatcher(registry, commandServices, eventBus);

// 모든 내장 커맨드 등록
registry.registerAll(fileCommands);
registry.registerAll(editCommands);
registry.registerAll(viewCommands);
registry.registerAll(formatCommands);
registry.registerAll(insertCommands);
registry.registerAll(tableCommands);
registry.registerAll(pageCommands);
registry.registerAll(toolCommands);

// 상태 바 요소
const sbMessage = () => document.getElementById('sb-message')!;
const sbPage = () => document.getElementById('sb-page')!;
const sbSection = () => document.getElementById('sb-section')!;
const sbZoomVal = () => document.getElementById('sb-zoom-val')!;
const sbPaper = () => document.getElementById('sb-paper')!;
const sbCount = () => document.getElementById('sb-count')!;
let statusSectionIndex = 0;
let paperStatusFrame = 0;
let characterStatusFrame = 0;
const statusCharacterCounter = new StatusCharacterCounter();
const statusNumber = new Intl.NumberFormat('ko-KR');

function updatePaperStatus(): void {
  paperStatusFrame = 0;
  const paper = sbPaper();
  try {
    if (wasm.getSectionCount() === 0) {
      paper.textContent = '—';
      paper.title = '용지 크기';
      return;
    }
    const size = describePaperSize(wasm.getPageDef(statusSectionIndex));
    paper.textContent = size.label;
    paper.title = size.title;
  } catch {
    paper.textContent = '—';
    paper.title = '용지 크기';
  }
}

function schedulePaperStatus(): void {
  if (!paperStatusFrame) paperStatusFrame = requestAnimationFrame(updatePaperStatus);
}

function updateCharacterStatus(): void {
  characterStatusFrame = 0;
  const indicator = sbCount();
  if (!inputHandler) {
    indicator.textContent = '0글자';
    indicator.title = '문서 글자 수';
    return;
  }
  try {
    if (wasm.getSectionCount() === 0) {
      indicator.textContent = '0글자';
      indicator.title = '문서 글자 수';
      return;
    }
    const { current, total, scope } = statusCharacterCounter.read(wasm, inputHandler);
    indicator.textContent = scope === 'document'
      ? `${statusNumber.format(total)}글자`
      : `${statusNumber.format(current)}/${statusNumber.format(total)}글자`;
    indicator.title = scope === 'selection'
      ? '선택한 글자 / 전체 글자'
      : scope === 'cell' ? '현재 셀 글자 / 전체 글자' : '문서 글자 수';
  } catch (error) {
    console.warn('[status] 글자 수를 읽지 못했습니다:', error);
    indicator.textContent = '—';
    indicator.title = '글자 수를 읽지 못했습니다';
  }
}

function scheduleCharacterStatus(invalidate = false): void {
  if (invalidate) statusCharacterCounter.invalidate();
  if (!characterStatusFrame) characterStatusFrame = requestAnimationFrame(updateCharacterStatus);
}
let autosaveStatusRestoreTimer: ReturnType<typeof setTimeout> | null = null;
let autosavePreviousMessage: string | null = null;

function autosaveScheduleFromUserSettings(): AutosaveScheduleSettings {
  const settings = userSettings.getAutosaveSettings();
  return {
    recoveryEnabled: settings.recoveryEnabled,
    recoveryIntervalMs: settings.recoveryIntervalMinutes * 60_000,
    idleEnabled: settings.idleSaveEnabled,
    idleDelayMs: settings.idleDelaySeconds * 1_000,
  };
}

function handleAutosaveStatus(status: AutosaveStatus): void {
  const message = document.getElementById('sb-message');
  if (!message) return;
  if (autosaveStatusRestoreTimer) {
    clearTimeout(autosaveStatusRestoreTimer);
    autosaveStatusRestoreTimer = null;
  }

  if (status.state === 'saving') {
    if (autosavePreviousMessage === null) {
      autosavePreviousMessage = message.textContent ?? '';
    }
    message.textContent = '복구용 자동 저장 중...';
    return;
  }

  const restoreTarget = autosavePreviousMessage;
  autosavePreviousMessage = null;
  const nextMessage = status.state === 'saved'
    ? `복구용 자동 저장 완료 (${formatBytes(status.byteLength)})`
    : '복구용 자동 저장 실패';
  message.textContent = nextMessage;
  if (restoreTarget !== null) {
    autosaveStatusRestoreTimer = setTimeout(() => {
      if (message.textContent === nextMessage) {
        message.textContent = restoreTarget;
      }
      autosaveStatusRestoreTimer = null;
    }, status.state === 'saved' ? 1_600 : 4_000);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    window.setTimeout(finish, 50);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

async function updateLoadProgress(percent: number, label: string): Promise<void> {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  sbMessage().textContent = `파일 로딩 ${safePercent}% - ${label}`;
  await waitForNextPaint();
}

/**
 * CanvasKit은 browser CSS font fallback을 사용하지 않는다. 초기 페이지를 먼저 표시한 뒤,
 * 저장된 권한 범위 안에서 필요한 local face를 준비하고 등록된 경우에만 다시 그린다.
 */
/** 설치 글꼴 중 합성 글리프 bbox 가 잘린 face 를 복구해 Canvas2D 에 등록하고, 등록되면 다시 그린다. */
function prepareLocalFontRepairs(fontNames: readonly string[] | undefined): void {
  if (!fontNames?.length) return;
  const requestedFonts = [...fontNames];
  void (async () => {
    await loadStoredLocalFonts();
    if (await repairLocalFontFacesFor(requestedFonts)) eventBus.emit('document-view-changed');
  })().catch((error) => {
    console.warn('[LocalFonts] 설치 글꼴 복구 등록 실패, 설치 글꼴로 계속 표시합니다:', error);
  });
}

function prepareCanvasKitLocalFonts(fontNames: readonly string[] | undefined): void {
  const renderer = canvasView?.getRenderBackend() === 'canvaskit'
    ? rendererSession?.getCanvasKitRenderer() ?? null
    : null;
  if (!renderer || !fontNames?.length) return;
  const requestedFonts = [...fontNames];
  void (async () => {
    await loadStoredLocalFonts();
    await renderer.prepareLocalFonts(requestedFonts);
    if (
      renderer === rendererSession?.getCanvasKitRenderer()
      && canvasView?.getRenderBackend() === 'canvaskit'
    ) {
      // 등록 성공 여부와 관계없이 pending 진단이 끝난 상태를 page snapshot에 반영한다.
      eventBus.emit('document-view-changed');
    }
  })().catch((error) => {
    console.warn('[CanvasKit] 로컬 Typeface 준비 실패, 기본 fallback으로 계속 표시합니다:', error);
  });
}

async function initialize(): Promise<void> {
  installWebAppShell();
  installDesktopWindowChrome();
  editorStyleOverflow = new EditorStyleOverflow(document.getElementById('style-bar')!);
  const msg = sbMessage();
  try {
    extensionViewerSettings = await loadExtensionViewerSettings();
    if (extensionViewerSettings.disableExternalWebFonts) {
      console.info('[main] 외부 웹폰트 사용 안 함 옵션이 켜져 있습니다.');
    }
    msg.textContent = extensionViewerSettings.disableExternalWebFonts
      ? '로컬 폰트 준비 중...'
      : '웹폰트 로딩 중...';
    await loadWebFonts([], undefined, extensionViewerSettings);  // CSS @font-face 등록 + CRITICAL 폰트만 로드
    msg.textContent = 'WASM 로딩 중...';
    await wasm.initialize();
    if (import.meta.env.DEV) {
      initRhwpDev(wasm);
    }
    const renderBackendRequest = resolveRenderBackendRequest(window.location.search);
    const canvaskitModeRequest = resolveCanvasKitRenderModeRequest(window.location.search);
    const canvaskitMode = canvaskitModeRequest.mode;
    const canvaskitSurfaceRequest = resolveCanvasKitSurfaceRequest(window.location.search);
    const renderProfile = resolveRenderProfile(window.location.search);
    const diagnosticsBackendRequest: EmbedRendererRuntimeRequestV1['backend'] =
      renderBackendRequest.backend === 'auto'
        ? { ...renderBackendRequest, backend: 'canvas2d' }
        : { ...renderBackendRequest, backend: renderBackendRequest.backend };
    rendererRuntimeRequest = {
      backend: diagnosticsBackendRequest,
      canvaskitMode: canvaskitModeRequest,
      canvaskitSurface: canvaskitSurfaceRequest,
      renderProfile,
    };
    if (renderBackendRequest.unsupportedReason) {
      console.warn(
        `[main] 지원하지 않는 renderer 값입니다: ${renderBackendRequest.requested}; Canvas2D를 사용합니다.`,
      );
    }
    if (canvaskitModeRequest.unsupportedReason) {
      console.warn(
        `[main] 지원하지 않는 CanvasKit mode입니다: ${canvaskitModeRequest.requested}; default를 사용합니다.`,
      );
    }
    renderBackendFallbackReason = renderBackendRequest.unsupportedReason ?? null;
    rendererSession = new RendererSession(
      renderBackendRequest,
      canvaskitModeRequest,
      canvaskitSurfaceRequest,
      renderProfile,
      async (mode, surface) => {
        msg.textContent = 'CanvasKit 로딩 중...';
        const { CanvasKitLayerRenderer } = await import('@/view/canvaskit-renderer');
        return CanvasKitLayerRenderer.create(mode, surface, {
          requirePreparedFontFamilies: renderBackendRequest.backend === 'auto',
        });
      },
      {
        transformCanvasKitPreflight(report) {
          const plan = resolveCanvasKitFontPlan(
            report.requiredFontFamilies,
            extensionViewerSettings,
          );
          const blockers = plan.unavailableFonts.map(font => `fontUnavailable:${font}`);
          if (wasm.getShowControlCodes()) blockers.push('viewOption:showControlCodes');
          return withCanvasKitSurfaceBlockers(
            report,
            blockers,
          );
        },
        async prepareCanvasKitDocument(renderer, report) {
          const plan = resolveCanvasKitFontPlan(
            report.requiredFontFamilies,
            extensionViewerSettings,
          );
          if (plan.unavailableFonts.length > 0) {
            throw new Error(`CanvasKit font family가 준비되지 않았습니다: ${plan.unavailableFonts.join(', ')}`);
          }
          await renderer.prepareBundledFonts(plan.sources);
        },
      },
    );
    msg.textContent = 'HWP 파일을 선택해주세요.';

    const container = document.getElementById('scroll-container')!;
    canvasView = new CanvasView(
      container,
      wasm,
      eventBus,
      rendererSession,
    );

    // [#3313] 외부 연결 그림(HWP3 pic_type=0)의 비동기 주입이 첫 렌더 이후에 끝나면
    // 화면이 이전 프레임(그림 없는 상태)에 머무른다. 주입 완료 시 뷰 문서를 다시
    // 로드해 페이지 트리를 재구성한다 — dirty 마킹 없는 뷰 전용 갱신.
    wasm.onExternalImagesInjected = () => {
      void canvasView?.loadDocument();
    };

    // 눈금자 초기화
    ruler = new Ruler(
      document.getElementById('h-ruler') as HTMLCanvasElement,
      document.getElementById('v-ruler') as HTMLCanvasElement,
      container,
      eventBus,
      wasm,
      canvasView.getVirtualScroll(),
      canvasView.getViewportManager(),
    );

    inputHandler = new InputHandler(
      container, wasm, eventBus,
      canvasView.getVirtualScroll(),
      canvasView.getViewportManager(),
    );
    inputHandler.setEditMode(editMode);
    inputHandler.setReadOnly(documentReadOnly);
    inputHandler.setUserEditingLocked(agentUserEditingLocked());

    toolbar = new Toolbar(document.getElementById('style-bar')!, wasm, eventBus, dispatcher);
    toolbar.setEnabled(false);

    // InputHandler에 커맨드 디스패처 및 컨텍스트 메뉴 주입
    inputHandler.setDispatcher(dispatcher);
    inputHandler.setContextMenu(new ContextMenu(dispatcher, registry));
    commandPalette = new CommandPalette(registry, dispatcher);
    inputHandler.setCommandPalette(commandPalette);
    const commandSearch = document.getElementById('editor-command-search');
    if (commandSearch) {
      const shortcutLabel = detectPlatformKind() === 'mac' ? '⌘/' : 'Ctrl+/';
      const shortcut = commandSearch.querySelector('kbd');
      if (shortcut) shortcut.textContent = shortcutLabel;
      commandSearch.title = `명령 검색 (${shortcutLabel})`;
      commandSearch.addEventListener('click', () => commandPalette?.open());
    }
    inputHandler.setCellSelectionRenderer(
      new CellSelectionRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setTableObjectRenderer(
      new TableObjectRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setTableResizeRenderer(
      new TableResizeRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setPictureObjectRenderer(
      new TableObjectRenderer(container, canvasView.getVirtualScroll(), true),
    );

    new MenuBar(document.getElementById('menu-bar')!, eventBus, dispatcher, registry, {
      onMenuOpen: (menuName) => {
        if (menuName === 'file') void renderRecentSubmenu();
      },
    });

    // 툴바 내 data-cmd 버튼 클릭 → 커맨드 디스패치
    // (.tb-btn + 서식바 접기 버튼 .sb-collapse-btn)
    document.querySelectorAll('.tb-btn[data-cmd], .sb-collapse-btn[data-cmd]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const cmd = (btn as HTMLElement).dataset.cmd;
        if (cmd) dispatcher.dispatch(cmd, { anchorEl: btn as HTMLElement });
      });
      (btn as HTMLElement).addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const cmd = (btn as HTMLElement).dataset.cmd;
        if (cmd && dispatcher.isEnabled(cmd)) dispatcher.dispatch(cmd, { anchorEl: btn as HTMLElement });
      });
    });

    // 스플릿 버튼 드롭다운 메뉴
    document.querySelectorAll('.tb-split').forEach(split => {
      const arrow = split.querySelector('.tb-split-arrow');
      if (arrow) {
        arrow.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // 다른 열린 메뉴 닫기
          document.querySelectorAll('.tb-split.open').forEach(s => {
            if (s !== split) s.classList.remove('open');
          });
          split.classList.toggle('open');
        });
      }
      split.querySelectorAll('.tb-split-item[data-cmd]').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          split.classList.remove('open');
          const cmd = (item as HTMLElement).dataset.cmd;
          if (cmd) dispatcher.dispatch(cmd, { anchorEl: item as HTMLElement });
        });
      });
    });
    // 외부 클릭 시 스플릿 메뉴 닫기
    document.addEventListener('mousedown', () => {
      document.querySelectorAll('.tb-split.open').forEach(s => s.classList.remove('open'));
    });

    // #780: 도구 모음/서식 도구 모음 영역 mousedown 시 focus 이동 방지
    // — 편집 영역의 텍스트 선택(cursor.anchor)이 보존되어야 서식 적용이 동작함
    for (const id of ['icon-toolbar', 'style-bar']) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).tagName !== 'INPUT' && (e.target as HTMLElement).tagName !== 'SELECT') {
          e.preventDefault();
        }
      });
    }

    setupFileInput();
    setupZoomControls();
    setupEventListeners();
    tableRibbonMenus = setupTableRibbonMenus(
      document.getElementById('icon-toolbar')!,
      (command, anchor) => {
        const fromOverflow = Boolean(anchor.closest('#editor-toolbar-overflow'));
        dispatcher.dispatch(command, { anchorEl: anchor });
        if (fromOverflow) editorToolbarOverflow?.closePopover();
      },
      (command) => dispatcher.isEnabled(command),
    );
    editorToolbarOverflow = new EditorToolbarOverflow(document.getElementById('icon-toolbar')!);
    editorStyleOverflow?.refresh();
    setupGlobalShortcuts();
    installDesktopFileHandling((handles) => {
      const handle = handles[0];
      if (!handle) return;
      void readFileFromHandle(handle)
        .then(({ bytes, name }) => openDocumentBytes({
          bytes,
          fileName: name,
          fileHandle: handle,
        }))
        .catch(async (error) => {
          await handle.releaseUnusedSaveTarget?.().catch(() => {});
          if (!(error instanceof DocumentOwnedElsewhereError)) showLoadError(error);
        });
    });
    installDesktopGeneratedDocumentHandling(({ bytes, fileName, readOnly, cloudEditDraft }) => {
      cloudEditDraftIdentity = cloudEditDraft ?? null;
      if (readOnly) setDocumentReadOnly(true);
      eventBus.emit('open-document-bytes', { bytes, fileName });
    });
    installDesktopEditCommandHandling((command) => {
      const target = document.activeElement;
      if (ownsTextInput(target) && !isEditorInput(target)) {
        document.execCommand(command === 'select-all' ? 'selectAll' : command);
        return;
      }
      if (!allowsDocumentShortcut(target) || !inputHandler?.isActive()) return;
      inputHandler.finalizeCompositionBeforeCursorMove();
      inputHandler.focus();
      dispatcher.dispatch(`edit:${command}`);
    });
    installDesktopPlainTextPasteHandling((text) => {
      inputHandler?.performPlainTextPaste(text);
    });
    if (isPinnedDocumentEnabled()) void loadPinnedDocument();
    else void loadFromUrlParam();
    void offerAutosaveRecoveryIfIdle();
    installPwaFileHandling(window as FileHandlingWindowLike, {
      openDocumentBytes(payload) {
        eventBus.emit('open-document-bytes', payload);
      },
      notifyUnsupportedFile(fileName) {
        showLoadError(new Error(`지원하지 않는 파일 형식입니다: ${fileName}. HWP/HWPX/HML/RHWPX 파일만 지원합니다.`));
      },
      notifyError(error) {
        showLoadError(error);
      },
      notifyMultipleFiles(count) {
        console.warn(`[pwa-file-handling] 여러 파일(${count}개)이 전달되어 첫 번째 파일만 엽니다.`);
      },
    });

    // E2E 테스트용 전역 노출 (개발 모드 전용)
    if (import.meta.env.DEV) {
      (window as any).__inputHandler = inputHandler;
      (window as any).__canvasView = canvasView;
      (window as any).__rendererSession = rendererSession;
      (window as any).__renderBackend = null;
      (window as any).__renderBackendRequest = renderBackendRequest;
      (window as any).__rendererRuntimeRequest = rendererRuntimeRequest;
      (window as any).__renderBackendFallbackReason = renderBackendFallbackReason;
      (window as any).__canvaskitRenderMode = canvaskitMode;
      (window as any).__canvaskitSurfaceRequest = canvaskitSurfaceRequest;
      (window as any).__renderProfile = renderProfile;
    }

    // AI 페어 에디팅: rhwp-agent 허브 브리지 + 사이드바 (Phase 1)
    // 선택(opt-in) 기능이므로 여기서 실패해도 렌더러 초기화를 실패로 만들지 않는다.
    try {
      const agentBridge = initAgentBridge({
        canPublishCloudDocument: () => cloudDocumentPublishingEnabled,
        wasm,
        eventBus,
        inputHandler,
        canvasView,
        documentState,
        isReadOnly: () => documentReadOnly,
      });
      agentBridgeRef = agentBridge;
      agentBridge.onEditingLeaseChange(setAgentEditingLease);
      const cloudRuntime = installCloudDocumentRuntimeApi(agentBridge);
      const versionController = new DocumentVersionController({
        wasm,
        eventBus,
        documentState,
        getInputHandler: () => inputHandler,
        getDocumentId: () => activeDocumentId,
        agentBridge,
        autoEnable: () => !cloudRuntime && userSettings.getUseHancomGit(),
      });
      versionControllerRef = versionController;
      // The outer client owns the conversation. A worker needs the bridge and editor,
      // but must not open another composer or start a default-provider chat.
      if (!cloudRuntime) {
        const agentSidebar = initAgentSidebar({
          bridge: agentBridge,
          eventBus,
          editorSettingsRuntime: {
            preview: applyEditorSettingsPreview,
            committed: commitEditorSettingsRuntime,
          },
          versionController,
          getAgentUndoEntry: () => inputHandler?.getAgentUndoEntry() ?? null,
          undoAgentTurn: (entry) => inputHandler?.undoAgentTurn(entry) ?? false,
          navigateToChange: (position, anchor) => {
            if (!inputHandler) return;
            if (anchor && position.cellIndex === undefined) {
              position = { ...position, cursorRect: { ...anchor } };
            }
            inputHandler.moveCursorTo(position);
          },
          openClassicVersionControl: () => openClassicDocumentHistory(commandServices),
          getDocumentContext: () => {
            const documentName = wasm.pageCount > 0 ? wasm.fileName : null;
            let selectionLabel: string | null = null;
            if (inputHandler?.getSelectedPictureRef()) {
              selectionLabel = '개체 선택됨';
            } else if (inputHandler?.hasSelection()) {
              selectionLabel = '텍스트 선택됨';
            }
            return {
              documentId: activeDocumentId,
              documentName,
              selectionLabel,
              isDirty: documentState.isDirty(),
              isNewDocument: wasm.isNewDocument,
              sourceFormat: wasm.getSourceFormat(),
            };
          },
          moveToLibraryDocument: async (target) => {
            await runLibraryMove(commandServices, target, () => activeDocumentId);
          },
          prepareCloudTransfer: prepareCloudTransferDocument,
          beginCloudAuthorityTransition,
          prepareCloudTakeover: () => confirmSaveBeforeReplacingDocument(commandServices),
          setCloudDocumentLease,
          applyCloudResult,
          publishCloudCheckpoint,
          isCloudCheckpointMerged: (checkpoint) => versionController.isCloudCheckpointMerged(checkpoint),
          mergeCloudCheckpoint: async (startId, checkpoint) => {
            const applied = await versionController.mergeCloudCheckpoint(startId, checkpoint);
            if (applied) await versionController.refresh();
            return applied;
          },
          applyCloudTakeover,
        });
        disposeAgentSidebar = () => {
          agentSidebar.dispose();
          disposeAgentSidebar = () => {};
        };
        awaitPendingCloudTransferForClose = agentSidebar.awaitPendingCloudTransferForClose;
        agentSidebarReady = true;
        initInlinePrompt({
          wasm,
          eventBus,
          inputHandler,
          canvasView,
          bridge: agentBridge,
          submit: agentSidebar.sendInlinePrompt,
        });
      }
      if (import.meta.env.DEV) {
        (window as any).__agentBridge = agentBridge;
        (window as any).__versionController = versionController;
      }
    } catch (agentError) {
      console.error('[main] 에이전트 사이드바 초기화 실패 (기능 비활성화):', agentError);
    }

    rendererInitialized = true;
  } catch (error) {
    rendererInitializationError = error instanceof Error ? error.message : String(error);
    msg.textContent = `WASM 초기화 실패: ${error}`;
    console.error('[main] WASM 초기화 실패:', error);
  }
}

/**
 * 전역 단축키 핸들러 — InputHandler.active 여부와 무관하게 동작해야 하는 단축키.
 * 예: 문서 미로드 상태에서도 Alt+N(새 문서), Ctrl+O(열기) 등.
 */
function setupGlobalShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey
      || e.key !== '/'
      || e.isComposing || e.defaultPrevented) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!allowsDocumentShortcut(target)) return;
    e.preventDefault();
    e.stopPropagation();
    commandPalette?.open();
  }, true);
  document.addEventListener('keydown', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (e.defaultPrevented || e.isComposing || !allowsDocumentShortcut(target)) return;
    // 문서 입력은 모드별 처리가 있으므로 같은 키를 두 번 실행하지 않는다.
    if (isEditorInput(target) && inputHandler?.isActive()) return;
    const commandId = matchShortcut(e, defaultShortcuts);
    if (!commandId) return;
    if (!inputHandler?.isActive() && !['file:new-doc', 'file:open'].includes(commandId)) return;
    e.preventDefault();
    if (inputHandler?.isActive()) inputHandler.focus();
    dispatcher.dispatch(commandId);
  }, false);
}

function setupFileInput(): void {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const openAction = document.getElementById('document-open-action') as HTMLButtonElement | null;
  const newAction = document.getElementById('document-new-action') as HTMLButtonElement | null;

  openAction?.addEventListener('click', () => dispatcher.dispatch('file:open'));
  newAction?.addEventListener('click', () => dispatcher.dispatch('file:new-doc'));

  fileInput.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const skipUnsavedGuard = input.dataset.skipUnsavedGuard === 'true';
    delete input.dataset.skipUnsavedGuard;
    const file = input.files?.[0];
    if (!file) return;
    if (!isSupportedDocumentFileName(file.name)) {
      alert('HWP/HWPX/HML/RHWPX 파일만 지원합니다.');
      fileInput.value = '';
      return;
    }
    let fileHandle: FileSystemFileHandleLike | null | undefined;
    try {
      fileHandle = await captureDesktopNativeDroppedFile(file);
    } catch (error) {
      fileInput.value = '';
      showLoadError(error);
      return;
    }
    await loadFile(file, { skipUnsavedGuard, fileHandle: fileHandle ?? undefined });
    fileInput.value = '';
  });

  // 문서 전체에서 브라우저 기본 드롭 동작 방지 (파일 열기/다운로드 방지)
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // 드래그 앤 드롭 지원 (scroll-container 영역)
  const container = document.getElementById('scroll-container')!;
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.classList.add('drag-over');
  });
  container.addEventListener('dragleave', () => {
    container.classList.remove('drag-over');
  });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (agentEditingLease.active) {
      showToast({ message: '에이전트가 편집을 마친 뒤 파일을 놓을 수 있습니다.', durationMs: 2600 });
      return;
    }
    const dropName = file.name.toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
    const isImage = imageExts.some(ext => dropName.endsWith(ext));
    const isDoc = isSupportedDocumentFileName(dropName);
    if (!isImage && !isDoc) {
      alert('HWP/HWPX/HML/RHWPX 파일 또는 이미지 파일만 지원합니다.');
      return;
    }

    // #3259: Chromium은 getAsFileSystemHandle을 drop event와 같은 tick에 호출해야 한다.
    // 아직 bytes를 읽거나 handle을 저장하지 않으며, 아래 사용자 확인이 승인된 뒤에만 사용한다.
    const browserDroppedFileHandle = isDoc
      ? captureDroppedFileHandle(e.dataTransfer?.items, file)
      : Promise.resolve<FileSystemFileHandleLike | null>(null);
    const desktopDroppedFileHandle = isDoc
      ? captureDesktopNativeDroppedFile(file)
      : Promise.resolve<FileSystemFileHandleLike | null | undefined>(undefined);
    const droppedFileHandle = desktopDroppedFileHandle.then(async (nativeHandle) => (
      nativeHandle === undefined ? browserDroppedFileHandle : nativeHandle
    ));

    // [#1439] 보안: 드롭으로 로컬 파일을 읽는 동작은 기본에서 제외하고, 사용자가
    // 명시적으로 [열기]를 눌러 동의한 경우에만 진행한다 (확장/웹 공통).
    const confirmed = await showDropConfirmDialog(file.name);
    if (!confirmed) {
      const unusedHandle = await droppedFileHandle.catch(() => null);
      await unusedHandle?.releaseUnusedSaveTarget?.().catch(() => {});
      return;
    }

    if (isImage) {
      if (!inputHandler || wasm.pageCount === 0) return;
      let objectUrl = '';
      try {
        const data = await readBlobBytesWithLimit(file, INSERTED_IMAGE_MAX_BYTES, '그림');
        const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
        assertEncodedImageDecodeDimensions(data, '그림');
        const img = new Image();
        objectUrl = URL.createObjectURL(file);
        img.src = objectUrl;
        await img.decode();
        assertImageDecodeDimensions(img.naturalWidth, img.naturalHeight, '그림');
        const result = inputHandler.insertDroppedImageAtClientPoint(
          data,
          ext,
          img.naturalWidth,
          img.naturalHeight,
          file.name,
          e.clientX,
          e.clientY,
        );
        if (!result.ok) {
          showToast({
            message: `그림 삽입에 실패했습니다.\n${result.error ?? '삽입 위치 또는 이미지 정보를 확인할 수 없습니다.'}`,
            durationMs: 6000,
          });
        }
      } catch (error) {
        const message = error instanceof Error && error.message
          ? error.message
          : '브라우저가 이 이미지 파일을 읽지 못했습니다.';
        console.warn('[drop] 이미지 준비 실패:', error);
        showToast({
          message: `그림을 삽입할 수 없습니다.\n${message}`,
          durationMs: 6000,
        });
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
      return;
    }

    // HWP/HWPX/HML/RHWPX — loadFile 내부 unsaved 가드는 드롭 확인 이후에 동작한다.
    let fileHandle: FileSystemFileHandleLike | null;
    try {
      fileHandle = await droppedFileHandle;
    } catch {
      return;
    }
    await loadFile(file, { fileHandle, untrustedSource: true });
  });
}

function setupZoomControls(): void {
  if (!canvasView) return;
  const vm = canvasView.getViewportManager();
  setupStatusZoomSlider(document.getElementById('sb-zoom-range') as HTMLInputElement, sbZoomVal(), vm, eventBus);

  document.getElementById('sb-zoom-in')!.addEventListener('click', () => {
    vm.smoothZoomBy(0.1);
  });
  document.getElementById('sb-zoom-out')!.addEventListener('click', () => {
    vm.smoothZoomBy(-0.1);
  });

  // 폭 맞춤: 용지 폭에 맞게 줌 조절
  document.getElementById('sb-zoom-fit-width')!.addEventListener('click', () => {
    if (wasm.pageCount === 0) return;
    const container = document.getElementById('scroll-container')!;
    const pageInfo = wasm.getPageInfo(0);
    // pageInfo.width는 이미 px 단위 (96dpi 기준)
    const zoom = calculateFitWidthZoom(container.clientWidth, pageInfo.width);
    vm.setZoom(zoom);
  });

  // 쪽 맞춤: 한 페이지 전체가 보이도록 줌 조절
  document.getElementById('sb-zoom-fit')!.addEventListener('click', () => {
    if (wasm.pageCount === 0) return;
    const container = document.getElementById('scroll-container')!;
    const pageInfo = wasm.getPageInfo(0);
    // pageInfo.width/height는 이미 px 단위 (96dpi 기준)
    const zoom = calculateFitPageZoom(
      container.clientWidth,
      container.clientHeight,
      pageInfo.width,
      pageInfo.height,
    );
    vm.setZoom(zoom);
  });

  // 모바일: 줌 값 클릭 → 100% 토글
  document.getElementById('sb-zoom-val')!.addEventListener('click', () => {
    const currentZoom = vm.getZoom();
    if (Math.abs(currentZoom - 1.0) < 0.05) {
      // 현재 100% → 쪽 맞춤으로 전환
      document.getElementById('sb-zoom-fit')!.click();
    } else {
      // 현재 쪽 맞춤/기타 → 100%로 전환
      vm.setZoom(1.0);
    }
  });
}

let totalSections = 1;

function setupEventListeners(): void {
  eventBus.on('font-files-imported', () => {
    try {
      wasm.refreshLayout();
      eventBus.emit('document-view-changed');
      prepareCanvasKitLocalFonts(wasm.getDocumentInfo().fontsUsed);
    } catch (error) {
      console.warn('[LocalFonts] 글꼴 가져오기 뒤 문서 갱신 실패:', error);
    }
  });
  eventBus.on('current-page-changed', (page, _total) => {
    const pageIdx = page as number;
    sbPage().textContent = `${pageIdx + 1} / ${_total} 쪽`;

    // 구역 정보: 현재 페이지의 sectionIndex로 갱신
    if (wasm.pageCount > 0) {
      try {
        const pageInfo = wasm.getPageInfo(pageIdx);
        statusSectionIndex = pageInfo.sectionIndex;
        sbSection().textContent = `구역: ${pageInfo.sectionIndex + 1} / ${totalSections}`;
        schedulePaperStatus();
      } catch { /* 무시 */ }
    }
  });

  eventBus.on('zoom-level-display', (zoom) => {
    sbZoomVal().textContent = `${Math.round((zoom as number) * 100)}%`;
  });

  eventBus.on('cursor-rect-updated', () => {
    if (inputHandler) {
      const section = inputHandler.getCursorPosition().sectionIndex;
      if (section !== statusSectionIndex) {
        statusSectionIndex = section;
        schedulePaperStatus();
      }
    }
    scheduleCharacterStatus();
  });

  eventBus.on('cell-selection-changed', () => scheduleCharacterStatus());

  // 삽입/수정 모드 토글
  eventBus.on('insert-mode-changed', (insertMode) => {
    document.getElementById('sb-mode')!.textContent = (insertMode as boolean) ? '삽입' : '수정';
  });

  eventBus.on('document-mutated', (reason) => {
    documentState.markDirty(typeof reason === 'string' ? reason : 'document-mutated');
    schedulePaperStatus();
    scheduleCharacterStatus(true);
  });

  eventBus.on('document-changed', (reason) => {
    documentState.markDirty(typeof reason === 'string' ? reason : 'document-changed');
    scheduleCloudEditDraftSave();
    schedulePaperStatus();
    scheduleCharacterStatus(true);
  });

  eventBus.on('renderer-selection-changed', (payload) => {
    const diagnostics = payload as RendererSessionDiagnostics;
    renderBackendFallbackReason = diagnostics.fallbackReason;
    if (import.meta.env.DEV) {
      (window as any).__renderBackend = diagnostics.effectiveBackend;
      (window as any).__renderBackendFallbackReason = diagnostics.fallbackReason;
      (window as any).__rendererSelection = diagnostics;
    }
  });

  eventBus.on('document-dirty-changed', () => {
    eventBus.emit('command-state-changed');
  });

  eventBus.on('document-file-handle-saved', (payload) => {
    const saved = payload as {
      fileHandle: FileSystemFileHandleLike;
      previousFileHandle: FileSystemFileHandleLike | null;
      fileName: string;
      sourceFormat: string;
    };
    const documentId = activeDocumentId;
    const sourceDigest = wasm.documentDigest;
    if (!documentId || !sourceDigest) {
      void releaseReplacedNativeFileHandle(saved.previousFileHandle, saved.fileHandle)
        .catch((error) => console.warn('[desktop] 이전 네이티브 파일 핸들 해제 실패:', error));
      return;
    }

    // Save/Save As changes storage metadata, not logical document identity. Explicitly
    // bind the new handle to the active ID so reopening it in a later session restores
    // the same document-scoped references. Download fallbacks emit no such event.
    void (async () => {
      await rememberNativeDocument(documentId, saved.fileHandle, sourceDigest);
      await releaseReplacedNativeFileHandle(saved.previousFileHandle, saved.fileHandle);
      await addRecentDoc({
        documentId,
        sourceDigest,
        fileName: saved.fileName,
        sourceFormat: saved.sourceFormat,
        handle: saved.fileHandle,
      });
    })().catch((err) => console.warn('[recent] 저장 핸들 identity 갱신 실패:', err));
  });

  eventBus.on('autosave-settings-changed', () => {
    autosaveManager.updateSchedule(autosaveScheduleFromUserSettings());
  });

  // 필드 정보 표시
  const sbField = document.getElementById('sb-field');
  eventBus.on('field-info-changed', (info) => {
    if (!sbField) return;
    const fi = info as { fieldId: number; fieldType: string; guideName?: string } | null;
    if (fi) {
      const label = fi.guideName || `#${fi.fieldId}`;
      sbField.textContent = `[누름틀] ${label}`;
      sbField.style.display = '';
    } else {
      sbField.textContent = '';
      sbField.style.display = 'none';
    }
  });

  const modeGroups = Array.from(
    document.querySelectorAll<HTMLElement>('#icon-toolbar > .tb-mode-group[data-toolbar-mode]'),
  );
  const defaultTbGroups = Array.from(
    document.querySelectorAll<HTMLElement>('#icon-toolbar > .tb-group:not(.tb-mode-group), #icon-toolbar > .tb-sep'),
  );
  let objectSelected = false;
  let tableObjectSelected = false;
  let headerFooterActive = false;
  let noteToolbarActive = false;

  const applyContextualToolbarMode = (): ContextualEditingToolbarMode => {
    const context = getContext();
    const mode = contextualEditingToolbarMode({
      objectSelected,
      inTable: tableObjectSelected
        || context.inTableObjectSelection
        || context.inCellSelectionMode
        || context.inTable,
      headerFooterActive,
      noteActive: noteToolbarActive,
    });
    if (mode !== 'table') tableRibbonMenus?.closeAll();
    defaultTbGroups.forEach((element) => {
      element.style.display = mode === 'default' ? '' : 'none';
    });
    document.querySelectorAll<HTMLButtonElement>(
      '#icon-toolbar .tb-group:not(.tb-mode-group) .tb-btn[data-cmd]',
    ).forEach((button) => {
      button.disabled = !dispatcher.isEnabled(button.dataset.cmd ?? '');
    });
    modeGroups.forEach((group) => {
      group.style.display = group.dataset.toolbarMode === mode ? '' : 'none';
      if (group.dataset.toolbarMode === mode) {
        const selectedObject = inputHandler?.getSelectedPictureRef() ?? null;
        const selectedObjects = inputHandler?.getSelectedPictureRefs() ?? [];
        const selectedObjectScope = selectedObject ? objectAddressScope(selectedObject) : null;
        const objectSelection = {
          kind: selectedObject?.type ?? null,
          count: selectedObjects.length,
          topLevel: selectedObjects.length > 0 && selectedObjects.every(isTopLevelBodyObject),
          arrangeable: context.canArrangeSelectedObject,
          groupable: context.canGroupSelectedObjects,
          ungroupable: context.canUngroupSelectedObject,
          deletable: Boolean(
            selectedObject
            && (
              selectedObjectScope === 'body'
              || (selectedObjectScope === 'cell' && selectedObject.type === 'image')
            ),
          ),
          propertyEditable: Boolean(
            selectedObject
            && selectedObjectScope !== 'memo'
            && (selectedObjectScope !== 'note' || selectedObject.type === 'equation'),
          ),
        };
        group.querySelectorAll<HTMLButtonElement>('.tb-btn[data-cmd]').forEach((button) => {
          const command = button.dataset.cmd ?? '';
          button.disabled = !dispatcher.isEnabled(command)
            || (mode === 'object' && !contextualObjectCommandEnabled(command, objectSelection));
        });
      }
    });
    tableRibbonMenus?.refresh();
    document.getElementById('icon-toolbar')?.setAttribute('data-context-mode', mode);
    return mode;
  };

  eventBus.on('picture-object-selection-changed', (selected) => {
    objectSelected = selected as boolean;
    if (objectSelected) {
      tableObjectSelected = false;
      setBasicToolboxExpanded(true);
    }
    applyContextualToolbarMode();
  });
  eventBus.on('table-object-selection-changed', (selected) => {
    tableObjectSelected = selected as boolean;
    if (tableObjectSelected) {
      objectSelected = false;
      setBasicToolboxExpanded(true);
    }
    applyContextualToolbarMode();
  });
  eventBus.on('cursor-format-changed', applyContextualToolbarMode);
  eventBus.on('cell-selection-changed', applyContextualToolbarMode);
  eventBus.on('command-state-changed', applyContextualToolbarMode);

  // 머리말/꼬리말 편집 모드 시 도구상자 전환 + 본문 dimming
  const hfLabel = document.querySelector<HTMLElement>('.tb-headerfooter-group .tb-hf-label');
  const hfLiveStatus = document.getElementById('hf-edit-status-live');
  const scrollContainer = document.getElementById('scroll-container');

  eventBus.on('headerFooterModeChanged', (payload) => {
    const state = parseHeaderFooterModeChanged(payload);
    const isActive = state !== 'none';
    headerFooterActive = isActive;
    // 접힌 기본 도구 상자는 머리말/꼬리말 전용 버튼을 가리므로 모드 진입 시 펼친다.
    if (isActive) setBasicToolboxExpanded(true);
    // 도구상자 전환
    if (hfLabel) {
      const kind = state === 'none' ? '' : state.mode === 'header' ? '머리말' : '꼬리말';
      const target = state === 'none' ? '' : headerFooterApplyToLabel(state.applyTo);
      hfLabel.textContent = state === 'none' ? '' : `${kind} · ${target} 편집 중`;
      hfLabel.dataset.mode = state === 'none' ? '' : state.mode;
      hfLabel.dataset.applyTo = state === 'none' ? '' : String(state.applyTo);
      if (hfLiveStatus) {
        hfLiveStatus.textContent = state === 'none'
          ? '머리말 꼬리말 편집 종료'
          : `${kind} ${target} 편집 중, 구역 ${state.sectionIdx + 1} 첫 페이지`;
      }
    }
    applyContextualToolbarMode();
    // 서식 도구 모음은 머리말/꼬리말 편집 시에도 유지 (문단/글자 모양 설정 필요)
    // 본문 dimming
    if (scrollContainer) {
      if (isActive) {
        scrollContainer.classList.add('hf-editing');
      } else {
        scrollContainer.classList.remove('hf-editing');
      }
    }
  });

  eventBus.on('footnoteModeChanged', (active) => {
    const isActive = active as boolean;
    noteToolbarActive = isActive;
    if (isActive) setBasicToolboxExpanded(true);
    applyContextualToolbarMode();
  });

  applyContextualToolbarMode();
}

function applyEditorSettingsPreview(settings: EditorScalarSettings): void {
  applyTheme(settings.theme.mode);
  syncThemeMenu(settings.theme.mode);
  wasm.setShowControlCodes(settings.view.showControlCodes);
  wasm.setShowParagraphMarks(settings.view.showParagraphMarks);
  syncTextMarkMenu(settings.view.showControlCodes, settings.view.showParagraphMarks);
  const clipEnabled = !settings.view.clipView;
  wasm.setClipEnabled(clipEnabled);
  syncClipMenu(clipEnabled);
  eventBus.emit('document-view-changed');
}

function commitEditorSettingsRuntime(settings: EditorScalarSettings): void {
  applyEditorSettingsPreview(settings);
  eventBus.emit('autosave-settings-changed');
  eventBus.emit('font-settings-changed');
  eventBus.emit('command-state-changed');
}

/** 문서 초기화 공통 시퀀스 (loadFile, createNewDocument 양쪽에서 사용) */
function applySavedTextMarkSettings(): void {
  applyEditorSettingsPreview(userSettings.getEditorScalarSettings());
}

async function initializeDocument(
  docInfo: DocumentInfo,
  options: { suppressDialogs?: boolean } = {},
): Promise<void> {
  const msg = sbMessage();
  try {
    await updateLoadProgress(55, '폰트 준비 중...');
    setActiveDocumentFonts(docInfo.fontsUsed ?? []);
    if (docInfo.fontsUsed?.length) {
      await loadWebFonts(docInfo.fontsUsed, (loaded, total) => {
        const fontPercent = total > 0 ? 55 + Math.round((loaded / total) * 20) : 65;
        msg.textContent = `파일 로딩 ${fontPercent}% - 폰트 로딩 중... (${loaded}/${total})`;
      }, extensionViewerSettings);
    }
    await updateLoadProgress(75, '문서 상태 적용 중...');
    totalSections = docInfo.sectionCount ?? 1;
    statusSectionIndex = 0;
    sbSection().textContent = `구역: 1 / ${totalSections}`;
    schedulePaperStatus();
    applySavedTextMarkSettings();
    await updateLoadProgress(82, '페이지 렌더 준비 중...');
    await canvasView?.loadDocument();
    prepareCanvasKitLocalFonts(docInfo.fontsUsed);
    prepareLocalFontRepairs(docInfo.fontsUsed);
    await updateLoadProgress(90, '도구 모음 준비 중...');
    toolbar?.setEnabled(!documentReadOnly && !agentUserEditingLocked());
    toolbar?.initFontDropdown(docInfo.fontsUsed);
    toolbar?.initStyleDropdown();
    await updateLoadProgress(94, '문서 검증 및 글꼴 확인 중...');
    const emptyState = document.getElementById('document-empty-state');
    if (emptyState) {
      emptyState.hidden = true;
      emptyState.setAttribute('aria-hidden', 'true');
    }

    // #177: HWPX 비표준 lineseg 감지 (진단 로그).
    // #2527: 자동 보정(reflowLinesegs)이 빈-lineseg 문서에서 글리프 좌표를 붕괴시켜
    // 글자가 대량으로 겹치므로, 모달을 띄우지 않고 항상 '그대로 보기'로 연다.
    // reflow 근본 수정 후 모달/자동 보정 재도입을 검토한다.
    try {
      if (wasm.getSourceFormat() === 'hwpx') {
        const report = wasm.getValidationWarnings();
        if (report.count > 0) {
          console.log(`[validation] ${report.count} warnings — 그대로 보기 (#2527)`, report.summary);
        }
      } else if (wasm.getSourceFormat() === 'hml') {
        const metadata = wasm.getHmlOpenMetadata();
        if (metadata) showHmlImportWarning(metadata);
      }
    } catch (e) {
      console.warn('[validation] 감지 실패 (치명적이지 않음):', e);
    }

    if (!options.suppressDialogs) {
      await promptLocalFontsIfNeeded(docInfo);
    }

    // 로컬 글꼴 감지 결과가 뷰를 갱신한 뒤에 캐럿을 연결해야 입력 포커스가 재설정과 경합하지 않는다.
    await updateLoadProgress(96, '편집 상태 초기화 중...');
    inputHandler?.activateWithCaretPosition();
    eventBus.emit('document-context-changed');
    scheduleCharacterStatus(true);
    // 최종 단계 뒤에는 비동기 작업이 없으므로 100% progress paint를 기다리지 않는다.
    msg.textContent = documentReadOnly ? '읽기 전용' : '';

    // #2527: 자동 보정을 하지 않으므로 로드 직후 문서는 항상 clean.
    documentState.markClean('document-initialized');
    try {
      await versionControllerRef?.documentLoaded();
    } catch (error) {
      console.warn('[Hancom Git] Could not initialize document history', error);
      showToast({ message: '문서는 열렸지만 버전 기록을 준비하지 못했습니다.', durationMs: 4500 });
    }
  } catch (error) {
    console.error('[initDoc] 오류:', error);
    if (window.innerWidth < 768) alert(`초기화 오류: ${error}`);
  }
}

async function promptLocalFontsIfNeeded(docInfo: DocumentInfo): Promise<void> {
  if (!docInfo.fontsUsed?.length) return;

  const msg = sbMessage();
  try {
    await loadStoredLocalFonts();
    const report = analyzeDocumentFonts(docInfo.fontsUsed);
    if (!report.shouldPromptLocalAccess) return;

    const choice = await showLocalFontsModalIfNeeded(report, {
      disableExternalWebFonts: extensionViewerSettings.disableExternalWebFonts,
    });
    if (typeof choice === 'object' && choice.type === 'import') {
      try {
        const result = await importLocalFontFiles(choice.files);
        if (result.imported.length > 0) {
          const fonts = getLocalFonts({ includeRegistered: true });
          eventBus.emit('local-fonts-changed', { fonts, report: analyzeDocumentFonts(docInfo.fontsUsed) });
          eventBus.emit('font-files-imported');
        }
        showToast({ message: localFontImportMessage(result), durationMs: result.rejected.length ? 8000 : 5000 });
      } catch (error) {
        showToast({
          message: error instanceof Error ? error.message : '글꼴 파일을 불러오지 못했습니다.',
          durationMs: 6000,
        });
      }
      return;
    }
    if (choice !== 'detect') return;

    msg.textContent = '로컬 글꼴 감지 중...';
    const fonts = await detectLocalFonts({
      force: true,
      includeRegistered: true,
      candidateFamilies: docInfo.fontsUsed,
    });
    const nextReport = analyzeDocumentFonts(docInfo.fontsUsed);
    eventBus.emit('local-fonts-changed', { fonts, report: nextReport });
    prepareCanvasKitLocalFonts(docInfo.fontsUsed);
    prepareLocalFontRepairs(docInfo.fontsUsed);
    const state = getLocalFontState();
    const resultLabel = state.source === 'font-presence-probe' ? '확인됨' : '감지됨';
    msg.textContent = `로컬 글꼴 ${fonts.length}개 ${resultLabel}`;
    showToast({
      message: `로컬 글꼴 ${fonts.length}개를 ${resultLabel.replace('됨', '')}하고 저장했습니다.\n다음 문서 로드부터 감지 결과를 재사용합니다.`,
      durationMs: 5000,
    });
  } catch (error) {
    console.warn('[local-fonts] 감지 안내/실행 실패 (치명적이지 않음):', error);
    msg.textContent = '';
    showToast({
      message: '로컬 글꼴 감지에 실패했습니다.\n웹 대체 글꼴로 계속 표시합니다.',
      durationMs: 8000,
    });
  }
}

async function loadFile(
  file: File,
  options: {
    skipUnsavedGuard?: boolean;
    fileHandle?: FileSystemFileHandleLike | null;
    suppressDialogs?: boolean;
    /** Drag payloads retain a save handle but never receive the exact-picker parser grant. */
    untrustedSource?: boolean;
  } = {},
): Promise<boolean> {
  try {
    if (!await canReplaceCurrentDocument(options.skipUnsavedGuard)) return false;
    await updateLoadProgress(0, '파일 읽는 중...');
    const selected = options.fileHandle && !options.untrustedSource
      ? await readFileFromHandle(options.fileHandle)
      : {
        bytes: await readBlobBytesWithLimit(file, UNTRUSTED_DOCUMENT_MAX_BYTES, '문서'),
        name: file.name,
      };
    await updateLoadProgress(15, '파일 읽기 완료');
    return openDocumentBytes({
      bytes: selected.bytes,
      fileName: selected.name,
      fileHandle: options.fileHandle ?? null,
      skipUnsavedGuard: true,
      suppressDialogs: options.suppressDialogs,
    });
  } catch (error) {
    await options.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    if (!(error instanceof DocumentOwnedElsewhereError)) showLoadError(error);
    return false;
  }
}

function prepareCanvasRendererDocument(): void {
  canvasView?.prepareDocumentLoad();
}

async function reserveDocumentOpen(
  data: Uint8Array,
  fileHandle: typeof wasm.currentFileHandle,
  skipRecent = false,
  grant?: VerifiedDocumentGrant | null,
): Promise<{ identity: DocumentPreflightIdentity; reservationId: string | null | undefined }> {
  const mainIssuedDocumentId = getNativeFileHandleVerifiedDocumentId(fileHandle);
  const verifiedGrant = grant ?? (mainIssuedDocumentId
    ? { kind: 'verified' as const, documentId: mainIssuedDocumentId }
    : null);
  const resolved = await resolveDocumentPreflight(
    data,
    fileHandle,
    await listRecentDocs(),
    undefined,
    verifiedGrant,
  );
  const identity = skipRecent
    ? { ...resolved, documentId: createActiveDocumentId(), useSourceDigest: false }
    : resolved;
  const reservationId = await reserveDesktopDocument(identity, fileHandle);
  if (reservationId === null) throw new DocumentOwnedElsewhereError();
  return { identity, reservationId };
}

async function reserveSaveHandleForWrite(
  handle: FileSystemFileHandleLike,
): Promise<((saved: boolean) => Promise<void>) | void> {
  const currentHandle = wasm.currentFileHandle;
  const currentIdentity = activeDocumentId
    ? { documentId: activeDocumentId, sourceDigest: wasm.documentDigest, useSourceDigest: false }
    : null;
  if (handle === currentHandle) {
    if (currentIdentity) bindNativeFileHandleIdentity(handle, currentIdentity);
    return;
  }
  if (currentHandle && typeof handle.isSameEntry === 'function') {
    try {
      if (await handle.isSameEntry(currentHandle)) {
        if (currentIdentity) bindNativeFileHandleIdentity(handle, currentIdentity);
        return;
      }
    } catch {
      // Continue with recent/digest identity when the browser cannot compare handles.
    }
  }

  if (handle.identityKind === 'native-path') {
    if (!currentIdentity) throw new Error('Active document identity is unavailable');
    bindNativeFileHandleIdentity(handle, currentIdentity);
    const reservationId = await reserveDesktopDocument(currentIdentity, handle);
    if (reservationId === null) throw new DocumentOwnedElsewhereError();
    if (!reservationId) return;
    return async (saved) => {
      if (saved) await commitDesktopDocument(reservationId);
      else await cancelDesktopDocument(reservationId);
    };
  }

  const target = await handle.getFile();
  const targetBytes = await readBlobBytesWithLimit(
    target,
    EXACT_LOCAL_DOCUMENT_MAX_BYTES,
    '저장 대상 문서',
  );
  const identity = await resolveDocumentPreflight(targetBytes, handle, await listRecentDocs());
  if (identity.documentId === activeDocumentId) return;

  const reservationId = await reserveDesktopDocument(identity, handle);
  if (reservationId === null) throw new DocumentOwnedElsewhereError();
  if (!reservationId) return;
  return () => cancelDesktopDocument(reservationId);
}

async function loadBytes(
  data: Uint8Array,
  fileName: string,
  fileHandle: typeof wasm.currentFileHandle,
  startTime = performance.now(),
  options: {
    dataReadProgressShown?: boolean;
    skipRecent?: boolean;
    suppressDialogs?: boolean;
    grant?: VerifiedDocumentGrant | null;
    preparedDocument?: PreparedWasmDocument;
  } = {},
): Promise<void> {
  const ownership = await reserveDocumentOpen(
    data,
    fileHandle,
    options.skipRecent,
    options.grant,
  );
  const previousFileHandle = wasm.currentFileHandle;
  if (!options.dataReadProgressShown) {
    await updateLoadProgress(0, '문서 데이터 준비 중...');
  }
  await updateLoadProgress(25, '문서 파싱 및 쪽 계산 중...');
  let docInfo: DocumentInfo;
  try {
    inputHandler?.deactivate();
    docInfo = options.preparedDocument
      ? wasm.adoptPreparedDocument(options.preparedDocument)
      : consumeExactLocalFileRead(data, fileHandle)
        ? wasm.loadTrustedLocalFileOnce(data, fileName)
        : wasm.loadDocument(data, fileName);
    await commitDesktopDocument(ownership.reservationId);
    fileHandle?.adoptSaveTarget?.();
  } catch (error) {
    await cancelDesktopDocument(ownership.reservationId).catch(() => {});
    activeDocumentId = null;
    eventBus.emit('document-context-changed');
    await releaseDesktopDocument().catch(() => {});
    await releaseReplacedNativeFileHandle(previousFileHandle, null).catch(() => {});
    await autosaveManager.endDocument({ discardDraft: true, reason: 'failed-document-replacement' })
      .catch(() => {});
    throw error;
  }
  activeDocumentId = ownership.identity.documentId;
  bindNativeFileHandleIdentity(fileHandle, ownership.identity);
  await rememberNativeDocument(
    ownership.identity.documentId,
    fileHandle,
    ownership.identity.sourceDigest,
  )
    .catch((error) => console.warn('[desktop] native document bookmark failed:', error));
  await releaseReplacedNativeFileHandle(previousFileHandle, fileHandle)
    .catch((error) => console.warn('[desktop] 교체된 네이티브 파일 핸들 해제 실패:', error));
  prepareCanvasRendererDocument();
  eventBus.emit('document-swapped');
  await updateLoadProgress(45, '자동 저장 준비 중...');
  forgetConvertedHmlSaveHandle(fileHandle);
  wasm.currentFileHandle = fileHandle;

  // 최근 문서 기록 — 문서 로드 성공 직후, 폰트/모달 등 블로킹 UI 단계 이전에 기록한다.
  // 핸들이 있으면 라이브 재열기용으로 함께 기록하고, 없으면(드롭/input/URL 로드)
  // 메타-only 로 기록한다 — 목록에는 남기되 자동 재열기는 핸들 있는 항목만 가능하다.
  // 자동저장 복구본은 options.skipRecent 로 제외.
  if (!options.skipRecent) {
    const sourceDigest = wasm.documentDigest;
    if (!sourceDigest) {
      console.warn('[recent] 원본 digest가 없어 세션 전용 문서 ID를 사용합니다.');
    } else {
      try {
        await addRecentDoc({
          documentId: ownership.identity.documentId,
          sourceDigest,
          fileName: wasm.fileName,
          sourceFormat: wasm.getSourceFormat(),
          handle: fileHandle,
        });
      } catch (err) {
        console.warn('[recent] 최근 문서 기록 실패, 세션 identity를 유지합니다:', err);
      }
    }
  }

  await autosaveManager.beginDocument(
    { fileName: wasm.fileName, sourceFormat: wasm.getSourceFormat() },
    { discardPreviousDraft: true },
  );
  await updateLoadProgress(50, '문서 초기화 중...');
  const elapsed = performance.now() - startTime;
  console.debug(`[load] ${fileName}: ${docInfo.pageCount} pages in ${elapsed.toFixed(1)}ms`);
  await initializeDocument(docInfo, {
    suppressDialogs: options.suppressDialogs,
  });
}

/** 파일 메뉴 "최근 문서" 서브패널을 최신 목록으로 다시 렌더한다(메뉴 open 시 호출). */
async function renderRecentSubmenu(): Promise<void> {
  const panel = document.getElementById('recent-docs-panel');
  if (!panel) return;

  let recents;
  try {
    recents = await listRecentDocs();
  } catch (err) {
    console.warn('[recent] 최근 문서 조회 실패:', err);
    return;
  }

  const makeItem = (opts: {
    label: string;
    cmd?: string;
    id?: string;
    right?: string;
    disabled?: boolean;
    title?: string;
  }): HTMLElement => {
    const item = document.createElement('div');
    item.className = opts.disabled ? 'md-item disabled' : 'md-item';
    if (opts.cmd) item.dataset.cmd = opts.cmd;
    if (opts.id) item.dataset.id = opts.id;
    if (opts.title) item.title = opts.title;
    const icon = document.createElement('span');
    icon.className = 'md-icon';
    const label = document.createElement('span');
    label.className = 'md-label';
    label.textContent = opts.label;
    item.append(icon, label);
    if (opts.right) {
      const right = document.createElement('span');
      right.className = 'md-shortcut';
      right.textContent = opts.right;
      item.append(right);
    }
    return item;
  };

  const frag = document.createDocumentFragment();
  if (recents.length === 0) {
    frag.append(makeItem({ label: '(최근 문서 없음)', disabled: true }));
  } else {
    for (const doc of recents) {
      frag.append(
        makeItem({
          label: doc.fileName,
          cmd: 'file:open-recent',
          id: doc.id,
          right: doc.sourceFormat.toUpperCase(),
          title: doc.fileName,
        }),
      );
    }
    const sep = document.createElement('div');
    sep.className = 'md-sep';
    frag.append(sep);
    frag.append(makeItem({ label: '최근 문서 목록 지우기', cmd: 'file:clear-recent' }));
  }

  panel.replaceChildren(frag);
  // 목록이 비면 서브메뉴 자체를 비활성(hover 열림 차단). updateMenuStates가
  // 렌더 이전(스테일) 내용으로 판정하므로 여기서 직접 갱신한다.
  panel.closest('.md-sub')?.classList.toggle('disabled', recents.length === 0);
}

function shouldSkipInitialAutosaveRecovery(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('url') || isPinnedDocumentEnabled();
}

async function loadPinnedDocument(): Promise<void> {
  try {
    await startPinnedDocument({
      eventBus,
      // 글꼴 구성은 서버 쪽 번들 글꼴을 그대로 쓰므로 기기별 로컬 글꼴 안내를 띄우지 않는다.
      loadBytes: (data, fileName) => loadBytes(data, fileName, null, performance.now(), {
        skipRecent: true,
        suppressDialogs: true,
      }),
      exportBytes: () => wasm.exportHwp(),
      markSaved: () => {
        documentState.markClean('pinned-save');
        void autosaveManager.discardCurrentDraft('pinned-save');
      },
    });
  } catch (error) {
    showLoadError(error);
  }
}

async function offerAutosaveRecoveryIfIdle(): Promise<void> {
  if (shouldSkipInitialAutosaveRecovery()) return;

  try {
    await rendererSessionContextPromise;
    const drafts = (await listRecoverableAutosaveDrafts())
      .filter((draft) => draft.data.byteLength > 0);
    if (drafts.length === 0) return;
    if (wasm.pageCount > 0 || documentState.isDirty()) return;

    const choice = await showAutosaveRecoveryDialog(drafts);
    if (choice.action === 'later') return;
    if (choice.action === 'delete-all') {
      await clearRecoverableAutosaveDrafts();
      showToast({ message: '복구 후보를 삭제했습니다.', durationMs: 2200 });
      return;
    }

    const draft = drafts.find((item) => item.id === choice.draftId);
    if (!draft) return;
    try {
      await restoreAutosaveDraft(draft);
    } catch (error) {
      showLoadError(error);
    }
  } catch (error) {
    console.warn('[autosave] 복구 후보 확인 실패:', error);
  }
}

async function restoreAutosaveDraft(draft: AutosaveDraft): Promise<void> {
  const fileName = recoveryFileName(draft.fileName);
  await loadBytes(new Uint8Array(draft.data), fileName, null, performance.now(), { skipRecent: true });
  await deleteAutosaveDraft(draft.id);
  documentState.markDirty('autosave-recovered');
  showToast({
    message: `"${fileName}" 복구본을 열었습니다.\n원본 파일은 자동으로 덮어쓰지 않습니다.`,
    durationMs: 5000,
  });
}


async function createNewDocument(): Promise<void> {
  const msg = sbMessage();
  const previousFileHandle = wasm.currentFileHandle;
  const identity = { documentId: createActiveDocumentId(), sourceDigest: null };
  const reservationId = await reserveDesktopDocument(identity, null);
  if (reservationId === null) throw new DocumentOwnedElsewhereError();
  try {
    msg.textContent = '새 문서 생성 중...';
    inputHandler?.deactivate();
    const docInfo = wasm.createNewDocument();
    await commitDesktopDocument(reservationId);
    activeDocumentId = identity.documentId;
    await releaseReplacedNativeFileHandle(previousFileHandle, wasm.currentFileHandle)
      .catch((error) => console.warn('[desktop] 새 문서 전환 핸들 해제 실패:', error));
    prepareCanvasRendererDocument();
    await autosaveManager.beginDocument(
      { fileName: wasm.fileName, sourceFormat: wasm.getSourceFormat() },
      { discardPreviousDraft: true },
    );
    await initializeDocument(docInfo);
  } catch (error) {
    await cancelDesktopDocument(reservationId).catch(() => {});
    activeDocumentId = null;
    eventBus.emit('document-context-changed');
    await releaseDesktopDocument().catch(() => {});
    await releaseReplacedNativeFileHandle(previousFileHandle, null).catch(() => {});
    await autosaveManager.endDocument({ discardDraft: true, reason: 'failed-new-document' })
      .catch(() => {});
    msg.textContent = `새 문서 생성 실패: ${error}`;
    console.error('[main] 새 문서 생성 실패:', error);
  }
}

async function canReplaceCurrentDocument(skipUnsavedGuard?: boolean): Promise<boolean> {
  if (cloudAuthorityTransitionCount > 0 && skipUnsavedGuard !== true) {
    showToast({ message: 'Cloud 전송과 문서 권한 전환이 끝난 뒤 문서를 바꿀 수 있습니다.', durationMs: 2600 });
    return false;
  }
  if (agentEditingLease.active) {
    showToast({ message: '에이전트가 편집을 마친 뒤 문서를 바꿀 수 있습니다.', durationMs: 2600 });
    return false;
  }
  const allowed = skipUnsavedGuard === true
    || await confirmSaveBeforeReplacingDocument(commandServices);
  if (!allowed) return false;
  await versionControllerRef?.whenIdle();
  return true;
}

async function openDocumentBytes(data: OpenDocumentBytesEvent) {
  if (!await canReplaceCurrentDocument(data.skipUnsavedGuard)) {
    await data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    return false;
  }
  try {
    if (isPortableHistoryFileName(data.fileName) || isPortableHistoryBytes(data.bytes)) {
      const bundle = openPortableHistoryBundle(data.bytes);
      const store = new VersionGraphStore();
      const retainPortableHistoryHandle = Boolean(
        data.fileHandle
        && !isLegacyPortableHistoryFolderHandle(data.fileHandle)
        && isPortableHistoryFileName(data.fileName),
      );
      const openFileName = retainPortableHistoryHandle
        ? data.fileName
        : bundle.documentFileName;
      let importedRepository = false;
      let preparedDocument: PreparedWasmDocument | null = null;
      try {
        const imported = await store.importRepositorySnapshot(bundle.snapshot);
        importedRepository = imported.imported;
        preparedDocument = wasm.prepareDocument(
          bundle.currentDocumentBytes,
          openFileName,
        );
        userSettings.setUseHancomGit(true);
        await loadBytes(
          bundle.currentDocumentBytes,
          openFileName,
          retainPortableHistoryHandle ? data.fileHandle : null,
          performance.now(),
          {
            grant: {
              kind: 'verified',
              documentId: bundle.snapshot.repository.documentId,
            },
            preparedDocument,
          },
        );
        persistActiveBranch(bundle.snapshot.repository.documentId, bundle.activeBranch);
        await versionControllerRef?.refresh().catch((error) => {
          console.warn('[versioning] 가져온 기록 새로고침 실패:', error);
        });
      } catch (error) {
        if (importedRepository) {
          await store.removeImportedRepository(
            bundle.snapshot.repository.id,
            versionDocumentId(bundle.snapshot.repository.documentId),
            bundle.snapshot.repository.revision,
          ).catch(() => undefined);
        }
        throw error;
      } finally {
        preparedDocument?.dispose();
        await store.close();
      }
      if (!retainPortableHistoryHandle) {
        await data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
      }
      showToast({ message: '문서와 전체 버전 기록을 불러왔습니다.', durationMs: 3500 });
      return true;
    }
    await loadBytes(data.bytes, data.fileName, data.fileHandle, performance.now(), {
      grant: data.grant,
      suppressDialogs: data.suppressDialogs,
    });
    return true;
  } catch (error) {
    await data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    throw error;
  }
}

// 커맨드에서 새 문서 생성 호출
eventBus.on('create-new-document', (payload) => {
  void (async () => {
    const options = payload as { skipUnsavedGuard?: boolean } | undefined;
    if (!await canReplaceCurrentDocument(options?.skipUnsavedGuard)) return;
    await createNewDocument();
  })();
});
eventBus.on('open-document-bytes', async (payload) => {
  const data = payload as OpenDocumentBytesEvent;
  const notifyDone = (ok: boolean, error?: string) => {
    if (!data.requestId) return;
    eventBus.emit('open-document-bytes:done', { requestId: data.requestId, ok, error });
  };
  try {
    if (!await openDocumentBytes(data)) {
      notifyDone(false, '문서 열기가 취소되었습니다.');
      return;
    }
    notifyDone(true);
  } catch (error) {
    // #265: WASM 파서 에러 (예: HWP 3.0 미지원) 를 사용자에게 전파
    if (!(error instanceof DocumentOwnedElsewhereError)) showLoadError(error);
    const msg = error instanceof Error ? error.message : String(error);
    notifyDone(false, msg);
  }
});

// 수식 더블클릭 → 수식 편집 대화상자
eventBus.on('equation-edit-request', () => {
  dispatcher.dispatch('insert:equation-edit');
});

/**
 * URL 파라미터(?url=)로 전달된 HWP 파일을 자동 로드한다.
 * Chrome 확장 프로그램에서 뷰어 탭을 열 때 사용.
 */
async function loadFromUrlParam(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const fileUrl = params.get('url');
  if (!fileUrl) return;

  const fileName = params.get('filename') || fileUrl.split('/').pop()?.split('?')[0] || FALLBACK_DOCUMENT_FILE_NAME;
  const msg = sbMessage();

  try {
    msg.textContent = '파일 로딩 중...';
    console.log(`[loadFromUrlParam] ${fileUrl}`);

    // file:// 은 확장 권한을 먼저 확인한다. 공개 URL 정책은 HTTP(S) 직접 fetch와
    // SW 프록시 우회 방지에만 적용한다.
    let validatedRemoteUrl: URL | null = null;
    if (fileUrl.startsWith('file:')) {
      if (typeof chrome === 'undefined') {
        throw new RemoteDocumentUrlError('scheme-blocked', 'file: URL은 확장 프로그램에서만 열 수 있습니다.');
      }
      const allowed = await isFileSchemeAccessAllowed();
      if (allowed === false) {
        showFileUrlAccessGuidance();
        return;
      }
    } else {
      // Keep the parsed URL as the authority for both policy and fetch. URL()
      // canonicalizes leading ASCII whitespace/control characters that a raw
      // /^https?:/ check can miss.
      validatedRemoteUrl = validateRemoteDocumentUrl(fileUrl);
    }

    const browserRuntime = (
      globalThis as typeof globalThis & {
        browser?: { runtime?: { sendMessage?: unknown } };
      }
    ).browser?.runtime;
    const hasExtensionRuntime = (
      typeof chrome !== 'undefined'
      && typeof (chrome as { runtime?: { sendMessage?: unknown } }).runtime?.sendMessage === 'function'
    ) || typeof browserRuntime?.sendMessage === 'function';
    if (hasExtensionRuntime && validatedRemoteUrl) {
      // Extension-origin fetch and its service worker both carry host
      // permissions. Hostname validation cannot stop DNS rebinding, so remote
      // URLs stay fail-closed until a native/server fetcher can resolve and pin
      // every redirect hop while preserving Host/SNI.
      throw new ExtensionRemoteProxyUnavailableError();
    }

    // file: remains an explicitly granted local read; ordinary web Studio
    // fetches retain the browser's CORS/private-network enforcement.
    const response = await fetch(validatedRemoteUrl?.href ?? fileUrl);

    if (!response.ok) {
      await cancelResponseBody(response, `HTTP ${response.status}`);
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const contentType = response.headers.get('content-type');
    const data = await readResponseBytesWithLimit(
      response,
      UNTRUSTED_DOCUMENT_MAX_BYTES,
      '원격 문서',
    );
    assertRemoteDocumentBytes(data, contentType);
    await loadBytes(data, fileName, null);
  } catch (error) {
    if (error instanceof DocumentOwnedElsewhereError) return;
    if (
      error instanceof RemoteDocumentUrlError
      && error.reason === 'scheme-blocked'
      && fileUrl.startsWith('file:')
    ) {
      // file:// 은 별도 안내 흐름(#1131)을 유지한다 — 공개 URL 정책과 무관.
      if (typeof chrome !== 'undefined') {
        const allowed = await isFileSchemeAccessAllowed();
        if (allowed === false) {
          showFileUrlAccessGuidance();
          return;
        }
      }
    }
    showLoadError(error);
  }
}

/**
 * 확장 프로그램의 "파일 URL에 대한 액세스 허용" 권한 상태를 조회한다 (#1131).
 *
 * 확장 페이지에서만 의미가 있다. API 부재(비-확장 환경 등) 시 판정 불가로
 * `null` 을 반환하여 호출부가 기존 동작(일반 에러)으로 폴백하도록 한다.
 *
 * @returns 허용=true, 미허용=false, 판정 불가=null
 */
async function isFileSchemeAccessAllowed(): Promise<boolean | null> {
  const ext = (typeof chrome !== 'undefined' ? chrome.extension : undefined) as
    | { isAllowedFileSchemeAccess?: () => Promise<boolean> }
    | undefined;
  if (!ext?.isAllowedFileSchemeAccess) return null;
  try {
    return await ext.isAllowedFileSchemeAccess();
  } catch {
    return null;
  }
}

/**
 * 로컬 file:// 문서를 열 때 "파일 URL 액세스 허용" 권한이 꺼져 있어 로드가
 * 실패한 경우, 일반 "Failed to fetch" 대신 원인과 해결 방법을 안내한다 (#1131).
 *
 * 설정 화면(chrome://extensions/?id=...)은 일반 링크로는 열리지 않으므로
 * 확장 컨텍스트의 chrome.tabs.create 로 연다.
 */
function showFileUrlAccessGuidance(): void {
  const errMsg = '로컬 파일을 열려면 확장 프로그램의 "파일 URL에 대한 액세스 허용"을 켜야 합니다.\n설정에서 권한을 허용한 뒤 파일을 다시 열어 주세요.';
  const sb = sbMessage();
  if (sb) sb.textContent = '파일 로드 실패: 파일 URL 액세스 권한이 필요합니다.';
  console.error('[main] file:// 로드 실패 — 파일 URL 액세스 미허용 (#1131)');
  showToast({
    message: errMsg,
    durationMs: 0, // 사용자가 읽고 직접 닫기
    confirmLabel: '확인',
    action: {
      label: '설정 열기',
      onClick: () => {
        if (typeof chrome !== 'undefined' && chrome.tabs?.create && chrome.runtime?.id) {
          chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
        }
      },
    },
  });
}

/**
 * 파일 로드 실패 시 사용자에게 에러를 명확히 알린다 (#265).
 *
 * 상태 표시줄은 22px 한 줄로 긴 에러 메시지가 ellipsis 로 잘리므로,
 * 우상단 토스트 (긴 메시지 줄바꿈 지원 · 사용자 닫기 · action 링크) 를
 * 병행 사용한다.
 */
function showLoadError(error: unknown): void {
  const raw = String(error).replace(/^Error:\s*/, '');
  const errMsg = `파일 로드 실패: ${raw}`;
  const sb = sbMessage();
  if (sb) sb.textContent = errMsg;
  console.error('[main] 파일 로드 실패:', error);
  showToast({
    message: errMsg,
    durationMs: 0, // 에러는 자동 페이드 없음 — 사용자가 읽고 닫기
    confirmLabel: '확인',
  });
}

const initPromise = initialize();

installEmbedRuntime({
  hostWindow: window,
  parentWindow: window.parent,
  handlers: {
    async ready() {
      await initPromise;
      return true;
    },
    async loadFile(data, fileName, skipUnsavedGuard, suppressDialogs) {
      await initPromise;
      if (!await canReplaceCurrentDocument(skipUnsavedGuard)) {
        throw new Error('문서 열기가 취소되었습니다.');
      }
      await loadBytes(data, fileName, null, undefined, { suppressDialogs });
      return { pageCount: wasm.pageCount };
    },
    async pageCount() {
      await initPromise;
      return wasm.pageCount;
    },
    async getRendererDiagnostics(pageIndex) {
      await initPromise;
      const selection = canvasView?.getRendererSessionDiagnostics() ?? null;
      return {
        schemaVersion: 1 as const,
        request: rendererRuntimeRequest,
        initialized: rendererInitialized,
        initializationError: rendererInitializationError,
        effectiveBackend: selection?.effectiveBackend ?? null,
        backendFallbackReason: selection?.fallbackReason ?? renderBackendFallbackReason,
        selection,
        page: {
          index: pageIndex,
          canvaskit: canvasView?.getCanvasKitRenderDiagnostics(pageIndex) ?? null,
        },
      };
    },
    async getPageSvg(page) {
      await initPromise;
      return wasm.renderPageSvg(page);
    },
    async exportHwp() {
      await initPromise;
      return wasm.exportHwp();
    },
    async exportHwpx() {
      await initPromise;
      return wasm.exportHwpx();
    },
    async exportHml() {
      await initPromise;
      return wasm.exportHml();
    },
    async getHmlSaveState() {
      await initPromise;
      return wasm.getHmlSaveState();
    },
    async exportHwpVerify() {
      await initPromise;
      return JSON.parse(wasm.exportHwpVerify());
    },
    async notifySaved(fileName) {
      await initPromise;
      return completeHostSave(fileName);
    },
  },
});
