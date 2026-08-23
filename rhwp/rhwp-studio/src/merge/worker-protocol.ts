import type { MergeManifestEntrySeed, MergeResolution } from '../versioning/types.ts';
import type { MergeAnalysis, MergeValidationResult } from './domain.ts';

export interface MergeDocumentManifests {
  base: unknown;
  current: unknown;
  incoming: unknown;
}

export type MergeWorkerOperation =
  | 'analyze'
  | 'analyze-document'
  | 'materialize'
  | 'materialize-document'
  | 'synthesize-virtual-base'
  | 'synthesize-virtual-base-document'
  | 'build-manifest';

export type MergeWorkerRequest =
  | { id: number; operation: 'analyze'; base: unknown; current: unknown; incoming: unknown }
  | {
      id: number;
      operation: 'analyze-document';
      base: Uint8Array;
      current: Uint8Array;
      incoming: Uint8Array;
      manifests?: MergeDocumentManifests;
    }
  | {
      id: number;
      operation: 'materialize';
      analysis: MergeAnalysis;
      resolutions: Readonly<Record<string, MergeResolution>>;
    }
  | {
      id: number;
      operation: 'materialize-document';
      base: Uint8Array;
      current: Uint8Array;
      incoming: Uint8Array;
      resolutions: Readonly<Record<string, MergeResolution>>;
      manifests?: MergeDocumentManifests;
    }
  | { id: number; operation: 'synthesize-virtual-base'; bases: unknown[] }
  | {
      id: number;
      operation: 'synthesize-virtual-base-document';
      bases: Uint8Array[];
      currentFormat: 'hwp' | 'hwpx';
    }
  | { id: number; operation: 'build-manifest'; bytes: Uint8Array };

export type MergeWorkerResponse =
  | { id: number; type: 'progress'; operation: MergeWorkerOperation; phase: string; percent?: number }
  | { id: number; type: 'analysis'; value: MergeAnalysis }
  | { id: number; type: 'materialized'; tree: unknown; validation: MergeValidationResult }
  | {
      id: number;
      type: 'materialized-document';
      bytes: Uint8Array;
      validation: MergeValidationResult;
    }
  | { id: number; type: 'virtual-base'; tree: unknown }
  | { id: number; type: 'virtual-base-document'; bytes: Uint8Array }
  | { id: number; type: 'manifest'; entries: MergeManifestEntrySeed[] }
  | { id: number; type: 'error'; message: string; stack?: string };
