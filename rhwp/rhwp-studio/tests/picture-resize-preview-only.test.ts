import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workDir = mkdtempSync(path.join(tmpdir(), 'rhwp-picture-resize-preview-'));
const driverPath = path.join(workDir, 'driver.mjs');

writeFileSync(driverPath, `
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const srcRoot = ${JSON.stringify(pathToFileURL(path.join(studioRoot, 'src') + path.sep).href)};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) return nextResolve(srcRoot + specifier.slice(2) + '.ts', context);
    if (/^\\.{1,2}\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

let removedDocumentMouseMove = 0;
globalThis.document = {
  removeEventListener(type) { if (type === 'mousemove') removedDocumentMouseMove++; },
};

const picture = await import(srcRoot + 'engine/input-handler-picture.ts');
const calls = { preview: [], clearPreview: 0, mutations: [], operations: [], events: [], renders: 0 };
const host = {
  pictureResizeState: {
    dir: 'se',
    ref: { sec: 0, ppi: 1, ci: 2, type: 'image' },
    origWidth: 750,
    origHeight: 600,
    origHorzOffset: 150,
    origVertOffset: 225,
    startClientX: 0,
    startClientY: 0,
    pageIndex: 0,
    bbox: { x: 2, y: 3, w: 10, h: 8 },
    rotationAngle: 0,
  },
  isPictureResizeDragging: true,
  dragRafId: 0,
  onMouseMoveBound() {},
  container: { style: {} },
  viewportManager: { getZoom: () => 1 },
  pictureObjectRenderer: {
    renderDragPreview(bbox, zoom, angle) { calls.preview.push({ bbox, zoom, angle }); },
    clearDragPreview() { calls.clearPreview++; },
  },
  wasm: {
    getPictureProperties() { return { sizeProtect: false }; },
    setPictureProperties(sec, ppi, ci, props) { calls.mutations.push({ sec, ppi, ci, props }); },
  },
  eventBus: { emit(name) { calls.events.push(name); } },
  executeOperation(operation) { calls.operations.push(operation.kind); },
  cleanupPictureResizeDrag() { picture.cleanupPictureResizeDrag.call(host); },
  renderPictureObjectSelection() { calls.renders++; },
};

const pointer = { clientX: 10, clientY: 6 };
picture.updatePictureResizeDrag.call(host, pointer);
const afterMove = {
  previews: calls.preview.length,
  mutations: calls.mutations.length,
  operations: calls.operations.length,
  documentChanged: calls.events.filter((name) => name === 'document-changed').length,
};

picture.finishPictureResizeDrag.call(host, pointer);
const afterRelease = {
  mutations: calls.mutations.length,
  operations: calls.operations.length,
  documentChanged: calls.events.filter((name) => name === 'document-changed').length,
  removedDocumentMouseMove,
  clearPreview: calls.clearPreview,
  renders: calls.renders,
};

process.stdout.write('###' + JSON.stringify({ afterMove, afterRelease, calls }) + '###');
`);

const transformHooks = pathToFileURL(path.join(studioRoot, 'tests', 'support', 'ts-transform-hooks.mjs')).href;
const run = spawnSync(
  process.execPath,
  ['--no-warnings', '--import', transformHooks, driverPath],
  { cwd: studioRoot, encoding: 'utf8' },
);
rmSync(workDir, { recursive: true, force: true });

assert.equal(run.status, 0, `picture resize behavior driver failed:\n${run.stdout}\n${run.stderr}`);
const captured = /###([\s\S]*)###/.exec(run.stdout);
assert.ok(captured, `picture resize behavior result missing:\n${run.stdout}\n${run.stderr}`);
const observed = JSON.parse(captured[1]);

test('picture resize mousemove is preview-only', () => {
  assert.deepEqual(observed.afterMove, {
    previews: 1,
    mutations: 0,
    operations: 0,
    documentChanged: 0,
  });
});

test('picture resize mouseup applies one mutation and one undo record', () => {
  assert.equal(observed.afterRelease.mutations, 1);
  assert.equal(observed.afterRelease.operations, 1);
  assert.equal(observed.afterRelease.documentChanged, 1);
  assert.equal(observed.afterRelease.removedDocumentMouseMove, 1);
  assert.equal(observed.afterRelease.clearPreview, 1);
  assert.equal(observed.afterRelease.renders, 1);
  assert.deepEqual(observed.calls.operations, ['record']);
});
