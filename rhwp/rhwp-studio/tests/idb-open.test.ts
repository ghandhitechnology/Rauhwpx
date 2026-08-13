import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDB_OPEN_TIMEOUT_MS,
  openIndexedDatabase,
  withTimeout,
} from '../src/core/idb-open.ts';

test('withTimeout은 제한 시간 안에 끝나지 않으면 거부한다', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 20, 'probe'),
    /probe timed out after 20ms/,
  );
});

test('withTimeout은 원본 Promise 결과를 그대로 전달한다', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, 'probe'), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 50, 'probe'), /boom/);
});

test('openIndexedDatabase는 open이 응답하지 않으면 null로 폴백한다', async () => {
  const hanging = {
    open() {
      return {
        set onerror(_fn: unknown) {},
        set onsuccess(_fn: unknown) {},
        set onupgradeneeded(_fn: unknown) {},
        set onblocked(_fn: unknown) {},
      };
    },
  } as unknown as IDBFactory;

  const started = Date.now();
  const db = await openIndexedDatabase('probe', 1, () => {}, {
    indexedDB: hanging,
    timeoutMs: 30,
  });
  assert.equal(db, null);
  assert.ok(Date.now() - started < 500, '타임아웃 폴백이 호출부를 붙잡으면 안 된다');
});

test('IndexedDB 제한 시간은 파일 열기 경로를 막지 않을 만큼 짧다', () => {
  assert.ok(IDB_OPEN_TIMEOUT_MS <= 2_000);
});
