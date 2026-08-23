import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';

test.before(async () => {
  if (!executablePath) return;
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-manual-editor-browser-test'),
    logLevel: 'silent',
    resolve: {
      alias: {
        '@': resolve(studioRoot, 'src'),
        '@wasm/rhwp.js': resolve(rhwpRoot, 'pkg/rhwp.js'),
        '@wasm': resolve(rhwpRoot, 'pkg'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      fs: { allow: [studioRoot, resolve(rhwpRoot, 'pkg')] },
    },
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

async function withPage<T>(
  context: test.TestContext,
  action: (page: import('puppeteer-core').Page) => Promise<T>,
): Promise<T | undefined> {
  if (!browser) {
    context.skip('Chrome or Chromium is unavailable');
    return undefined;
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    return await action(page);
  } finally {
    await page.close();
  }
}

test('rich-text editor changes text and formatting while preserving intervals', async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { buildManualConflictEditor } = await import('/src/merge/manual-conflict-editor.ts');
    const current = {
      text: 'Current text',
      fontSize: 11,
      bold: false,
      alignment: 'left',
      intervals: [{ start: 0, end: 7, color: '#111111' }],
    };
    let payload: unknown;
    const editor = buildManualConflictEditor({
      conflict: {
        id: 'rich', kind: 'formatting', path: ['paragraphs', '0', 'formatting'],
        reason: 'same-field-changed', base: current, current,
        incoming: { ...current, text: 'Incoming text' }, supportsBoth: false,
        supportsManual: true, fingerprint: 'rich-fingerprint',
      },
      initialValue: current,
      onResolve: (value) => { payload = value; },
    })!;
    document.body.appendChild(editor);
    const set = (path: string, value: string, checked?: boolean) => {
      const control = editor.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        `[data-field-path="${path}"] input, [data-field-path="${path}"] textarea, [data-field-path="${path}"] select`,
      )!;
      control.value = value;
      if (checked !== undefined && control instanceof HTMLInputElement) control.checked = checked;
    };
    set('text', 'Manually merged text');
    set('fontSize', '14');
    set('bold', '', true);
    set('alignment', 'justify');
    editor.querySelector<HTMLButtonElement>('button:last-child')!.click();
    return { family: editor.dataset.editorFamily, payload };
  }));
  assert.equal(result?.family, 'rich-text');
  assert.deepEqual(result?.payload, {
    text: 'Manually merged text', fontSize: 14, bold: true, alignment: 'justify',
    intervals: [{ start: 0, end: 7, color: '#111111' }],
  });
});

test('table editor changes grid cells, formula, and structural operation', async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { buildManualConflictEditor } = await import('/src/merge/manual-conflict-editor.ts');
    const current = {
      rowCount: 2,
      colCount: 2,
      structureOperation: 'insert-row',
      formula: 'SUM(A1:A2)',
      cells: [[{ value: 'A1' }, { value: 'B1' }], [{ value: 'A2' }, { value: 'B2' }]],
    };
    let payload: unknown;
    const editor = buildManualConflictEditor({
      conflict: {
        id: 'table', kind: 'table-structure', path: ['tables', '0'],
        reason: 'same-field-changed', base: current, current, incoming: current,
        supportsBoth: false, supportsManual: true, fingerprint: 'table-fingerprint',
      },
      initialValue: current,
      onResolve: (value) => { payload = value; },
    })!;
    document.body.appendChild(editor);
    const control = (path: string) => editor.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[data-field-path="${path}"] input, [data-field-path="${path}"] textarea, [data-field-path="${path}"] select`,
    )!;
    control('cells.0.1.value').value = 'Merged B1';
    control('formula').value = 'SUM(A1:B2)';
    control('structureOperation').value = 'merge-cells';
    editor.querySelector<HTMLButtonElement>('button:last-child')!.click();
    return { family: editor.dataset.editorFamily, hasGrid: Boolean(editor.querySelector('.merge-table-grid')), payload };
  }));
  assert.equal(result?.family, 'table');
  assert.equal(result?.hasGrid, true);
  assert.equal((result?.payload as any).cells[0][1].value, 'Merged B1');
  assert.equal((result?.payload as any).formula, 'SUM(A1:B2)');
  assert.equal((result?.payload as any).structureOperation, 'merge-cells');
  assert.equal((result?.payload as any).cells[1][1].value, 'B2');
});

test('shape/chart editor changes nested geometry, series, and visibility properties', async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { buildManualConflictEditor } = await import('/src/merge/manual-conflict-editor.ts');
    const current = {
      title: 'Sales', visible: true,
      geometry: { x: 10, y: 20, width: 300, height: 180 },
      series: [{ name: 'Q1', values: [1, 2] }],
    };
    let payload: unknown;
    const editor = buildManualConflictEditor({
      conflict: {
        id: 'chart', kind: 'chart-series', path: ['shapes', 'chart-1'],
        reason: 'same-field-changed', base: current, current, incoming: current,
        supportsBoth: false, supportsManual: true, fingerprint: 'chart-fingerprint',
      },
      initialValue: current,
      onResolve: (value) => { payload = value; },
    })!;
    document.body.appendChild(editor);
    const input = (path: string) => editor.querySelector<HTMLInputElement>(`[data-field-path="${path}"] input`)!;
    input('geometry.width').value = '420';
    input('series.0.name').value = 'Merged series';
    input('visible').checked = false;
    editor.querySelector<HTMLButtonElement>('button:last-child')!.click();
    return { family: editor.dataset.editorFamily, payload };
  }));
  assert.equal(result?.family, 'shape-chart');
  assert.equal((result?.payload as any).geometry.width, 420);
  assert.equal((result?.payload as any).series[0].name, 'Merged series');
  assert.equal((result?.payload as any).visible, false);
  assert.equal((result?.payload as any).geometry.height, 180);
});

test('image editor hides byte data and supports side selection, property edits, and upload', async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { buildManualConflictEditor } = await import('/src/merge/manual-conflict-editor.ts');
    const current = { kind: 'image-bytes', id: 1, extension: 'png', bytesBase64: 'CURRENT_BYTES' };
    const incoming = { kind: 'image-bytes', id: 1, extension: 'webp', bytesBase64: 'INCOMING_BYTES' };
    const resolutions: unknown[] = [];
    const editor = buildManualConflictEditor({
      conflict: {
        id: 'image', kind: 'image-bytes', path: ['resources', 'image-1'],
        reason: 'same-field-changed', base: current, current, incoming,
        supportsBoth: false, supportsManual: true, fingerprint: 'image-fingerprint',
      },
      initialValue: current,
      onResolve: (value) => { resolutions.push(value); },
      onChooseSide: (side) => { resolutions.push({ side }); },
      uploadAsset: async (file) => ({ kind: 'image-bytes', id: 1, extension: file.name.split('.').at(-1), bytesBase64: 'UPLOADED' }),
    })!;
    document.body.appendChild(editor);
    const hiddenBytes = editor.querySelector('[data-field-path="bytesBase64"]') === null;
    [...editor.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Select incoming image')!.click();
    const extension = editor.querySelector<HTMLInputElement>('[data-field-path="extension"] input')!;
    extension.value = 'gif';
    [...editor.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.startsWith('Apply image'))!.click();
    const upload = editor.querySelector<HTMLInputElement>('input[type="file"]')!;
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1, 2, 3])], 'replacement.webp', { type: 'image/webp' }));
    upload.files = transfer.files;
    upload.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve));
    return { family: editor.dataset.editorFamily, hiddenBytes, resolutions };
  }));
  assert.equal(result?.family, 'image');
  assert.equal(result?.hiddenBytes, true);
  assert.deepEqual(result?.resolutions, [
    { side: 'incoming' },
    { kind: 'image-bytes', id: 1, extension: 'gif', bytesBase64: 'CURRENT_BYTES' },
    { kind: 'image-bytes', id: 1, extension: 'webp', bytesBase64: 'UPLOADED' },
  ]);
});

test('document property editor covers section, style, numbering, field, and resource values', async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { buildManualConflictEditor } = await import('/src/merge/manual-conflict-editor.ts');
    const fixtures = [
      ['section-property', { pageWidth: 210, landscape: false }],
      ['style', { name: 'Body', basedOn: 'Normal', fontSize: 10 }],
      ['numbering', { level: 1, start: 1 }],
      ['field-properties', { fieldType: 'date', value: '2026-08-23', locked: false }],
      ['resource-reference', { resourceId: 7, path: 'media/image.png' }],
    ] as const;
    const outputs: Array<{ family?: string; payload?: unknown; controlCount: number }> = [];
    for (const [kind, current] of fixtures) {
      let payload: unknown;
      const editor = buildManualConflictEditor({
        conflict: {
          id: kind, kind, path: ['docInfo', kind], reason: 'same-field-changed',
          base: current, current, incoming: current, supportsBoth: false,
          supportsManual: true, fingerprint: `${kind}-fingerprint`,
        },
        initialValue: current,
        onResolve: (value) => { payload = value; },
      })!;
      document.body.appendChild(editor);
      const first = editor.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        '.merge-structured-field input, .merge-structured-field textarea, .merge-structured-field select',
      )!;
      if (first instanceof HTMLInputElement && first.type === 'checkbox') first.checked = !first.checked;
      else if (first instanceof HTMLInputElement && first.type === 'number') first.value = String(Number(first.value) + 1);
      else first.value = `${first.value}-merged`;
      editor.querySelector<HTMLButtonElement>('button:last-child')!.click();
      outputs.push({ family: editor.dataset.editorFamily, payload, controlCount: editor.querySelectorAll('.merge-structured-field').length });
      editor.remove();
    }
    return outputs;
  }));
  assert.equal(result?.length, 5);
  for (const output of result ?? []) {
    assert.equal(output.family, 'document-properties');
    assert.ok(output.controlCount >= 2);
    assert.ok(output.payload);
  }
});

test('atomic conflicts do not construct a manual editor', async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { buildManualConflictEditor } = await import('/src/merge/manual-conflict-editor.ts');
    return buildManualConflictEditor({
      conflict: {
        id: 'atomic', kind: 'unknown-control', path: ['controls', 'opaque'],
        reason: 'unknown-control-modified', base: { kind: 'hash', hash: 'a' },
        current: { kind: 'hash', hash: 'b' }, incoming: { kind: 'hash', hash: 'c' },
        supportsBoth: false, supportsManual: false, fingerprint: 'atomic-fingerprint',
      },
      initialValue: { kind: 'hash', hash: 'b' },
      onResolve: () => undefined,
    }) === null;
  }));
  assert.equal(result, true);
});

test('manual editor resolutions participate in resolver Undo/Redo and validation gating', async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { MergeResolverWindow } = await import('/src/merge/merge-resolver-window.ts');
    const now = Date.now();
    const conflict = {
      id: 'undo-text', kind: 'text', path: ['sections', '0', 'paragraphs', '0', 'text'],
      reason: 'same-field-changed' as const, base: 'Base', current: 'Current', incoming: 'Incoming',
      supportsBoth: false, supportsManual: true, fingerprint: 'undo-text-fingerprint',
    };
    const draft = {
      id: 'undo-draft', repositoryId: 'repository', targetBranch: 'main', sourceBranch: 'source',
      baseCommitIds: ['base'], currentHead: 'current', sourceHead: 'incoming',
      targetBranchRevision: 1, sourceBranchRevision: 1, mode: 'diverged' as const,
      analysisVersion: 1, conflicts: [conflict], resolutions: {}, automaticResult: {},
      manualAssetBlobIds: [], history: [], historyIndex: 0, createdAt: now, updatedAt: now,
    };
    const resolver = new MergeResolverWindow();
    const closed = resolver.open({
      draft,
      analysis: { analysisVersion: 1, result: {}, conflicts: [conflict], automaticOperationCount: 0 },
      sourceBranch: 'source', currentBranch: 'main', mode: 'diverged',
      documents: {
        base: { bytes: new Uint8Array(), fileName: 'empty.hwp' },
        current: { bytes: new Uint8Array(), fileName: 'empty.hwp' },
        incoming: { bytes: new Uint8Array(), fileName: 'empty.hwp' },
      },
      materialize: async () => ({
        tree: {},
        validation: { valid: true, errors: [], checks: { parsed: true, exported: true, reloaded: true, structurallyValid: true } },
      }),
      saveDraft: async () => undefined,
      discardDraft: async () => undefined,
      complete: async () => ({} as any),
      finalizeSourceDisposition: async () => undefined,
    });
    const complete = document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button')!;
    const initiallyDisabled = complete.disabled;
    const textarea = document.querySelector<HTMLTextAreaElement>('.merge-manual-family-rich-text textarea')!;
    textarea.value = 'Manual text';
    document.querySelector<HTMLButtonElement>('.merge-manual-family-rich-text .merge-structured-fields > button')!.click();
    const resolutionAfterApply = resolver.snapshot()?.resolutions['undo-text'];
    const disabledBeforeValidation = complete.disabled;
    await new Promise((resolve) => setTimeout(resolve, 220));
    const enabledAfterValidation = !complete.disabled;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    const unresolvedAfterUndo = resolver.snapshot()?.unresolvedCount;
    const disabledAfterUndo = complete.disabled;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 220));
    const resolutionAfterRedo = resolver.snapshot()?.resolutions['undo-text'];
    const enabledAfterRedoValidation = !complete.disabled;
    await resolver.close();
    await closed;
    return {
      initiallyDisabled,
      resolutionAfterApply,
      disabledBeforeValidation,
      enabledAfterValidation,
      unresolvedAfterUndo,
      disabledAfterUndo,
      resolutionAfterRedo,
      enabledAfterRedoValidation,
    };
  }));
  assert.deepEqual(result, {
    initiallyDisabled: true,
    resolutionAfterApply: { kind: 'manual', payload: 'Manual text' },
    disabledBeforeValidation: true,
    enabledAfterValidation: true,
    unresolvedAfterUndo: 1,
    disabledAfterUndo: true,
    resolutionAfterRedo: { kind: 'manual', payload: 'Manual text' },
    enabledAfterRedoValidation: true,
  });
});

test('default source branch still prompts, disables delete, and dismissal keeps it', async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { MergeResolverWindow } = await import('/src/merge/merge-resolver-window.ts');
    const resolver = new MergeResolverWindow();
    const resolverRoot = document.createElement('div');
    document.body.appendChild(resolverRoot);
    Object.assign(resolver as any, {
      root: resolverRoot,
      options: { sourceBranch: 'main', canDeleteSource: false },
    });
    const disposition = (resolver as any).requestSourceDisposition() as Promise<'keep' | 'delete'>;
    const overlay = document.querySelector<HTMLElement>('.merge-confirm-overlay')!;
    const select = overlay.querySelector<HTMLSelectElement>('.merge-source-select')!;
    const deleteOption = select.querySelector<HTMLOptionElement>('option[value="delete"]')!;
    const copy = overlay.querySelector('p')!.textContent;
    overlay.click();
    return {
      disposition: await disposition,
      deleteDisabled: deleteOption.disabled,
      copy,
      overlayRemoved: !document.querySelector('.merge-confirm-overlay'),
    };
  }));
  assert.deepEqual(result, {
    disposition: 'keep',
    deleteDisabled: true,
    copy: 'The merge is applied. “main” is a default branch and must be kept.',
    overlayRemoved: true,
  });
});
