import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const threads = readFileSync(new URL('../src/agent/threads.ts', import.meta.url), 'utf8');
const executor = readFileSync(new URL('../src/agent/tool-executor.ts', import.meta.url), 'utf8');

test('/templates opens a local picker and selection becomes a removable chip', () => {
  assert.match(sidebar, /value: '\/templates'[^\n]*local: 'templates'/);
  assert.match(sidebar, /option\.local === 'templates'/);
  assert.match(sidebar, /option\.templateId/);
  assert.match(sidebar, /templateChipClear\.addEventListener/);
  assert.match(sidebar, /selectTemplate\(null\)/);
});

test('template context persists by stable id and is sent structurally', () => {
  assert.match(threads, /activeTemplateId: string \| null/);
  assert.match(sidebar, /currentThread\.activeTemplateId = template\?\.id \?\? null/);
  assert.match(bridge, /type: 'chat-user-message'[\s\S]*activeTemplateId: this\.activeTemplateId/);
  assert.doesNotMatch(bridge, /arrayBuffer\(\)[\s\S]{0,100}chat-user-message/);
});

test('inline invocation resolves the longest template name before its request', () => {
  assert.match(sidebar, /sort\(\(a, b\) => b\.name\.length - a\.name\.length\)/);
  assert.match(sidebar, /value === name \|\| value\.startsWith\(`\$\{name\} `\)/);
  assert.match(sidebar, /text = tail\.slice\(match\.name\.length\)\.trim\(\)/);
  assert.match(sidebar, /if \(completeName\) \{\s*setSlashMenuOpen\(false\)/,
    'once a full template name is followed by request text, Enter must submit instead of clearing the request');
});

test('threads clear deleted template ids only after an authoritative catalog arrives', () => {
  assert.match(sidebar, /thread\.activeTemplateId && templateCatalog\.revision > 0 && !activeTemplate/);
  assert.match(sidebar, /bridge\.setActiveTemplate\(activeTemplate\?\.id \?\? thread\.activeTemplateId\)/);
  assert.match(sidebar, /currentThread\.activeTemplateId && !selected/);
});

test('template mapping expires when the open document revision changes', () => {
  assert.match(executor, /if \(tool === 'get_structure'\) this\.documentInspectionRevision = this\.revision/);
  assert.match(executor, /this\.documentInspectionRevision !== this\.revision/);
  assert.match(executor, /this\.documentInspectionRevision = null/);
});
