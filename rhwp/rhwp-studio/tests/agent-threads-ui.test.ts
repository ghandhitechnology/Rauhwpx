import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const documentSwitchSource = source.slice(
  source.indexOf('function handleDocumentSwitch'),
  source.indexOf('\n  function setConfigPanelOpen', source.indexOf('function handleDocumentSwitch')),
);

test('saving a document rebinds the current chat instead of starting a new one', () => {
  assert.match(
    documentSwitchSource,
    /const sameIdentity = Boolean\(\s*nextDocumentId && currentDocumentId && nextDocumentId === currentDocumentId/s,
  );
  assert.match(documentSwitchSource, /const activeThreadMatchesDocument = readOnlyDocLabel === null[\s\S]*threadMatchesDocument\(currentThread, currentDocumentId, currentDocKey\)/);
  assert.match(documentSwitchSource, /if \(activeThreadMatchesDocument\) \{\s*currentThread\.docKey = nextKey;\s*currentThread\.documentId = nextDocumentId;/);
});
