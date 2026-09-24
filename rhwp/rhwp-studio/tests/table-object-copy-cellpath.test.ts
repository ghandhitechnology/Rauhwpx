import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('selected nested table copy resolves the containing cell paragraph and inner control', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { tableControlCopyAddress } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
    const outer = { controlIndex: 1, cellIndex: 5, cellParaIndex: 4 };
    const inner = { controlIndex: 0, cellIndex: 3, cellParaIndex: 0 };
    assert.deepEqual(tableControlCopyAddress({ ci: 1, cellPath: [outer, inner] }), {
      controlIndex: 0,
      cellPathJson: JSON.stringify([outer]),
    });
    assert.deepEqual(tableControlCopyAddress({ ci: 1, cellPath: [outer] }), {
      controlIndex: 1,
      cellPathJson: '',
    });
  } finally {
    await vite.close();
  }
});
