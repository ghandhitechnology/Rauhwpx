import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canGroupTopLevelBodyObjects, canUngroupTopLevelBodyObject, sameAddressedObject } from '../src/core/object-address.ts';

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
