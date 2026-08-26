/// <reference lib="webworker" />

import init from '@wasm/rhwp.js';
import * as wasmModule from '@wasm/rhwp.js';
import type { MergeAnalysis, MergeValidationResult } from './domain.ts';
import type { MergeWorkerRequest, MergeWorkerResponse } from './worker-protocol.ts';
import type { MergeManifestEntrySeed } from '../versioning/types.ts';

interface StructuralMergeExports {
  structuralMergeAnalyze(base: string, current: string, incoming: string): string;
  structuralMergeMaterialize(analysis: string, resolutions: string): string;
  structuralMergeVirtualBase?(bases: string): string;
  structuralMergeAnalyzeDocument?(base: Uint8Array, current: Uint8Array, incoming: Uint8Array): string;
  structuralMergeAnalyzeDocumentWithManifests?(
    base: Uint8Array,
    current: Uint8Array,
    incoming: Uint8Array,
    baseManifest: string,
    currentManifest: string,
    incomingManifest: string,
  ): string;
  structuralMergeMaterializeDocument?(
    base: Uint8Array,
    current: Uint8Array,
    incoming: Uint8Array,
    resolutions: string,
  ): Uint8Array;
  structuralMergeMaterializeDocumentWithManifests?(
    base: Uint8Array,
    current: Uint8Array,
    incoming: Uint8Array,
    baseManifest: string,
    currentManifest: string,
    incomingManifest: string,
    resolutions: string,
  ): Uint8Array;
  structuralMergeVirtualBaseDocument?(basesBase64Json: string, currentFormat: 'hwp' | 'hwpx'): Uint8Array;
  structuralMergeBuildManifest?(bytes: Uint8Array): string;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
let wasmReady: Promise<void> | null = null;

function post(message: MergeWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

async function exportsReady(): Promise<StructuralMergeExports> {
  if (!wasmReady) {
    const initializing = init().then(() => undefined);
    wasmReady = initializing.catch((error) => {
      wasmReady = null;
      throw error;
    });
  }
  await wasmReady;
  const exports = wasmModule as unknown as Partial<StructuralMergeExports>;
  if (
    typeof exports.structuralMergeAnalyze !== 'function'
    || typeof exports.structuralMergeMaterialize !== 'function'
  ) {
    throw new Error('This RHWP WebAssembly build does not include the structural merge exports.');
  }
  return exports as StructuralMergeExports;
}

function canonical(value: unknown): string {
  const visit = (child: unknown, seen: WeakSet<object>): unknown => {
    if (!child || typeof child !== 'object') return child;
    if (seen.has(child)) throw new TypeError('Merge trees must not contain cycles.');
    seen.add(child);
    const result = Array.isArray(child)
      ? child.map((item) => visit(item, seen))
      : Object.fromEntries(Object.entries(child as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, visit(item, seen)]));
    seen.delete(child);
    return result;
  };
  return JSON.stringify(visit(value, new WeakSet()));
}

function neutralBase(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) return [];
  if (left && right && typeof left === 'object' && typeof right === 'object') return {};
  return null;
}

function parseAnalysis(raw: string): MergeAnalysis {
  const parsed = JSON.parse(raw) as {
    analysisVersion?: number;
    analysis_version?: number;
    result: unknown;
    conflicts: MergeAnalysis['conflicts'];
    automaticOperationCount?: number;
    automatic_operation_count?: number;
  };
  return {
    analysisVersion: parsed.analysisVersion ?? parsed.analysis_version ?? 1,
    result: parsed.result,
    conflicts: parsed.conflicts,
    automaticOperationCount:
      parsed.automaticOperationCount ?? parsed.automatic_operation_count ?? 0,
  };
}

function wireAnalysis(analysis: MergeAnalysis): Record<string, unknown> {
  return {
    analysisVersion: analysis.analysisVersion,
    result: analysis.result,
    conflicts: analysis.conflicts,
    automaticOperationCount: analysis.automaticOperationCount,
  };
}

function validateTree(tree: unknown): MergeValidationResult {
  const errors: string[] = [];
  const visit = (value: unknown, path: string, seen: WeakSet<object>): void => {
    if (value === undefined) {
      errors.push(`${path} contains an undefined value.`);
      return;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      errors.push(`${path} contains a non-finite number.`);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) {
      errors.push(`${path} contains a cycle.`);
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) value.forEach((child, index) => visit(child, `${path}[${index}]`, seen));
    else for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, seen);
    seen.delete(value);
  };
  visit(tree, '$', new WeakSet());
  return { valid: errors.length === 0, errors };
}

function detectFormat(bytes: Uint8Array): 'hwp' | 'hwpx' | 'unknown' {
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length >= ole.length && ole.every((value, index) => bytes[index] === value)) return 'hwp';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'hwpx';
  return 'unknown';
}

function pendingHostValidation(bytes: Uint8Array): MergeValidationResult {
  return {
    // Rust가 바이트를 반환해도 내부 어댑터 완료만 확인된다. 최종 적용 전 컨트롤러가
    // 새 WASM 문서에서 로드, 내보내기, 재로드, 구조 비교, 리소스 종속성 검사를 수행한다.
    valid: false,
    errors: ['Host parse/export/reload and resource validation is pending.'],
    checks: {
      parsed: false,
      exported: false,
      reloaded: false,
      structurallyValid: false,
      format: detectFormat(bytes),
    },
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function parseManifestEntries(raw: string): MergeManifestEntrySeed[] {
  const parsed = JSON.parse(raw) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) throw new Error('Structural manifest did not contain entries.');
  return parsed.entries.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') throw new Error(`Manifest entry ${index} is invalid.`);
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.kind !== 'string'
      || !Array.isArray(entry.path)
      || !entry.path.every((part) => typeof part === 'string')
      || typeof entry.propertyHash !== 'string'
      || !/^blake3:[0-9a-f]{64}$/.test(entry.propertyHash)
      || (entry.identityHint !== undefined && typeof entry.identityHint !== 'string')
    ) throw new Error(`Manifest entry ${index} has an invalid shape.`);
    return {
      kind: entry.kind,
      path: entry.path as string[],
      propertyHash: entry.propertyHash as `blake3:${string}`,
      ...(entry.identityHint ? { identityHint: entry.identityHint } : {}),
    };
  });
}

async function analyze(base: unknown, current: unknown, incoming: unknown): Promise<MergeAnalysis> {
  const exports = await exportsReady();
  return parseAnalysis(exports.structuralMergeAnalyze(canonical(base), canonical(current), canonical(incoming)));
}

scope.addEventListener('message', (event: MessageEvent<MergeWorkerRequest>) => {
  const request = event.data;
  void (async () => {
    post({ id: request.id, type: 'progress', operation: request.operation, phase: 'initializing', percent: 0 });
    if (request.operation === 'analyze') {
      const value = await analyze(request.base, request.current, request.incoming);
      post({ id: request.id, type: 'analysis', value });
      return;
    }
    if (request.operation === 'build-manifest') {
      const exports = await exportsReady();
      if (typeof exports.structuralMergeBuildManifest !== 'function') {
        throw new Error('This RHWP WebAssembly build does not include structural manifest export.');
      }
      const entries = parseManifestEntries(exports.structuralMergeBuildManifest(request.bytes));
      post({ id: request.id, type: 'manifest', entries });
      return;
    }
    if (request.operation === 'analyze-document') {
      const exports = await exportsReady();
      if (typeof exports.structuralMergeAnalyzeDocument !== 'function') {
        throw new Error('This RHWP WebAssembly build does not include document-byte merge analysis.');
      }
      const value = parseAnalysis(request.manifests
        && typeof exports.structuralMergeAnalyzeDocumentWithManifests === 'function'
        ? exports.structuralMergeAnalyzeDocumentWithManifests(
          request.base,
          request.current,
          request.incoming,
          JSON.stringify(request.manifests.base),
          JSON.stringify(request.manifests.current),
          JSON.stringify(request.manifests.incoming),
        )
        : exports.structuralMergeAnalyzeDocument(
          request.base,
          request.current,
          request.incoming,
        ));
      post({ id: request.id, type: 'analysis', value });
      return;
    }
    if (request.operation === 'materialize') {
      const exports = await exportsReady();
      const tree = JSON.parse(exports.structuralMergeMaterialize(
        JSON.stringify(wireAnalysis(request.analysis)),
        JSON.stringify(request.resolutions),
      ));
      post({ id: request.id, type: 'materialized', tree, validation: validateTree(tree) });
      return;
    }
    if (request.operation === 'materialize-document') {
      const exports = await exportsReady();
      if (typeof exports.structuralMergeMaterializeDocument !== 'function') {
        throw new Error('This RHWP WebAssembly build does not include document-byte merge materialization.');
      }
      const bytes = request.manifests
        && typeof exports.structuralMergeMaterializeDocumentWithManifests === 'function'
        ? exports.structuralMergeMaterializeDocumentWithManifests(
          request.base,
          request.current,
          request.incoming,
          JSON.stringify(request.manifests.base),
          JSON.stringify(request.manifests.current),
          JSON.stringify(request.manifests.incoming),
          JSON.stringify(request.resolutions),
        )
        : exports.structuralMergeMaterializeDocument(
          request.base,
          request.current,
          request.incoming,
          JSON.stringify(request.resolutions),
        );
      const validation = pendingHostValidation(bytes);
      post({ id: request.id, type: 'materialized-document', bytes, validation }, [bytes.buffer]);
      return;
    }
    if (request.operation === 'synthesize-virtual-base-document') {
      const exports = await exportsReady();
      if (typeof exports.structuralMergeVirtualBaseDocument !== 'function') {
        throw new Error('This RHWP WebAssembly build does not include document-byte virtual base synthesis.');
      }
      const basesJson = JSON.stringify(request.bases.map(base64));
      const bytes = exports.structuralMergeVirtualBaseDocument(basesJson, request.currentFormat);
      post({ id: request.id, type: 'virtual-base-document', bytes }, [bytes.buffer]);
      return;
    }

    const bases = [...request.bases].sort((left, right) => canonical(left).localeCompare(canonical(right)));
    if (bases.length === 0) throw new Error('At least one merge base is required.');
    const exports = await exportsReady();
    if (typeof exports.structuralMergeVirtualBase === 'function') {
      const tree = JSON.parse(exports.structuralMergeVirtualBase(JSON.stringify(bases)));
      post({ id: request.id, type: 'virtual-base', tree });
      return;
    }
    let tree = structuredClone(bases[0]);
    for (let index = 1; index < bases.length; index += 1) {
      post({
        id: request.id,
        type: 'progress',
        operation: request.operation,
        phase: 'synthesizing',
        percent: Math.round((index / bases.length) * 100),
      });
      // A neutral recursive base merges disjoint properties and keyed children;
      // same-field differences conservatively prefer the canonical first tree.
      tree = (await analyze(neutralBase(tree, bases[index]), tree, bases[index])).result;
    }
    post({ id: request.id, type: 'virtual-base', tree });
  })().catch((error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    post({ id: request.id, type: 'error', message: normalized.message, stack: normalized.stack });
  });
});
