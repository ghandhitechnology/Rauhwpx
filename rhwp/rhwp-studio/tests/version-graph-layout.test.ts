import assert from 'node:assert/strict';
import test from 'node:test';

import { layoutCommitGraph } from '../src/versioning/graph-layout.ts';
import { commitId } from '../src/versioning/types.ts';

test('linear history stays in one deterministic lane', () => {
  const rows = layoutCommitGraph([
    { id: commitId('c3'), ordinal: 3, parents: [commitId('c2')] },
    { id: commitId('c1'), ordinal: 1, parents: [] },
    { id: commitId('c2'), ordinal: 2, parents: [commitId('c1')] },
  ]);

  assert.deepEqual(rows.map((row) => [row.commitId, row.lane, row.laneCount]), [
    ['c3', 0, 1],
    ['c2', 0, 1],
    ['c1', 0, 1],
  ]);
  assert.deepEqual(rows.map((row) => row.startsLane), [true, false, false]);
});

test('merge parents receive stable lanes regardless of input order', () => {
  const commits = [
    { id: commitId('merge'), ordinal: 4, parents: [commitId('main'), commitId('branch')] } as const,
    { id: commitId('branch'), ordinal: 3, parents: [commitId('root')] } as const,
    { id: commitId('main'), ordinal: 2, parents: [commitId('root')] } as const,
    { id: commitId('root'), ordinal: 1, parents: [] } as const,
  ];

  const first = layoutCommitGraph(commits);
  const second = layoutCommitGraph([...commits].reverse());

  assert.deepEqual(first, second);
  assert.deepEqual(first[0]?.edges.map((edge) => edge.toLane), [0, 1]);
  assert.equal(first.find((row) => row.commitId === 'branch')?.lane, 1);
  assert.deepEqual(first.find((row) => row.commitId === 'branch')?.lanesBefore, ['main', 'branch']);
  assert.deepEqual(first.find((row) => row.commitId === 'branch')?.lanesAfter, ['main', 'root']);
  assert.equal(first.find((row) => row.commitId === 'branch')?.startsLane, false);
  assert.equal(first.at(-1)?.laneCount, 1);
});

test('paged layout continues from the prior page lane frontier', () => {
  const commits = [
    { id: commitId('merge'), ordinal: 4, parents: [commitId('main'), commitId('branch')] } as const,
    { id: commitId('branch'), ordinal: 3, parents: [commitId('root')] } as const,
    { id: commitId('main'), ordinal: 2, parents: [commitId('root')] } as const,
    { id: commitId('root'), ordinal: 1, parents: [] } as const,
  ];
  const complete = layoutCommitGraph(commits);
  const firstPage = layoutCommitGraph(commits.slice(0, 2));
  const secondPage = layoutCommitGraph(commits.slice(2), firstPage.at(-1)?.lanesAfter);

  assert.deepEqual([...firstPage, ...secondPage], complete);
});
