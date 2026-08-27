import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adjacentPreviewRole,
  syncPreviewTabState,
  wrappedFocusIndex,
  type PreviewTabElement,
} from '../src/merge/accessibility.ts';
import type { MergePreviewRole } from '../src/merge/domain.ts';

const roles: MergePreviewRole[] = ['base', 'current', 'incoming', 'result'];

class FakeTab implements PreviewTabElement {
  dataset: { role?: string };
  tabIndex = 0;
  attributes = new Map<string, string>();
  constructor(role: MergePreviewRole) { this.dataset = { role }; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}

test('tab state exposes exactly one selected, tabbable preview', () => {
  const tabs = roles.map((role) => new FakeTab(role));
  syncPreviewTabState(tabs, 'incoming');
  assert.deepEqual(tabs.map((tab) => tab.attributes.get('aria-selected')), ['false', 'false', 'true', 'false']);
  assert.deepEqual(tabs.map((tab) => tab.tabIndex), [-1, -1, 0, -1]);
});

test('preview tab keyboard navigation wraps and supports Home/End', () => {
  assert.equal(adjacentPreviewRole(roles, 'base', 'ArrowLeft'), 'result');
  assert.equal(adjacentPreviewRole(roles, 'result', 'ArrowRight'), 'base');
  assert.equal(adjacentPreviewRole(roles, 'incoming', 'Home'), 'base');
  assert.equal(adjacentPreviewRole(roles, 'current', 'End'), 'result');
});

test('focus trap only wraps at the nested dialog boundaries', () => {
  assert.equal(wrappedFocusIndex(0, 3, true), 2);
  assert.equal(wrappedFocusIndex(2, 3, false), 0);
  assert.equal(wrappedFocusIndex(1, 3, false), null);
  assert.equal(wrappedFocusIndex(-1, 3, false), null);
});
