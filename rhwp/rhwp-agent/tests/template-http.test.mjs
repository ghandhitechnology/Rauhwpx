import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTemplateHttpHandler } from '../template-http.mjs';
import { TemplateStore } from '../template-store.mjs';

const HWP = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.from('http-template'),
]);
const HWPX = Buffer.concat([Buffer.from('PK'), Buffer.from('replacement-template')]);

async function fixture(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-template-http-'));
  const store = await new TemplateStore({ rootDir }).init();
  const changes = [];
  const handler = createTemplateHttpHandler({ store, token: 'test-token', onChanged: (change) => changes.push(change) });
  const server = http.createServer((req, res) => {
    void handler(req, res, new URL(req.url, 'http://127.0.0.1')).then((handled) => {
      if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const request = (pathname, init = {}) => fetch(`${base}${pathname}`, {
    ...init,
    headers: { Authorization: 'Bearer test-token', Origin: 'http://127.0.0.1:5173', ...init.headers },
  });
  return { base, request, changes };
}

function uploadHeaders(name, fileName, format, pageCount = 1, sectionCount = 1) {
  return {
    'X-Template-Name': encodeURIComponent(name),
    'X-File-Name': encodeURIComponent(fileName),
    'X-Template-Format': format,
    'X-Template-Page-Count': String(pageCount),
    'X-Template-Section-Count': String(sectionCount),
  };
}

test('template HTTP catalog supports authenticated CRUD and revisioned content', async (t) => {
  const { base, request, changes } = await fixture(t);
  const unauthorized = await fetch((await request('/templates')).url);
  assert.equal(unauthorized.status, 401);
  const packagedApp = await fetch(`${base}/templates`, {
    headers: { Authorization: 'Bearer test-token', Origin: 'rauhwpx://app' },
  });
  assert.equal(packagedApp.status, 200);

  const addedResponse = await request('/templates', {
    method: 'POST', headers: uploadHeaders('보고서 양식', 'report.hwp', 'hwp', 2, 1), body: HWP,
  });
  assert.equal(addedResponse.status, 201);
  const added = (await addedResponse.json()).template;
  assert.equal(added.name, '보고서 양식');

  const listed = await (await request('/templates')).json();
  assert.equal(listed.templates[0].id, added.id);

  const renamed = await request(`/templates/${added.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '월간 보고서' }),
  });
  assert.equal((await renamed.json()).template.name, '월간 보고서');

  const replaced = await request(`/templates/${added.id}`, {
    method: 'PUT', headers: uploadHeaders('월간 보고서', 'report.hwpx', 'hwpx', 3, 2), body: HWPX,
  });
  assert.equal((await replaced.json()).template.revision, 2);

  const content = await request(`/templates/${added.id}/content`);
  assert.equal(content.headers.get('x-template-revision'), '2');
  assert.equal(content.headers.get('access-control-expose-headers'), 'X-Template-Revision');
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), HWPX);

  const deleted = await request(`/templates/${added.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(changes.map((change) => change.type), ['added', 'renamed', 'replaced', 'deleted']);
});
