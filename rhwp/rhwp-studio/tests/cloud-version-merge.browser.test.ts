import { browserExecutable, browserLaunchArgs, requireWasmPackage } from './browser-support.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

import puppeteer, { type Browser } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';

const executablePath = browserExecutable();
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
    // Keep Vite's dependency optimizer isolated from other browser test files.
    // Parallel servers otherwise invalidate the shared node_modules/.vite cache
    // while this page is still dynamically importing the controller graph.
    cacheDir: resolve(studioRoot, 'node_modules/.vite-cloud-version-merge-browser-test'),
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
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: browserLaunchArgs(),
  });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

async function openCloudDocument(page: import('puppeteer-core').Page, format: 'hwp' | 'hwpx', scenario: string) {
  await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
  return page.evaluate(async ({ format, scenario }) => {
    const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }, snapshots] = await Promise.all([
      import('/src/core/wasm-bridge.ts'), import('/src/core/event-bus.ts'),
      import('/src/core/document-dirty-state.ts'), import('/src/versioning/index.ts'),
      import('/src/versioning/controller.ts'), import('/src/versioning/snapshot.ts'),
    ]);
    const wasm = new WasmBridge();
    await wasm.initialize();
    wasm.loadDocument(new Uint8Array(await (await fetch('/samples/shift-return.hwp')).arrayBuffer()), 'test.hwp');
    if (format === 'hwpx') wasm.loadDocument(wasm.exportHwpx(), 'test.hwpx');
    const fileName = `test.${format}`;
    wasm.fileName = fileName;
    const eventBus = new EventBus();
    const dirty = new DocumentDirtyState(eventBus);
    const store = new versions.VersionGraphStore();
    const id = `cloud-merge-${format}-${scenario}`;
    const startId = `start-${scenario}-${format}`;
    let locked = false;
    const undo: Uint8Array[] = [];
    const redo: Uint8Array[] = [];
    const handler = {
      prepareSnapshotCapacity: () => {},
      replaceContentFromBytes: (bytes: Uint8Array) => {
        undo.push(snapshots.captureVersionSnapshot(wasm).bytes);
        redo.length = 0;
        wasm.loadDocument(bytes, fileName);
        eventBus.emit('document-mutated');
      },
      isUserEditingLocked: () => locked,
      setUserEditingLocked: (value: boolean) => { locked = value; },
      performUndo: () => { const bytes = undo.pop(); if (bytes) { redo.push(snapshots.captureVersionSnapshot(wasm).bytes); wasm.loadDocument(bytes, fileName); eventBus.emit('document-mutated'); } },
      discardRedoHistory: () => { redo.length = 0; },
      discardLatestUndoHistory: () => { undo.pop(); },
    };
    const deps = { store, wasm, eventBus, documentState: dirty,
      getInputHandler: () => handler, getDocumentId: () => id, autoEnable: () => true,
      agentBridge: { pendingEdits: { hasPending: () => false, onChange: () => () => {} },
        isTurnRunning: () => false, onEvent: () => () => {}, requestCheckpointTitle: async () => null },
    };
    let controller = new DocumentVersionController(deps);
    await controller.documentLoaded();
    const initial = controller.getState();
    const handoff = await controller.prepareCloudBranch(startId, snapshots.captureVersionSnapshot(wasm).bytes, fileName);
    const headBefore = controller.getState().branches.find((item) => item.isActive)!.headId;
    const remote = new WasmBridge();
    await remote.initialize();
    remote.loadDocument(handoff, fileName);
    remote.insertText(0, 0, scenario === 'conflict' ? 0 : remote.getParagraphLength(0, 0), ':CLOUD');
    const remoteBytes = snapshots.captureVersionSnapshot(remote).bytes;
    const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const checkpoint = { bytes: remoteBytes, fileName, sha256: await sha(remoteBytes), byteLength: remoteBytes.length,
      sessionId: `session-${scenario}-${format}`, documentId: id, kind: 'turn' as const, revision: 1, turn: 1, operationId: 'turn-1' };
    wasm.insertText(0, 0, 0, 'LOCAL:');
    dirty.markDirty('test');
    eventBus.emit('document-mutated');
    // File save must not turn the working tree into a branch commit.
    dirty.markClean('file-save');
    eventBus.emit('document-saved', { reason: 'save', fileName, sourceFormat: format });
    await controller.whenIdle();
    const afterSave = controller.getState();
    const replay = await controller.prepareCloudBranch(startId, snapshots.captureVersionSnapshot(wasm).bytes, fileName);
    // Reopening a controller must retain the original source and active branch.
    controller.dispose();
    controller = new DocumentVersionController(deps);
    await controller.refresh();
    const text = () => snapshots.captureVersionSnapshot(wasm).compareSnapshot.paragraphs.map((p) => p.text).join('\n');
    const inspect = () => ({ state: controller.getState(), text: text() });
    const cloud = {
      controller, store, wasm, dirty, eventBus, checkpoint, startId, inspect,
      begin: () => {
        (window as any).__cloudOutcome = undefined;
        (window as any).__cloudError = null;
        (window as any).__cloudMerge = controller.mergeCloudCheckpoint(startId, checkpoint).then(
          (value) => { (window as any).__cloudOutcome = value; },
          (error) => { (window as any).__cloudError = String(error); },
        );
      },
    };
    Object.assign(window, { __cloud: cloud });
    remote.releaseDocument();
    return { initial: { enabled: initial.enabled, dirty: initial.dirty, commits: initial.commits.length },
      saved: { dirty: afterSave.dirty, head: afterSave.branches.find((item) => item.isActive)!.headId }, headBefore,
      sameHandoff: await sha(replay) === await sha(handoff) };
  }, { format, scenario });
}

async function finishReview(page: import('puppeteer-core').Page) {
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button');
    return button && !button.disabled;
  }, { timeout: 20_000 });
  await page.click('.merge-resolver-footer .merge-primary-button');
  await page.waitForSelector('.merge-resolver-window', { hidden: true });
}

for (const format of ['hwp', 'hwpx'] as const) {
  test(`${format}: cloud import, file-save divergence, durable handoff, stash and three-way reapply`, { timeout: 60_000 }, async () => {
    const page = await browser!.newPage();
    try {
      const baseline = await openCloudDocument(page, format, 'stash');
      assert.deepEqual(baseline.initial, { enabled: true, dirty: false, commits: 1 });
      assert.equal(baseline.saved.dirty, true);
      assert.equal(baseline.saved.head, baseline.headBefore);
      assert.equal(baseline.sameHandoff, true);
      await page.evaluate(() => (window as any).__cloud.begin());
      await page.waitForSelector('.version-merge-preparation');
      assert.equal(await page.evaluate(() => (window as any).__cloud.inspect().text.includes('LOCAL:')), true);
      await page.click('.version-merge-preparation button[type="submit"]');
      await page.waitForSelector('.merge-resolver-window');
      assert.equal(await page.$$eval('.merge-preview-pane', (panes) => panes.filter((pane) => (pane as HTMLElement).checkVisibility()).length), 1);
      await finishReview(page);
      await page.waitForFunction(() => (window as any).__cloudOutcome === true || (window as any).__cloudError);
      assert.equal(await page.evaluate(() => (window as any).__cloudError), null);
      const merged = await page.evaluate(() => (window as any).__cloud.inspect());
      assert.match(merged.text, /:CLOUD/);
      assert.doesNotMatch(merged.text, /LOCAL:/);
      assert.equal(merged.state.shelves.length, 1);
      const mergedHead = merged.state.branches.find((item: any) => item.isActive).headId;
      await page.evaluate(async () => {
        const { controller } = (window as any).__cloud;
        await controller.applyShelf(controller.getState().shelves[0].id, true);
      });
      await finishReview(page);
      const reapplied = await page.evaluate(() => (window as any).__cloud.inspect());
      assert.match(reapplied.text, /LOCAL:/);
      assert.match(reapplied.text, /:CLOUD/);
      assert.equal(reapplied.state.dirty, true);
      assert.equal(reapplied.state.shelves.length, 0);
      assert.equal(reapplied.state.branches.find((item: any) => item.isActive).headId, mergedHead);
      assert.equal(reapplied.state.branches.some((item: any) => item.name.startsWith('보관 ')), false);
    } finally { await page.close(); }
  });
}

test('cloud merge cancellation preserves local edits, and a separate branch owns an explicit local commit', { timeout: 45_000 }, async () => {
  const page = await browser!.newPage();
  try {
    const baseline = await openCloudDocument(page, 'hwp', 'branch');
    await page.evaluate(() => (window as any).__cloud.begin());
    await page.waitForSelector('.version-merge-preparation');
    await page.click('.version-merge-preparation [data-choice="cancel"]');
    await page.waitForFunction(() => (window as any).__cloudOutcome === false);
    const cancelled = await page.evaluate(() => (window as any).__cloud.inspect());
    assert.equal(cancelled.state.branches.find((item: any) => item.isActive).headId, baseline.headBefore);
    assert.match(cancelled.text, /LOCAL:/);
    assert.doesNotMatch(cancelled.text, /:CLOUD/);
    const count = cancelled.state.commits.length;
    await page.evaluate(() => (window as any).__cloud.begin());
    await page.waitForSelector('.version-merge-preparation');
    assert.equal(await page.evaluate(() => (window as any).__cloud.controller.getState().commits.length), count);
    await page.click('.version-merge-preparation input[value="branch"]');
    await page.type('.version-merge-branch-name', '내 편집');
    await page.click('.version-merge-preparation button[type="submit"]');
    await finishReview(page);
    const result = await page.evaluate(async () => {
      const { controller, store } = (window as any).__cloud;
      const state = controller.getState();
      const own = state.branches.find((item: any) => item.name === '내 편집');
      const commit = await store.getCommit(own.headId);
      const compare = await store.getCompareSnapshot(commit.compareSnapshotId);
      return { ...((window as any).__cloud.inspect()), ownText: compare.snapshot.paragraphs.map((p: any) => p.text).join('\n'), parents: commit.parents };
    });
    assert.equal(result.state.activeBranch, 'main');
    assert.deepEqual(result.parents, [baseline.headBefore]);
    assert.match(result.ownText, /LOCAL:/);
    assert.doesNotMatch(result.ownText, /:CLOUD/);
    assert.doesNotMatch(result.text, /LOCAL:/);
    assert.match(result.text, /:CLOUD/);
  } finally { await page.close(); }
});

test('committing local edits on the current branch opens real conflicts and rejects wrong document or digest', { timeout: 45_000 }, async () => {
  const page = await browser!.newPage();
  try {
    await openCloudDocument(page, 'hwp', 'conflict');
    const failures = await page.evaluate(async () => {
      const { controller, checkpoint, startId } = (window as any).__cloud;
      const errors: string[] = [];
      const before = controller.getState().commits.length;
      for (const patch of [{ documentId: 'other-document' }, { sha256: '0'.repeat(64) }, { kind: 'operation' }]) {
        try { await controller.mergeCloudCheckpoint(startId, { ...checkpoint, ...patch }); } catch (error) { errors.push(String(error)); }
      }
      return { errors, unchanged: before === controller.getState().commits.length };
    });
    assert.equal(failures.errors.length, 3);
    assert.equal(failures.unchanged, true);
    await page.evaluate(() => (window as any).__cloud.begin());
    await page.waitForSelector('.version-merge-preparation');
    await page.click('.version-merge-preparation input[value="commit"]');
    await page.click('.version-merge-preparation button[type="submit"]');
    await page.waitForSelector('.merge-conflict-item');
    if (process.env.CLOUD_MERGE_CONFLICT_SCREENSHOT) await page.screenshot({ path: process.env.CLOUD_MERGE_CONFLICT_SCREENSHOT });
    assert.equal(await page.$eval('.merge-resolver-footer .merge-primary-button', (button) => (button as HTMLButtonElement).disabled), true);
    await page.click('.merge-resolution-button:nth-child(3)');
    assert.equal(await page.$$eval('.merge-resolution-button[aria-pressed="true"]', (buttons) => buttons.length), 1);
    await page.click('.merge-conflict-tools > summary');
    await page.click('.merge-bulk-actions button:nth-child(2)');
    await finishReview(page);
    const result = await page.evaluate(async () => {
      const { controller, store } = (window as any).__cloud;
      const state = controller.getState();
      const head = await store.getCommit(state.branches.find((item: any) => item.isActive).headId);
      return { ...((window as any).__cloud.inspect()), parents: head.parents, conflicts: head.merge.conflictCount };
    });
    assert.equal(result.parents.length, 2);
    assert.ok(result.conflicts > 0);
    assert.match(result.text, /:CLOUD/);
    assert.doesNotMatch(result.text, /LOCAL:/);
  } finally { await page.close(); }
});

test('successive cloud turns merge into the active local branch and older signals leave uncommitted edits intact', { timeout: 60_000 }, async () => {
  const page = await browser!.newPage();
  try {
    await openCloudDocument(page, 'hwpx', 'repeat');
    const mainHead = await page.evaluate(async () => {
      const { controller } = (window as any).__cloud;
      await controller.createBranch('검토');
      return controller.getState().branches.find((branch: any) => branch.name === 'main').headId;
    });
    await page.evaluate(() => (window as any).__cloud.begin());
    await finishReview(page);
    const first = await page.evaluate(async () => {
      const cloud = (window as any).__cloud;
      cloud.wasm.insertText(0, 1, 0, 'AFTER_MERGE:');
      cloud.dirty.markDirty('test');
      cloud.eventBus.emit('document-mutated');
      const before = cloud.inspect();
      const applied = await cloud.controller.mergeCloudCheckpoint(cloud.startId, cloud.checkpoint);
      return { before, after: cloud.inspect(), applied };
    });
    assert.equal(first.applied, true);
    assert.equal(first.after.text, first.before.text);
    assert.equal(first.after.state.dirty, true);
    assert.equal(first.after.state.activeBranch, '검토');
    await page.evaluate(async () => {
      const cloud = (window as any).__cloud;
      const { WasmBridge } = await import('/src/core/wasm-bridge.ts');
      const remote = new WasmBridge();
      await remote.initialize();
      remote.loadDocument(cloud.checkpoint.bytes, cloud.checkpoint.fileName);
      remote.insertText(0, 0, remote.getParagraphLength(0, 0), ':NEXT');
      const bytes = remote.exportHwpx();
      remote.releaseDocument();
      cloud.firstCheckpoint = { ...cloud.checkpoint };
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      Object.assign(cloud.checkpoint, { bytes, sha256, byteLength: bytes.length, revision: 2, turn: 2, operationId: 'turn-2' });
      cloud.begin();
    });
    await page.waitForSelector('.version-merge-preparation');
    await page.click('.version-merge-preparation [data-choice="cancel"]');
    await page.waitForFunction(() => (window as any).__cloudOutcome === false);
    // Turn 2 is imported but unmerged. Replaying turn 1 cannot open a review of turn 2.
    const old = await page.evaluate(async () => {
      const cloud = (window as any).__cloud;
      const applied = await cloud.controller.mergeCloudCheckpoint(cloud.startId, cloud.firstCheckpoint);
      return { applied, text: cloud.inspect().text, reviewOpen: Boolean(document.querySelector('.merge-resolver-window')) };
    });
    assert.equal(old.applied, true);
    assert.equal(old.reviewOpen, false);
    assert.equal(old.text, first.after.text);
    await page.evaluate(() => (window as any).__cloud.begin());
    await page.waitForSelector('.version-merge-preparation');
    await page.click('.version-merge-preparation input[value="commit"]');
    await page.click('.version-merge-preparation button[type="submit"]');
    await page.waitForSelector('.merge-resolver-window');
    assert.equal(await page.$('.merge-conflict-item'), null, 'inherited paragraph identities must survive the first merge');
    await finishReview(page);
    const final = await page.evaluate(() => (window as any).__cloud.inspect());
    assert.equal(final.state.activeBranch, '검토');
    assert.equal(final.state.branches.find((branch: any) => branch.name === 'main').headId, mainHead);
    assert.match(final.text, /AFTER_MERGE:/);
    assert.match(final.text, /LOCAL:/);
    assert.match(final.text, /:CLOUD:NEXT/);
  } finally { await page.close(); }
});

test('stash application rolls the editor back on a failed transaction and can be retried', { timeout: 45_000 }, async () => {
  const page = await browser!.newPage();
  try {
    await openCloudDocument(page, 'hwp', 'stash-failure');
    await page.evaluate(() => (window as any).__cloud.begin());
    await page.waitForSelector('.version-merge-preparation');
    await page.click('.version-merge-preparation button[type="submit"]');
    await finishReview(page);
    const merged = await page.evaluate(() => (window as any).__cloud.inspect());
    await page.evaluate(async () => {
      const { controller, store } = (window as any).__cloud;
      const complete = store.completeShelfMerge.bind(store);
      let fail = true;
      store.completeShelfMerge = (input: unknown) => {
        if (fail) { fail = false; throw new Error('Test storage failure'); }
        return complete(input);
      };
      await controller.applyShelf(controller.getState().shelves[0].id, true);
    });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button')?.disabled);
    await page.click('.merge-resolver-footer .merge-primary-button');
    await page.waitForSelector('.merge-action-status[data-kind="error"]');
    const failed = await page.evaluate(() => (window as any).__cloud.inspect());
    assert.equal(failed.text, merged.text);
    assert.equal(failed.state.shelves.length, 1);
    assert.equal(failed.state.branches.find((item: any) => item.isActive).headId, merged.state.branches.find((item: any) => item.isActive).headId);
    await finishReview(page);
    const applied = await page.evaluate(() => (window as any).__cloud.inspect());
    assert.match(applied.text, /LOCAL:/);
    assert.match(applied.text, /:CLOUD/);
    assert.equal(applied.state.shelves.length, 0);
    assert.equal(applied.state.dirty, true);
  } finally { await page.close(); }
});
