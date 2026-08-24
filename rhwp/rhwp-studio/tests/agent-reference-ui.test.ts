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
  assert.match(library, /메시지에 참고자료 첨부/);
  assert.match(library, /trigger\.title = '참고자료'/);
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
  assert.match(library, /'\.png', '\.jpg', '\.jpeg', '\.webp', '\.gif'/);
  assert.doesNotMatch(library, /'\.svg'/);
  assert.match(library, /page\.addEventListener\('drop'/);
  assert.match(library, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(library, /event\.key !== 'Escape'/);
  assert.match(library, /remove\.setAttribute\('aria-label', `\$\{file\.name\} 참고자료 제거`\)/);
  assert.doesNotMatch(library, /innerHTML/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(library, /revision !== countRevision/);
  assert.match(library, /contextChanged\(\): void \{\s*contextRevision\+\+;\s*requestRevision\+\+;\s*countRevision\+\+;/);
});

test('a reconstructed question never probes a transient thread reference scope', () => {
  assert.match(library, /function isAuthorizedSessionTarget\(target: ScopeTarget\)/);
  assert.match(library, /bridge\.getActiveAgent\(\) === null/);
  assert.match(library, /bridge\.getPendingUserQuestion\(\)/);
  assert.match(library, /pendingQuestion\.threadId === target\.scopeId/);
  assert.match(library, /\.filter\(isAuthorizedSessionTarget\)/);
});

test('composer attachments upload into removable staging drafts before their message is sent', () => {
  assert.match(library, /const draftUploads: UploadChip\[\] = \[\]/);
  assert.match(library, /openPicker\(targetFor\('chat', options\.getContext\(\)\), true\)/);
  assert.match(library, /if \(draft\) stageFiles\(selected\)/);
  assert.match(library, /state = el\('span', 'ag-reference-upload-chip-state', '전송 대기'\)/);
  assert.match(library, /`\$\{file\.name\} 첨부 취소`/);
  assert.match(library, /async function stageOne\(chip: UploadChip\)/);
  assert.match(library, /bridge\.stageReference\(chip\.target\.scopeId, chip\.file\)/);
  assert.match(library, /hasBlockingDrafts: \(\) => draftUploads\.some/);
  assert.match(library, /function takeReadyDrafts\(\): StagedReference\[\]/);
  assert.doesNotMatch(sidebar, /if \(!input\.value\) referenceLibrary\.discardDrafts\(\)/);
  assert.match(sidebar, /referenceLibrary\.takeReadyDrafts\(\)/);
  assert.match(sidebar, /bridge\.sendUserMessage\(requestText, skillNameForMessage, staged\.map/);
  assert.match(sidebar, /send\.disabled = connState !== 'connected' \|\| attachmentsSending \|\| chatStarting[\s\S]*\|\| \(!questionPending && referenceLibrary\.hasBlockingDrafts\(\)\)/);
  assert.match(css, /\.ag-reference-upload-remove:focus-visible/);
});

test('sidebar and fullscreen share seamless drop and pasted-image staging', () => {
  assert.match(library, /stageDraftFiles: stageFiles/);
  assert.match(sidebar, /root\.addEventListener\('dragenter', onAttachmentDragEnter\)/);
  assert.match(sidebar, /root\.addEventListener\('drop', onAttachmentDrop\)/);
  assert.match(sidebar, /input\.addEventListener\('paste', onAttachmentPaste\)/);
  assert.match(sidebar, /clipboardImageFiles\(event\.clipboardData\)/);
  assert.match(sidebar, /referenceLibrary\.stageDraftFiles\(images\)/);
  assert.match(sidebar, /붙여넣은 이미지/);
  assert.match(sidebar, /ag-attachment-dragging/);
  assert.match(css, /\.ag-reference-upload-preview/);
  assert.match(css, /\.ag-root\.ag-attachment-dragging::after/);
  assert.match(library, /URL\.createObjectURL\(file\)/);
  assert.match(library, /URL\.revokeObjectURL\(chip\.previewUrl\)/);
});

test('ready attachments can send without typed text and image models are gated', () => {
  assert.match(sidebar, /referenceLibrary\.allDraftsAreImages\(\)/);
  assert.match(sidebar, /첨부한 이미지를 확인해 주세요\./);
  assert.match(sidebar, /첨부한 파일을 확인해 주세요\./);
  assert.match(sidebar, /modelSupportsImages\(selectedAgent, selectedModel\)/);
  assert.match(sidebar, /현재 Pi 모델은 이미지 입력을 지원하지 않습니다/);
});

test('failed staged uploads retain an accessible retry bound to the selected chat scope', () => {
  assert.match(library, /chip\.target = target/);
  assert.match(library, /`\$\{file\.name\} 참고자료 업로드 다시 시도`/);
  assert.match(library, /await stageOne\(chip\)/);
  assert.match(library, /chip\.retry\.hidden = false/);
  assert.match(library, /파일을 업로드하지 못했습니다/);
  assert.match(css, /\.ag-reference-upload-retry:focus-visible/);
});

test('sent user messages persist attachment pills that open the reference library', () => {
  assert.match(sidebar, /function renderUserMessage\(message: ThreadMessage\)/);
  assert.match(sidebar, /ag-msg-attachments/);
  assert.match(sidebar, /referenceLibrary\.openFile\(attachment\.fileId!\)/);
  assert.match(sidebar, /attachment\.status = 'deleted'/);
});

test('sidebar always starts provider sessions with stable thread and document identity', () => {
  assert.match(sidebar, /function startCurrentBridgeChat\(force = false\)/);
  assert.match(sidebar, /currentThread\.id,[\s\S]*currentThread\.documentId,[\s\S]*currentThread\.docKey/);
  assert.equal((sidebar.match(/bridge\.startChat\(/g) ?? []).length, 1);
  assert.match(sidebar, /startCurrentBridgeChat\(true\)/);
  assert.match(sidebar, /documentId: currentDocumentId/);
  assert.match(sidebar, /threadMatchesDocument\(\s*loaded,\s*currentDocumentId,\s*currentDocKey/);
  assert.match(sidebar, /currentThread\.documentId = currentDocumentId \?\? currentThread\.documentId/);
  assert.match(sidebar, /function handleDocumentSwitch[\s\S]*startNewChat\(\{ silent: true \}\)/);
});
