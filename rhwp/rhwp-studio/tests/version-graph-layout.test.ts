import assert from 'node:assert/strict';
import test from 'node:test';

import { layoutCommitGraph, orderBranchHeadFrontier } from '../src/versioning/graph-layout.ts';
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
  assert.equal(secondPage[0]?.startsLane, false);
});

test('branch heads seed default, active, then sorted unique lanes', () => {
  const branches = [
    { name: 'notes', target: commitId('notes-head') },
    { name: 'main', target: commitId('main-head') },
    { name: 'alias', target: commitId('shared-head') },
    { name: 'docs', target: commitId('docs-head') },
    { name: 'hotfix', target: commitId('shared-head') },
  ];

  assert.deepEqual(
    orderBranchHeadFrontier(branches, 'main', 'docs'),
    ['main-head', 'docs-head', 'shared-head', 'notes-head'],
  );
  assert.deepEqual(
    orderBranchHeadFrontier([...branches].reverse(), 'main', 'docs'),
    ['main-head', 'docs-head', 'shared-head', 'notes-head'],
  );
});

test('preferred head tips start locally while paging lanes continue from above', () => {
  const rows = layoutCommitGraph([
    { id: commitId('feature-head'), ordinal: 3, parents: [commitId('root')] },
    { id: commitId('paged-head'), ordinal: 2, parents: [commitId('root')] },
    { id: commitId('root'), ordinal: 1, parents: [] },
  ], [commitId('paged-head')], [commitId('feature-head')]);

  const preferred = rows.find((row) => row.commitId === 'feature-head')!;
  const paged = rows.find((row) => row.commitId === 'paged-head')!;
  assert.equal(preferred.lane, 1);
  assert.equal(preferred.startsLane, true);
  assert.deepEqual(preferred.activeLanesBefore, ['paged-head']);
  assert.equal(paged.lane, 0);
  assert.equal(paged.startsLane, false);
  assert.ok(paged.activeLanesBefore.includes('paged-head'));
});

test('four diverged refs keep stable fork lanes without rails above their tips', () => {
  const commits = [
    { id: commitId('notes-head'), ordinal: 5, parents: [commitId('root')] },
    { id: commitId('hotfix-head'), ordinal: 4, parents: [commitId('root')] },
    { id: commitId('docs-head'), ordinal: 3, parents: [commitId('root')] },
    { id: commitId('main-head'), ordinal: 2, parents: [commitId('root')] },
    { id: commitId('root'), ordinal: 1, parents: [] },
  ];
  const preferredHeads = [
    commitId('main-head'),
    commitId('docs-head'),
    commitId('hotfix-head'),
    commitId('notes-head'),
  ];
  const rows = layoutCommitGraph(commits, [], preferredHeads);
  const shuffled = [commits[2], commits[4], commits[0], commits[3], commits[1]];

  assert.deepEqual(rows, layoutCommitGraph([...commits].reverse(), [], preferredHeads));
  assert.deepEqual(rows, layoutCommitGraph(shuffled, [], preferredHeads));
  assert.deepEqual(
    preferredHeads.map((id) => rows.find((row) => row.commitId === id)?.lane),
    [0, 1, 2, 3],
  );
  for (const id of preferredHeads) {
    const row = rows.find((candidate) => candidate.commitId === id)!;
    assert.equal(row.startsLane, true);
    assert.equal(row.activeLanesBefore.includes(id), false);
  }
});

test('merge-back keeps the target first parent on the default lane', () => {
  const commits = [
    { id: commitId('merge'), ordinal: 5, parents: [commitId('main-tip'), commitId('topic-tip')] },
    { id: commitId('topic-tip'), ordinal: 4, parents: [commitId('root')] },
    { id: commitId('main-tip'), ordinal: 3, parents: [commitId('root')] },
    { id: commitId('root'), ordinal: 1, parents: [] },
  ];
  const rows = layoutCommitGraph(commits, [], [commitId('merge'), commitId('topic-tip')]);

  assert.equal(rows[0]?.lane, 0);
  assert.equal(rows[0]?.startsLane, true);
  assert.deepEqual(rows[0]?.edges.map((edge) => edge.toLane), [0, 1]);
  assert.equal(rows.find((row) => row.commitId === 'main-tip')?.lane, 0);
});

test('refs sharing one head use one lane and do not invent an edge', () => {
  const frontier = orderBranchHeadFrontier([
    { name: 'main', target: commitId('shared') },
    { name: 'release', target: commitId('shared') },
  ], 'main', 'release');
  const rows = layoutCommitGraph([
    { id: commitId('shared'), ordinal: 2, parents: [commitId('root')] },
    { id: commitId('root'), ordinal: 1, parents: [] },
  ], [], frontier);

  assert.deepEqual(frontier, ['shared']);
  assert.equal(rows[0]?.laneCount, 1);
  assert.equal(rows[0]?.startsLane, true);
  assert.deepEqual(rows[0]?.edges, [{ parentId: 'root', fromLane: 0, toLane: 0 }]);
});
