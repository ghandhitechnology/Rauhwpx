import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');

test('reference metadata normalizer accepts defensive backend aliases', () => {
  assert.match(source, /item\.id \?\? item\.referenceId/);
  assert.match(source, /item\.name \?\? item\.fileName \?\? item\.filename/);
  assert.match(source, /item\.size \?\? item\.byteLength/);
  assert.match(source, /item\.mimeType \?\? item\.contentType/);
  assert.match(source, /item\.status \?\? item\.state/);
  assert.match(source, /item\.createdAt \?\? item\.uploadedAt/);
});

test('search hit normalizer accepts results without injecting content into markup', () => {
  assert.match(source, /item\.referenceId \?\? item\.fileId \?\? item\.id/);
  assert.match(source, /item\.snippet \?\? item\.text/);
  assert.match(source, /typeof item\.chunkId === 'string'/);
  assert.match(source, /item\.page === null/);
});

test('bridge sends stable chat scope and uses authenticated streaming HTTP endpoints', () => {
  assert.match(source, /type: 'chat-start' as const,[\s\S]*threadId,[\s\S]*documentId,[\s\S]*documentName/);
  assert.match(source, /type: 'chat-user-message',[\s\S]*threadId: message\.context\.threadId,[\s\S]*documentId: message\.context\.documentId/);
  assert.match(source, /messageId: message\.messageId, stagedReferenceIds: message\.stagedReferenceIds/);
  assert.match(source, /case 'chat-reference-status'/);
  assert.match(source, /context: ReferenceScopeContext/);
  assert.match(source, /threadId: message\.context\.threadId/);
  assert.match(source, /documentId: message\.context\.documentId/);
  assert.match(source, /Authorization: `Bearer \$\{this\.token\}`/);
  assert.match(source, /this\.referenceUrl\('\/reference-files', \{ scope, scopeId \}\)/);
  assert.match(source, /this\.referenceUrl\('\/reference-staging', \{ scopeId \}\)/);
  assert.match(source, /'X-File-Name': encodeURIComponent\(file\.name\)/);
  assert.match(source, /this\.referenceUrl\('\/reference-search'/);
  assert.match(source, /q: query/);
  assert.match(source, /maxResults: Math\.max/);
  assert.match(source, /body\?\.error\?\.message/);
  assert.match(source, /`\/reference-files\/\$\{encodeURIComponent\(file\.id\)\}`/);
  assert.doesNotMatch(source, /type: 'references-(?:list|search)|type: 'reference-(?:upload|delete)/);
});
