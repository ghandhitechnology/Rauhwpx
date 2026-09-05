import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startStudioServer } from '../document-runtime/studio-harness.mjs';

test('cloud document shell reuses built assets and preserves reference bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-studio-shell-'));
  const html = '<!doctype html><html lang="ko"><head><title>문서</title><script type="module" src="/assets/editor.js"></script></head><body>내용</body></html>';
  await fs.writeFile(path.join(root, 'index.html'), html);
  await fs.writeFile(path.join(root, 'reference.html'), html);
  const { server, origin } = await startStudioServer({
    studioRoot: root, bootstrap: 'test-bootstrap',
    resources: new Map([['document', path.join(root, 'index.html')]]),
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const route of ['/', '/index.html', '/document.html']) {
    const response = await fetch(`${origin}${route}`);
    const served = await response.text();
    assert.match(served, /<head><meta name="google" content="notranslate">/);
    assert.match(served, /<style id="cloud-document-shell">/);
    assert.match(served, /src="\/assets\/editor.js"/);
    assert.match(served, /#editor-area > :not\(#scroll-container\)/);
    assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(served));
    const head = await fetch(`${origin}${route}`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
    assert.equal(await head.text(), '');
  }
  assert.equal(await (await fetch(`${origin}/reference.html`)).text(), html);
  assert.equal(await (await fetch(`${origin}/_runtime/resource/document?bootstrap=test-bootstrap`)).text(), html);
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), html);
});
