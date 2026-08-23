import { exportDocumentForFormat } from '../command/save-document-format.ts';
import { defaultFormatForSource, saveFormatForFileName } from '../command/save-target.ts';
import { buildSnapshotFromWasm, compareSnapshots } from '../compare/diff-engine.ts';
import type { CompareDocumentSnapshot, CompareOptions } from '../compare/types.ts';
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { CheckpointTitleSummary } from '../agent/types.ts';
import { fingerprintBytes } from './hash.ts';
import type { ContentFingerprint, VersionStats } from './types.ts';

export const VERSION_COMPARE_OPTIONS: CompareOptions = {
  caseSensitive: true,
  ignoreWhitespace: false,
  kinds: ['text', 'table', 'shape', 'image', 'chart', 'paragraphMeta'],
  strategy: 'identity',
  performanceTuning: {
    maxComputeMs: 1_200,
    hardSegmentCells: 80_000,
  },
};

export interface CapturedVersionSnapshot {
  bytes: Uint8Array;
  fingerprint: ContentFingerprint;
  compareSnapshot: CompareDocumentSnapshot;
}

export interface VersionDiffAnalysis {
  stats: VersionStats;
  titleSummary: CheckpointTitleSummary;
}

function currentSaveFormat(wasm: WasmBridge): 'hml' | 'hwp' | 'hwpx' {
  const targetName = wasm.currentFileHandle?.name ?? wasm.fileName;
  return saveFormatForFileName(targetName) ?? defaultFormatForSource(wasm.getSourceFormat());
}

export function captureVersionSnapshot(wasm: WasmBridge): CapturedVersionSnapshot {
  const canonicalBytes = wasm.exportHwp();
  const fingerprint = fingerprintBytes(canonicalBytes);
  const compareSnapshot = buildSnapshotFromWasm(wasm, wasm.fileName, VERSION_COMPARE_OPTIONS);
  const format = currentSaveFormat(wasm);
  let bytes: Uint8Array;
  try {
    // `canonicalBytes` is already the HWP export used for fingerprinting.
    // Reuse it instead of serializing large HWP documents twice per checkpoint.
    bytes = format === 'hwp' ? canonicalBytes : exportDocumentForFormat(wasm, format);
  } catch {
    bytes = canonicalBytes;
  }
  return { bytes, fingerprint, compareSnapshot };
}

export function analyzeVersionDiff(
  before: CompareDocumentSnapshot | null,
  after: CompareDocumentSnapshot,
): VersionDiffAnalysis {
  if (!before) {
    const added = after.paragraphs.length + after.controls.length;
    return {
      stats: { added, removed: 0, modified: 0 },
      titleSummary: {
        totals: { added: 1, removed: 0, modified: 0 },
        items: [{ change: 'added', objectType: 'document', heading: '버전 기록 시작' }],
      },
    };
  }
  const session = compareSnapshots(before, after, VERSION_COMPARE_OPTIONS);
  const stats = session.diffItems.reduce<VersionStats>((result, item) => {
    if (item.severity === 'added') result.added += 1;
    else if (item.severity === 'removed') result.removed += 1;
    else result.modified += 1;
    return result;
  }, { added: 0, removed: 0, modified: 0 });
  const totals = { ...stats };
  const items: CheckpointTitleSummary['items'] = [];
  for (const item of session.diffItems.slice(0, 12)) {
    const candidate = {
      change: item.severity,
      objectType: item.kind,
      heading: item.title.slice(0, 120),
      snippet: (item.rightPreview || item.leftPreview).slice(0, 220) || undefined,
    } as const;
    const next = [...items, candidate];
    if (new TextEncoder().encode(JSON.stringify({ totals, items: next })).byteLength > 4096) break;
    items.push(candidate);
  }
  return { stats, titleSummary: { totals, items } };
}

export function calculateVersionStats(
  before: CompareDocumentSnapshot | null,
  after: CompareDocumentSnapshot,
): VersionStats {
  return analyzeVersionDiff(before, after).stats;
}

export function compactVersionDiff(
  before: CompareDocumentSnapshot | null,
  after: CompareDocumentSnapshot,
): string[] {
  if (!before) return ['문서 버전 기록 시작'];
  return compareSnapshots(before, after, VERSION_COMPARE_OPTIONS).diffItems
    .slice(0, 12)
    .map((item) => {
      const location = item.path.paragraph === undefined
        ? `구역 ${item.path.section + 1}`
        : `구역 ${item.path.section + 1}, 문단 ${item.path.paragraph + 1}`;
      const preview = item.rightPreview || item.leftPreview;
      return `${item.severity} ${item.kind} · ${location} · ${item.title}${preview ? ` · ${preview}` : ''}`;
    });
}

export function buildCheckpointTitleSummary(
  before: CompareDocumentSnapshot | null,
  after: CompareDocumentSnapshot,
): CheckpointTitleSummary {
  return analyzeVersionDiff(before, after).titleSummary;
}
