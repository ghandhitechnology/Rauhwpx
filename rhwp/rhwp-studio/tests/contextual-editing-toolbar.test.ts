import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  contextualEditingToolbarMode,
  contextualObjectCommandEnabled,
} from '../src/ui/contextual-editing-toolbar.ts';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const inputHandler = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');

test('일반 문서에서는 기본 도구 모음을 유지한다', () => {
  assert.equal(contextualEditingToolbarMode({
    objectSelected: false,
    inTable: false,
    headerFooterActive: false,
    noteActive: false,
  }), 'default');
});

test('개체와 표 상태는 주변 편집 모드보다 우선한다', () => {
  assert.equal(contextualEditingToolbarMode({
    objectSelected: true,
    inTable: true,
    headerFooterActive: true,
    noteActive: true,
  }), 'object');
  assert.equal(contextualEditingToolbarMode({
    objectSelected: false,
    inTable: true,
    headerFooterActive: true,
    noteActive: true,
  }), 'table');
});

test('주석과 머리말 편집 모드의 우선순위를 결정한다', () => {
  assert.equal(contextualEditingToolbarMode({
    objectSelected: false,
    inTable: false,
    headerFooterActive: true,
    noteActive: true,
  }), 'note');
  assert.equal(contextualEditingToolbarMode({
    objectSelected: false,
    inTable: false,
    headerFooterActive: true,
    noteActive: false,
  }), 'header-footer');
});

test('개체와 표 모드는 한컴식 문맥 도구와 선택 이벤트에 연결된다', () => {
  assert.match(html, /data-toolbar-mode="object"/);
  assert.match(html, /data-toolbar-mode="table"/);
  assert.match(html, /data-cmd="insert:arrange-front"/);
  assert.match(html, /data-cmd="table:cell-props"/);
  assert.match(html, /data-cmd="table:cell-merge"/);
  assert.match(main, /eventBus\.on\('picture-object-selection-changed'/);
  assert.match(main, /eventBus\.on\('table-object-selection-changed'/);
  assert.match(inputHandler, /cursor\.exitPictureObjectSelection\(\)/);
  assert.match(inputHandler, /pictureObjectRenderer\?\.clear\(\)/);
  assert.match(inputHandler, /cursor\.exitTableObjectSelection\(\)/);
  assert.match(inputHandler, /tableObjectRenderer\?\.clear\(\)/);
  assert.match(inputHandler, /cursor\.exitCellSelectionMode\(\)/);
  assert.match(inputHandler, /cellSelectionRenderer\?\.clear\(\)/);
  assert.match(inputHandler, /eventBus\.emit\('picture-object-selection-changed', false\)/);
  assert.match(inputHandler, /eventBus\.emit\('table-object-selection-changed', false\)/);
  assert.match(main, /setBasicToolboxExpanded\(true\)/);
});

test('문서 교체는 기존 편집 상태를 WASM 교체 전에 해제한다', () => {
  const loadStart = main.indexOf('async function loadBytes');
  const loadEnd = main.indexOf('/** 파일 메뉴', loadStart);
  const loadBlock = main.slice(loadStart, loadEnd);
  assert.ok(
    loadBlock.indexOf('inputHandler?.deactivate()') < loadBlock.indexOf('wasm.loadDocument'),
  );

  const createStart = main.indexOf('async function createNewDocument');
  const createEnd = main.indexOf('\nasync function', createStart + 1);
  const createBlock = main.slice(createStart, createEnd);
  assert.ok(
    createBlock.indexOf('inputHandler?.deactivate()') < createBlock.indexOf('wasm.createNewDocument'),
  );
});

test('개체 문맥 버튼은 실제 선택 종류와 개수에 맞게 활성화된다', () => {
  const picture = {
    kind: 'image', count: 1, topLevel: true,
    arrangeable: true, groupable: false, ungroupable: false,
    deletable: true, propertyEditable: true,
  };
  assert.equal(contextualObjectCommandEnabled('insert:arrange-front', picture), true);
  assert.equal(contextualObjectCommandEnabled('insert:group-shapes', picture), false);
  assert.equal(contextualObjectCommandEnabled('insert:ungroup-shapes', picture), false);
  assert.equal(contextualObjectCommandEnabled('insert:group-shapes', {
    ...picture, count: 2, groupable: true,
  }), true);
  assert.equal(contextualObjectCommandEnabled('insert:arrange-front', {
    ...picture, topLevel: false, arrangeable: false,
  }), false);
  assert.equal(contextualObjectCommandEnabled('insert:ungroup-shapes', {
    kind: 'group',
    count: 1,
    topLevel: true,
    arrangeable: true,
    groupable: false,
    ungroupable: true,
    deletable: true,
    propertyEditable: true,
  }), true);
  assert.equal(contextualObjectCommandEnabled('insert:ungroup-shapes', {
    kind: 'group',
    count: 1,
    topLevel: false,
    arrangeable: false,
    groupable: false,
    ungroupable: false,
    deletable: false,
    propertyEditable: true,
  }), false);
  assert.equal(contextualObjectCommandEnabled('insert:picture-delete', {
    ...picture,
    topLevel: false,
    deletable: false,
  }), false);
  assert.equal(contextualObjectCommandEnabled('insert:picture-props', {
    ...picture,
    propertyEditable: false,
  }), false);
});
