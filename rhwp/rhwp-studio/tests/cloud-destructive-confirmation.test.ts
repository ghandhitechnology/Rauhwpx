import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloudServerDestructiveConfirmationCopy,
  createCloudServerDestructiveActionGate,
} from '../src/ui/agent-sidebar/cloud-destructive-confirmation.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const trigger = {} as HTMLElement;

test('destructive Cloud server copy names every account-wide consequence', () => {
  const remove = cloudServerDestructiveConfirmationCopy('delete');
  const recreate = cloudServerDestructiveConfirmationCopy('recreate');

  assert.equal(remove.confirmLabel, '모든 Cloud 작업을 끝내고 서버 삭제');
  assert.match(remove.serverImpact, /저장된 작업 데이터가 삭제/);
  assert.equal(recreate.confirmLabel, '모든 Cloud 작업을 끝내고 서버 다시 만들기');
  assert.match(recreate.serverImpact, /삭제된 뒤 새 서버/);
});

test('Cancel is fail-closed and never starts the destructive mutation', async () => {
  const decision = deferred<boolean>();
  let runs = 0;
  const gate = createCloudServerDestructiveActionGate({
    present: () => ({ result: decision.promise, dismiss() {} }),
  });

  const result = gate.request({
    action: 'delete',
    trigger,
    isCurrent: () => true,
    run: () => { runs += 1; },
  });
  decision.resolve(false);

  assert.equal(await result, 'cancelled');
  assert.equal(runs, 0);
});

test('double requests and requests during the mutation stay single-flight', async () => {
  const decision = deferred<boolean>();
  const mutation = deferred<void>();
  let presentations = 0;
  let runs = 0;
  const gate = createCloudServerDestructiveActionGate({
    present: () => {
      presentations += 1;
      return { result: decision.promise, dismiss() {} };
    },
  });
  const request = {
    action: 'delete' as const,
    trigger,
    isCurrent: () => true,
    run: async () => {
      runs += 1;
      await mutation.promise;
    },
  };

  const first = gate.request(request);
  assert.equal(await gate.request(request), 'ignored');
  decision.resolve(true);
  await Promise.resolve();
  assert.equal(runs, 1);
  assert.equal(await gate.request(request), 'ignored');
  mutation.resolve();

  assert.equal(await first, 'completed');
  assert.equal(presentations, 1);
  assert.equal(runs, 1);
});

test('an approval becomes stale when the displayed server state changes', async () => {
  const decision = deferred<boolean>();
  let current = true;
  let staleNotices = 0;
  let runs = 0;
  const gate = createCloudServerDestructiveActionGate({
    present: () => ({ result: decision.promise, dismiss() {} }),
  });

  const result = gate.request({
    action: 'recreate',
    trigger,
    isCurrent: () => current,
    run: () => { runs += 1; },
    onStale: () => { staleNotices += 1; },
  });
  current = false;
  decision.resolve(true);

  assert.equal(await result, 'stale');
  assert.equal(staleNotices, 1);
  assert.equal(runs, 0);
});

test('invalidating an open confirmation dismisses it without mutating', async () => {
  const decision = deferred<boolean>();
  let dismissals = 0;
  let runs = 0;
  const gate = createCloudServerDestructiveActionGate({
    present: () => ({
      result: decision.promise,
      dismiss() {
        dismissals += 1;
        decision.resolve(false);
      },
    }),
  });

  const result = gate.request({
    action: 'delete',
    trigger,
    isCurrent: () => true,
    run: () => { runs += 1; },
  });
  gate.invalidate();

  assert.equal(await result, 'stale');
  assert.equal(dismissals, 1);
  assert.equal(runs, 0);
});
