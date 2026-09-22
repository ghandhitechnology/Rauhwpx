import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relative: string) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

const main = source('../src/main.ts');
const controller = source('../src/versioning/controller.ts');

test('document replacement and close wait for the current version operation queue', () => {
  assert.match(controller, /#operation = Promise\.resolve\(\)/);
  assert.match(
    controller,
    /async whenIdle\(\): Promise<void> \{[\s\S]*?pending = this\.#operation;[\s\S]*?await pending;[\s\S]*?while \(pending !== this\.#operation\)/,
    'the idle observer includes work added while settling',
  );
  assert.match(main, /let versionControllerRef: DocumentVersionController \| null = null/);
  assert.match(main, /versionControllerRef = versionController/);
  assert.match(
    main,
    /const allowed = skipUnsavedGuard[\s\S]*?if \(!allowed\) return false;\s*await versionControllerRef\?\.whenIdle\(\);\s*return true;/,
  );
});

test('failed document replacement clears and republishes document context', () => {
  assert.match(
    main,
    /async function loadBytes[\s\S]*?docInfo =[\s\S]*?consumeExactLocalFileRead[\s\S]*?wasm\.loadDocument[\s\S]*?catch \(error\) \{[\s\S]*?activeDocumentId = null;\s*eventBus\.emit\('document-context-changed'\)/,
  );
  assert.match(
    main,
    /async function createNewDocument[\s\S]*?catch \(error\) \{[\s\S]*?activeDocumentId = null;\s*eventBus\.emit\('document-context-changed'\)/,
  );
  assert.match(
    controller,
    /on\('document-context-changed', \(\) => \{[\s\S]*?void this\.refresh\(\)/,
  );
});

test('opening a canonical history archive keeps its handle while legacy folder imports release theirs', () => {
  assert.match(main, /userSettings\.setUseHancomGit\(true\)/);
  assert.match(
    main,
    /retainPortableHistoryHandle[\s\S]*?!isLegacyPortableHistoryFolderHandle\(data\.fileHandle\)[\s\S]*?isPortableHistoryFileName/,
  );
  assert.match(
    main,
    /retainPortableHistoryHandle \? data\.fileHandle : null/,
  );
  assert.match(
    main,
    /if \(!retainPortableHistoryHandle\) \{[\s\S]*?releaseUnusedSaveTarget/,
  );
  const fileCommands = source('../src/command/commands/file.ts');
  assert.match(
    fileCommands,
    /await writeBlobToHandle\(currentHandle, historyBlob, services\.validateSaveHandle\);\s*completePortableHistorySave/,
  );
  assert.match(
    fileCommands,
    /targetHandle = await windowLike\.showSaveFilePicker[\s\S]*?if \(targetHandle\)[\s\S]*?await writeBlobToHandle\(targetHandle[\s\S]*?completePortableHistorySave/,
  );
  assert.match(fileCommands, /if \(targetHandle === null\) return 'cancelled'/);
  assert.match(fileCommands, /id: 'file:import-legacy-history'/);
  assert.match(
    fileCommands,
    /isPortableHistoryFileName\(services\.wasm\.fileName\)[\s\S]*?return saveWithHistory\(services\)/,
  );
});
