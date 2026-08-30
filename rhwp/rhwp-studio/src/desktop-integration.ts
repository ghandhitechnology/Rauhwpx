/**
 * 로컬 에이전트 허브 기동.
 *
 * Electron 은 preload IPC 로 메인 프로세스가 허브를 띄운다.
 * Vite 개발 서버는 `/__rhwp/ensure-agent-hub` 가 같은 일을 한다.
 * 패키지된 PWA/브라우저는 Node 를 띄울 수 없어 no-op 이다.
 */

import type {
  FileSystemFileHandleLike,
  FileSystemWritableFileStreamLike,
  SaveFilePickerOptionsLike,
} from './command/file-system-access.ts';
import { FALLBACK_DOCUMENT_FILE_NAME } from './core/document-names.ts';
import type {
  CloudCommandRequest,
  CloudDisplayEvent,
  CloudProfileDraft,
  CloudResultAction,
  CloudServerMode,
  CloudSessionScope,
  CloudTransferIntentRequest,
  CloudTransferRequest,
  CloudTransferReference,
} from './cloud/types.ts';

export const DEV_AGENT_HUB_ENSURE_PATH = '/__rhwp/ensure-agent-hub';

export interface RendererSessionContext {
  launchId: string;
  sessionId: string;
  hubUrl: string;
  hubToken: string;
}

export interface NativeFileHandleDescriptor {
  kind: 'file';
  handleId: string;
  name: string;
  saveTargetCreated?: boolean;
  verifiedDocumentId?: string;
}

export interface DocumentOwnershipIdentity {
  documentId: string;
  sourceDigest: string | null;
  useSourceDigest?: boolean;
}

interface NativeFileReadResult {
  name: string;
  bytes: Uint8Array;
}

export interface RhwpDesktopApi {
  ensureAgentHub?: () => Promise<{ started?: boolean; ready?: boolean } | boolean>;
  getSessionContext?: () => Promise<RendererSessionContext>;
  getLaunchFiles?: () => Promise<NativeFileHandleDescriptor[]>;
  getLaunchGeneratedDocument?: () => Promise<{
    launchDocumentId: string;
    fileName: string;
    bytes: Uint8Array;
    readOnly?: boolean;
  } | null>;
  openGeneratedDocumentWindow?: (payload: {
    fileName: string;
    downloadUrl: string;
    readOnly?: boolean;
  }) => Promise<boolean>;
  pickNativeOpenFile?: (options?: {
    suggestedName?: string;
    documentId?: string;
  }) => Promise<NativeFileHandleDescriptor | { owned: true } | null>;
  claimNativeDroppedFile?: (
    file: File,
  ) => Promise<NativeFileHandleDescriptor | { owned: true } | null> | null;
  pickNativeSaveFile?: (options: {
    suggestedName: string;
    extension: 'hwp' | 'hwpx' | 'hml';
  }) => Promise<NativeFileHandleDescriptor | { owned: true } | null>;
  savePortableHistoryFile?: (payload: {
    suggestedName: string;
    files: ReadonlyArray<{ name: string; bytes: Uint8Array }>;
  }) => Promise<{ fileName: string; byteLength: number } | null>;
  releaseNativeFile?: (handleId: string) => Promise<void>;
  readNativeFile?: (handleId: string) => Promise<NativeFileReadResult>;
  getNativeFileSourcePath?: (handleId: string) => Promise<string | null>;
  validateNativeSave?: (
    handleId: string,
    identity: DocumentOwnershipIdentity,
  ) => Promise<void>;
  writeNativeFile?: (
    handleId: string,
    bytes: Uint8Array,
    identity: DocumentOwnershipIdentity,
  ) => Promise<{ name: string; byteLength: number }>;
  writePortableHistoryFile?: (
    handleId: string,
    files: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
    identity: DocumentOwnershipIdentity,
  ) => Promise<{ name: string; byteLength: number }>;
  isSameNativeFile?: (firstHandleId: string, secondHandleId: string) => Promise<boolean>;
  rememberNativeDocument?: (
    documentId: string,
    handleId: string,
    digest?: string | null,
  ) => Promise<void>;
  reopenNativeDocument?: (
    documentId: string,
  ) => Promise<NativeFileHandleDescriptor | { owned: true } | null>;
  searchNearbyNativeDocument?: (
    documentId: string,
    options?: { basenameHint?: string },
  ) => Promise<ReadonlyArray<{ probeId: string; fileName: string }>>;
  readNativeProbe?: (probeId: string) => Promise<NativeFileReadResult>;
  claimNativeProbe?: (
    probeId: string,
  ) => Promise<NativeFileHandleDescriptor | { owned: true } | null>;
  verifyNativePick?: (documentId: string, handleId: string) => Promise<boolean>;
  reserveDocument?: (
    identity: DocumentOwnershipIdentity,
    nativeHandleId?: string,
  ) => Promise<{ ok: true; reservationId: string } | { ok: false; reason: 'owned' }>;
  commitDocument?: (reservationId: string) => Promise<void>;
  cancelDocument?: (reservationId: string) => Promise<void>;
  releaseDocument?: () => Promise<void>;
  respondToCloseRequest?: (requestId: string, allowClose: boolean) => Promise<boolean>;
  onCloseRequested?: (callback: (request: {
    requestId: string;
    reason: 'close' | 'quit';
  }) => void) => void;
  platform?: string;
  isFullScreen?: () => Promise<boolean>;
  onFullScreenChange?: (callback: (fullscreen: boolean) => void) => void;
  onOpenFiles?: (callback: (files: NativeFileHandleDescriptor[]) => void) => void;
  onOpenGeneratedDocument?: (callback: (payload: {
    launchDocumentId: string;
    fileName: string;
    bytes: Uint8Array;
    readOnly?: boolean;
  }) => void) => void;
  /** Cloud methods are optional so the browser build and older desktop preloads stay usable. */
  cloudGetState?: (payload: CloudSessionScope) => Promise<unknown>;
  cloudSaveProfile?: (payload: { profile: CloudProfileDraft }) => Promise<unknown>;
  cloudTestProfile?: (payload: { profile?: CloudProfileDraft }) => Promise<unknown>;
  cloudProvision?: (payload: {
    installChannel: 'stable' | 'prerelease';
    profile?: CloudProfileDraft;
  }) => Promise<unknown>;
  cloudPair?: (payload: { code: string; profile?: CloudProfileDraft }) => Promise<unknown>;
  cloudSelectServerMode?: (payload: { mode: CloudServerMode }) => Promise<unknown>;
  cloudSpawnSandbox?: (payload: { providerId?: string; provider?: string; apiKey?: string }) => Promise<unknown>;
  cloudSandboxStatus?: () => Promise<unknown>;
  cloudTeardownSandbox?: (payload: { force?: boolean }) => Promise<unknown>;
  cloudTransfer?: (payload: CloudTransferRequest) => Promise<unknown>;
  cloudSetTransferIntent?: (payload: CloudTransferIntentRequest) => Promise<unknown>;
  cloudReadReference?: (payload: Pick<CloudTransferReference, 'id' | 'scope' | 'scopeId'>) => Promise<unknown>;
  cloudCommand?: (payload: CloudCommandRequest) => Promise<unknown>;
  cloudDismissSession?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudCompleteTakeover?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudDownloadResult?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudDownloadCheckpoint?: (payload: { sessionId: string; operationId?: string }) => Promise<unknown>;
  cloudOpenDisplay?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudCloseDisplay?: (payload: { connectionId: string }) => Promise<unknown>;
  cloudResolveResult?: (payload: { sessionId: string; action: CloudResultAction }) => Promise<unknown>;
  onCloudEvent?: (callback: (event: unknown) => void) => (() => void) | void;
  onCloudDisplayEvent?: (callback: (event: {
    connectionId: string;
    event: CloudDisplayEvent;
  }) => void) => (() => void) | void;
  onPastePlainText?: (callback: (text: string) => void) => void;
}

export interface DesktopHost {
  rhwpDesktop?: RhwpDesktopApi;
  navigator?: {
    serviceWorker?: {
      getRegistrations: () => Promise<ReadonlyArray<{ unregister: () => Promise<boolean> }>>;
      addEventListener: (type: string, listener: () => void) => void;
    };
  };
}

export interface PublishedDocumentLink {
  readonly downloadUrl: string;
  readonly fileName: string;
  readonly readOnly?: boolean;
}

/** Only hub-issued localhost artifact URLs become in-app document actions. */
export function parsePublishedDocumentLink(raw: string): PublishedDocumentLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return null;
  const match = url.pathname.match(/^\/artifacts\/[A-Za-z0-9_-]{16,128}\/([^/]+)$/u);
  if (!match) return null;
  let fileName;
  try {
    fileName = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!/\.(?:hwp|hwpx)$/iu.test(fileName) || fileName.includes('\0')) return null;
  return {
    downloadUrl: url.href,
    fileName,
    ...(url.searchParams.get('templatePreview') === '1' ? { readOnly: true } : {}),
  };
}

export async function openPublishedDocumentInNewWindow(
  artifact: PublishedDocumentLink,
  win?: DesktopHost,
  options: { readOnly?: boolean } = {},
): Promise<void> {
  const host = desktopHost(win);
  const openNative = host?.rhwpDesktop?.openGeneratedDocumentWindow;
  if (openNative) {
    if (!await openNative({
      fileName: artifact.fileName,
      downloadUrl: artifact.downloadUrl,
      ...(options.readOnly ? { readOnly: true } : {}),
    })) {
      throw new Error('새 문서 창을 열지 못했습니다.');
    }
    return;
  }

  const browserWindow = (win ?? globalThis) as DesktopHost & {
    location?: { href: string };
    open?: (url?: string | URL, target?: string, features?: string) => unknown;
  };
  if (!browserWindow.location?.href || !browserWindow.open) {
    throw new Error('새 문서 창을 열 수 없습니다.');
  }
  const editorUrl = new URL(browserWindow.location.href);
  editorUrl.search = '';
  editorUrl.hash = '';
  editorUrl.searchParams.set('url', artifact.downloadUrl);
  editorUrl.searchParams.set('filename', artifact.fileName);
  if (options.readOnly) editorUrl.searchParams.set('templatePreview', '1');
  browserWindow.open(editorUrl.href, '_blank', 'noopener');
}

let inflight: Promise<boolean> | null = null;
let sessionContextInflight: Promise<RendererSessionContext | null> | null = null;
let devHubContext: Pick<RendererSessionContext, 'launchId' | 'hubUrl' | 'hubToken'> | null = null;
const nativeHandleMetadata = new WeakMap<FileSystemFileHandleLike, {
  api: RhwpDesktopApi;
  handleId: string;
  identity: DocumentOwnershipIdentity | null;
  readonly verifiedDocumentId: string | null;
}>();
const browserLaunchId = createSessionId('launch');
const browserSessionId = createSessionId('session');

function createSessionId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function validSessionContext(value: unknown): value is RendererSessionContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  return ['launchId', 'sessionId', 'hubUrl', 'hubToken']
    .every((key) => typeof context[key] === 'string' && context[key].length > 0);
}

function desktopHost(win?: DesktopHost): DesktopHost | undefined {
  return win ?? (typeof globalThis !== 'undefined' ? (globalThis as DesktopHost) : undefined);
}

function isDevBuild(): boolean {
  return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
}

export function isDesktopApp(win?: DesktopHost): boolean {
  const api = desktopHost(win)?.rhwpDesktop;
  if (typeof api?.ensureAgentHub === 'function' || typeof api?.getSessionContext === 'function') return true;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Electron/i.test(ua);
}

export async function requestDevAgentHub(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  if (typeof fetchImpl !== 'function') return false;
  try {
    const path = `${DEV_AGENT_HUB_ENSURE_PATH}?sessionId=${encodeURIComponent(browserSessionId)}`;
    const response = await fetchImpl(path, { method: 'POST' });
    if (!response.ok) return false;
    const body = await response.json();
    if (
      body?.ready === true
      && typeof body.launchId === 'string'
      && typeof body.hubUrl === 'string'
      && typeof body.hubToken === 'string'
    ) {
      devHubContext = {
        launchId: body.launchId,
        hubUrl: body.hubUrl,
        hubToken: body.hubToken,
      };
    }
    return body?.ready === true;
  } catch (error) {
    console.warn('[rhwp-desktop] 개발 서버 허브 기동 실패:', error);
    return false;
  }
}

function readEnsureResult(result: { ready?: boolean } | boolean | undefined): boolean {
  if (result && typeof result === 'object') return result.ready !== false;
  return Boolean(result);
}

export function websocketHubUrl(hubUrl: string) {
  const url = new URL(hubUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Unsupported agent hub protocol: ${url.protocol}`);
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function httpHubUrl(hubUrl: string) {
  const url = new URL(hubUrl);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  return url.toString().replace(/\/$/, '');
}

export interface BrowserSessionContextOptions {
  hubUrl?: string;
  hubToken?: string;
  launchId?: string;
  sessionId?: string;
}

/**
 * Electron configuration is authoritative and must come from preload. Browser and
 * Vite runs keep their explicit environment/dev fallback.
 */
export async function resolveRendererSessionContext(
  win?: DesktopHost,
  browser: BrowserSessionContextOptions = {},
): Promise<RendererSessionContext | null> {
  const host = desktopHost(win);
  if (isDesktopApp(host)) {
    const getSessionContext = host?.rhwpDesktop?.getSessionContext;
    if (typeof getSessionContext !== 'function') {
      console.warn('[rhwp-desktop] preload 세션 구성이 없습니다.');
      return null;
    }
    try {
      const context = await getSessionContext();
      if (!validSessionContext(context)) {
        console.warn('[rhwp-desktop] preload 세션 구성이 올바르지 않습니다.');
        return null;
      }
      return context;
    } catch (error) {
      console.warn('[rhwp-desktop] preload 세션 구성 조회 실패:', error);
      return null;
    }
  }

  const env = (import.meta as ImportMeta & { env?: ImportMetaEnv }).env;
  if (isDevBuild() && !browser.hubUrl) await requestDevAgentHub();
  return {
    launchId: browser.launchId ?? devHubContext?.launchId ?? browserLaunchId,
    sessionId: browser.sessionId ?? browserSessionId,
    hubUrl: browser.hubUrl ?? devHubContext?.hubUrl ?? env?.VITE_RHWP_AGENT_URL ?? 'ws://127.0.0.1:5175',
    hubToken: browser.hubToken ?? devHubContext?.hubToken ?? env?.VITE_RHWP_AGENT_TOKEN ?? 'dev',
  };
}

/** 같은 renderer 안의 autosave와 AgentBridge가 동일한 window session을 공유한다. */
export function getRendererSessionContext(): Promise<RendererSessionContext | null> {
  if (!sessionContextInflight) {
    sessionContextInflight = resolveRendererSessionContext();
  }
  return sessionContextInflight;
}

export function installDesktopCloseHandling(
  onCloseRequest: (reason: 'close' | 'quit') => Promise<boolean>,
  win?: DesktopHost,
) {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.onCloseRequested || !api.respondToCloseRequest) return false;
  api.onCloseRequested((request) => {
    void onCloseRequest(request.reason).then(
      (allowClose) => api.respondToCloseRequest!(request.requestId, allowClose),
      () => api.respondToCloseRequest!(request.requestId, false),
    );
  });
  return true;
}

export async function ensureDesktopAgentHub(win?: DesktopHost): Promise<boolean> {
  if (inflight) return inflight;
  const ensure = desktopHost(win)?.rhwpDesktop?.ensureAgentHub;
  const run = (async () => {
    try {
      if (typeof ensure === 'function') return readEnsureResult(await ensure());
      if (isDevBuild()) return requestDevAgentHub();
      return false;
    } catch (error) {
      console.warn('[rhwp-desktop] 허브 기동 요청 실패:', error);
      return false;
    }
  })();
  inflight = run;
  void run.finally(() => {
    if (inflight === run) inflight = null;
  });
  return run;
}

function validNativeDescriptor(value: unknown): value is NativeFileHandleDescriptor {
  if (!value || typeof value !== 'object') return false;
  const descriptor = value as Record<string, unknown>;
  return descriptor.kind === 'file'
    && typeof descriptor.handleId === 'string'
    && descriptor.handleId.length > 0
    && typeof descriptor.name === 'string'
    && descriptor.name.length > 0
    && (
      descriptor.verifiedDocumentId === undefined
      || (
        typeof descriptor.verifiedDocumentId === 'string'
        && descriptor.verifiedDocumentId.length > 0
        && descriptor.verifiedDocumentId === descriptor.verifiedDocumentId.trim()
        && !descriptor.verifiedDocumentId.includes('\0')
      )
    );
}

export function createNativeFileHandle(
  descriptor: NativeFileHandleDescriptor,
  api: RhwpDesktopApi,
  { saveTarget = false } = {},
): FileSystemFileHandleLike {
  if (!validNativeDescriptor(descriptor) || !api.readNativeFile || !api.writeNativeFile) {
    throw new Error('Invalid native file handle descriptor');
  }

  let unusedSaveTarget = saveTarget;
  const handle: FileSystemFileHandleLike = {
    kind: 'file',
    name: descriptor.name,
    identityKind: 'native-path',
    async getFile() {
      const result = await api.readNativeFile!(descriptor.handleId);
      return new File([result.bytes as BlobPart], result.name);
    },
    async releaseUnusedSaveTarget() {
      if (!unusedSaveTarget || !api.releaseNativeFile) return;
      unusedSaveTarget = false;
      await api.releaseNativeFile(descriptor.handleId);
    },
    adoptSaveTarget() {
      unusedSaveTarget = false;
    },
    async validateSaveTarget() {
      const metadata = nativeHandleMetadata.get(handle);
      if (!metadata?.identity) throw new Error('Native save target has no active document ownership');
      if (!api.validateNativeSave) throw new Error('Native save ownership validation is unavailable');
      await api.validateNativeSave(descriptor.handleId, metadata.identity);
    },
    async createWritable(): Promise<FileSystemWritableFileStreamLike> {
      const chunks: Blob[] = [];
      let closed = false;
      return {
        async write(data) {
          if (closed) throw new Error('Native file stream is closed');
          chunks.push(data);
        },
        async close() {
          if (closed) return;
          const metadata = nativeHandleMetadata.get(handle);
          if (!metadata?.identity) throw new Error('Native save target has no active document ownership');
          const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
          await api.writeNativeFile!(descriptor.handleId, bytes, metadata.identity);
          closed = true;
        },
      };
    },
    async isSameEntry(other) {
      if (other === handle) return true;
      const otherMetadata = nativeHandleMetadata.get(other);
      if (!otherMetadata || otherMetadata.api !== api || !api.isSameNativeFile) {
        throw new DOMException('Handle kinds cannot be compared', 'NotSupportedError');
      }
      return api.isSameNativeFile(descriptor.handleId, otherMetadata.handleId);
    },
    async queryPermission() {
      return 'granted';
    },
    async requestPermission() {
      return 'granted';
    },
  };
  nativeHandleMetadata.set(handle, {
    api,
    handleId: descriptor.handleId,
    identity: null,
    verifiedDocumentId: descriptor.verifiedDocumentId ?? null,
  });
  return handle;
}

/** Main-issued identity derived from the exact canonical path bookmark. */
export function getNativeFileHandleVerifiedDocumentId(
  handle: FileSystemFileHandleLike | null | undefined,
): string | null {
  return handle ? nativeHandleMetadata.get(handle)?.verifiedDocumentId ?? null : null;
}

export function bindNativeFileHandleIdentity(
  handle: FileSystemFileHandleLike | null,
  identity: DocumentOwnershipIdentity,
) {
  const metadata = handle ? nativeHandleMetadata.get(handle) : null;
  if (metadata) metadata.identity = { ...identity };
}

/** Resolve only the exact desktop path represented by this opaque, sender-owned handle. */
export async function getNativeFileSourcePath(
  handle: FileSystemFileHandleLike | null | undefined,
): Promise<string | null> {
  const metadata = handle ? nativeHandleMetadata.get(handle) : null;
  if (!metadata?.api.getNativeFileSourcePath) return null;
  const sourcePath = await metadata.api.getNativeFileSourcePath(metadata.handleId);
  return typeof sourcePath === 'string' && sourcePath.trim() && !sourcePath.includes('\0')
    ? sourcePath
    : null;
}

export function captureDesktopNativeDroppedFile(
  file: File,
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.claimNativeDroppedFile) return Promise.resolve(undefined);
  // The preload call reaches webUtils synchronously while Chromium still owns the drop File.
  const pending = api.claimNativeDroppedFile(file);
  return Promise.resolve(pending).then((result) => {
    if (!result) return undefined;
    if ('owned' in result) throw new Error('다른 창에서 이미 열려 있는 문서입니다.');
    if (!validNativeDescriptor(result)) throw new Error('Desktop drop returned an invalid handle');
    return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
  });
}

export async function pickDesktopNativeProjectFile(
  options: { suggestedName: string; documentId: string },
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | 'owned' | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.pickNativeOpenFile) return undefined;
  const result = await api.pickNativeOpenFile(options);
  if (!result) return null;
  if ('owned' in result) return 'owned';
  if (!validNativeDescriptor(result)) throw new Error('Desktop open picker returned an invalid handle');
  return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
}

export async function pickDesktopNativeOpenFile(
  win?: DesktopHost,
  options?: { suggestedName?: string; documentId?: string },
): Promise<FileSystemFileHandleLike | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.pickNativeOpenFile) return undefined;
  const result = await api.pickNativeOpenFile(options);
  if (!result || 'owned' in result) return null;
  if (!validNativeDescriptor(result)) throw new Error('Desktop open picker returned an invalid handle');
  return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
}

export async function pickDesktopNativeSaveFile(
  options: SaveFilePickerOptionsLike,
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.pickNativeSaveFile) return undefined;
  const suggestedName = options.suggestedName ?? FALLBACK_DOCUMENT_FILE_NAME;
  const match = suggestedName.match(/\.(hwp|hwpx|hml)$/i);
  if (!match) throw new Error('Save target format is unavailable');
  const result = await api.pickNativeSaveFile({
    suggestedName,
    extension: match[1]!.toLowerCase() as 'hwp' | 'hwpx' | 'hml',
  });
  if (!result) return null;
  if ('owned' in result) throw new Error('다른 창에서 이미 열려 있는 문서입니다.');
  if (!validNativeDescriptor(result)) throw new Error('Desktop save picker returned an invalid handle');
  return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
}

export async function saveDesktopPortableHistoryFile(
  folder: { folderName: string; files: ReadonlyArray<{ name: string; bytes: Uint8Array }> },
  win?: DesktopHost,
): Promise<'saved' | 'cancelled' | 'unavailable'> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.savePortableHistoryFile) return 'unavailable';
  const result = await api.savePortableHistoryFile({
    suggestedName: folder.folderName,
    files: folder.files.map((file) => ({
      name: file.name,
      bytes: new Uint8Array(file.bytes),
    })),
  });
  return result ? 'saved' : 'cancelled';
}

/** Overwrite an already-open native `.rhwpx` package without showing a save picker. */
export async function writeDesktopPortableHistoryFile(
  handle: FileSystemFileHandleLike | null | undefined,
  folder: { folderName: string; files: ReadonlyArray<{ name: string; bytes: Uint8Array }> },
  win?: DesktopHost,
): Promise<'saved' | 'unavailable'> {
  const metadata = handle ? nativeHandleMetadata.get(handle) : null;
  const api = desktopHost(win)?.rhwpDesktop ?? metadata?.api;
  if (
    !handle
    || handle.identityKind !== 'native-path'
    || !metadata?.identity
    || !api?.writePortableHistoryFile
  ) {
    return 'unavailable';
  }
  await api.writePortableHistoryFile(
    metadata.handleId,
    folder.files.map((file) => ({
      name: file.name,
      bytes: new Uint8Array(file.bytes),
    })),
    metadata.identity,
  );
  return 'saved';
}

export async function rememberNativeDocument(
  documentId: string | null | undefined,
  handle: FileSystemFileHandleLike | null | undefined,
  digest?: string | null,
): Promise<void> {
  const metadata = handle ? nativeHandleMetadata.get(handle) : null;
  if (!documentId || !metadata?.api.rememberNativeDocument) return;
  await metadata.api.rememberNativeDocument(documentId, metadata.handleId, digest);
}

export async function restoreNativeDocument(
  documentId: string | null | undefined,
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | 'owned' | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.reopenNativeDocument || !documentId) return null;
  try {
    const result = await api.reopenNativeDocument(documentId);
    if (!result) return null;
    if ('owned' in result) return 'owned';
    if (!validNativeDescriptor(result)) return null;
    return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
  } catch (error) {
    console.warn('[desktop] native document reopen failed:', error);
    return null;
  }
}

export interface NativeProbeRef {
  readonly probeId: string;
  readonly fileName: string;
}

export async function searchNearbyNativeDocuments(
  documentId: string,
  options: { basenameHint?: string } = {},
  win?: DesktopHost,
): Promise<readonly NativeProbeRef[] | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.searchNearbyNativeDocument || !documentId) return null;
  try {
    const result = await api.searchNearbyNativeDocument(documentId, options);
    if (!Array.isArray(result)) return null;
    return result.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const probe = item as Record<string, unknown>;
      if (typeof probe.probeId !== 'string' || !probe.probeId) return [];
      if (typeof probe.fileName !== 'string' || !probe.fileName) return [];
      return [{ probeId: probe.probeId, fileName: probe.fileName }];
    });
  } catch (error) {
    console.warn('[desktop] native nearby search failed:', error);
    return null;
  }
}

export async function readNativeProbe(
  probeId: string,
  win?: DesktopHost,
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.readNativeProbe || !probeId) return null;
  const result = await api.readNativeProbe(probeId);
  if (!result || typeof result.name !== 'string') return null;
  return { bytes: result.bytes, fileName: result.name };
}

export async function claimNativeProbe(
  probeId: string,
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | 'owned' | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.claimNativeProbe || !probeId) return null;
  const result = await api.claimNativeProbe(probeId);
  if (!result) return null;
  if ('owned' in result) return 'owned';
  if (!validNativeDescriptor(result)) return null;
  return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
}

export async function verifyNativePick(
  documentId: string,
  handle: FileSystemFileHandleLike | null | undefined,
  win?: DesktopHost,
): Promise<boolean> {
  const api = desktopHost(win)?.rhwpDesktop ?? (handle ? nativeHandleMetadata.get(handle)?.api : undefined);
  const handleId = handle ? nativeHandleMetadata.get(handle)?.handleId : undefined;
  if (!api?.verifyNativePick || !documentId || !handleId) return false;
  try {
    return await api.verifyNativePick(documentId, handleId) === true;
  } catch {
    return false;
  }
}

export async function releaseReplacedNativeFileHandle(
  previous: FileSystemFileHandleLike | null,
  next: FileSystemFileHandleLike | null,
) {
  const previousMetadata = previous ? nativeHandleMetadata.get(previous) : null;
  const nextMetadata = next ? nativeHandleMetadata.get(next) : null;
  if (!previousMetadata?.api.releaseNativeFile) return;
  if (
    nextMetadata
    && nextMetadata.api === previousMetadata.api
    && nextMetadata.handleId === previousMetadata.handleId
  ) return;
  const previousDocumentId = previousMetadata.identity?.documentId;
  if (previousDocumentId && previousMetadata.api.rememberNativeDocument) {
    await previousMetadata.api.rememberNativeDocument(
      previousDocumentId,
      previousMetadata.handleId,
    ).catch((error) => console.warn('[desktop] native document bookmark failed:', error));
  }
  await previousMetadata.api.releaseNativeFile(previousMetadata.handleId);
}

export async function reserveDesktopDocument(
  identity: DocumentOwnershipIdentity,
  handle: FileSystemFileHandleLike | null,
  win?: DesktopHost,
): Promise<string | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.reserveDocument) return undefined;
  const nativeHandleId = handle ? nativeHandleMetadata.get(handle)?.handleId : undefined;
  const result = await api.reserveDocument(identity, nativeHandleId);
  return result.ok ? result.reservationId : null;
}

export async function commitDesktopDocument(
  reservationId: string | null | undefined,
  win?: DesktopHost,
) {
  if (reservationId) await desktopHost(win)?.rhwpDesktop?.commitDocument?.(reservationId);
}

export async function cancelDesktopDocument(
  reservationId: string | null | undefined,
  win?: DesktopHost,
) {
  if (reservationId) await desktopHost(win)?.rhwpDesktop?.cancelDocument?.(reservationId);
}

export async function releaseDesktopDocument(win?: DesktopHost) {
  await desktopHost(win)?.rhwpDesktop?.releaseDocument?.();
}

export function installDesktopFileHandling(
  openHandles: (handles: FileSystemFileHandleLike[]) => void,
  win?: DesktopHost,
) {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.readNativeFile || !api.writeNativeFile) return;
  const seen = new Set<string>();
  const receive = (descriptors: NativeFileHandleDescriptor[]) => {
    const handles = descriptors
      .filter(validNativeDescriptor)
      .filter((descriptor) => {
        if (seen.has(descriptor.handleId)) return false;
        seen.add(descriptor.handleId);
        return true;
      })
      .map((descriptor) => createNativeFileHandle(descriptor, api, { saveTarget: true }));
    if (handles.length > 0) openHandles(handles);
  };
  api.onOpenFiles?.(receive);
  void api.getLaunchFiles?.().then(receive).catch((error) => {
    console.warn('[rhwp-desktop] 시작 파일 조회 실패:', error);
  });
}

export function installDesktopGeneratedDocumentHandling(
  openDocument: (payload: { bytes: Uint8Array; fileName: string; readOnly: boolean }) => void,
  win?: DesktopHost,
) {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.onOpenGeneratedDocument) return false;
  const seen = new Set<string>();
  const receive = (payload: { launchDocumentId?: string; bytes?: Uint8Array; fileName?: string; readOnly?: boolean } | null) => {
    const launchDocumentId = typeof payload?.launchDocumentId === 'string'
      ? payload.launchDocumentId
      : '';
    const fileName = typeof payload?.fileName === 'string' ? payload.fileName : '';
    const bytes = payload?.bytes instanceof Uint8Array ? payload.bytes : null;
    if (!launchDocumentId || seen.has(launchDocumentId) || !bytes || !/\.(?:hwp|hwpx)$/iu.test(fileName)) return;
    seen.add(launchDocumentId);
    openDocument({ bytes, fileName, readOnly: payload?.readOnly === true });
  };
  api.onOpenGeneratedDocument(receive);
  void api.getLaunchGeneratedDocument?.().then(receive).catch((error) => {
    console.warn('[rhwp-desktop] 생성 문서 시작 데이터 조회 실패:', error);
  });
  return true;
}

export function installDesktopPlainTextPasteHandling(
  paste: (text: string) => void,
  win?: DesktopHost,
): boolean {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.onPastePlainText) return false;
  api.onPastePlainText((text) => {
    if (typeof text === 'string' && text.length > 0) paste(text);
  });
  return true;
}

/**
 * macOS Electron 창 크롬 연동.
 *
 * 셸이 titleBarStyle: 'hidden' 으로 뜨므로 메뉴바가 창 최상단을 차지한다.
 * `desktop-mac` 클래스로 신호등 버튼 자리(왼쪽 여백)와 드래그 영역을 켜고,
 * 전체 화면에서는 신호등이 사라지므로 `desktop-fullscreen` 으로 여백을 되돌린다.
 */
export function installDesktopWindowChrome(win?: DesktopHost): void {
  if (!isDesktopApp(win) || typeof document === 'undefined') return;
  const api = desktopHost(win)?.rhwpDesktop;
  const platform = api?.platform
    ?? (typeof navigator !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent)
      ? 'darwin'
      : '');
  if (platform !== 'darwin') return;
  const root = document.documentElement;
  root.classList.add('desktop-mac');
  const setFullscreen = (fullscreen: boolean) => {
    root.classList.toggle('desktop-fullscreen', fullscreen);
  };
  api?.onFullScreenChange?.(setFullscreen);
  void api?.isFullScreen?.().then(setFullscreen).catch(() => {
    /* IPC 미지원 셸에서는 기본(비전체화면) 상태 유지 */
  });
}

type ServiceWorkerLike = NonNullable<NonNullable<DesktopHost['navigator']>['serviceWorker']>;

function serviceWorkerContainer(win?: DesktopHost): ServiceWorkerLike | undefined {
  const host = desktopHost(win);
  return host?.navigator?.serviceWorker
    ?? (typeof navigator !== 'undefined'
      ? navigator.serviceWorker as unknown as ServiceWorkerLike
      : undefined);
}

/** Electron 셸에서는 PWA SW가 IndexedDB 할당량 정리로 최근문서/자동저장 open을 멈출 수 있다. */
export async function suppressDesktopServiceWorker(win?: DesktopHost): Promise<void> {
  if (!isDesktopApp(win)) return;
  const sw = serviceWorkerContainer(win);
  if (!sw?.getRegistrations) return;
  const unregisterAll = async () => {
    try {
      const regs = await sw.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    } catch {
      /* ignore */
    }
  };
  await unregisterAll();
  sw.addEventListener?.('controllerchange', () => {
    void unregisterAll();
  });
}

/** 브라우저 PWA만 등록하고, Electron 은 기존 SW를 끈다. */
export function installWebAppShell(win?: DesktopHost): void {
  if (isDesktopApp(win)) {
    void suppressDesktopServiceWorker(win);
    return;
  }
  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({ immediate: true });
    })
    .catch(() => {
      /* 테스트·개발 번들에는 virtual module이 없을 수 있다 */
    });
}
