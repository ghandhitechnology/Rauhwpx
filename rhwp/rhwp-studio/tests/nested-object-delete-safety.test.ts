import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  canGroupTopLevelBodyObjects,
  canUngroupTopLevelBodyObject,
  sameAddressedObject,
} from '../src/core/object-address.ts';

const picture = readFileSync(
  new URL('../src/engine/input-handler-picture.ts', import.meta.url),
  'utf8',
);
const keyboard = readFileSync(
  new URL('../src/engine/input-handler-keyboard.ts', import.meta.url),
  'utf8',
);
const input = readFileSync(
  new URL('../src/engine/input-handler.ts', import.meta.url),
  'utf8',
);
const insert = readFileSync(
  new URL('../src/command/commands/insert.ts', import.meta.url),
  'utf8',
);
const mouse = readFileSync(
  new URL('../src/engine/input-handler-mouse.ts', import.meta.url),
  'utf8',
);
const cursor = readFileSync(
  new URL('../src/engine/cursor.ts', import.meta.url),
  'utf8',
);

test('unsupported nested object addresses never fall through to body delete APIs', () => {
  const helperStart = picture.indexOf('export function canDeleteObjectControl');
  const helperEnd = picture.indexOf('/**', helperStart + 1);
  const helper = picture.slice(helperStart, helperEnd);
  assert.match(helper, /objectAddressScope\(ref\)/);
  assert.match(helper, /scope === 'body'/);
  assert.match(helper, /scope === 'cell' && ref\.type === 'image'/);

  const commandStart = insert.indexOf("id: 'insert:picture-delete'");
  const commandEnd = insert.indexOf("id: 'insert:group-shapes'", commandStart);
  assert.match(
    insert.slice(commandStart, commandEnd),
    /!isObjectDeleteTargetSupported\(ref\)/,
  );

  const keyStart = keyboard.indexOf("if (e.key === 'Delete' || e.key === 'Backspace')");
  const keyEnd = keyboard.indexOf('// Ctrl+C', keyStart);
  assert.match(keyboard.slice(keyStart, keyEnd), /canDeleteObjectControl\(ref\)/);

  for (const method of ['performCut(): void', 'performDelete(): void']) {
    const start = input.indexOf(method);
    const end = input.indexOf('\n  /**', start + 1);
    assert.match(input.slice(start, end), /_picture\.canDeleteObjectControl\(ref\)/);
  }
});

test('grouping and click-to-front reject nested address domains', () => {
  const groupStart = insert.indexOf("id: 'insert:group-shapes'");
  const groupEnd = insert.indexOf("id: 'insert:ungroup-shapes'", groupStart);
  assert.match(
    insert.slice(groupStart, groupEnd),
    /!canGroupTopLevelBodyObjects\(refs\)/,
  );
  assert.match(insert.slice(groupStart, groupEnd), /ctx\.canGroupSelectedObjects/);

  const ungroupStart = groupEnd;
  const ungroupEnd = insert.indexOf('// ─── 회전/대칭', ungroupStart);
  assert.match(
    insert.slice(ungroupStart, ungroupEnd),
    /!canUngroupTopLevelBodyObject\(ref\)/,
  );
  assert.match(insert.slice(ungroupStart, ungroupEnd), /ctx\.canUngroupSelectedObject/);

  const frontStart = mouse.indexOf('function bringShapeToFront');
  const frontEnd = mouse.indexOf('\n}\n', frontStart) + 2;
  const front = mouse.slice(frontStart, frontEnd);
  assert.match(front, /isTopLevelBodyObject\(picHit\)/);
});

test('nested and non-body group addresses are rejected before body-only APIs', () => {
  const bodyA = { sec: 0, ppi: 0, ci: 0, type: 'shape' };
  const bodyB = { sec: 0, ppi: 1, ci: 0, type: 'image' };
  const cellPath = [{ controlIndex: 2, cellIndex: 0, cellParaIndex: 0 }];

  assert.equal(canGroupTopLevelBodyObjects([bodyA, bodyB]), true);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, cellPath }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, cellIdx: 0 }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, cellParaIdx: 0 }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, outerTableControlIdx: 0 }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, headerFooter: { kind: 'header' } }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, noteRef: { kind: 'footnote' } }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, memoRef: { memoIndex: 0 } }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, memoRef: 0 }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, sec: 1 }]), false);

  assert.equal(canUngroupTopLevelBodyObject({ ...bodyA, type: 'group' }), true);
  assert.equal(canUngroupTopLevelBodyObject({ ...bodyA, type: 'group', cellPath }), false);
});

test('selection identity and hit conversion retain the complete object address', () => {
  const body = { sec: 0, ppi: 0, ci: 0, type: 'line' };
  const nested = {
    ...body,
    cellPath: [{ controlIndex: 2, cellIndex: 0, cellParaIndex: 0 }],
  };
  assert.equal(sameAddressedObject(body, nested), false);
  assert.equal(sameAddressedObject(nested, { ...nested }), true);
  assert.match(cursor, /sameAddressedObject\(r, ref\)/);
  assert.match(cursor, /enterPictureObjectSelectionRef\(ref: PictureSelectionRef\)/);
  assert.match(mouse, /enterPictureObjectSelectionRef\(\{ \.\.\.picHit, type: 'line' \}\)/);
  assert.match(mouse, /enterPictureObjectSelectionRef\(\{ \.\.\.picHit, type: 'shape' \}\)/);
  assert.match(mouse, /enterPictureObjectSelectionRef\(textBoxHit\)/);
  assert.match(input, /findShapeByOuterClick\([\s\S]*item\.cellPath[\s\S]*item\.noteRef[\s\S]*item\.memoRef/);

  const conversionStart = picture.indexOf('function controlToRef');
  const conversionEnd = picture.indexOf('/** 클릭 좌표', conversionStart);
  const conversion = picture.slice(conversionStart, conversionEnd);
  for (const field of ['cellPath', 'headerFooter', 'noteRef', 'memoRef']) {
    assert.match(conversion, new RegExp(`ctrl\\.${field}`), `${field} survives line/shape hit conversion`);
  }
});
