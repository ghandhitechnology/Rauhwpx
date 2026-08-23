import assert from 'node:assert/strict';
import test from 'node:test';

import { MergeCompletionCoordinator } from '../src/merge/completion-coordinator.ts';
import type {
  MergeApplicationRequest,
  MergeAppliedReceipt,
} from '../src/merge/domain.ts';

const application = {
  draft: { id: 'draft' },
  title: 'Merge source into main',
  mode: 'diverged',
  resolutions: {},
  materialized: { tree: {}, validation: { valid: true, errors: [] } },
} as unknown as MergeApplicationRequest;

test('failed source finalization retains receipt and retry never reapplies', async () => {
  const coordinator = new MergeCompletionCoordinator();
  const receipt = {} as MergeAppliedReceipt;
  let applyCount = 0;
  let finalizeCount = 0;
  const apply = async () => { applyCount += 1; return receipt; };
  await coordinator.ensureApplied(application, apply);
  await assert.rejects(
    coordinator.finalize('delete', async () => { finalizeCount += 1; throw new Error('delete failed'); }),
    /delete failed/,
  );
  assert.equal(coordinator.hasPending, true);
  await coordinator.ensureApplied(application, apply);
  assert.equal(applyCount, 1);

  const completed = await coordinator.finalize('keep', async (received, disposition) => {
    finalizeCount += 1;
    assert.equal(received, receipt);
    assert.equal(disposition, 'keep');
  });
  assert.equal(finalizeCount, 2);
  assert.equal(completed.sourceDisposition, 'keep');
  assert.equal(coordinator.hasPending, false);
});
