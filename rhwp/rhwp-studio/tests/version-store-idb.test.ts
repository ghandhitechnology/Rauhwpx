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
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: process.env.CI || process.env.DEPOT_JOB_URL
        ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        : [],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const versioning = await import('/src/versioning/index.ts');
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(versioning.VERSION_DATABASE_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('deleteDatabase was blocked'));
      });
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(versioning.VERSION_DATABASE_NAME, 1);
        request.onblocked = () => reject(new Error('open was blocked'));
        request.onupgradeneeded = () => {
          const database = request.result;
          const repositories = database.createObjectStore('repositories', { keyPath: 'id' });
          repositories.createIndex('documentId', 'documentId', { unique: true });
          const commits = database.createObjectStore('commits', { keyPath: 'id' });
          commits.createIndex('repositoryId', 'repositoryId');
          commits.createIndex('repositoryOrdinal', ['repositoryId', 'ordinal'], { unique: true });
          const refs = database.createObjectStore('refs', { keyPath: 'key' });
          refs.createIndex('repositoryId', 'repositoryId');
          database.createObjectStore('blobs', { keyPath: 'id' });
          database.createObjectStore('compareSnapshots', { keyPath: 'id' });
          const shelves = database.createObjectStore('shelves', { keyPath: 'id' });
          shelves.createIndex('repositoryId', 'repositoryId');
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction([
            'repositories',
            'commits',
            'refs',
            'blobs',
            'compareSnapshots',
          ], 'readwrite');
          const legacyBytes = new Uint8Array([7, 8, 9]);
          const legacyBlobId = versioning.hashBytes(legacyBytes);
          const legacySnapshot = {
            meta: { name: 'Legacy', sectionCount: 1, pageCount: 1 },
            paragraphs: [],
            controls: [],
          };
          const legacySnapshotId = versioning.hashCompareSnapshot(legacySnapshot);
          transaction.objectStore('repositories').put({
            schemaVersion: 1,
            id: 'legacy-repository',
            documentId: 'legacy-document',
            revision: 1,
            nextOrdinal: 3,
            enabledAt: 1,
            lastSavedFingerprint: versioning.fingerprintBytes(legacyBytes),
          });
          transaction.objectStore('blobs').put({
            id: legacyBlobId,
            byteLength: legacyBytes.byteLength,
            bytes: legacyBytes,
          });
          transaction.objectStore('compareSnapshots').put({
            id: legacySnapshotId,
            byteLength: versioning.serializeCompareSnapshot(legacySnapshot).byteLength,
            snapshot: legacySnapshot,
          });
          transaction.objectStore('commits').put({
            id: 'legacy-root',
            repositoryId: 'legacy-repository',
            parents: [],
            ordinal: 1,
            blobId: legacyBlobId,
            compareSnapshotId: legacySnapshotId,
            contentFingerprint: versioning.fingerprintBytes(legacyBytes),
            title: 'Legacy root',
            titleRevision: 0,
            titleOrigin: 'manual',
            author: { kind: 'user', label: 'Legacy user' },
            reason: 'initial',
            stats: { added: 0, removed: 0, modified: 0 },
            createdAt: 1,
          });
          transaction.objectStore('commits').put({
            id: 'legacy-commit',
            repositoryId: 'legacy-repository',
            parents: ['legacy-root'],
            ordinal: 2,
            blobId: legacyBlobId,
            compareSnapshotId: legacySnapshotId,
            contentFingerprint: versioning.fingerprintBytes(legacyBytes),
            title: 'Legacy initial',
            titleRevision: 0,
            titleOrigin: 'manual',
            author: { kind: 'user', label: 'Legacy user' },
            reason: 'initial',
            stats: { added: 0, removed: 0, modified: 0 },
            createdAt: 1,
          });
          transaction.objectStore('refs').put({
            key: 'legacy-repository\u0000branch\u0000main',
            repositoryId: 'legacy-repository',
            kind: 'branch',
            name: 'main',
            target: 'legacy-commit',
            revision: 1,
          });
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
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
      const migrated = await store.getRepository(versioning.repositoryId('legacy-repository'));
      const migratedDrafts = await store.listMergeDrafts(versioning.repositoryId('legacy-repository'));
      const migratedManifest = await store.ensureMergeManifest(
        versioning.repositoryId('legacy-repository'),
        versioning.commitId('legacy-commit'),
      );
      const migratedCommit = await store.getCommit(versioning.commitId('legacy-commit'));
      const migratedRoot = await store.getCommit(versioning.commitId('legacy-root'));
      const migratedBranch = await store.getBranch(
        versioning.repositoryId('legacy-repository'),
        versioning.branchName('main'),
      );
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
        const blobSizes = await store.getBlobSizes([created.commit.blobId, checkpoint.commit.blobId]);
        return {
          openCount,
          migratedSchemaVersion: migrated?.schemaVersion,
          migratedDefaultBranch: migrated?.defaultBranch,
          migratedDraftCount: migratedDrafts.length,
          migratedManifestCommit: migratedManifest.commitId,
          migratedManifestId: migratedManifest.id,
          migratedCommitManifest: migratedCommit?.mergeManifestId,
          migratedRootManifest: migratedRoot?.mergeManifestId,
          migratedParentManifests: migratedManifest.parentManifestIds,
          migratedBranchGeneration: migratedBranch?.generation,
          staleRejected,
          ordinals: [firstPage[0]?.ordinal, secondPage[0]?.ordinal],
          usage,
          repository: created.repository.id,
          found: found?.id,
          refCount: refs.length,
          shelfCount: shelves.length,
          blobSizes: [blobSizes.get(created.commit.blobId), blobSizes.get(checkpoint.commit.blobId)],
          head: checkpoint.branch.target,
          commit: checkpoint.commit.id,
        };
      } finally {
        IDBObjectStore.prototype.getAll = originalGetAll;
        await store.close();
      }
    });

    assert.equal(result.openCount, 1);
    assert.equal(result.migratedSchemaVersion, 2);
    assert.equal(result.migratedDefaultBranch, 'main');
    assert.equal(result.migratedDraftCount, 0);
    assert.equal(result.migratedManifestCommit, 'legacy-commit');
    assert.equal(result.migratedCommitManifest, result.migratedManifestId);
    assert.deepEqual(result.migratedParentManifests, [result.migratedRootManifest]);
    assert.equal(result.migratedBranchGeneration, 'legacy-v2:legacy-repository:main');
    assert.equal(result.staleRejected, true);
    assert.deepEqual(result.ordinals, [2, 1]);
    assert.equal(result.usage.commitCount, 2);
    assert.equal(result.usage.blobCount, 2);
    assert.equal(result.usage.compareSnapshotCount, 2);
    assert.equal(result.found, result.repository);
    assert.equal(result.refCount, 1);
    assert.equal(result.shelfCount, 0);
    assert.deepEqual(result.blobSizes, [2, 2]);
    assert.equal(result.head, result.commit);
  } finally {
    await browser?.close();
    await server.close();
  }
});
