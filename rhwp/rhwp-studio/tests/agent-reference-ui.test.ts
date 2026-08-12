import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const library = readFileSync(
  new URL('../src/ui/agent-sidebar/reference-library.ts', import.meta.url),
  'utf8',
);
const css = readFileSync(
  new URL('../src/ui/agent-sidebar/reference-library.css', import.meta.url),
  'utf8',
);
const sidebar = readFileSync(
  new URL('../src/ui/agent-sidebar/index.ts', import.meta.url),
  'utf8',
);

test('composer exposes chat-scoped quick add and a separate reference library page', () => {
  assert.match(sidebar, /createReferenceLibrary\(\{/);
  assert.match(sidebar, /composerField\.insertBefore\(referenceLibrary\.quickAddButton, sendHint\)/);
  assert.match(sidebar, /composerUtilityActions\.insertBefore\(referenceLibrary\.trigger, permissionBtn\)/);
  assert.match(sidebar, /referenceLibrary\.page/);
  assert.match(library, /이 채팅에 참고자료 추가/);
  assert.match(library, /targetFor\('chat', options\.getContext\(\)\)/);
  assert.match(css, /\.ag-references-open \.ag-references-page/);
});

test('library uses real, inert tabpanels for chat, document, and global scopes', () => {
  assert.match(library, /\['chat', 'document', 'global'\] as const/);
  assert.match(library, /tabs\.setAttribute\('role', 'tablist'\)/);
  assert.match(library, /tab\.setAttribute\('role', 'tab'\)/);
  assert.match(library, /panel\.setAttribute\('role', 'tabpanel'\)/);
  assert.match(library, /page\.append\(header, tabs, \.\.\.tabPanels\.values\(\), fileInput\)/);
  assert.match(library, /tabPanels\.get\(activeScope\)!\.append\(toolbar, scopeHint, status, error, results, dropHint\)/);
  assert.match(library, /panel\.inert = !active/);
  assert.match(library, /documentTab\.disabled = !context\.documentId/);
  assert.match(css, /\.ag-reference-tabpanel\[hidden\] \{ display: none; \}/);
});

test('library searches backend content and exposes loading/error/keyboard semantics', () => {
  assert.match(library, /bridge\.searchReferences\(query, target\.scope, target\.scopeId, 20\)/);
  assert.match(library, /snippet/);
  assert.match(library, /status\.setAttribute\('role', 'status'\)/);
  assert.match(library, /error\.setAttribute\('role', 'alert'\)/);
  assert.match(library, /fileInput\.multiple = true/);
  assert.match(library, /fileInput\.accept = ACCEPTED_FILES/);
  assert.match(library, /ACCEPTED_EXTENSIONS as readonly string\[\][^\n]*\.includes\(extension\)/);
  assert.doesNotMatch(library, /'\.rtf'/);
  assert.match(library, /page\.addEventListener\('drop'/);
  assert.match(library, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(library, /event\.key !== 'Escape'/);
  assert.match(library, /remove\.setAttribute\('aria-label', `\$\{file\.name\} 참고자료 제거`\)/);
  assert.doesNotMatch(library, /innerHTML/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(library, /revision !== countRevision/);
  assert.match(library, /contextChanged\(\): void \{\s*requestRevision\+\+;\s*countRevision\+\+;/);
});

test('failed quick uploads retain an accessible retry bound to the original scope', () => {
  assert.match(library, /const retryTarget = \{ \.\.\.target \}/);
  assert.match(library, /`\$\{file\.name\} 참고자료 업로드 다시 시도`/);
  assert.match(library, /await uploadOne\(file, retryTarget, \{ root, state, retry \}\)/);
  assert.match(library, /chip\.retry\.hidden = false/);
  assert.match(library, /다시 시도하거나 파일을 다시 추가해 주세요/);
  assert.match(css, /\.ag-reference-upload-retry:focus-visible/);
});

test('sidebar always starts provider sessions with stable thread and document identity', () => {
  assert.match(sidebar, /function startCurrentBridgeChat\(force = false\)/);
  assert.match(sidebar, /currentThread\.id,[\s\S]*currentThread\.documentId,[\s\S]*currentThread\.docKey/);
  assert.equal((sidebar.match(/bridge\.startChat\(/g) ?? []).length, 1);
  assert.match(sidebar, /startCurrentBridgeChat\(true\)/);
  assert.match(sidebar, /documentId: currentDocumentId/);
  assert.match(sidebar, /loaded\.documentId[\s\S]*loaded\.documentId === currentDocumentId[\s\S]*loaded\.docKey === currentDocKey/);
  assert.match(
    sidebar,
    /currentThread\.docKey = nextKey;\s*\n\s*currentThread\.documentId = nextDocumentId;\s*\n\s*referenceLibrary\.contextChanged\(\);\s*\n\s*bridge\.stopChat\(\);\s*\n\s*startCurrentBridgeChat\(true\)/,
  );
  assert.match(
    sidebar,
    /if \(readOnlyDocLabel !== null && currentThreadMatches\) \{[\s\S]*currentThread\.documentId = nextDocumentId;[\s\S]*startCurrentBridgeChat\(true\)/,
  );
});
