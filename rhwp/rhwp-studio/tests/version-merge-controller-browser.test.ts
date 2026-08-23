import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

import puppeteer, { type Browser } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';

const BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

const executablePath = BROWSER_CANDIDATES.find(existsSync);
const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const rhwpRoot = resolve(studioRoot, '..');
const wasmPackageRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? resolve(rhwpRoot, 'pkg');
const wasmPackageAvailable = existsSync(resolve(wasmPackageRoot, 'rhwp.js'))
  && existsSync(resolve(wasmPackageRoot, 'rhwp_bg.wasm'));
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';

test.before(async () => {
  if (!executablePath) return;
  assert.ok(
    wasmPackageAvailable,
    'Real WASM browser tests require generated rhwp/pkg/rhwp.js and rhwp/pkg/rhwp_bg.wasm; build the WASM package before npm test',
  );
  server = await createServer({
    root: studioRoot,
    configFile: false,
    // Keep Vite's dependency optimizer isolated from other browser test files.
    // Parallel servers otherwise invalidate the shared node_modules/.vite cache
    // while this page is still dynamically importing the controller graph.
    cacheDir: resolve(studioRoot, 'node_modules/.vite-merge-controller-browser-test'),
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
      name: 'merge-browser-test-samples',
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
  browser = await puppeteer.launch({ executablePath, headless: true });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

test('dirty merge entry creates a real pre-merge checkpoint before already-integrated exit', { timeout: 30_000 }, async (context) => {
  if (!browser) {
    context.skip('Chrome or Chromium is unavailable');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versioning, controllerModule] = await Promise.all([
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
      const store = new versioning.VersionGraphStore({ indexedDB: null });
      const pendingEdits = {
        hasPending: () => false,
        onChange: () => () => undefined,
      };
      let readOnly = false;
      const inputHandler = {
        prepareSnapshotCapacity: () => undefined,
        replaceContentFromBytes: (bytes: Uint8Array) => {
          wasm.loadDocument(bytes, 'shift-return.hwp');
        },
        isReadOnly: () => readOnly,
        setReadOnly: (next: boolean) => { readOnly = next; },
      };
      const agentBridge = {
        pendingEdits,
        onEvent: () => () => undefined,
        isTurnRunning: () => false,
        getPermissionProfile: () => 'safe',
        getActiveAgent: () => null,
        requestCheckpointTitle: async () => null,
      };
      const controller = new controllerModule.DocumentVersionController({
        store,
        wasm,
        eventBus,
        documentState: dirty,
        getInputHandler: () => inputHandler,
        getDocumentId: () => 'browser-merge-document',
        agentBridge,
      });
      try {
        await controller.enable();
        await controller.createBranch('source');
        await controller.switchBranch('main');
        wasm.insertText(0, 0, 0, 'pre-merge dirty change');
        dirty.markDirty('test');
        eventBus.emit('document-mutated');
        let message = '';
        try { await controller.startMerge('source'); } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        const repository = await store.findRepositoryByDocumentId(
          versioning.documentId('browser-merge-document'),
        );
        const commits = repository
          ? await store.listCommits(repository.id, { limit: 10 })
          : [];
        const main = repository
          ? await store.getBranch(repository.id, versioning.branchName('main'))
          : null;
        const source = repository
          ? await store.getBranch(repository.id, versioning.branchName('source'))
          : null;
        return {
          message,
          reasons: commits.map((commit) => commit.reason),
          mainHead: main?.target,
          sourceHead: source?.target,
        };
      } finally {
        controller.dispose();
        wasm.releaseDocument();
      }
    });
    assert.equal(result.message, '이미 병합된 브랜치입니다.');
    assert.ok(result.reasons.includes('pre-merge'));
    assert.notEqual(result.mainHead, result.sourceHead);
  } finally {
    await page.close();
  }
});

test('clean fast-forward is reviewed and keeps the source branch by default', { timeout: 30_000 }, async (context) => {
  if (!browser) {
    context.skip('Chrome or Chromium is unavailable');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    await page.evaluate(async () => {
      const [wasmModule, eventModule, dirtyModule, versioning, controllerModule, snapshotModule] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'),
        import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'),
        import('/src/versioning/snapshot.ts'),
      ]);
      const response = await fetch('/samples/shift-return.hwp');
      const wasm = new wasmModule.WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), 'shift-return.hwp');
      const rootCapture = snapshotModule.captureVersionSnapshot(wasm);
      const store = new versioning.VersionGraphStore({ indexedDB: null });
      const created = await store.createRepository({
        documentId: versioning.documentId('browser-fast-forward-document'),
        lastSavedFingerprint: rootCapture.fingerprint,
        initial: {
          bytes: rootCapture.bytes,
          compareSnapshot: rootCapture.compareSnapshot,
          contentFingerprint: rootCapture.fingerprint,
          title: 'Initial',
          titleOrigin: 'manual',
          titleRevision: 0,
          author: { kind: 'user', label: 'Browser test' },
          stats: { added: 0, removed: 0, modified: 0 },
        },
      });
      const source = await store.createBranch({
        repositoryId: created.repository.id,
        name: versioning.branchName('source'),
        target: created.commit.id,
        expectedRepositoryRevision: created.repository.revision,
      });
      wasm.insertText(0, 0, 0, 'incoming clean change');
      const incomingCapture = snapshotModule.captureVersionSnapshot(wasm);
      await store.createCheckpoint({
        repositoryId: created.repository.id,
        branch: source.branch.name,
        expectedRepositoryRevision: source.repository.revision,
        expectedBranchRevision: source.branch.revision,
        expectedHead: source.branch.target,
        reason: 'manual',
        bytes: incomingCapture.bytes,
        compareSnapshot: incomingCapture.compareSnapshot,
        contentFingerprint: incomingCapture.fingerprint,
        title: 'Incoming',
        titleOrigin: 'manual',
        titleRevision: 0,
        author: { kind: 'user', label: 'Browser test' },
        stats: { added: 1, removed: 0, modified: 0 },
      });
      wasm.loadDocument(rootCapture.bytes, 'shift-return.hwp');
      const eventBus = new eventModule.EventBus();
      const dirty = new dirtyModule.DocumentDirtyState(eventBus);
      let readOnly = false;
      const inputHandler = {
        prepareSnapshotCapacity: () => undefined,
        replaceContentFromBytes: (bytes: Uint8Array) => wasm.loadDocument(bytes, 'shift-return.hwp'),
        isReadOnly: () => readOnly,
        setReadOnly: (next: boolean) => { readOnly = next; },
      };
      const pendingEdits = { hasPending: () => false, onChange: () => () => undefined };
      const controller = new controllerModule.DocumentVersionController({
        store,
        wasm,
        eventBus,
        documentState: dirty,
        getInputHandler: () => inputHandler,
        getDocumentId: () => 'browser-fast-forward-document',
        agentBridge: {
          pendingEdits,
          onEvent: () => () => undefined,
          isTurnRunning: () => false,
          getPermissionProfile: () => 'safe',
          getActiveAgent: () => null,
          requestCheckpointTitle: async () => null,
        },
      });
      await controller.enable();
      await controller.startMerge('source');
      Object.assign(window, { __mergeController: controller, __mergeStore: store, __mergeWasm: wasm });
    });
    await page.waitForSelector('.merge-resolver-window');
    assert.equal(await page.$eval('.merge-mode-select', (select) => (select as HTMLSelectElement).value), 'fast-forward');
    try {
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button');
        return Boolean(button && !button.disabled);
      }, { timeout: 20_000 });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        status: document.querySelector('.merge-validation-label')?.textContent,
        completeDisabled: document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button')?.disabled,
        conflicts: [...document.querySelectorAll('.merge-conflict-item')].map((node) => node.textContent),
        editor: document.querySelector('.merge-conflict-editor')?.textContent,
      }));
      throw new Error(`Diverged merge did not become completable: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    await page.click('.merge-resolver-footer .merge-primary-button');
    await page.waitForSelector('.merge-confirm-overlay');
    assert.equal(await page.$eval('.merge-source-select', (select) => (select as HTMLSelectElement).value), 'keep');
    await page.click('.merge-confirm-dialog .merge-secondary-button');
    await page.waitForSelector('.merge-resolver-window', { hidden: true });
    const result = await page.evaluate(async () => {
      const controller = (window as any).__mergeController;
      const store = (window as any).__mergeStore;
      const wasm = (window as any).__mergeWasm;
      const state = controller.getState();
      const repository = await store.findRepositoryByDocumentId(state.documentId);
      const main = await store.getBranch(repository.id, 'main');
      const source = await store.getBranch(repository.id, 'source');
      const commits = await store.listCommits(repository.id);
      controller.dispose();
      wasm.releaseDocument();
      return {
        mainHead: main?.target,
        sourceHead: source?.target,
        reasons: commits.map((commit: { reason: string }) => commit.reason),
      };
    });
    assert.equal(result.mainHead, result.sourceHead);
    assert.deepEqual(result.reasons.sort(), ['initial', 'manual']);
  } finally {
    await page.close();
  }
});

test('diverged clean merge creates ordered parents and Undo/Redo moves bytes with refs', { timeout: 45_000 }, async (context) => {
  if (!browser) {
    context.skip('Chrome or Chromium is unavailable');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    await page.evaluate(async () => {
      const [wasmModule, eventModule, dirtyModule, versioning, controllerModule, snapshotModule] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'),
        import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'),
        import('/src/versioning/snapshot.ts'),
      ]);
      const response = await fetch('/samples/shift-return.hwp');
      const wasm = new wasmModule.WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), 'shift-return.hwp');
      const base = snapshotModule.captureVersionSnapshot(wasm);
      wasm.insertText(0, 0, 0, 'CURRENT:');
      const current = snapshotModule.captureVersionSnapshot(wasm);
      wasm.loadDocument(base.bytes, 'shift-return.hwp');
      wasm.insertText(0, 0, wasm.getParagraphLength(0, 0), ':INCOMING');
      const incoming = snapshotModule.captureVersionSnapshot(wasm);
      wasm.loadDocument(current.bytes, 'shift-return.hwp');

      const store = new versioning.VersionGraphStore({ indexedDB: null });
      const created = await store.createRepository({
        documentId: versioning.documentId('browser-diverged-document'),
        lastSavedFingerprint: base.fingerprint,
        initial: {
          bytes: base.bytes,
          compareSnapshot: base.compareSnapshot,
          contentFingerprint: base.fingerprint,
          title: 'Initial',
          titleOrigin: 'manual',
          titleRevision: 0,
          author: { kind: 'user', label: 'Browser test' },
          stats: { added: 0, removed: 0, modified: 0 },
        },
      });
      const source = await store.createBranch({
        repositoryId: created.repository.id,
        name: versioning.branchName('source'),
        target: created.commit.id,
        expectedRepositoryRevision: created.repository.revision,
      });
      const currentCheckpoint = await store.createCheckpoint({
        repositoryId: created.repository.id,
        branch: created.branch.name,
        expectedRepositoryRevision: source.repository.revision,
        expectedBranchRevision: created.branch.revision,
        expectedHead: created.branch.target,
        reason: 'manual',
        bytes: current.bytes,
        compareSnapshot: current.compareSnapshot,
        contentFingerprint: current.fingerprint,
        title: 'Current side',
        titleOrigin: 'manual',
        titleRevision: 0,
        author: { kind: 'user', label: 'Browser test' },
        stats: { added: 1, removed: 0, modified: 0 },
      });
      const incomingCheckpoint = await store.createCheckpoint({
        repositoryId: created.repository.id,
        branch: source.branch.name,
        expectedRepositoryRevision: currentCheckpoint.repository.revision,
        expectedBranchRevision: source.branch.revision,
        expectedHead: source.branch.target,
        reason: 'manual',
        bytes: incoming.bytes,
        compareSnapshot: incoming.compareSnapshot,
        contentFingerprint: incoming.fingerprint,
        title: 'Incoming side',
        titleOrigin: 'manual',
        titleRevision: 0,
        author: { kind: 'user', label: 'Browser test' },
        stats: { added: 1, removed: 0, modified: 0 },
      });

      const eventBus = new eventModule.EventBus();
      const dirty = new dirtyModule.DocumentDirtyState(eventBus);
      let readOnly = false;
      type HistoryEntry = {
        before: Uint8Array;
        after: Uint8Array;
        callbacks: { afterUndo?: () => void; afterRedo?: () => void };
      };
      const undo: HistoryEntry[] = [];
      const redo: HistoryEntry[] = [];
      const inputHandler = {
        prepareSnapshotCapacity: () => undefined,
        replaceContentFromBytes: (
          bytes: Uint8Array,
          callbacks: HistoryEntry['callbacks'] = {},
        ) => {
          const before = wasm.exportHwp();
          wasm.replaceContentFromBytes(bytes);
          const entry = { before, after: wasm.exportHwp(), callbacks };
          undo.push(entry);
          redo.length = 0;
        },
        performUndo: () => {
          const entry = undo.pop();
          if (!entry) return;
          wasm.replaceContentFromBytes(entry.before);
          redo.push(entry);
          entry.callbacks.afterUndo?.();
        },
        performRedo: () => {
          const entry = redo.pop();
          if (!entry) return;
          wasm.replaceContentFromBytes(entry.after);
          undo.push(entry);
          entry.callbacks.afterRedo?.();
        },
        discardRedoHistory: () => { redo.length = 0; },
        discardLatestUndoHistory: () => { undo.pop(); },
        isReadOnly: () => readOnly,
        setReadOnly: (next: boolean) => { readOnly = next; },
      };
      const pendingEdits = { hasPending: () => false, onChange: () => () => undefined };
      const controller = new controllerModule.DocumentVersionController({
        store,
        wasm,
        eventBus,
        documentState: dirty,
        getInputHandler: () => inputHandler,
        getDocumentId: () => 'browser-diverged-document',
        agentBridge: {
          pendingEdits,
          onEvent: () => () => undefined,
          isTurnRunning: () => false,
          getPermissionProfile: () => 'safe',
          getActiveAgent: () => null,
          requestCheckpointTitle: async () => null,
        },
      });
      await controller.enable();
      await controller.startMerge('source');
      Object.assign(window, {
        __mergeController: controller,
        __mergeStore: store,
        __mergeWasm: wasm,
        __mergeInput: inputHandler,
        __mergeSnapshot: snapshotModule,
        __mergeExpected: {
          current: currentCheckpoint.commit.id,
          incoming: incomingCheckpoint.commit.id,
        },
      });
    });
    await page.waitForSelector('.merge-resolver-window');
    assert.equal(await page.$eval('.merge-direction', (node) => node.textContent), 'source → main');
    assert.equal(await page.$('.merge-mode-select'), null, 'diverged merges cannot bypass a merge checkpoint');
    assert.match(
      await page.$eval('.merge-clean-message', (node) => node.textContent ?? ''),
      /충돌이 없습니다/,
      'disjoint current/incoming edits must stay mandatory but conflict-free in review',
    );
    try {
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button');
        return Boolean(button && !button.disabled);
      }, { timeout: 20_000 });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        status: document.querySelector('.merge-validation-status')?.textContent,
        conflicts: [...document.querySelectorAll('.merge-conflict-item')].map((node) => node.textContent),
        editor: document.querySelector('.merge-conflict-editor')?.textContent,
      }));
      throw new Error(`Diverged merge did not become completable: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    await page.click('.merge-resolver-footer .merge-primary-button');
    await page.waitForSelector('.merge-confirm-overlay');
    await page.click('.merge-confirm-dialog .merge-secondary-button');
    await page.waitForSelector('.merge-resolver-window', { hidden: true });

    const merged = await page.evaluate(async () => {
      const store = (window as any).__mergeStore;
      const controller = (window as any).__mergeController;
      const wasm = (window as any).__mergeWasm;
      const snapshot = (window as any).__mergeSnapshot;
      const expected = (window as any).__mergeExpected;
      const repository = await store.findRepositoryByDocumentId(controller.getState().documentId);
      const main = await store.getBranch(repository.id, 'main');
      const source = await store.getBranch(repository.id, 'source');
      const commit = await store.getCommit(main.target);
      return {
        repositoryId: repository.id,
        mainHead: main.target,
        sourceHead: source?.target,
        currentHead: expected.current,
        incomingHead: expected.incoming,
        parents: commit.parents,
        reason: commit.reason,
        metadata: commit.merge,
        text: snapshot.captureVersionSnapshot(wasm).compareSnapshot.paragraphs[0]?.text,
      };
    });
    assert.deepEqual(merged.parents, [merged.currentHead, merged.incomingHead]);
    assert.equal(merged.reason, 'merge');
    assert.equal(merged.metadata.sourceBranchAtMerge, 'source');
    assert.equal(merged.metadata.targetBranchAtMerge, 'main');
    assert.equal(merged.sourceHead, merged.incomingHead);
    assert.match(merged.text, /CURRENT:/);
    assert.match(merged.text, /:INCOMING/);

    await page.evaluate(() => (window as any).__mergeInput.performUndo());
    await page.waitForFunction(async (repositoryId, currentHead) => {
      const store = (window as any).__mergeStore;
      return (await store.getBranch(repositoryId, 'main'))?.target === currentHead;
    }, {}, merged.repositoryId, merged.currentHead);
    const undoneText = await page.evaluate(() => {
      const wasm = (window as any).__mergeWasm;
      const snapshot = (window as any).__mergeSnapshot;
      return snapshot.captureVersionSnapshot(wasm).compareSnapshot.paragraphs[0]?.text;
    });
    assert.match(undoneText, /CURRENT:/);
    assert.doesNotMatch(undoneText, /:INCOMING/);

    await page.evaluate(() => (window as any).__mergeInput.performRedo());
    await page.waitForFunction(async (repositoryId, mergeHead) => {
      const store = (window as any).__mergeStore;
      return (await store.getBranch(repositoryId, 'main'))?.target === mergeHead;
    }, {}, merged.repositoryId, merged.mainHead);
    const redone = await page.evaluate(async () => {
      const controller = (window as any).__mergeController;
      const store = (window as any).__mergeStore;
      const wasm = (window as any).__mergeWasm;
      const snapshot = (window as any).__mergeSnapshot;
      const repository = await store.findRepositoryByDocumentId(controller.getState().documentId);
      const source = await store.getBranch(repository.id, 'source');
      const text = snapshot.captureVersionSnapshot(wasm).compareSnapshot.paragraphs[0]?.text;
      controller.dispose();
      wasm.releaseDocument();
      return { sourceHead: source?.target, text };
    });
    assert.equal(redone.sourceHead, merged.incomingHead);
    assert.match(redone.text, /CURRENT:/);
    assert.match(redone.text, /:INCOMING/);
  } finally {
    await page.close();
  }
});

test('HWPX branch transitions stay clean and do not create phantom checkpoints', { timeout: 45_000 }, async (context) => {
  if (!browser) {
    context.skip('Chrome or Chromium is unavailable');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versioning, controllerModule] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'),
        import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'),
      ]);
      const response = await fetch('/samples/task1763/cell_trailing_ls_expand.hwpx');
      const fileName = 'cell_trailing_ls_expand.hwpx';
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), fileName);
      const eventBus = new EventBus();
      const dirty = new DocumentDirtyState(eventBus);
      const store = new versioning.VersionGraphStore({ indexedDB: null });
      let readOnly = false;
      const inputHandler = {
        prepareSnapshotCapacity: () => undefined,
        replaceContentFromBytes: (bytes: Uint8Array) => wasm.loadDocument(bytes, fileName),
        isReadOnly: () => readOnly,
        setReadOnly: (next: boolean) => { readOnly = next; },
      };
      const pendingEdits = { hasPending: () => false, onChange: () => () => undefined };
      const controller = new controllerModule.DocumentVersionController({
        store,
        wasm,
        eventBus,
        documentState: dirty,
        getInputHandler: () => inputHandler,
        getDocumentId: () => 'browser-hwpx-clean-branches',
        agentBridge: {
          pendingEdits,
          onEvent: () => () => undefined,
          isTurnRunning: () => false,
          getPermissionProfile: () => 'safe',
          getActiveAgent: () => null,
          requestCheckpointTitle: async () => null,
        },
      });
      await controller.enable();
      const enabled = controller.getState();
      await controller.createBranch('experiment');
      const created = controller.getState();
      await controller.switchBranch('main');
      const switched = controller.getState();
      const repository = await store.findRepositoryByDocumentId(versioning.documentId('browser-hwpx-clean-branches'));
      const commits = await store.listCommits(repository.id);
      controller.dispose();
      wasm.releaseDocument();
      return {
        enabled: { dirty: enabled.dirty, commits: enabled.commits.length },
        created: { dirty: created.dirty, commits: created.commits.length, branch: created.activeBranch },
        switched: { dirty: switched.dirty, commits: switched.commits.length, branch: switched.activeBranch },
        reasons: commits.map((commit: { reason: string }) => commit.reason),
      };
    });
    assert.deepEqual(result.enabled, { dirty: false, commits: 1 });
    assert.deepEqual(result.created, { dirty: false, commits: 1, branch: 'experiment' });
    assert.deepEqual(result.switched, { dirty: false, commits: 1, branch: 'main' });
    assert.deepEqual(result.reasons, ['initial']);
  } finally {
    await page.close();
  }
});

test('HWPX controller durably completes clean and conflicted merges with composite Undo/Redo', { timeout: 120_000 }, async (context) => {
  if (!browser) {
    context.skip('Chrome or Chromium is unavailable');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    for (const conflicted of [false, true]) {
      const setup = await page.evaluate(async ({ conflicted }) => {
        const [wasmModule, eventModule, dirtyModule, versioning, controllerModule, snapshotModule] = await Promise.all([
          import('/src/core/wasm-bridge.ts'),
          import('/src/core/event-bus.ts'),
          import('/src/core/document-dirty-state.ts'),
          import('/src/versioning/index.ts'),
          import('/src/versioning/controller.ts'),
          import('/src/versioning/snapshot.ts'),
        ]);
        const response = await fetch('/samples/shift-return.hwp');
        const wasm = new wasmModule.WasmBridge();
        await wasm.initialize();
        wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), 'source.hwp');
        const fileName = `controller-${conflicted ? 'conflict' : 'clean'}.hwpx`;
        const baseBytes = wasm.exportHwpx();
        wasm.loadDocument(baseBytes, fileName);
        const base = snapshotModule.captureVersionSnapshot(wasm);
        wasm.insertText(0, 0, 0, 'CURRENT:');
        const currentExport = snapshotModule.captureVersionSnapshot(wasm);
        wasm.loadDocument(base.bytes, fileName);
        wasm.insertText(
          0,
          0,
          conflicted ? 0 : wasm.getParagraphLength(0, 0),
          conflicted ? 'INCOMING:' : ':INCOMING',
        );
        const incoming = snapshotModule.captureVersionSnapshot(wasm);
        wasm.loadDocument(currentExport.bytes, fileName);
        // HWPX import/export can normalize package representation. Capture the
        // exact live model so the controller does not correctly classify the
        // fixture setup itself as dirty and add an unrelated pre-merge parent.
        const current = snapshotModule.captureVersionSnapshot(wasm);

        const store = new versioning.VersionGraphStore({ indexedDB: null });
        const documentId = `browser-hwpx-controller-${conflicted ? 'conflict' : 'clean'}`;
        const created = await store.createRepository({
          documentId: versioning.documentId(documentId),
          lastSavedFingerprint: base.fingerprint,
          initial: {
            bytes: base.bytes,
            compareSnapshot: base.compareSnapshot,
            contentFingerprint: base.fingerprint,
            title: 'Initial',
            titleOrigin: 'manual',
            titleRevision: 0,
            author: { kind: 'user', label: 'Browser test' },
            stats: { added: 0, removed: 0, modified: 0 },
          },
        });
        const source = await store.createBranch({
          repositoryId: created.repository.id,
          name: versioning.branchName('source'),
          target: created.commit.id,
          expectedRepositoryRevision: created.repository.revision,
        });
        const currentCheckpoint = await store.createCheckpoint({
          repositoryId: created.repository.id,
          branch: created.branch.name,
          expectedRepositoryRevision: source.repository.revision,
          expectedBranchRevision: created.branch.revision,
          expectedHead: created.branch.target,
          reason: 'manual',
          bytes: current.bytes,
          compareSnapshot: current.compareSnapshot,
          contentFingerprint: current.fingerprint,
          title: 'Current side',
          titleOrigin: 'manual',
          titleRevision: 0,
          author: { kind: 'user', label: 'Browser test' },
          stats: { added: 1, removed: 0, modified: 0 },
        });
        const incomingCheckpoint = await store.createCheckpoint({
          repositoryId: created.repository.id,
          branch: source.branch.name,
          expectedRepositoryRevision: currentCheckpoint.repository.revision,
          expectedBranchRevision: source.branch.revision,
          expectedHead: source.branch.target,
          reason: 'manual',
          bytes: incoming.bytes,
          compareSnapshot: incoming.compareSnapshot,
          contentFingerprint: incoming.fingerprint,
          title: 'Incoming side',
          titleOrigin: 'manual',
          titleRevision: 0,
          author: { kind: 'user', label: 'Browser test' },
          stats: { added: 1, removed: 0, modified: 0 },
        });

        const eventBus = new eventModule.EventBus();
        const dirty = new dirtyModule.DocumentDirtyState(eventBus);
        let readOnly = false;
        type HistoryEntry = {
          before: Uint8Array;
          after: Uint8Array;
          callbacks: { afterUndo?: () => void; afterRedo?: () => void };
        };
        const undo: HistoryEntry[] = [];
        const redo: HistoryEntry[] = [];
        const load = (bytes: Uint8Array) => wasm.loadDocument(bytes, fileName);
        const inputHandler = {
          prepareSnapshotCapacity: () => undefined,
          replaceContentFromBytes: (bytes: Uint8Array, callbacks: HistoryEntry['callbacks'] = {}) => {
            const before = wasm.exportHwpx();
            load(bytes);
            undo.push({ before, after: wasm.exportHwpx(), callbacks });
            redo.length = 0;
          },
          performUndo: () => {
            const entry = undo.pop();
            if (!entry) return;
            load(entry.before);
            redo.push(entry);
            entry.callbacks.afterUndo?.();
          },
          performRedo: () => {
            const entry = redo.pop();
            if (!entry) return;
            load(entry.after);
            undo.push(entry);
            entry.callbacks.afterRedo?.();
          },
          discardRedoHistory: () => { redo.length = 0; },
          discardLatestUndoHistory: () => { undo.pop(); },
          isReadOnly: () => readOnly,
          setReadOnly: (next: boolean) => { readOnly = next; },
        };
        const pendingEdits = { hasPending: () => false, onChange: () => () => undefined };
        const controller = new controllerModule.DocumentVersionController({
          store,
          wasm,
          eventBus,
          documentState: dirty,
          getInputHandler: () => inputHandler,
          getDocumentId: () => documentId,
          agentBridge: {
            pendingEdits,
            onEvent: () => () => undefined,
            isTurnRunning: () => false,
            getPermissionProfile: () => 'safe',
            getActiveAgent: () => null,
            requestCheckpointTitle: async () => null,
          },
        });
        await controller.enable();
        await controller.startMerge('source');
        Object.assign(window, {
          __hwpxController: controller,
          __hwpxStore: store,
          __hwpxWasm: wasm,
          __hwpxInput: inputHandler,
          __hwpxSnapshot: snapshotModule,
          __hwpxExpected: {
            repositoryId: created.repository.id,
            currentHead: currentCheckpoint.commit.id,
            incomingHead: incomingCheckpoint.commit.id,
          },
        });
        return { repositoryId: created.repository.id };
      }, { conflicted });

      await page.waitForSelector('.merge-resolver-window');
      const conflictCount = await page.$$eval('.merge-conflict-item', (items) => items.length);
      if (conflicted) {
        assert.ok(conflictCount > 0, 'same-position HWPX edits must require explicit resolution');
        await page.click('.merge-bulk-actions button:nth-child(2)');
      } else {
        assert.equal(conflictCount, 0, 'disjoint HWPX edits must merge cleanly');
        assert.match(await page.$eval('.merge-clean-message', (node) => node.textContent ?? ''), /충돌이 없습니다/);
      }
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button');
        return Boolean(button && !button.disabled);
      }, { timeout: 60_000 });
      await page.click('.merge-resolver-footer .merge-primary-button');
      await page.waitForSelector('.merge-confirm-overlay');
      assert.equal(await page.$eval('.merge-source-select', (node) => (node as HTMLSelectElement).value), 'keep');
      await page.click('.merge-confirm-dialog .merge-secondary-button');
      await page.waitForSelector('.merge-resolver-window', { hidden: true });

      const merged = await page.evaluate(async () => {
        const controller = (window as any).__hwpxController;
        const store = (window as any).__hwpxStore;
        const wasm = (window as any).__hwpxWasm;
        const snapshot = (window as any).__hwpxSnapshot;
        const expected = (window as any).__hwpxExpected;
        const main = await store.getBranch(expected.repositoryId, 'main');
        const source = await store.getBranch(expected.repositoryId, 'source');
        const commit = await store.getCommit(main.target);
        const manifest = await store.getMergeManifest(commit.mergeManifestId);
        return {
          mergeHead: main.target,
          sourceHead: source?.target,
          currentHead: expected.currentHead,
          incomingHead: expected.incomingHead,
          parents: commit.parents,
          reason: commit.reason,
          merge: commit.merge,
          manifestCoverage: manifest?.coverage,
          manifestKinds: manifest?.entries.map((entry: { kind: string }) => entry.kind),
          text: snapshot.captureVersionSnapshot(wasm).compareSnapshot.paragraphs[0]?.text ?? '',
          magic: [...wasm.exportHwpx().slice(0, 2)],
        };
      });
      assert.deepEqual(merged.parents, [merged.currentHead, merged.incomingHead]);
      assert.equal(merged.reason, 'merge');
      assert.equal(merged.merge.sourceBranchAtMerge, 'source');
      assert.equal(merged.merge.targetBranchAtMerge, 'main');
      assert.equal(merged.merge.conflictCount, conflictCount);
      assert.equal(merged.sourceHead, merged.incomingHead);
      assert.equal(merged.manifestCoverage, 'full-document');
      for (const kind of [
        'document',
        'document-properties',
        'section',
        'section-settings',
        'paragraph',
        'text',
        'character-style',
        'paragraph-style',
        'style',
      ]) assert.ok(merged.manifestKinds.includes(kind), `HWPX manifest must include ${kind}`);
      assert.deepEqual(merged.magic, [0x50, 0x4b]);
      if (conflicted) {
        assert.match(merged.text, /INCOMING:/);
        assert.doesNotMatch(merged.text, /CURRENT:/);
      } else {
        assert.match(merged.text, /CURRENT:/);
        assert.match(merged.text, /:INCOMING/);
      }

      await page.evaluate(() => (window as any).__hwpxInput.performUndo());
      await page.waitForFunction(async (repositoryId, currentHead) => (
        (await (window as any).__hwpxStore.getBranch(repositoryId, 'main'))?.target === currentHead
      ), {}, setup.repositoryId, merged.currentHead);
      const undone = await page.evaluate(async () => {
        const expected = (window as any).__hwpxExpected;
        const store = (window as any).__hwpxStore;
        const wasm = (window as any).__hwpxWasm;
        const snapshot = (window as any).__hwpxSnapshot;
        return {
          sourceHead: (await store.getBranch(expected.repositoryId, 'source'))?.target,
          text: snapshot.captureVersionSnapshot(wasm).compareSnapshot.paragraphs[0]?.text ?? '',
          magic: [...wasm.exportHwpx().slice(0, 2)],
        };
      });
      assert.equal(undone.sourceHead, merged.incomingHead);
      assert.match(undone.text, /CURRENT:/);
      assert.doesNotMatch(undone.text, /INCOMING:/);
      assert.deepEqual(undone.magic, [0x50, 0x4b]);

      await page.evaluate(() => (window as any).__hwpxInput.performRedo());
      await page.waitForFunction(async (repositoryId, mergeHead) => (
        (await (window as any).__hwpxStore.getBranch(repositoryId, 'main'))?.target === mergeHead
      ), {}, setup.repositoryId, merged.mergeHead);
      const redone = await page.evaluate(async () => {
        const controller = (window as any).__hwpxController;
        const expected = (window as any).__hwpxExpected;
        const store = (window as any).__hwpxStore;
        const wasm = (window as any).__hwpxWasm;
        const snapshot = (window as any).__hwpxSnapshot;
        const result = {
          sourceHead: (await store.getBranch(expected.repositoryId, 'source'))?.target,
          text: snapshot.captureVersionSnapshot(wasm).compareSnapshot.paragraphs[0]?.text ?? '',
          magic: [...wasm.exportHwpx().slice(0, 2)],
        };
        controller.dispose();
        wasm.releaseDocument();
        return result;
      });
      assert.equal(redone.sourceHead, merged.incomingHead);
      assert.deepEqual(redone.magic, [0x50, 0x4b]);
      if (conflicted) {
        assert.match(redone.text, /INCOMING:/);
        assert.doesNotMatch(redone.text, /CURRENT:/);
      } else {
        assert.match(redone.text, /CURRENT:/);
        assert.match(redone.text, /:INCOMING/);
      }
    }
  } finally {
    await page.close();
  }
});

test('real resolver completes clean and conflicted HWP/HWPX worker merges', { timeout: 90_000 }, async (context) => {
  if (!browser) {
    context.skip('Chrome or Chromium is unavailable');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    for (const format of ['hwp', 'hwpx'] as const) {
      for (const conflicted of [false, true]) {
        const setup = await page.evaluate(async ({ format, conflicted }) => {
          const [wasmModule, mergeModule, snapshotModule] = await Promise.all([
            import('/src/core/wasm-bridge.ts'),
            import('/src/merge/index.ts'),
            import('/src/versioning/snapshot.ts'),
          ]);
          const response = await fetch('/samples/shift-return.hwp');
          const wasm = new wasmModule.WasmBridge();
          await wasm.initialize();
          wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), 'fixture.hwp');
          const exportBytes = () => format === 'hwpx' ? wasm.exportHwpx() : wasm.exportHwp();
          const fileName = `merge-fixture.${format}`;
          const base = exportBytes();
          wasm.loadDocument(base, fileName);
          wasm.insertText(0, 0, 0, 'CURRENT:');
          const current = exportBytes();
          wasm.loadDocument(base, fileName);
          wasm.insertText(
            0,
            0,
            conflicted ? 0 : wasm.getParagraphLength(0, 0),
            conflicted ? 'INCOMING:' : ':INCOMING',
          );
          const incoming = exportBytes();
          wasm.loadDocument(current, fileName);

          const worker = new mergeModule.MergeWorkerClient();
          const analysis = await worker.analyzeDocument(base, current, incoming);
          const now = Date.now();
          const draft = {
            id: `browser-${format}-${conflicted ? 'conflict' : 'clean'}`,
            repositoryId: 'browser-resolver-repository',
            targetBranch: 'main',
            sourceBranch: 'source',
            baseCommitIds: ['base'],
            currentHead: 'current',
            sourceHead: 'incoming',
            targetBranchRevision: 1,
            sourceBranchRevision: 1,
            mode: 'diverged' as const,
            analysisVersion: analysis.analysisVersion,
            conflicts: analysis.conflicts,
            resolutions: {},
            automaticResult: analysis.result,
            manualAssetBlobIds: [],
            history: [],
            historyIndex: 0,
            createdAt: now,
            updatedAt: now,
          };
          const resolver = new mergeModule.MergeResolverWindow();
          resolver.open({
            draft,
            analysis,
            sourceBranch: 'source',
            currentBranch: 'main',
            mode: 'diverged',
            documents: {
              base: { bytes: base, fileName, label: 'Base' },
              current: { bytes: current, fileName, label: 'Current' },
              incoming: { bytes: incoming, fileName, label: 'Incoming' },
            },
            canDeleteSource: false,
            materialize: async ({ resolutions, signal }) => {
              const output = await worker.materializeDocument(base, current, incoming, resolutions, { signal });
              const first = new wasmModule.WasmBridge();
              const second = new wasmModule.WasmBridge();
              try {
                await Promise.all([first.initialize(), second.initialize()]);
                first.loadDocument(output.bytes, fileName);
                const once = format === 'hwpx' ? first.exportHwpx() : first.exportHwp();
                second.loadDocument(once, fileName);
                const twice = format === 'hwpx' ? second.exportHwpx() : second.exportHwp();
                if (once.byteLength === 0 || twice.byteLength === 0) throw new Error('empty merge export');
                return {
                  tree: analysis.result,
                  document: { bytes: output.bytes, fileName, label: 'Result' },
                  validation: {
                    valid: true,
                    errors: [],
                    checks: {
                      parsed: true,
                      exported: true,
                      reloaded: true,
                      structurallyValid: true,
                      format,
                    },
                  },
                };
              } finally {
                first.releaseDocument();
                second.releaseDocument();
              }
            },
            saveDraft: async () => undefined,
            discardDraft: async () => undefined,
            complete: async (application) => {
              (window as any).__resolverApplication = application;
              return {};
            },
            finalizeSourceDisposition: async (_receipt, disposition) => {
              (window as any).__resolverDisposition = disposition;
            },
          });
          Object.assign(window, {
            __resolverWasm: wasm,
            __resolverWorker: worker,
            __resolverFormat: format,
            __resolverSnapshot: snapshotModule,
          });
          return { conflictCount: analysis.conflicts.length };
        }, { format, conflicted });

        await page.waitForSelector('.merge-resolver-window');
        if (format === 'hwp' && conflicted) {
          await page.setViewport({ width: 420, height: 720 });
          const geometry = await page.evaluate(() => {
            const root = document.querySelector<HTMLElement>('.merge-resolver-window')!;
            const body = document.querySelector<HTMLElement>('.merge-resolver-body')!;
            const editor = document.querySelector<HTMLElement>('.merge-conflict-editor')!;
            const footer = document.querySelector<HTMLElement>('.merge-resolver-footer')!;
            const bodyRect = body.getBoundingClientRect();
            const editorRect = editor.getBoundingClientRect();
            const footerRect = footer.getBoundingClientRect();
            const actionsFit = [...footer.querySelectorAll<HTMLButtonElement>('button')].every((button) => {
              const rect = button.getBoundingClientRect();
              return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
            });
            return {
              rootFits: root.scrollWidth <= root.clientWidth,
              bodyFits: body.scrollHeight <= body.clientHeight + 1,
              bodyOverflow: getComputedStyle(body).overflow,
              editorInsideBody: editorRect.bottom <= bodyRect.bottom + 1,
              footerAfterBody: bodyRect.bottom <= footerRect.top + 1,
              footerFits: footer.scrollWidth <= footer.clientWidth,
              actionsFit,
            };
          });
          assert.deepEqual(geometry, {
            rootFits: true,
            bodyFits: true,
            bodyOverflow: 'hidden',
            editorInsideBody: true,
            footerAfterBody: true,
            footerFits: true,
            actionsFit: true,
          });
          await page.setViewport({ width: 1280, height: 800 });
        }
        if (conflicted) {
          assert.ok(setup.conflictCount > 0, `${format} fixture must produce a typed conflict`);
          assert.equal(
            await page.$$eval('.merge-conflict-state', (nodes) => nodes.every((node) => node.textContent === '미해결')),
            true,
          );
          await page.click('.merge-bulk-actions button:nth-child(2)');
        } else {
          assert.equal(setup.conflictCount, 0, `${format} disjoint edits must merge cleanly`);
          assert.match(await page.$eval('.merge-clean-message', (node) => node.textContent ?? ''), /충돌이 없습니다/);
        }
        await page.waitForFunction(() => {
          const button = document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button');
          return Boolean(button && !button.disabled);
        }, { timeout: 20_000 });
        await page.click('.merge-resolver-footer .merge-primary-button');
        await page.waitForSelector('.merge-confirm-overlay');
        assert.equal(
          await page.$eval('.merge-source-select option[value="delete"]', (option) => (option as HTMLOptionElement).disabled),
          true,
        );
        await page.click('.merge-confirm-dialog .merge-secondary-button');
        await page.waitForSelector('.merge-resolver-window', { hidden: true });
        const result = await page.evaluate(async ({ conflicted }) => {
          const application = (window as any).__resolverApplication;
          const disposition = (window as any).__resolverDisposition;
          const worker = (window as any).__resolverWorker;
          const wasm = (window as any).__resolverWasm;
          const snapshot = (window as any).__resolverSnapshot;
          const bytes = application.materialized.document.bytes;
          const fileName = application.materialized.document.fileName;
          const inspector = new (wasm.constructor)();
          await inspector.initialize();
          inspector.loadDocument(bytes, fileName);
          const text = snapshot.captureVersionSnapshot(inspector).compareSnapshot.paragraphs[0]?.text ?? '';
          const resolutions = Object.values(application.resolutions) as Array<{ kind: string }>;
          inspector.releaseDocument();
          worker.dispose();
          wasm.releaseDocument();
          delete (window as any).__resolverApplication;
          delete (window as any).__resolverDisposition;
          return {
            text,
            disposition,
            resolutionKinds: resolutions.map((resolution) => resolution.kind),
            magic: [...bytes.slice(0, 8)],
            conflicted,
          };
        }, { conflicted });
        assert.equal(result.disposition, 'keep');
        if (conflicted) {
          assert.ok(result.resolutionKinds.length > 0);
          assert.ok(result.resolutionKinds.every((kind) => kind === 'incoming'));
          assert.match(result.text, /INCOMING:/);
          assert.doesNotMatch(result.text, /CURRENT:/);
        } else {
          assert.match(result.text, /CURRENT:/);
          assert.match(result.text, /:INCOMING/);
        }
        if (format === 'hwpx') assert.deepEqual(result.magic.slice(0, 2), [0x50, 0x4b]);
        else assert.deepEqual(result.magic, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
      }
    }
  } finally {
    await page.close();
  }
});
