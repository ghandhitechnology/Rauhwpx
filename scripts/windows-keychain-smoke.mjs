import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, safeStorage } from 'electron';

import { createSecretVault } from '../desktop/secret-vault.mjs';

let root;
let exitCode = 0;

try {
  await app.whenReady();
  assert.equal(process.platform, 'win32');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx keychain smoke-'));
  const filePath = path.join(root, 'secrets.json');

  const first = createSecretVault({ filePath, safeStorage });
  await Promise.all([
    first.set('rhwp.smoke.first', 'windows-dpapi-secret-one'),
    first.set('rhwp.smoke.second', 'windows-dpapi-secret-two'),
  ]);

  const reopened = createSecretVault({ filePath, safeStorage });
  assert.deepEqual(
    await Promise.all([
      reopened.get('rhwp.smoke.first'),
      reopened.get('rhwp.smoke.second'),
    ]),
    ['windows-dpapi-secret-one', 'windows-dpapi-secret-two'],
  );
  assert.doesNotMatch(await fs.readFile(filePath, 'utf8'), /windows-dpapi-secret/);

  await reopened.delete('rhwp.smoke.first');
  const final = createSecretVault({ filePath, safeStorage });
  assert.equal(await final.get('rhwp.smoke.first'), null);
  assert.equal(await final.get('rhwp.smoke.second'), 'windows-dpapi-secret-two');
  console.log('Windows DPAPI vault smoke test passed.');
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  app.exit(exitCode);
}
