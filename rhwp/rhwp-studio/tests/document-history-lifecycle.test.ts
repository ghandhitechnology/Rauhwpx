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
    /async whenIdle\(\): Promise<void> \{[\s\S]*?this\.#queueApprovalCheckpoint\(\);[\s\S]*?pending = this\.#operation;[\s\S]*?await pending;[\s\S]*?while \(pending !== this\.#operation\)/,
    'the idle observer must queue deferred approval work and include work added while settling',
  );
  assert.match(
    controller,
    /#queueApprovalCheckpoint\(\): void \{[\s\S]*?clearTimeout\(this\.#pendingApprovalTimer\)[\s\S]*?void this\.#enqueue\(/,
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
    /docInfo = wasm\.loadDocument[\s\S]*?catch \(error\) \{[\s\S]*?activeDocumentId = null;\s*eventBus\.emit\('document-context-changed'\)/,
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

test('opening a portable history package enables native version control and keeps the bundle handle', () => {
  assert.match(main, /userSettings\.setUseHancomGit\(true\)/);
  assert.match(
    main,
    /retainNativeBundleHandle[\s\S]*?identityKind === 'native-path'[\s\S]*?isPortableHistoryFileName/,
  );
  assert.match(
    main,
    /retainNativeBundleHandle \? data\.fileHandle : null/,
  );
  assert.match(
    main,
    /if \(!retainNativeBundleHandle\) \{[\s\S]*?releaseUnusedSaveTarget/,
  );
  const fileCommands = source('../src/command/commands/file.ts');
  assert.match(fileCommands, /writeDesktopPortableHistoryFile\(currentHandle, bundle\)/);
  assert.match(
    fileCommands,
    /isPortableHistoryFileName\(services\.wasm\.fileName\)[\s\S]*?return saveWithHistory\(services\)/,
  );
});
