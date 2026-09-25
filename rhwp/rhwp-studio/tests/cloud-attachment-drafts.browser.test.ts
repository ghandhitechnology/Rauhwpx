import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('cloud composer stages images and files without a local hub and restores a failed send', { timeout: 30_000 }, async () => {
  const server = await createServer({
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, open: false }, logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const page = await browser.newPage();
    const address = server.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}`);
    const result = await page.evaluate(async () => {
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
      const { createReferenceLibrary } = await import('/src/ui/agent-sidebar/reference-library.ts');
      const hubCalls: string[] = [];
      const bridge = {
        getConnectionState: () => 'disconnected',
        stageReference: async () => { hubCalls.push('stage'); throw new Error('local hub is off'); },
        discardStagedReference: async () => { hubCalls.push('discard'); },
      } as any;
      const library = createReferenceLibrary({
        bridge,
        getContext: () => ({ threadId: 'cloud-thread', documentId: 'document-1', documentName: 'test.hwpx' }),
      });
      document.body.append(library.page, library.quickAddButton, library.quickUploads);
      library.setDraftMode('cloud');
      const quickAddEnabled = !library.quickAddButton.disabled;
      const image = new File([new Uint8Array([1, 2, 3])], 'figure.png', { type: 'image/png' });
      const documentFile = new File(['cloud document'], 'notes.txt', { type: 'text/plain' });
      library.stageDraftFiles([image, documentFile]);
      await new Promise((done) => setTimeout(done, 0));
      const previewCount = library.quickUploads.querySelectorAll('img.ag-reference-upload-preview').length;
      const readyBeforeSend = !library.hasBlockingDrafts();
      const first = await library.takeReadyCloudDrafts();
      const firstBytes = first.map((file) => [...file.bytes]);
      // A rejected queue operation restores the same files to the composer.
      library.stageDraftFiles(first.map((file) => new File([file.bytes.slice().buffer], file.name, { type: file.mimeType })));
      await new Promise((done) => setTimeout(done, 0));
      const restored = await library.takeReadyCloudDrafts();
      let finishHubStage!: (reference: any) => void;
      bridge.stageReference = async () => {
        hubCalls.push('stage');
        return new Promise((done) => { finishHubStage = done; });
      };
      library.stageDraftFiles([image]);
      await new Promise((done) => setTimeout(done, 0));
      library.setDraftMode('local');
      library.setDraftMode('cloud');
      finishHubStage({
        id: 'stale-local-stage', scope: 'chat', scopeId: 'cloud-thread',
        name: image.name, mimeType: image.type, size: image.size,
        status: 'ready', createdAt: '', expiresAt: '',
      });
      await new Promise((done) => setTimeout(done, 0));
      const afterSwitch = await library.takeReadyCloudDrafts();
      const largeBytes = new Uint8Array(21 * 1024 * 1024);
      library.stageDraftFiles([
        new File([largeBytes], 'large.txt', { type: 'text/plain' }),
        new File([largeBytes], 'large.png', { type: 'image/png' }),
      ]);
      const largeFileAccepted = library.quickUploads.querySelectorAll('.ag-reference-upload-chip').length === 1;
      const imageSizeError = library.quickUploads.querySelector('.ag-reference-quick-error')?.textContent ?? '';
      library.discardDrafts();
      for (let batch = 0; batch < 2; batch++) {
        library.stageDraftFiles(Array.from({ length: 10 }, (_unused, index) =>
          new File(['a'], `file-${batch}-${index}.txt`, { type: 'text/plain' })));
      }
      library.stageDraftFiles([new File(['a'], 'file-21.txt', { type: 'text/plain' })]);
      const draftCount = library.quickUploads.querySelectorAll('.ag-reference-upload-chip').length;
      const countError = library.quickUploads.querySelector('.ag-reference-quick-error')?.textContent ?? '';
      const result = {
        quickAddEnabled, previewCount, readyBeforeSend,
        names: first.map((file) => file.name),
        scopeIds: first.map((file) => file.scopeId),
        firstBytes,
        restoredBytes: restored.map((file) => [...file.bytes]),
        hubCallsBeforeSwitch: hubCalls.slice(0, -2),
        hubCallsAfterSwitch: hubCalls,
        afterSwitchId: afterSwitch[0]?.id,
        largeFileAccepted, imageSizeError,
        draftCount, countError,
      };
      library.dispose();
      return result;
    });
    assert.equal(result.quickAddEnabled, true);
    assert.equal(result.previewCount, 1);
    assert.equal(result.readyBeforeSend, true);
    assert.deepEqual(result.names, ['figure.png', 'notes.txt']);
    assert.deepEqual(result.scopeIds, ['cloud-thread', 'cloud-thread']);
    assert.deepEqual(result.firstBytes, [[1, 2, 3], [...Buffer.from('cloud document')]]);
    assert.deepEqual(result.restoredBytes, result.firstBytes);
    assert.deepEqual(result.hubCallsBeforeSwitch, []);
    assert.deepEqual(result.hubCallsAfterSwitch, ['stage', 'discard']);
    assert.notEqual(result.afterSwitchId, 'stale-local-stage');
    assert.equal(result.largeFileAccepted, true);
    assert.match(result.imageSizeError, /large\.png.*20 MB/);
    assert.equal(result.draftCount, 20);
    assert.match(result.countError, /최대 20개/);
    await page.evaluate(async () => {
      const { saveCloudStartAttachments } = await import('/src/agent/cloud-chat-drafts.ts');
      await saveCloudStartAttachments('retry-after-reload', [{
        id: 'image-stage', name: 'figure.png', mimeType: 'image/png', size: 3,
        bytes: new Uint8Array([1, 2, 3]),
      }, {
        id: 'file-stage', name: 'notes.txt', mimeType: 'text/plain', size: 4,
        bytes: new Uint8Array([4, 5, 6, 7]),
      }]);
    });
    await page.reload();
    const afterReload = await page.evaluate(async () => {
      const { loadCloudStartAttachments, deleteCloudStartAttachments } = await import('/src/agent/cloud-chat-drafts.ts');
      const recovered = await loadCloudStartAttachments('retry-after-reload');
      await deleteCloudStartAttachments('retry-after-reload');
      return {
        ids: recovered?.map((file) => file.id),
        bytes: recovered?.map((file) => [...file.bytes]),
        deleted: await loadCloudStartAttachments('retry-after-reload'),
      };
    });
    assert.deepEqual(afterReload.ids, ['image-stage', 'file-stage']);
    assert.deepEqual(afterReload.bytes, [[1, 2, 3], [4, 5, 6, 7]]);
    assert.equal(afterReload.deleted, null);
  } finally {
    await browser.close();
    await server.close();
  }
});
