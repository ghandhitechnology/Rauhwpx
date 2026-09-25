import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cloudReferenceRoots } from '../../rhwp/rhwp-agent/cloud-reference-roots.mjs';
import { assertImagePathInsideRoots, imageRootsFromEnv } from '../../rhwp/rhwp-agent/image-path-policy.mjs';

test('cloud image insertion can read attached images without exposing other workspace files', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-image-roots-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const workRoot = path.join(workspace, 'agent-work');
  const input = path.join(workspace, 'input');
  const followUps = path.join(workspace, 'follow-up-attachments');
  const home = path.join(workspace, 'home');
  await Promise.all([workRoot, input, followUps, home].map((directory) => fs.mkdir(directory)));
  const initialImage = path.join(input, '0-reference-photo.png');
  const followUpImage = path.join(followUps, 'message-1', '00-photo.png');
  const secret = path.join(home, 'provider-auth.json');
  await fs.mkdir(path.dirname(followUpImage));
  await Promise.all([
    fs.writeFile(initialImage, 'initial'),
    fs.writeFile(followUpImage, 'follow-up'),
    fs.writeFile(secret, 'secret'),
  ]);
  const roots = cloudReferenceRoots(workRoot, { RAUHWpx_CLOUD_RUNTIME: '1' });
  const imageRoots = imageRootsFromEnv({ RHWP_IMAGE_ROOTS: roots.join(path.delimiter) });
  assert.equal(await assertImagePathInsideRoots(initialImage, imageRoots), await fs.realpath(initialImage));
  assert.equal(await assertImagePathInsideRoots(followUpImage, imageRoots), await fs.realpath(followUpImage));
  await assert.rejects(assertImagePathInsideRoots(secret, imageRoots), { code: 'INVALID_ARGS' });
  await fs.rm(input, { recursive: true });
  await fs.symlink(home, input, 'dir');
  await assert.rejects(assertImagePathInsideRoots(secret, imageRoots), { code: 'INVALID_ARGS' });
  assert.deepEqual(cloudReferenceRoots(workRoot, {}), []);
  assert.throws(() => cloudReferenceRoots(workspace, { RAUHWpx_CLOUD_RUNTIME: '1' }), /agent-work/);
});
