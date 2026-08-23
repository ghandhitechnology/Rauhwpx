import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

test('browser IndexedDB reuses its connection and reads repository indexes without store scans', { timeout: 30_000 }, async (context) => {
  const executablePath = BROWSER_CANDIDATES.find(existsSync);
  if (!executablePath) {
    context.skip('Chrome or Chromium is unavailable');
    return;
  }

  const root = new URL('../', import.meta.url).pathname;
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await puppeteer.launch({ executablePath, headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const versioning = await import('/src/versioning/index.ts');
      const nativeOpen = indexedDB.open.bind(indexedDB);
      let openCount = 0;
      const factory = new Proxy(indexedDB, {
        get(target, property) {
          if (property === 'open') {
            return (...args: Parameters<IDBFactory['open']>) => {
              openCount += 1;
              return nativeOpen(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const store = new versioning.VersionGraphStore({ indexedDB: factory });
      await store.clearForTests();

      const bytes = (value: number) => new Uint8Array([value, value + 1]);
      const snapshot = (name: string) => ({
        meta: { name, sectionCount: 1, pageCount: 1 },
        paragraphs: [],
        controls: [],
      });
      const payload = (value: number, title: string) => ({
        bytes: bytes(value),
        compareSnapshot: snapshot(title),
        contentFingerprint: versioning.fingerprintBytes(bytes(value)),
        title,
        titleRevision: 0,
        titleOrigin: 'manual' as const,
        author: { kind: 'user' as const, label: 'Browser test' },
      });
      const created = await store.createRepository({
        documentId: versioning.documentId(`browser-${crypto.randomUUID()}`),
        lastSavedFingerprint: payload(1, 'Initial').contentFingerprint,
        initial: payload(1, 'Initial'),
      });
      const checkpoint = await store.createCheckpoint({
        repositoryId: created.repository.id,
        branch: created.branch.name,
        expectedRepositoryRevision: created.repository.revision,
        expectedBranchRevision: created.branch.revision,
        reason: 'manual',
        ...payload(2, 'Second'),
      });

      let staleRejected = false;
      try {
        await store.createCheckpoint({
          repositoryId: created.repository.id,
          branch: created.branch.name,
          expectedRepositoryRevision: created.repository.revision,
          expectedBranchRevision: created.branch.revision,
          reason: 'manual',
          ...payload(3, 'Stale'),
        });
      } catch (error) {
        staleRejected = error instanceof versioning.VersionError && error.code === 'STALE_WORKSPACE';
      }

      const originalGetAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function () {
        throw new Error(`store scan must not be used for ${this.name}`);
      };
      try {
        const firstPage = await store.listCommits(created.repository.id, { limit: 1 });
        const secondPage = await store.listCommits(created.repository.id, {
          beforeOrdinal: firstPage[0]?.ordinal,
          limit: 1,
        });
        const usage = await store.getRepositoryStorageUsage(created.repository.id);
        const found = await store.findRepositoryByDocumentId(created.repository.documentId);
        const refs = await store.listRefs(created.repository.id);
        const shelves = await store.listShelves(created.repository.id);
        return {
          openCount,
          staleRejected,
          ordinals: [firstPage[0]?.ordinal, secondPage[0]?.ordinal],
          usage,
          repository: created.repository.id,
          found: found?.id,
          refCount: refs.length,
          shelfCount: shelves.length,
          head: checkpoint.branch.target,
          commit: checkpoint.commit.id,
        };
      } finally {
        IDBObjectStore.prototype.getAll = originalGetAll;
        await store.close();
      }
    });

    assert.equal(result.openCount, 1);
    assert.equal(result.staleRejected, true);
    assert.deepEqual(result.ordinals, [2, 1]);
    assert.equal(result.usage.commitCount, 2);
    assert.equal(result.usage.blobCount, 2);
    assert.equal(result.usage.compareSnapshotCount, 2);
    assert.equal(result.found, result.repository);
    assert.equal(result.refCount, 1);
    assert.equal(result.shelfCount, 0);
    assert.equal(result.head, result.commit);
  } finally {
    await browser.close();
    await server.close();
  }
});
