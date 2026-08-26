import type { MergeConflict, MergeManifestEntrySeed, MergeResolution } from '../versioning/types.ts';
import type { MergeAnalysis, MergeValidationResult } from './domain.ts';
import type {
  MergeWorkerOperation,
  MergeWorkerRequest,
  MergeWorkerResponse,
  MergeDocumentManifests,
} from './worker-protocol.ts';

export interface MergeProgress {
  operation: MergeWorkerOperation;
  phase: string;
  elapsedMs: number;
  percent?: number;
}

export interface MergeWorkerCallOptions {
  signal?: AbortSignal;
  softBudgetMs?: number;
  onProgress?: (progress: MergeProgress) => void;
}

export interface MergeDocumentWorkerCallOptions extends MergeWorkerCallOptions {
  manifests?: MergeDocumentManifests;
}

export interface MergeMaterializeOutput {
  tree: unknown;
  validation: MergeValidationResult;
}

export interface MergeDocumentMaterializeOutput {
  bytes: Uint8Array;
  validation: MergeValidationResult;
}

interface WorkerLike {
  postMessage(message: MergeWorkerRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<MergeWorkerResponse>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<MergeWorkerResponse>) => void): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
  terminate(): void;
}

export type MergeWorkerFactory = () => WorkerLike;

interface Pending<T> {
  operation: MergeWorkerOperation;
  startedAt: number;
  resolve(value: T): void;
  reject(reason: unknown): void;
  options: MergeWorkerCallOptions;
  heartbeat: ReturnType<typeof setInterval>;
  budget: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  timeoutFallback?: () => T;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function identity(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  for (const key of ['stableId', 'stable_id', 'identity', 'id', 'key']) {
    if (typeof object[key] === 'string' || typeof object[key] === 'number') return String(object[key]);
  }
  return null;
}

function combineVirtualBases(left: unknown, right: unknown): unknown {
  if (stable(left) === stable(right)) return structuredClone(left);
  if (Array.isArray(left) && Array.isArray(right)) {
    const keyed = [...left, ...right].every((value) => identity(value) !== null);
    if (!keyed) return structuredClone(left);
    const values = new Map<string, unknown>();
    for (const value of [...left, ...right]) {
      const id = identity(value)!;
      values.set(id, values.has(id) ? combineVirtualBases(values.get(id), value) : structuredClone(value));
    }
    return [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    return Object.fromEntries([...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])]
      .sort()
      .map((key) => [key,
        key in leftObject && key in rightObject
          ? combineVirtualBases(leftObject[key], rightObject[key])
          : structuredClone(key in leftObject ? leftObject[key] : rightObject[key]),
      ]));
  }
  return structuredClone(left);
}

function fallbackVirtualBase(baseTrees: readonly unknown[]): unknown {
  const sorted = [...baseTrees].sort((a, b) => stable(a).localeCompare(stable(b)));
  return sorted.slice(1).reduce(combineVirtualBases, structuredClone(sorted[0]));
}

function budgetAnalysis(base: unknown, current: unknown, incoming: unknown): MergeAnalysis {
  const fingerprint = `budget:${shortHash(stable([base, current, incoming]))}`;
  const conflict: MergeConflict = {
    id: `conflict:${fingerprint}`,
    kind: 'document',
    path: [],
    reason: 'budget-exceeded',
    base,
    current,
    incoming,
    supportsBoth: false,
    fingerprint,
  };
  return { analysisVersion: 1, result: structuredClone(current), conflicts: [conflict], automaticOperationCount: 0 };
}

export class MergeWorkerClient {
  private worker: WorkerLike;
  private sequence = 0;
  private readonly pending = new Map<number, Pending<unknown>>();
  private readonly uncertainVirtualBases = new WeakSet<object>();
  private readonly factory: MergeWorkerFactory;
  private readonly onMessageBound: (event: MessageEvent<MergeWorkerResponse>) => void;
  private readonly onErrorBound: (event: ErrorEvent) => void;
  private readonly onMessageErrorBound: () => void;
  private disposed = false;

  constructor(factory: MergeWorkerFactory = () => new Worker(
    new URL('./merge.worker.ts', import.meta.url),
    { type: 'module', name: 'rhwp-structural-merge' },
  )) {
    this.factory = factory;
    this.onMessageBound = (event) => this.onMessage(event.data);
    this.onErrorBound = (event) => this.restartWorker(
      event.error ?? new Error(event.message || 'The merge worker failed.'),
    );
    this.onMessageErrorBound = () => this.restartWorker(new Error('The merge worker returned an unreadable message.'));
    this.worker = this.createWorker();
  }

  analyze(
    base: unknown,
    current: unknown,
    incoming: unknown,
    options: MergeWorkerCallOptions = {},
  ): Promise<MergeAnalysis> {
    if (this.disposed) return Promise.reject(new DOMException('The merge worker was disposed.', 'AbortError'));
    if (base && typeof base === 'object' && this.uncertainVirtualBases.has(base)) {
      options.onProgress?.({ operation: 'analyze', phase: 'budget-exceeded', elapsedMs: 0 });
      return Promise.resolve(budgetAnalysis(base, current, incoming));
    }
    return this.request(
      { id: 0, operation: 'analyze', base, current, incoming },
      options,
      () => budgetAnalysis(base, current, incoming),
    );
  }

  materialize(
    analysis: MergeAnalysis,
    resolutions: Readonly<Record<string, MergeResolution>>,
    options: MergeWorkerCallOptions = {},
  ): Promise<MergeMaterializeOutput> {
    return this.request({ id: 0, operation: 'materialize', analysis, resolutions }, options);
  }

  analyzeDocument(
    base: Uint8Array,
    current: Uint8Array,
    incoming: Uint8Array,
    options: MergeDocumentWorkerCallOptions = {},
  ): Promise<MergeAnalysis> {
    // The byte materializer only accepts conflict IDs emitted by the Rust
    // document merge. Its internal budget converts uncertain regions into
    // compatible conflicts, so the external soft budget reports but waits.
    return this.request(
      { id: 0, operation: 'analyze-document', base, current, incoming, manifests: options.manifests },
      options,
    );
  }

  materializeDocument(
    base: Uint8Array,
    current: Uint8Array,
    incoming: Uint8Array,
    resolutions: Readonly<Record<string, MergeResolution>>,
    options: MergeDocumentWorkerCallOptions = {},
  ): Promise<MergeDocumentMaterializeOutput> {
    return this.request({
      id: 0,
      operation: 'materialize-document',
      base,
      current,
      incoming,
      resolutions,
      manifests: options.manifests,
    }, options);
  }

  synthesizeVirtualBase(
    baseTrees: readonly unknown[],
    options: MergeWorkerCallOptions = {},
  ): Promise<unknown> {
    if (baseTrees.length === 0) return Promise.reject(new Error('At least one merge base is required.'));
    return this.request(
      { id: 0, operation: 'synthesize-virtual-base', bases: [...baseTrees] },
      options,
      () => {
        const fallback = fallbackVirtualBase(baseTrees);
        if (fallback && typeof fallback === 'object') this.uncertainVirtualBases.add(fallback);
        return fallback;
      },
    );
  }

  synthesizeVirtualBaseDocument(
    bases: readonly Uint8Array[],
    currentFormat: 'hwp' | 'hwpx',
    options: MergeWorkerCallOptions = {},
  ): Promise<Uint8Array> {
    if (bases.length === 0) return Promise.reject(new Error('At least one merge base is required.'));
    return this.request({
      id: 0,
      operation: 'synthesize-virtual-base-document',
      bases: [...bases],
      currentFormat,
    }, options);
  }

  buildDocumentManifest(
    bytes: Uint8Array,
    options: MergeWorkerCallOptions = {},
  ): Promise<MergeManifestEntrySeed[]> {
    return this.request({ id: 0, operation: 'build-manifest', bytes }, options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) {
      this.finishTimers(pending);
      pending.reject(new DOMException('The merge worker was disposed.', 'AbortError'));
    }
    this.pending.clear();
    this.removeWorkerListeners(this.worker);
    this.worker.terminate();
  }

  private createWorker(): WorkerLike {
    const worker = this.factory();
    worker.addEventListener('message', this.onMessageBound);
    worker.addEventListener('error', this.onErrorBound);
    worker.addEventListener('messageerror', this.onMessageErrorBound);
    return worker;
  }

  private removeWorkerListeners(worker: WorkerLike): void {
    worker.removeEventListener('message', this.onMessageBound);
    worker.removeEventListener('error', this.onErrorBound);
    worker.removeEventListener('messageerror', this.onMessageErrorBound);
  }

  private request<T>(
    request: MergeWorkerRequest,
    options: MergeWorkerCallOptions,
    timeoutFallback?: () => T,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new DOMException('The merge worker was disposed.', 'AbortError'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    const id = ++this.sequence;
    const operation = request.operation;
    const startedAt = performance.now();
    return new Promise<T>((resolve, reject) => {
      const report = (phase: string, percent?: number): void => options.onProgress?.({
        operation,
        phase,
        elapsedMs: Math.max(0, performance.now() - startedAt),
        percent,
      });
      const heartbeat = setInterval(() => report('working'), 100);
      const budget = setTimeout(() => this.onBudget(id), options.softBudgetMs ?? 5_000);
      const pending: Pending<T> = {
        operation,
        startedAt,
        resolve,
        reject,
        options,
        heartbeat,
        budget,
        timeoutFallback,
      };
      if (options.signal) {
        pending.onAbort = () => {
          const reason = options.signal?.reason ?? new DOMException('Aborted', 'AbortError');
          this.settle(id, () => reject(reason));
          // WebAssembly analysis is synchronous inside the worker. Restarting
          // is the only way to make abort release that dedicated thread now.
          this.restartWorker(new DOMException('The merge worker was restarted after cancellation.', 'AbortError'));
        };
        options.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending.set(id, pending as Pending<unknown>);
      report('queued', 0);
      this.worker.postMessage({ ...request, id } as MergeWorkerRequest);
    });
  }

  private onMessage(message: MergeWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === 'progress') {
      pending.options.onProgress?.({
        operation: message.operation,
        phase: message.phase,
        elapsedMs: Math.max(0, performance.now() - pending.startedAt),
        percent: message.percent,
      });
      return;
    }
    if (message.type === 'error') {
      const error = new Error(message.message);
      error.stack = message.stack ?? error.stack;
      this.settle(message.id, () => pending.reject(error));
      return;
    }
    const value = message.type === 'analysis'
      ? message.value
      : message.type === 'manifest'
        ? message.entries
      : message.type === 'materialized'
        ? { tree: message.tree, validation: message.validation }
        : message.type === 'materialized-document'
          ? { bytes: message.bytes, validation: message.validation }
          : message.type === 'virtual-base-document'
            ? message.bytes
            : message.tree;
    this.settle(message.id, () => pending.resolve(value));
  }

  private onBudget(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.options.onProgress?.({
      operation: pending.operation,
      phase: 'budget-exceeded',
      elapsedMs: Math.max(0, performance.now() - pending.startedAt),
    });
    if (!pending.timeoutFallback) {
      this.settle(id, () => pending.reject(new Error('The merge worker exceeded its time budget.')));
      this.restartWorker(new Error('A concurrent merge request was cancelled after the time budget was exceeded.'));
      return;
    }
    const fallback = pending.timeoutFallback();
    this.settle(id, () => pending.resolve(fallback));
    this.restartWorker(new Error('A concurrent merge request was cancelled after the soft budget was exceeded.'));
  }

  private restartWorker(reason?: unknown): void {
    this.removeWorkerListeners(this.worker);
    this.worker.terminate();
    if (reason !== undefined) {
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        this.finishTimers(pending);
        pending.reject(reason);
      }
    }
    if (!this.disposed) this.worker = this.createWorker();
  }

  private settle(id: number, action: () => void): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.finishTimers(pending);
    action();
  }

  private finishTimers(pending: Pending<unknown>): void {
    clearInterval(pending.heartbeat);
    clearTimeout(pending.budget);
    if (pending.onAbort && pending.options.signal) {
      pending.options.signal.removeEventListener('abort', pending.onAbort);
    }
  }
}
