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
  '/usr/bin/chromium-browser',
].filter((candidate): candidate is string => Boolean(candidate));

const executablePath = BROWSER_CANDIDATES.find(existsSync);
const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const rhwpRoot = resolve(studioRoot, '..');
const wasmPackageRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? resolve(rhwpRoot, 'pkg');
const wasmPackageAvailable = existsSync(resolve(wasmPackageRoot, 'rhwp.js'))
  && existsSync(resolve(wasmPackageRoot, 'rhwp_bg.wasm'));
const browserSkipReason = !executablePath
  ? 'Chrome or Chromium is unavailable'
  : !wasmPackageAvailable
    ? 'Resolver browser tests require generated rhwp/pkg/rhwp.js and rhwp/pkg/rhwp_bg.wasm; build the WASM package before npm test'
    : null;
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';

test.before(async () => {
  if (browserSkipReason) return;
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-manual-editor-browser-test'),
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
      fs: { allow: [studioRoot, wasmPackageRoot] },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: process.env.CI || process.env.DEPOT_JOB_URL
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      : [],
  });
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
    context.skip(browserSkipReason ?? 'Chrome or Chromium is unavailable');
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

test('rich-text editor changes text and formatting while preserving intervals', { skip: browserSkipReason ?? false }, async (context) => {
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
    const labels = [...editor.querySelectorAll<HTMLElement>('.merge-structured-field > span:first-child')]
      .map((label) => label.textContent ?? '');
    const alignmentOptions = [...editor.querySelectorAll<HTMLOptionElement>('[data-field-path="alignment"] option')]
      .map((option) => option.textContent ?? '');
    editor.querySelector<HTMLButtonElement>('button:last-child')!.click();
    return { family: editor.dataset.editorFamily, payload, labels, alignmentOptions };
  }));
  assert.equal(result?.family, 'rich-text');
  assert.doesNotMatch(result?.labels.join(' ') ?? '', /text|font|bold|alignment|interval/i);
  assert.deepEqual(result?.alignmentOptions, ['왼쪽', '가운데', '오른쪽', '양쪽 맞춤']);
  assert.deepEqual(result?.payload, {
    text: 'Manually merged text', fontSize: 14, bold: true, alignment: 'justify',
    intervals: [{ start: 0, end: 7, color: '#111111' }],
  });
});

test('table editor changes grid cells, formula, and structural operation', { skip: browserSkipReason ?? false }, async (context) => {
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

test('shape/chart editor changes nested geometry, series, and visibility properties', { skip: browserSkipReason ?? false }, async (context) => {
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

test('large values report hidden fields and clone the resolution only once on Apply', { skip: browserSkipReason ?? false }, async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { buildManualConflictEditor } = await import('/src/merge/manual-conflict-editor.ts');
    const current = Object.fromEntries(Array.from(
      { length: 201 },
      (_, index) => [`property${String(index).padStart(3, '0')}`, index],
    ));
    let payload: Record<string, number> | undefined;
    const editor = buildManualConflictEditor({
      conflict: {
        id: 'large', kind: 'document-property', path: ['properties'],
        reason: 'same-field-changed', base: current, current, incoming: current,
        supportsBoth: false, supportsManual: true, fingerprint: 'large-fingerprint',
      },
      initialValue: current,
      onResolve: (value) => { payload = value as Record<string, number>; },
    })!;
    document.body.appendChild(editor);

    const nativeClone = window.structuredClone;
    let cloneCount = 0;
    window.structuredClone = ((value: unknown) => {
      cloneCount += 1;
      return nativeClone(value);
    }) as typeof structuredClone;
    try {
      editor.querySelector<HTMLButtonElement>('button:last-child')!.click();
    } finally {
      window.structuredClone = nativeClone;
    }

    return {
      cloneCount,
      controlCount: editor.querySelectorAll('.merge-structured-field').length,
      hint: [...editor.querySelectorAll('.merge-manual-hint')].map((node) => node.textContent),
      hiddenProperty: payload?.property200,
    };
  }));
  assert.equal(result?.cloneCount, 1);
  assert.equal(result?.controlCount, 200);
  assert.ok(result?.hint.includes('속성이 많아 200개 이후 속성은 숨겼습니다.'));
  assert.equal(result?.hiddenProperty, 200);
});

test('numeric fields reject blank values instead of coercing them to zero', { skip: browserSkipReason ?? false }, async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { buildManualConflictEditor } = await import('/src/merge/manual-conflict-editor.ts');
    let payload: unknown;
    const editor = buildManualConflictEditor({
      conflict: {
        id: 'number', kind: 'shape-geometry', path: ['shapes', '1', 'width'],
        reason: 'same-field-changed', base: 10, current: 20, incoming: 30,
        supportsBoth: false, supportsManual: true, fingerprint: 'number-fingerprint',
      },
      initialValue: 20,
      onResolve: (value) => { payload = value; },
    })!;
    document.body.appendChild(editor);
    editor.querySelector<HTMLInputElement>('input[type="number"]')!.value = '';
    editor.querySelector<HTMLButtonElement>('button:last-child')!.click();
    return { payload, error: editor.querySelector('.merge-manual-error')?.textContent };
  }));
  assert.equal(result?.payload, undefined);
  assert.equal(result?.error, '올바른 숫자를 입력하세요.');
});

test('image editor hides byte data and supports side selection, property edits, and upload', { skip: browserSkipReason ?? false }, async (context) => {
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
      .find((button) => button.textContent === '가져올 이미지 선택')!.click();
    const extension = editor.querySelector<HTMLInputElement>('[data-field-path="extension"] input')!;
    extension.value = 'gif';
    [...editor.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '직접 편집 적용')!.click();
    const upload = editor.querySelector<HTMLInputElement>('input[type="file"]')!;
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1, 2, 3])], 'replacement.webp', { type: 'image/webp' }));
    upload.files = transfer.files;
    upload.dispatchEvent(new Event('change', { bubbles: true }));
    const deadline = performance.now() + 1_000;
    while (resolutions.length < 3) {
      if (performance.now() >= deadline) throw new Error('이미지 업로드 결과를 기다리는 시간이 초과되었습니다.');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
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

test('image upload validates files and ignores stale or detached editor results', { skip: browserSkipReason ?? false }, async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { buildManualConflictEditor } = await import('/src/merge/manual-conflict-editor.ts');
    const current = { kind: 'image-bytes', id: 1, extension: 'png', bytesBase64: 'CURRENT_BYTES' };
    const conflict = {
      id: 'image-guard', kind: 'image-bytes', path: ['resources', 'image-1'],
      reason: 'same-field-changed' as const, base: current, current, incoming: current,
      supportsBoth: false, supportsManual: true, fingerprint: 'image-guard-fingerprint',
    };
    const setFile = (input: HTMLInputElement, file: File) => {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = performance.now() + 1_000;
      while (!condition()) {
        if (performance.now() >= deadline) throw new Error(message);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    };

    let uploadCalls = 0;
    const validationEditor = buildManualConflictEditor({
      conflict,
      initialValue: current,
      onResolve: () => undefined,
      uploadAsset: async () => {
        uploadCalls += 1;
        return {};
      },
    })!;
    document.body.appendChild(validationEditor);
    const validationInput = validationEditor.querySelector<HTMLInputElement>('input[type="file"]')!;
    const validationError = validationEditor.querySelector<HTMLElement>('.merge-manual-error')!;
    setFile(validationInput, new File(['plain text'], 'not-image.txt', { type: 'text/plain' }));
    await waitFor(() => validationError.textContent?.includes('PNG, JPEG, GIF, BMP, WEBP') === true, '이미지 형식 오류가 표시되지 않았습니다.');
    const mimeError = validationError.textContent;
    setFile(validationInput, new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }));
    await waitFor(() => validationError.textContent?.includes('5MB 이하') === true, '이미지 크기 오류가 표시되지 않았습니다.');
    const sizeError = validationError.textContent;
    validationEditor.remove();

    const resolutions: unknown[] = [];
    const pending: Array<(payload: unknown) => void> = [];
    const guardedEditor = buildManualConflictEditor({
      conflict,
      initialValue: current,
      onResolve: (payload) => { resolutions.push(payload); },
      uploadAsset: () => new Promise((resolve) => { pending.push(resolve); }),
    })!;
    document.body.appendChild(guardedEditor);
    const guardedInput = guardedEditor.querySelector<HTMLInputElement>('input[type="file"]')!;
    setFile(guardedInput, new File(['first'], 'first.png', { type: 'image/png' }));
    await waitFor(() => pending.length === 1, '첫 번째 업로드가 시작되지 않았습니다.');
    setFile(guardedInput, new File(['second'], 'second.png', { type: 'image/png' }));
    await waitFor(() => pending.length === 2, '두 번째 업로드가 시작되지 않았습니다.');
    pending[0]!({ upload: 'stale' });
    await Promise.resolve();
    await Promise.resolve();
    guardedEditor.remove();
    pending[1]!({ upload: 'detached' });
    await Promise.resolve();
    await Promise.resolve();

    return { uploadCalls, mimeError, sizeError, resolutions };
  }));
  assert.equal(result?.uploadCalls, 0);
  assert.equal(result?.mimeError, 'PNG, JPEG, GIF, BMP, WEBP 이미지 파일만 올릴 수 있습니다.');
  assert.equal(result?.sizeError, '이미지는 5MB 이하만 올릴 수 있습니다.');
  assert.deepEqual(result?.resolutions, []);
});

test('document property editor covers section, style, numbering, field, and resource values', { skip: browserSkipReason ?? false }, async (context) => {
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

test('atomic conflicts do not construct a manual editor', { skip: browserSkipReason ?? false }, async (context) => {
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

test('manual editor resolutions participate in resolver Undo/Redo and validation gating', { skip: browserSkipReason ?? false }, async (context) => {
  const result = await withPage(context, (page) => page.evaluate(async () => {
    const { MergeResolverWindow } = await import('/src/merge/merge-resolver-window.ts');
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = performance.now() + 2_000;
      while (!condition()) {
        if (performance.now() >= deadline) throw new Error(message);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    };
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
    await waitFor(() => !complete.disabled, '수동 해결 검증이 완료되지 않았습니다.');
    const enabledAfterValidation = !complete.disabled;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    const unresolvedAfterUndo = resolver.snapshot()?.unresolvedCount;
    const disabledAfterUndo = complete.disabled;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
    await waitFor(() => !complete.disabled, '다시 실행 후 검증이 완료되지 않았습니다.');
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

test('default source branch still prompts, disables delete, and dismissal keeps it', { skip: browserSkipReason ?? false }, async (context) => {
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
    copy: '병합을 적용했습니다. “main” 브랜치는 기본 브랜치이므로 유지됩니다.',
    overlayRemoved: true,
  });
});

test('resolver desktop controls click, report failures, retry, and fit macOS chrome', { skip: browserSkipReason ?? false }, async (context) => {
  if (!browser) {
    context.skip(browserSkipReason ?? 'Chrome or Chromium is unavailable');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(async () => {
      const { MergeResolverWindow } = await import('/src/merge/merge-resolver-window.ts');
      document.documentElement.classList.add('desktop-mac');
      const now = Date.now();
      const events = {
        saved: 0,
        discarded: 0,
        completeAttempts: 0,
        finalized: [] as string[],
        closed: [] as string[],
      };
      let releaseComplete: (() => void) | undefined;
      const draft = {
        id: 'desktop-controls-draft', repositoryId: 'repository', targetBranch: 'main', sourceBranch: 'source',
        baseCommitIds: ['base'], currentHead: 'current', sourceHead: 'incoming',
        targetBranchRevision: 1, sourceBranchRevision: 1, mode: 'diverged' as const,
        analysisVersion: 1, conflicts: [], resolutions: {}, automaticResult: {},
        manualAssetBlobIds: [], history: [], historyIndex: 0, createdAt: now, updatedAt: now,
      };
      const harness = {
        events,
        releaseComplete() {
          releaseComplete?.();
          releaseComplete = undefined;
        },
        open() {
          const resolver = new MergeResolverWindow();
          resolver.open({
            draft: structuredClone(draft),
            analysis: { analysisVersion: 1, result: {}, conflicts: [], automaticOperationCount: 3 },
            sourceBranch: 'source', currentBranch: 'main', mode: 'diverged',
            documents: {
              base: { bytes: new Uint8Array(), fileName: 'empty.hwp', label: '기준' },
              current: { bytes: new Uint8Array(), fileName: 'empty.hwp', label: '현재' },
              incoming: { bytes: new Uint8Array(), fileName: 'empty.hwp', label: '가져올 변경' },
            },
            canDeleteSource: true,
            materialize: async () => ({
              tree: {},
              validation: {
                valid: true,
                errors: [],
                checks: { parsed: true, exported: true, reloaded: true, structurallyValid: true },
              },
            }),
            saveDraft: async () => { events.saved += 1; },
            discardDraft: async () => { events.discarded += 1; },
            complete: async () => {
              events.completeAttempts += 1;
              await new Promise<void>((resolve) => { releaseComplete = resolve; });
              if (events.completeAttempts === 1) throw new Error('테스트 저장 실패');
              return {} as any;
            },
            finalizeSourceDisposition: async (_receipt, disposition) => { events.finalized.push(disposition); },
            onClosed: (reason) => { events.closed.push(reason); },
          });
        },
      };
      Object.assign(window, { __mergeResolverHarness: harness });
    });

    for (const viewport of [
      { width: 900, height: 720 },
      { width: 1180, height: 800 },
      { width: 1600, height: 900 },
    ]) {
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
      await page.evaluate(() => (window as any).__mergeResolverHarness.open());
      await page.waitForSelector('.merge-resolver-window');
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button');
        return Boolean(button && !button.disabled);
      });
      const geometry = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('.merge-resolver-window')!;
        const heading = document.querySelector<HTMLElement>('.merge-resolver-heading')!;
        const controls = [
          ...document.querySelectorAll<HTMLButtonElement>('.merge-resolver-header-actions button'),
          document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button')!,
        ];
        const hitTargets = controls.map((button) => {
          const rect = button.getBoundingClientRect();
          return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === button;
        });
        return {
          noHorizontalOverflow: root.scrollWidth <= window.innerWidth,
          headingClearsTrafficLights: heading.getBoundingClientRect().left >= 94,
          controlsInside: controls.every((button) => {
            const rect = button.getBoundingClientRect();
            return rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
          }),
          hitTargets,
        };
      });
      assert.equal(geometry.noHorizontalOverflow, true, `${viewport.width}px resolver overflow`);
      assert.equal(geometry.headingClearsTrafficLights, true, `${viewport.width}px traffic-light overlap`);
      assert.equal(geometry.controlsInside, true, `${viewport.width}px control outside viewport`);
      assert.deepEqual(geometry.hitTargets, [true, true, true]);
      await page.click('.merge-close-button');
      await page.waitForSelector('.merge-resolver-window', { hidden: true });
    }

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(() => (window as any).__mergeResolverHarness.open());
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.merge-primary-button')?.disabled);
    await page.click('.merge-resolver-header-actions .merge-secondary-button');
    await page.waitForSelector('.merge-resolver-window', { hidden: true });

    await page.evaluate(() => {
      (window as any).__mergeResolverHarness.open();
      window.confirm = () => true;
    });
    await page.waitForSelector('.merge-resolver-window');
    await page.click('.merge-resolver-footer .merge-danger-button');
    await page.waitForSelector('.merge-resolver-window', { hidden: true });

    await page.evaluate(() => (window as any).__mergeResolverHarness.open());
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button');
      return Boolean(button && !button.disabled);
    });
    await page.click('.merge-resolver-footer .merge-primary-button');
    await page.waitForFunction(() => (
      document.querySelector('.merge-resolver-footer .merge-primary-button')?.textContent === '처리 중…'
    ));
    await page.evaluate(() => (window as any).__mergeResolverHarness.releaseComplete());
    await page.waitForSelector('.merge-action-status[data-kind="error"]');
    assert.match(
      await page.$eval('.merge-action-status', (node) => node.textContent ?? ''),
      /병합 작업 실패: 테스트 저장 실패/,
    );
    assert.equal(
      await page.$eval('.merge-resolver-footer .merge-primary-button', (node) => (node as HTMLButtonElement).disabled),
      false,
    );
    await page.click('.merge-resolver-footer .merge-primary-button');
    await page.waitForFunction(() => (window as any).__mergeResolverHarness.events.completeAttempts === 2);
    await page.evaluate(() => (window as any).__mergeResolverHarness.releaseComplete());
    await page.waitForSelector('.merge-confirm-overlay');
    assert.equal(await page.$eval('.merge-confirm-dialog h2', (node) => node.textContent), '소스 브랜치');
    assert.equal(await page.$('.merge-action-status:not(:empty)'), null);
    await page.click('.merge-confirm-dialog .merge-secondary-button');
    await page.waitForSelector('.merge-resolver-window', { hidden: true });

    const events = await page.evaluate(() => (window as any).__mergeResolverHarness.events);
    assert.deepEqual(events, {
      saved: 4,
      discarded: 1,
      completeAttempts: 2,
      finalized: ['keep'],
      closed: ['saved', 'saved', 'saved', 'saved', 'discarded', 'completed'],
    });
  } finally {
    await page.close();
  }
});
