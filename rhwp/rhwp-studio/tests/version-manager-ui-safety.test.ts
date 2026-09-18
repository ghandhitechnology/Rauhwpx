import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

const source = readSource('../src/ui/agent-sidebar/version-manager.ts');
const css = readSource('../src/ui/agent-sidebar/versions.css');

test('기록을 그리기 전에 첫 행을 roving tab stop으로 선택한다', () => {
  const normalizeSelection = source.indexOf(
    'if (!selectedCommitId || !current.commits.some((commit) => commit.id === selectedCommitId))',
  );
  const renderRows = source.indexOf('for (const commit of current.commits)', normalizeSelection);
  const assignTabStop = source.indexOf(
    'row.tabIndex = commit.id === selectedCommitId ? 0 : -1;',
    renderRows,
  );
  assert.ok(normalizeSelection >= 0 && normalizeSelection < renderRows);
  assert.ok(renderRows < assignTabStop);
});

