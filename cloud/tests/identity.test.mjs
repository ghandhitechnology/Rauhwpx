import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadOrCreateServerIdentity } from '../src/identity.mjs';

test('server identity creates the private key exclusively and derives the public key', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = loadOrCreateServerIdentity(root);
  const second = loadOrCreateServerIdentity(root);
  assert.equal(first.privateKey, second.privateKey);
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(first.serverPublicKey, second.serverPublicKey);

  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-identity-existing-'));
  t.after(() => fs.rm(otherRoot, { recursive: true, force: true }));
  const pair = generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  await fs.writeFile(path.join(otherRoot, 'server-ed25519-private.pem'), privatePem, { mode: 0o600 });
  await fs.writeFile(path.join(otherRoot, 'server-ed25519-public.pem'), 'stale-public-key\n', { mode: 0o644 });
  const recovered = loadOrCreateServerIdentity(otherRoot);
  assert.equal(recovered.privateKey, privatePem);
  assert.notEqual(recovered.publicKey, 'stale-public-key\n');
  assert.match(recovered.publicKey, /BEGIN PUBLIC KEY/);
});
