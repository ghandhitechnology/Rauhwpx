import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/merge/merge-resolver-window.ts', import.meta.url), 'utf8');
const labelsSource = await readFile(new URL('../src/merge/merge-labels.ts', import.meta.url), 'utf8');
const previewSource = await readFile(new URL('../src/merge/document-preview-pane.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/merge/merge-resolver.css', import.meta.url), 'utf8');

test('resolver exposes all four mandatory previews and unambiguous merge direction', () => {
  assert.match(source, /\['base', 'current', 'incoming', 'result'\]/);
  assert.match(source, /sourceBranch} → \${options\.currentBranch/);
  assert.match(source, /자동 변경은 모두 결과에 포함됩니다/);
});

test('resolver uses official Git merge terminology consistently', () => {
  assert.match(source, /'커밋 메시지'/);
  assert.match(source, /new Option\('Fast-forward 병합', 'fast-forward'\)/);
  assert.match(source, /new Option\('병합 커밋 만들기', 'explicit-checkpoint'\)/);
  assert.doesNotMatch(source, /체크포인트|빨리 감기|병합 마침|저장 후 닫기/);
});

test('resolver contract includes keyboard, accessibility, validation and explicit discard safeguards', () => {
  assert.match(source, /aria-live/);
  assert.match(source, /event\.key\.toLowerCase\(\) === 'z'/);
  assert.match(source, /window\.confirm\('이 병합 초안/);
  assert.match(source, /this\.validation\?\.valid/);
  assert.match(source, /conflict\.supportsBoth/);
  assert.match(source, /해결하지 않은 충돌/);
  assert.match(source, /경로나 종류로 충돌 검색/);
  assert.match(source, /aria-controls/);
  assert.match(source, /configureTabPanel/);
  assert.match(source, /details\.append\(summary, groupActions\)/);
  assert.doesNotMatch(source, /summary\.appendChild\(groupActions\)/);
  assert.match(labelsSource, /base64 이미지/);
  assert.match(source, /이 값은 나누어 병합할 수 없습니다/);
  assert.match(source, /mergeTokenLabel\(conflict\.kind/);
  assert.match(source, /mergePathLabel\(conflict\.path/);
});

test('completion applies before prompting and retries only source finalization', () => {
  const start = source.indexOf('private async confirmCompletion');
  const end = source.indexOf('private requestSourceDisposition', start);
  const completion = source.slice(start, end);
  const ensureApplied = completion.indexOf('this.completion.ensureApplied');
  const requestSourceDisposition = completion.indexOf('requestSourceDisposition()');
  assert.notEqual(ensureApplied, -1);
  assert.ok(ensureApplied < requestSourceDisposition);
  assert.ok(completion.indexOf('requestSourceDisposition()') < completion.indexOf('finalizeSourceDisposition'));
  assert.match(completion, /this\.completion\.finalize/);
  assert.match(source, /적용한 병합을 안전하게 마무리/);
  assert.match(source, /finish\('keep'\)/);
  assert.match(source, /resolverRoot\.inert = true/);
  assert.match(source, /resolverRoot\.inert = false/);
});

test('narrow layouts switch from the grid to preview tabs', () => {
  assert.match(css, /@media \(max-width: 1180px\)/);
  assert.match(css, /\.merge-preview-pane\.is-active/);
  assert.match(css, /grid-template: repeat\(2, minmax\(0, 1fr\)\) \/ repeat\(2/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.merge-resolver-body\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.doesNotMatch(css, /(?:^|\n)button:disabled\s*\{/);
});

test('macOS resolver clears the old drag layer and keeps title-bar controls clickable', () => {
  assert.match(css, /html\.desktop-mac body\.merge-resolver-open #menu-bar::after\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  assert.match(css, /html\.desktop-mac \.merge-resolver-header\s*\{[^}]*padding-left:\s*calc\(16px \+ var\(--desktop-traffic-light-inset/s);
  assert.match(css, /html\.desktop-mac \.merge-resolver-header\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(css, /html\.desktop-mac \.merge-resolver-header-actions,[\s\S]*?-webkit-app-region:\s*no-drag/);
  assert.match(css, /\.merge-action-status\s*\{[\s\S]*?pointer-events:\s*none;/);
  assert.match(source, /this\.showActionStatus\(message, 'error'\)/);
  assert.match(source, /this\.clearActionStatus\(\)/);
  assert.match(source, /materialized\.validation\.errors[\s\S]*?mergeErrorMessage/);
  assert.match(previewSource, /미리보기 실패: \$\{mergeErrorMessage/);
});
