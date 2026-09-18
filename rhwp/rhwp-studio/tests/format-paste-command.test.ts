import test from 'node:test';
import assert from 'node:assert/strict';

import { canExecuteFormatPaste } from '../src/command/format-paste-availability.ts';

function ctx(overrides: Partial<Parameters<typeof canExecuteFormatPaste>[0]> = {}) {
  return {
    hasDocument: true,
    hasCopiedFormat: true,
    isFormMode: false,
    hasSelection: true,
    inCellSelectionMode: false,
    ...overrides,
  };
}

test('모양 붙여넣기는 복사 상태와 적용 대상이 있을 때만 활성화된다', () => {
  assert.equal(canExecuteFormatPaste(ctx()), true);
  assert.equal(canExecuteFormatPaste(ctx({ hasSelection: false, inCellSelectionMode: true })), true);
  assert.equal(canExecuteFormatPaste(ctx({ hasDocument: false })), false);
  assert.equal(canExecuteFormatPaste(ctx({ hasCopiedFormat: false })), false);
  assert.equal(canExecuteFormatPaste(ctx({ isFormMode: true })), false);
  assert.equal(canExecuteFormatPaste(ctx({ hasSelection: false, inCellSelectionMode: false })), false);
});
