import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workDir = mkdtempSync(path.join(tmpdir(), 'rhwp-picture-move-rotate-preview-'));
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

let removedMouseMove = 0;
globalThis.document = {
  removeEventListener(type) { if (type === 'mousemove') removedMouseMove++; },
};

const picture = await import(srcRoot + 'engine/input-handler-picture.ts');

function harness(stateKey, state) {
  const calls = { previews: [], clears: 0, setters: [], connectors: 0, records: 0, changes: 0, renders: 0 };
  const scrollContent = { clientWidth: 1000, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const host = {
    [stateKey]: state,
    isPictureMoveDragging: stateKey === 'pictureMoveState',
    isPictureRotateDragging: stateKey === 'pictureRotateState',
    dragRafId: 0,
    onMouseMoveBound() {},
    container: { style: {}, querySelector: () => scrollContent },
    viewportManager: { getZoom: () => 1 },
    virtualScroll: {
      getPageAtPoint: () => 0,
      getPageOffset: () => 0,
      getPageWidth: () => 1000,
      getPageLeftResolved: () => 0,
    },
    pictureObjectRenderer: {
      renderDragPreview(bbox, zoom, angle) { calls.previews.push({ bbox, zoom, angle }); },
      clearDragPreview() { calls.clears++; },
    },
    wasm: {
      setPictureProperties(sec, ppi, ci, props) { calls.setters.push({ sec, ppi, ci, props }); },
      updateConnectorsInSection() { calls.connectors++; },
    },
    executeOperation(operation) { if (operation.kind === 'record') calls.records++; },
    eventBus: { emit(name) { if (name === 'document-changed') calls.changes++; } },
    renderPictureObjectSelection() { calls.renders++; },
  };
  return { host, calls };
}

const move = harness('pictureMoveState', {
  ref: { sec: 0, ppi: 1, ci: 2, type: 'image' },
  origHorzOffset: 100,
  origVertOffset: 200,
  startPageX: 2,
  startPageY: 3,
  lastPageX: 2,
  lastPageY: 3,
  totalDeltaH: 0,
  totalDeltaV: 0,
  pageIndex: 0,
  bbox: { x: 5, y: 6, w: 20, h: 10 },
  rotationAngle: 30,
});
const movePointer = { clientX: 12, clientY: 13 };
picture.updatePictureMoveDrag.call(move.host, movePointer);
const moveMotion = {
  previews: [...move.calls.previews], setters: [...move.calls.setters],
  connectors: move.calls.connectors, records: move.calls.records, changes: move.calls.changes,
  state: { ...move.host.pictureMoveState },
};
picture.finishPictureMoveDrag.call(move.host, movePointer);
const moveRelease = { ...move.calls, setters: [...move.calls.setters] };

const rotate = harness('pictureRotateState', {
  ref: { sec: 0, ppi: 1, ci: 2, type: 'image' },
  origAngle: 0,
  centerX: 0,
  centerY: 0,
  startAngle: 0,
  pageIndex: 0,
  bbox: { x: 5, y: 6, w: 20, h: 10 },
  finalAngle: 0,
});
const rotatePointer = { clientX: 0, clientY: 10, ctrlKey: false };
picture.updatePictureRotateDrag.call(rotate.host, rotatePointer);
const rotateMotion = {
  previews: [...rotate.calls.previews], setters: [...rotate.calls.setters],
  records: rotate.calls.records, changes: rotate.calls.changes,
  finalAngle: rotate.host.pictureRotateState.finalAngle,
};
picture.finishPictureRotateDrag.call(rotate.host, rotatePointer);
const rotateRelease = { ...rotate.calls, setters: [...rotate.calls.setters] };

process.stdout.write('###' + JSON.stringify({ moveMotion, moveRelease, rotateMotion, rotateRelease, removedMouseMove }) + '###');
`);

const transformHooks = pathToFileURL(path.join(studioRoot, 'tests', 'support', 'ts-transform-hooks.mjs')).href;
const run = spawnSync(
  process.execPath,
  ['--no-warnings', '--import', transformHooks, driverPath],
  { cwd: studioRoot, encoding: 'utf8' },
);
rmSync(workDir, { recursive: true, force: true });

assert.equal(run.status, 0, `picture move/rotate behavior driver failed:\n${run.stdout}\n${run.stderr}`);
const captured = /###([\s\S]*)###/.exec(run.stdout);
assert.ok(captured, `picture move/rotate result missing:\n${run.stdout}\n${run.stderr}`);
const observed = JSON.parse(captured[1]);

test('picture move motion updates only preview and in-memory delta', () => {
  assert.equal(observed.moveMotion.previews.length, 1);
  assert.equal(observed.moveMotion.state.totalDeltaH, 750);
  assert.equal(observed.moveMotion.state.totalDeltaV, 750);
  assert.deepEqual(observed.moveMotion.setters, []);
  assert.equal(observed.moveMotion.connectors, 0);
  assert.equal(observed.moveMotion.records, 0);
  assert.equal(observed.moveMotion.changes, 0);
});

test('picture move release mutates and updates connectors once', () => {
  assert.equal(observed.moveRelease.setters.length, 1);
  assert.deepEqual(observed.moveRelease.setters[0].props, { horzOffset: 850, vertOffset: 950 });
  assert.equal(observed.moveRelease.connectors, 1);
  assert.equal(observed.moveRelease.records, 1);
  assert.equal(observed.moveRelease.changes, 1);
  assert.equal(observed.moveRelease.clears, 1);
  assert.equal(observed.moveRelease.renders, 1);
});

test('picture rotation motion updates only preview and final angle memory', () => {
  assert.equal(observed.rotateMotion.previews.length, 1);
  assert.equal(observed.rotateMotion.finalAngle, 90);
  assert.deepEqual(observed.rotateMotion.setters, []);
  assert.equal(observed.rotateMotion.records, 0);
  assert.equal(observed.rotateMotion.changes, 0);
});

test('picture rotation release applies and records the final angle once', () => {
  assert.equal(observed.rotateRelease.setters.length, 1);
  assert.deepEqual(observed.rotateRelease.setters[0].props, { rotationAngle: 90 });
  assert.equal(observed.rotateRelease.records, 1);
  assert.equal(observed.rotateRelease.changes, 1);
  assert.equal(observed.rotateRelease.clears, 1);
  assert.equal(observed.rotateRelease.renders, 1);
  assert.equal(observed.removedMouseMove, 2);
});
