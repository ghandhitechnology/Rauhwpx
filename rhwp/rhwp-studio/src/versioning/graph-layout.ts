import type { CommitId, VersionCommit } from './types.ts';

export interface CommitGraphEdge {
  parentId: CommitId;
  fromLane: number;
  toLane: number;
}

export interface CommitGraphRow {
  commitId: CommitId;
  lane: number;
  laneCount: number;
  startsLane: boolean;
  lanesBefore: readonly CommitId[];
  lanesAfter: readonly CommitId[];
  edges: readonly CommitGraphEdge[];
}

export type GraphCommit = Pick<VersionCommit, 'id' | 'ordinal' | 'parents'>;

function orderCommits(commits: readonly GraphCommit[]): GraphCommit[] {
  return [...commits].sort((left, right) => (
    right.ordinal - left.ordinal || left.id.localeCompare(right.id)
  ));
}

export function layoutCommitGraph(
  commits: readonly GraphCommit[],
  initialLanes: readonly CommitId[] = [],
): CommitGraphRow[] {
  const lanes: CommitId[] = [...initialLanes];
  const rows: CommitGraphRow[] = [];

  for (const commit of orderCommits(commits)) {
    let lane = lanes.indexOf(commit.id);
    const startsLane = lane < 0;
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(commit.id);
    }

    const lanesBefore = [...lanes];
    const next = lanes.filter((id) => id !== commit.id);
    const parentDestinations = new Map<CommitId, number>();

    commit.parents.forEach((parentId, parentIndex) => {
      const existingLane = next.indexOf(parentId);
      if (existingLane >= 0) {
        parentDestinations.set(parentId, existingLane);
        return;
      }

      const insertionLane = parentIndex === 0
        ? Math.min(lane, next.length)
        : Math.min(lane + parentIndex, next.length);
      next.splice(insertionLane, 0, parentId);

      for (const [id, destination] of parentDestinations) {
        if (destination >= insertionLane) parentDestinations.set(id, destination + 1);
      }
      parentDestinations.set(parentId, insertionLane);
    });

    rows.push({
      commitId: commit.id,
      lane,
      laneCount: Math.max(lanesBefore.length, next.length),
      startsLane,
      lanesBefore,
      lanesAfter: [...next],
      edges: commit.parents.map((parentId) => ({
        parentId,
        fromLane: lane,
        toLane: parentDestinations.get(parentId) ?? next.indexOf(parentId),
      })),
    });

    lanes.splice(0, lanes.length, ...next);
  }

  return rows;
}
