import type {
  MergeConflict,
  MergeDraftHistoryEntry,
  MergeResolution,
} from '../versioning/types.ts';

export interface ResolutionChange {
  groupId: string;
  ids: string[];
  before: Array<MergeResolution | undefined>;
  after: Array<MergeResolution | undefined>;
}

let resolutionChangeSequence = 0;

function nextGroupId(): string {
  resolutionChangeSequence += 1;
  return `resolver-change:${Date.now().toString(36)}:${resolutionChangeSequence.toString(36)}`;
}

function copyResolution(value: MergeResolution | undefined): MergeResolution | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function supportsResolution(conflict: MergeConflict, resolution: MergeResolution): boolean {
  if (resolution.kind === 'both') return conflict.supportsBoth;
  if (resolution.kind === 'manual') return conflict.supportsManual !== false;
  return true;
}

export class MergeResolverState {
  private readonly conflictsById: Map<string, MergeConflict>;
  private readonly values = new Map<string, MergeResolution>();
  private history: ResolutionChange[] = [];
  private historyIndex = 0;

  constructor(
    conflicts: readonly MergeConflict[],
    initial: Readonly<Record<string, MergeResolution>> = {},
    persistedHistory: readonly MergeDraftHistoryEntry[] = [],
    persistedHistoryIndex = persistedHistory.length,
  ) {
    this.conflictsById = new Map(conflicts.map((conflict) => [conflict.id, conflict]));
    for (const [id, resolution] of Object.entries(initial)) {
      const conflict = this.conflictsById.get(id);
      if (conflict && supportsResolution(conflict, resolution)) {
        this.values.set(id, copyResolution(resolution)!);
      }
    }
    const grouped = new Map<string, ResolutionChange>();
    const orderedGroups: ResolutionChange[] = [];
    const appliedEntryCounts: number[] = [];
    persistedHistory.forEach((entry, index) => {
      const conflict = this.conflictsById.get(entry.conflictId);
      if (!conflict) return;
      if (entry.before && !supportsResolution(conflict, entry.before)) return;
      if (entry.after && !supportsResolution(conflict, entry.after)) return;
      const groupId = entry.groupId ?? `legacy:${index}`;
      let change = grouped.get(groupId);
      if (!change) {
        change = { groupId, ids: [], before: [], after: [] };
        grouped.set(groupId, change);
        orderedGroups.push(change);
        appliedEntryCounts.push(0);
      }
      change.ids.push(entry.conflictId);
      change.before.push(copyResolution(entry.before ?? undefined));
      change.after.push(copyResolution(entry.after ?? undefined));
      appliedEntryCounts[orderedGroups.indexOf(change)] += 1;
    });
    this.history = orderedGroups;
    let cumulativeEntries = 0;
    this.historyIndex = 0;
    for (let index = 0; index < this.history.length; index += 1) {
      cumulativeEntries += appliedEntryCounts[index];
      if (cumulativeEntries <= persistedHistoryIndex) this.historyIndex = index + 1;
    }
  }

  get canUndo(): boolean { return this.historyIndex > 0; }
  get canRedo(): boolean { return this.historyIndex < this.history.length; }
  get unresolvedCount(): number { return this.conflictsById.size - this.values.size; }

  get(id: string): MergeResolution | undefined {
    return copyResolution(this.values.get(id));
  }

  toRecord(): Record<string, MergeResolution> {
    return Object.fromEntries(
      [...this.values].map(([id, resolution]) => [id, copyResolution(resolution)!]),
    );
  }

  toPersistedHistory(): { history: MergeDraftHistoryEntry[]; historyIndex: number } {
    const history: MergeDraftHistoryEntry[] = [];
    let historyIndex = 0;
    this.history.forEach((change, changeIndex) => {
      change.ids.forEach((id, index) => {
        history.push({
          groupId: change.groupId,
          conflictId: id,
          before: copyResolution(change.before[index]) ?? null,
          after: copyResolution(change.after[index]) ?? null,
        });
        if (changeIndex < this.historyIndex) historyIndex += 1;
      });
    });
    return { history, historyIndex };
  }

  resolve(id: string, resolution: MergeResolution): boolean {
    return this.resolveMany([id], resolution) > 0;
  }

  resolveMany(ids: readonly string[], resolution: MergeResolution): number {
    const eligible = ids.filter((id) => {
      const conflict = this.conflictsById.get(id);
      return conflict && supportsResolution(conflict, resolution);
    });
    if (eligible.length === 0) return 0;
    const before = eligible.map((id) => copyResolution(this.values.get(id)));
    const after = eligible.map(() => copyResolution(resolution));
    if (eligible.every((id, index) => JSON.stringify(before[index]) === JSON.stringify(after[index]))) {
      return 0;
    }
    const change = { groupId: nextGroupId(), ids: eligible, before, after };
    this.apply(change, 'forward');
    this.history.splice(this.historyIndex);
    this.history.push(change);
    this.historyIndex = this.history.length;
    return eligible.length;
  }

  clear(id: string): boolean {
    if (!this.values.has(id)) return false;
    const before = [copyResolution(this.values.get(id))];
    const change = { groupId: nextGroupId(), ids: [id], before, after: [undefined] };
    this.apply(change, 'forward');
    this.history.splice(this.historyIndex);
    this.history.push(change);
    this.historyIndex = this.history.length;
    return true;
  }

  undo(): ResolutionChange | null {
    if (!this.canUndo) return null;
    const change = this.history[--this.historyIndex];
    this.apply(change, 'backward');
    return change;
  }

  redo(): ResolutionChange | null {
    if (!this.canRedo) return null;
    const change = this.history[this.historyIndex++];
    this.apply(change, 'forward');
    return change;
  }

  private apply(change: ResolutionChange, direction: 'forward' | 'backward'): void {
    const values = direction === 'forward' ? change.after : change.before;
    change.ids.forEach((id, index) => {
      const value = values[index];
      if (value === undefined) this.values.delete(id);
      else this.values.set(id, copyResolution(value)!);
    });
  }
}
