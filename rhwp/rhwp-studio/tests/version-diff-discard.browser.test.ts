import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer, { type Browser } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { browserExecutable, browserLaunchArgs, requireWasmPackage } from './browser-support.ts';

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const rhwpRoot = resolve(studioRoot, '..');
const wasmPackageRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? resolve(rhwpRoot, 'pkg');
requireWasmPackage(wasmPackageRoot);
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';

test.before(async () => {
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-version-diff-discard-test'),
    logLevel: 'silent',
    resolve: {
      alias: {
        '@': resolve(studioRoot, 'src'),
        '@wasm/rhwp.js': resolve(wasmPackageRoot, 'rhwp.js'),
        '@wasm': wasmPackageRoot,
      },
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      fs: { allow: [studioRoot, wasmPackageRoot, resolve(rhwpRoot, 'samples')] },
    },
    plugins: [{
      name: 'version-diff-discard-sample',
      configureServer(vite) {
        vite.middlewares.use('/samples', (request, response, next) => {
          const relative = decodeURIComponent(request.url?.split('?')[0] ?? '').replace(/^\/+/, '');
          if (!relative || relative.includes('..')) return next();
          void readFile(resolve(rhwpRoot, 'samples', relative)).then((bytes) => {
            response.setHeader('Content-Type', 'application/octet-stream');
            response.end(bytes);
          }, () => {
            response.statusCode = 404;
            response.end();
          });
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

test('root and child commits yield additions and first-parent changes; working tree uses live content', { timeout: 30_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }, snapshots] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'),
        import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'),
        import('/src/versioning/snapshot.ts'),
      ]);
      const response = await fetch('/samples/shift-return.hwp');
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), 'shift-return.hwp');
      const eventBus = new EventBus();
      const dirty = new DocumentDirtyState(eventBus);
      const store = new versions.VersionGraphStore({ indexedDB: null });
      let currentDocumentId = 'version-diff-test';
      const agentBridge = {
        pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
        onEvent: () => () => undefined,
        isTurnRunning: () => false,
        getEditingLease: () => ({ active: false, agent: 'codex' as const }),
        requestCheckpointTitle: async () => null,
      };
      const controller = new DocumentVersionController({
        store, wasm, eventBus, documentState: dirty,
        getInputHandler: () => null,
        getDocumentId: () => currentDocumentId,
        agentBridge,
      });
      try {
        await controller.enable();
        const root = controller.getState().commits[0]!;
        const rootDiff = await controller.diffCommit(root.id);
        const originalGetCompareSnapshot = store.getCompareSnapshot.bind(store);
        store.getCompareSnapshot = async () => null;
        let missingSnapshotRejected = false;
        try { await controller.diffCommit(root.id); } catch { missingSnapshotRejected = true; }
        store.getCompareSnapshot = originalGetCompareSnapshot;
        wasm.insertText(0, 0, 0, 'CHANGED ');
        eventBus.emit('document-mutated');
        const workingDiff = await controller.diffWorkingTree();
        await controller.checkpoint('changed');
        const child = controller.getState().commits[0]!;
        const childDiff = await controller.diffCommit(child.id);
        wasm.insertText(0, 0, 0, 'OTHER ');
        const other = snapshots.captureVersionSnapshot(wasm);
        const repository = (await store.findRepositoryByDocumentId(versions.documentId('version-diff-test')))!;
        const main = (await store.getBranch(repository.id, versions.branchName('main')))!;
        const source = await store.createBranch({
          repositoryId: repository.id, name: versions.branchName('source'),
          target: versions.commitId(root.id), expectedRepositoryRevision: repository.revision,
        });
        const payload = {
          bytes: other.bytes, compareSnapshot: other.compareSnapshot,
          contentFingerprint: other.fingerprint, title: 'other', titleOrigin: 'manual' as const,
          titleRevision: 0, author: { kind: 'user' as const, label: 'Tester' },
        };
        const sourceCommit = await store.createCheckpoint({
          ...payload, repositoryId: repository.id, branch: source.branch.name,
          expectedRepositoryRevision: source.repository.revision,
          expectedBranchRevision: source.branch.revision, reason: 'manual',
        });
        const merged = await store.createCheckpoint({
          ...payload, repositoryId: repository.id, branch: main.name,
          expectedRepositoryRevision: sourceCommit.repository.revision,
          expectedBranchRevision: main.revision,
          parents: [versions.commitId(child.id), sourceCommit.commit.id], reason: 'merge',
        });
        const mergeDiff = await controller.diffCommit(merged.commit.id);
        const externalHeadDiff = await controller.diffWorkingTree();
        const originalGetCompareSnapshotAgain = store.getCompareSnapshot.bind(store);
        store.getCompareSnapshot = async (id) => {
          const stored = await originalGetCompareSnapshotAgain(id);
          wasm.insertText(0, 0, 0, 'RACE ');
          eventBus.emit('document-mutated');
          return stored;
        };
        let staleEditorRejected = false;
        try { await controller.diffWorkingTree(); } catch { staleEditorRejected = true; }
        store.getCompareSnapshot = originalGetCompareSnapshotAgain;
        const countBeforeEdit = (await store.listCommits(repository.id)).length;
        const originalFindForEdit = store.findRepositoryByDocumentId.bind(store);
        let releaseEditLookup = () => undefined;
        let enteredEditLookup = () => undefined;
        const heldEditLookup = new Promise<void>((resolve) => { releaseEditLookup = resolve; });
        const editLookupEntered = new Promise<void>((resolve) => { enteredEditLookup = resolve; });
        let holdEditLookup = true;
        store.findRepositoryByDocumentId = async (id) => {
          if (holdEditLookup) {
            holdEditLookup = false;
            enteredEditLookup();
            await heldEditLookup;
          }
          return originalFindForEdit(id);
        };
        const refreshBeforeEdit = controller.refresh();
        await editLookupEntered;
        const checkpointBeforeEdit = controller.checkpoint('queued edit').then(() => false, () => true);
        wasm.insertText(0, 0, 0, 'LATE ');
        eventBus.emit('document-mutated');
        releaseEditLookup();
        await refreshBeforeEdit;
        const queuedEditRejected = await checkpointBeforeEdit;
        store.findRepositoryByDocumentId = originalFindForEdit;
        const queuedEditNoCommit = (await store.listCommits(repository.id)).length === countBeforeEdit;
        const countBeforeSwitch = (await store.listCommits(repository.id)).length;
        const originalFindRepository = store.findRepositoryByDocumentId.bind(store);
        let releaseLookup = () => undefined;
        let enteredLookup = () => undefined;
        const heldLookup = new Promise<void>((resolve) => { releaseLookup = resolve; });
        const lookupEntered = new Promise<void>((resolve) => { enteredLookup = resolve; });
        let holdNextLookup = true;
        store.findRepositoryByDocumentId = async (id) => {
          if (holdNextLookup) {
            holdNextLookup = false;
            enteredLookup();
            await heldLookup;
          }
          return originalFindRepository(id);
        };
        const pendingRefresh = controller.refresh();
        await lookupEntered;
        const pendingCheckpoint = controller.checkpoint('queued').then(() => false, () => true);
        const pendingCompare = controller.compare(root.id).then(() => false, () => true);
        currentDocumentId = 'other-document';
        releaseLookup();
        await pendingRefresh;
        const queuedCheckpointRejected = await pendingCheckpoint;
        const queuedCompareRejected = await pendingCompare;
        store.findRepositoryByDocumentId = originalFindRepository;
        return {
          rootHasAdditions: rootDiff.some((item) => item.severity === 'added'),
          workingHasChange: workingDiff.length > 0,
          childHasChange: childDiff.length > 0,
          childParent: child.parentIds[0],
          rootId: root.id,
          mergeUsesFirstParent: mergeDiff.length > 0
            && merged.commit.compareSnapshotId === sourceCommit.commit.compareSnapshotId,
          externalHeadDiffIsEmpty: externalHeadDiff.length === 0,
          staleEditorRejected,
          queuedEditRejected, queuedEditNoCommit,
          queuedCheckpointRejected, queuedCompareRejected,
          noQueuedCommit: (await store.listCommits(repository.id)).length === countBeforeSwitch,
          noStaleCompareWindow: !document.querySelector('.compare-inspector-window'),
          missingSnapshotRejected,
        };
      } finally {
        controller.dispose();
        await store.close();
        wasm.releaseDocument();
      }
    });
    assert.equal(result.rootHasAdditions, true);
    assert.equal(result.workingHasChange, true);
    assert.equal(result.childHasChange, true);
    assert.equal(result.childParent, result.rootId);
    assert.equal(result.mergeUsesFirstParent, true);
    assert.equal(result.externalHeadDiffIsEmpty, true);
    assert.equal(result.staleEditorRejected, true);
    assert.equal(result.queuedEditRejected, true);
    assert.equal(result.queuedEditNoCommit, true);
    assert.equal(result.queuedCheckpointRejected, true);
    assert.equal(result.queuedCompareRejected, true);
    assert.equal(result.noQueuedCommit, true);
    assert.equal(result.noStaleCompareWindow, true);
    assert.equal(result.missingSnapshotRejected, true);
  } finally {
    await page.close();
  }
});

test('discard restores HEAD, rejects stale storage, and rolls back a failed state update', { timeout: 30_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }, snapshots] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'),
        import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'),
        import('/src/versioning/snapshot.ts'),
      ]);
      const response = await fetch('/samples/shift-return.hwp');
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), 'shift-return.hwp');
      const eventBus = new EventBus();
      const dirty = new DocumentDirtyState(eventBus);
      const store = new versions.VersionGraphStore({ indexedDB: null });
      const undo: Uint8Array[] = [];
      let replacements = 0;
      let failNextReplace = false;
      let failRefreshAfterNextReplacement = false;
      let rejectNextRefresh = false;
      const inputHandler = {
        prepareSnapshotCapacity: () => undefined,
        replaceContentFromBytes: (bytes: Uint8Array) => {
          if (failNextReplace) {
            failNextReplace = false;
            throw new Error('replacement failed before applying');
          }
          undo.push(snapshots.captureVersionSnapshot(wasm).bytes);
          wasm.replaceContentFromBytes(bytes);
          replacements += 1;
          if (failRefreshAfterNextReplacement) {
            failRefreshAfterNextReplacement = false;
            rejectNextRefresh = true;
          }
        },
        performUndo: () => {
          const bytes = undo.pop();
          if (bytes) wasm.replaceContentFromBytes(bytes);
        },
      };
      let leaseActive = false;
      let currentDocumentId = 'version-discard-test';
      const agentBridge = {
        pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
        onEvent: () => () => undefined,
        isTurnRunning: () => false,
        getEditingLease: () => ({ active: leaseActive, agent: 'codex' as const }),
        requestCheckpointTitle: async () => null,
      };
      const controller = new DocumentVersionController({
        store, wasm, eventBus, documentState: dirty,
        getInputHandler: () => inputHandler,
        getDocumentId: () => currentDocumentId,
        agentBridge,
      });
      const text = () => snapshots.captureVersionSnapshot(wasm).compareSnapshot.paragraphs[0]?.text ?? '';
      const edit = (value: string) => {
        wasm.insertText(0, 0, 0, value);
        dirty.markDirty('test');
        eventBus.emit('document-mutated');
      };
      try {
        await controller.enable();
        const headText = text();
        const root = controller.getState().commits[0]!;
        edit('one ');
        await controller.discardUncommitted();
        const restored = text() === headText && !controller.getState().dirty
          && controller.getState().commits[0]?.id === root.id;

        edit('two ');
        leaseActive = true;
        let leaseRejected = false;
        try { await controller.discardUncommitted(); } catch { leaseRejected = true; }
        leaseActive = false;
        const leasePreserved = text().startsWith('two ');

        failNextReplace = true;
        let parseRejected = false;
        try { await controller.discardUncommitted(); } catch { parseRejected = true; }
        const parsePreserved = text().startsWith('two ') && dirty.isDirty();

        const originalGetBlob = store.getBlob.bind(store);
        store.getBlob = async () => null;
        let missingBlobRejected = false;
        try { await controller.discardUncommitted(); } catch { missingBlobRejected = true; }
        store.getBlob = originalGetBlob;
        const missingBlobPreserved = text().startsWith('two ');

        const repository = (await store.findRepositoryByDocumentId(versions.documentId('version-discard-test')))!;
        store.getBlob = async (id) => {
          const blob = await originalGetBlob(id);
          await store.createBranch({
            repositoryId: repository.id,
            name: versions.branchName('concurrent'), target: versions.commitId(root.id),
            expectedRepositoryRevision: repository.revision,
          });
          return blob;
        };
        let staleRejected = false;
        try { await controller.discardUncommitted(); } catch { staleRejected = true; }
        store.getBlob = originalGetBlob;
        const stalePreserved = text().startsWith('two ');
        await controller.refresh();

        let removeThrow = eventBus.on('document-dirty-changed', () => {
          removeThrow();
          throw new Error('dirty state listener failed');
        });
        let rollbackRejected = false;
        try { await controller.discardUncommitted(); } catch { rollbackRejected = true; }
        const rollbackPreserved = text().startsWith('two ') && dirty.isDirty();
        const originalListRefs = store.listRefs.bind(store);
        store.listRefs = async (id) => {
          if (rejectNextRefresh) {
            rejectNextRefresh = false;
            throw new Error('refresh failed after replacement');
          }
          return originalListRefs(id);
        };
        failRefreshAfterNextReplacement = true;
        let refreshRollbackRejected = false;
        try { await controller.discardUncommitted(); } catch { refreshRollbackRejected = true; }
        store.listRefs = originalListRefs;
        const refreshRollbackPreserved = text().startsWith('two ') && dirty.isDirty();
        await controller.discardUncommitted();
        edit('three ');
        let removeContextThrow = eventBus.on('document-context-changed', () => {
          removeContextThrow();
          throw new Error('context listener failed after replacement');
        });
        await controller.discardUncommitted();
        const finalRestored = text() === headText;
        edit('queued ');
        const originalFindForQueuedEdit = store.findRepositoryByDocumentId.bind(store);
        let releaseQueuedEditLookup = () => undefined;
        let enteredQueuedEditLookup = () => undefined;
        const heldQueuedEditLookup = new Promise<void>((resolve) => { releaseQueuedEditLookup = resolve; });
        const queuedEditLookupEntered = new Promise<void>((resolve) => { enteredQueuedEditLookup = resolve; });
        let holdQueuedEditLookup = true;
        store.findRepositoryByDocumentId = async (id) => {
          if (holdQueuedEditLookup) {
            holdQueuedEditLookup = false;
            enteredQueuedEditLookup();
            await heldQueuedEditLookup;
          }
          return originalFindForQueuedEdit(id);
        };
        const refreshBeforeQueuedEdit = controller.refresh();
        await queuedEditLookupEntered;
        const discardBeforeQueuedEdit = controller.discardUncommitted().then(() => false, () => true);
        edit('newer ');
        releaseQueuedEditLookup();
        await refreshBeforeQueuedEdit;
        const queuedEditDiscardRejected = await discardBeforeQueuedEdit;
        store.findRepositoryByDocumentId = originalFindForQueuedEdit;
        const queuedEditPreserved = text().startsWith('newer queued ');
        const originalFindRepository = store.findRepositoryByDocumentId.bind(store);
        let releaseLookup = () => undefined;
        let enteredLookup = () => undefined;
        const heldLookup = new Promise<void>((resolve) => { releaseLookup = resolve; });
        const lookupEntered = new Promise<void>((resolve) => { enteredLookup = resolve; });
        let holdNextLookup = true;
        store.findRepositoryByDocumentId = async (id) => {
          if (holdNextLookup) {
            holdNextLookup = false;
            enteredLookup();
            await heldLookup;
          }
          return originalFindRepository(id);
        };
        const pendingRefresh = controller.refresh();
        await lookupEntered;
        const pendingDiscard = controller.discardUncommitted();
        currentDocumentId = 'other-document';
        releaseLookup();
        await pendingRefresh;
        let queuedSwitchRejected = false;
        try { await pendingDiscard; } catch { queuedSwitchRejected = true; }
        store.findRepositoryByDocumentId = originalFindRepository;
        return {
          restored, leaseRejected, leasePreserved, staleRejected, stalePreserved,
          parseRejected, parsePreserved, missingBlobRejected, missingBlobPreserved,
          rollbackRejected, rollbackPreserved,
          refreshRollbackRejected, refreshRollbackPreserved,
          finalRestored,
          queuedEditDiscardRejected, queuedEditPreserved,
          queuedSwitchRejected,
          queuedSwitchPreserved: text().startsWith('newer queued '),
          replacements,
        };
      } finally {
        controller.dispose();
        await store.close();
        wasm.releaseDocument();
      }
    });
    assert.deepEqual(result, {
      restored: true, leaseRejected: true, leasePreserved: true,
      parseRejected: true, parsePreserved: true,
      missingBlobRejected: true, missingBlobPreserved: true,
      staleRejected: true, stalePreserved: true,
      rollbackRejected: true, rollbackPreserved: true,
      refreshRollbackRejected: true, refreshRollbackPreserved: true,
      finalRestored: true,
      queuedEditDiscardRejected: true, queuedEditPreserved: true,
      queuedSwitchRejected: true, queuedSwitchPreserved: true,
      replacements: 7,
    });
  } finally {
    await page.close();
  }
});

test('working diff captures table cells, long cell text, images, and paragraph formatting', { timeout: 30_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'),
        import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'),
      ]);
      const response = await fetch('/samples/shift-return.hwp');
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), 'shift-return.hwp');
      const eventBus = new EventBus();
      const dirty = new DocumentDirtyState(eventBus);
      const store = new versions.VersionGraphStore({ indexedDB: null });
      const controller = new DocumentVersionController({
        store, wasm, eventBus, documentState: dirty,
        getInputHandler: () => null,
        getDocumentId: () => 'version-diff-edge-test',
        agentBridge: {
          pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
          onEvent: () => () => undefined,
          isTurnRunning: () => false,
          getEditingLease: () => ({ active: false, agent: 'codex' as const }),
          requestCheckpointTitle: async () => null,
        },
      });
      const mutated = () => eventBus.emit('document-mutated');
      try {
        await controller.enable();
        const table = wasm.createTable(0, 0, 0, 2, 2);
        mutated();
        const tableKinds = (await controller.diffWorkingTree()).map((item) => item.kind);
        await controller.checkpoint('table');

        wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, 'CELL');
        mutated();
        const cellKinds = (await controller.diffWorkingTree()).map((item) => item.kind);
        await controller.checkpoint('cell');

        wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 4, 'x'.repeat(300));
        mutated();
        await controller.checkpoint('long baseline');
        wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 250, 'LAST');
        mutated();
        const longDiff = await controller.diffWorkingTree();
        const longKinds = longDiff.map((item) => item.kind);
        const longTextReadable = longDiff.some((item) => item.kind === 'table'
          && item.rightPreview.includes('LAST') && item.rightPreview.length > 180
          && !item.rightPreview.includes('cprev='));
        await controller.checkpoint('long changed');

        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/H3sAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
        const image = wasm.insertPicture(0, 0, 0, '', png, 1000, 1000, 1, 1, 'png');
        mutated();
        const imageKinds = (await controller.diffWorkingTree()).map((item) => item.kind);
        await controller.checkpoint('image');

        const beforeAlignment = wasm.getParaPropertiesAt(0, 0).alignment;
        wasm.applyParaFormat(0, 0, JSON.stringify({ alignment: beforeAlignment === 'center' ? 'right' : 'center' }));
        mutated();
        const afterAlignment = wasm.getParaPropertiesAt(0, 0).alignment;
        const formattingKinds = (await controller.diffWorkingTree()).map((item) => item.kind);
        await controller.checkpoint('paragraph format');

        const beforeBold = wasm.getCharPropertiesAt(0, 0, 0).bold;
        wasm.applyCharFormat(0, 0, 0, 1, JSON.stringify({ bold: !beforeBold }));
        mutated();
        const afterBold = wasm.getCharPropertiesAt(0, 0, 0).bold;
        const charFormattingKinds = (await controller.diffWorkingTree()).map((item) => item.kind);
        await controller.checkpoint('character format');

        const beforePageDef = wasm.getPageDef(0);
        wasm.setPageDef(0, { ...beforePageDef, marginLeft: beforePageDef.marginLeft + 100 });
        mutated();
        const afterPageDef = wasm.getPageDef(0);
        const pageLayoutKinds = (await controller.diffWorkingTree()).map((item) => item.kind);
        return {
          tableOk: table.ok, tableKinds, cellKinds, longKinds, longTextReadable,
          imageOk: image.ok, imageKinds, beforeAlignment, afterAlignment,
          formattingKinds, beforeBold, afterBold, charFormattingKinds,
          beforeMarginLeft: beforePageDef.marginLeft, afterMarginLeft: afterPageDef.marginLeft,
          pageLayoutKinds,
        };
      } finally {
        controller.dispose();
        await store.close();
        wasm.releaseDocument();
      }
    });
    assert.equal(result.tableOk, true);
    assert.ok(result.tableKinds.includes('table'));
    assert.ok(result.cellKinds.includes('table'));
    assert.ok(result.longKinds.includes('table'));
    assert.equal(result.longTextReadable, true);
    assert.equal(result.imageOk, true);
    assert.ok(result.imageKinds.includes('image'));
    assert.notEqual(result.beforeAlignment, result.afterAlignment);
    assert.ok(result.formattingKinds.includes('paragraphMeta'), JSON.stringify(result));
    assert.notEqual(result.beforeBold, result.afterBold);
    assert.ok(result.charFormattingKinds.includes('paragraphMeta'), JSON.stringify(result));
    assert.notEqual(result.beforeMarginLeft, result.afterMarginLeft);
    assert.ok(result.pageLayoutKinds.includes('paragraphMeta'), JSON.stringify(result));
  } finally {
    await page.close();
  }
});
