import assert from 'node:assert/strict';
import test from 'node:test';

import { contextualEditingToolbarMode, contextualObjectCommandEnabled } from '../src/ui/contextual-editing-toolbar.ts';

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
