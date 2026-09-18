import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const commandSource = readFileSync(
  new URL('../src/command/commands/file.ts', import.meta.url),
  'utf8',
);
const indexHtml = readFileSync(
  new URL('../index.html', import.meta.url),
  'utf8',
);
const printSurfaceSource = readFileSync(
  new URL('../src/command/print-surface.ts', import.meta.url),
  'utf8',
);
const toolbarCss = readFileSync(
  new URL('../src/styles/toolbar.css', import.meta.url),
  'utf8',
);
const pdfDialogSource = readFileSync(
  new URL('../src/ui/pdf-print-dialog.ts', import.meta.url),
  'utf8',
);
const editingSettingsSource = readFileSync(
  new URL('../src/ui/agent-sidebar/settings-editing.ts', import.meta.url),
  'utf8',
);
const printHtml = readFileSync(
  new URL('../public/print.html', import.meta.url),
  'utf8',
);

test('print pipeline은 저장 handle·파일명·dirty 상태를 변경하지 않는다', () => {
  const printSection = commandSource.slice(
    commandSource.indexOf('async function preparePrintPages'),
    commandSource.indexOf('export const fileCommands'),
  );
  assert.doesNotMatch(printSection, /\.fileName\s*=/);
  assert.doesNotMatch(printSection, /\.currentFileHandle\s*=/);
  assert.doesNotMatch(printSection, /documentState\.(markDirty|markClean)\(/);
});
