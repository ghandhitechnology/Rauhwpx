import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuthService } from '../src/auth.mjs';
import { openDatabase } from '../src/database.mjs';

test('pairing redemption retries return one durable token receipt after a lost response', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-pairing-retry-'));
  const filename = path.join(root, 'cloud.sqlite3');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let database = openDatabase(filename);
  const firstAuth = new AuthService(database);
  const pairing = firstAuth.createPairingCode();
  const request = {
    code: pairing.code,
    deviceName: 'Reliable desktop',
    requestId: 'pairing-request-12345678',
  };
  const first = firstAuth.redeemPairingCode(request);
  database.close();

  database = openDatabase(filename);
  t.after(() => database.close());
  const restartedAuth = new AuthService(database);
  const retried = restartedAuth.redeemPairingCode(request);

  assert.deepEqual(retried, first, 'the retry recovers the exact credentials issued before response loss');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM token_families').get().count, 1);
  assert.throws(
    () => restartedAuth.redeemPairingCode({ ...request, deviceName: 'Different desktop' }),
    { code: 'PAIRING_REQUEST_CONFLICT' },
  );
});

test('legacy pairing redemption remains one-shot when no request id is supplied', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-pairing-legacy-'));
  const database = openDatabase(path.join(root, 'cloud.sqlite3'));
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const auth = new AuthService(database);
  const pairing = auth.createPairingCode();
  auth.redeemPairingCode({ code: pairing.code, deviceName: 'Legacy desktop' });
  assert.throws(
    () => auth.redeemPairingCode({ code: pairing.code, deviceName: 'Legacy desktop' }),
    { code: 'PAIRING_CODE_INVALID' },
  );
});
