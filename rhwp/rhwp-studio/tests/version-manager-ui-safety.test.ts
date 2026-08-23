import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

const source = readSource('../src/ui/agent-sidebar/version-manager.ts');
const css = readSource('../src/ui/agent-sidebar/versions.css');

test('버전 이름 입력은 브라우저 프롬프트 대신 앱 내 대화상자를 사용한다', () => {
  assert.match(source, /function requestVersionText\(/);
  assert.match(source, /const returnFocus = document\.activeElement instanceof HTMLElement/);
  assert.match(source, /returnFocus\?\.focus\(\)/);
  assert.match(source, /dialog\.setAttribute\('role', 'dialog'\)/);
  assert.doesNotMatch(source, /window\.prompt\(/);
  assert.match(source, /if \(title !== null\) await perform\(\(\) => controller\.createShelf\(title \|\| undefined\)\)/);
});

test('수동 체크포인트는 이미 저장한 내용에도 명시적인 기록을 남긴다', () => {
  const controller = readSource('../src/versioning/controller.ts');
  assert.match(controller, /#createCheckpoint\(\{ reason: 'manual', message, allowSameContent: true \}\)/);
});

test('문서 변경 알림은 완료된 비교를 무효화한다', () => {
  assert.match(source, /function invalidatesCompletedComparisons\(/);
  assert.match(source, /changed\.length === 0 \|\| changed\.some\(\(key\) => !PASSIVE_COMPARISON_FIELDS\.has\(key\)\)/);
  assert.match(
    source,
    /if \(next !== current && invalidatesCompletedComparisons\(current, next\)\) \{\s*comparedCommits\.clear\(\);\s*\}/,
  );
  assert.match(
    source,
    /else \{\s*if \(invalidatesCompletedComparisons\(current, state\)\) comparedCommits\.clear\(\);\s*current = state;\s*\}/,
  );
});

test('저장·활성화·선행 비교·dirty 상태가 작업 버튼을 닫는다', () => {
  assert.match(source, /const savedDocument = Boolean\(current\.documentId && current\.saved\)/);
  assert.match(source, /: !current\.enabled\s*\? '이 문서에서 버전 기록을 먼저 켜세요\.'/);
  assert.match(source, /shelf\.dataset\.versionPrerequisiteDisabled = String\(!current\.dirty\)/);
  assert.match(source, /restore\.dataset\.versionPrerequisiteDisabled = String\(!comparedCommits\.has\(selected\.id\)\)/);
  assert.match(source, /adopt\.dataset\.versionPrerequisiteDisabled = String\(!comparedCommits\.has\(selected\.id\)\)/);
  assert.match(source, /gcButton\.dataset\.versionMutation = 'true'/);
});

test('숨긴 버전 영역은 구성 요소 display 규칙보다 우선한다', () => {
  assert.match(css, /\.ag-versions-page \[hidden\] \{\s*display: none !important;\s*\}/);
});

test('알림과 탭은 보조 기술에 완전한 관계를 제공한다', () => {
  assert.match(source, /notice\.setAttribute\('role', 'status'\)/);
  assert.match(source, /notice\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(source, /notice\.setAttribute\('aria-atomic', 'true'\)/);
  assert.match(source, /button\.id = `ag-versions-\$\{tab\.id\}-tab`/);
  assert.match(source, /button\.setAttribute\('aria-controls', `ag-versions-\$\{tab\.id\}-tabpanel`\)/);
  assert.match(source, /panel\.id = `ag-versions-\$\{id\}-tabpanel`/);
  assert.match(source, /panel\.setAttribute\('aria-labelledby', `ag-versions-\$\{id\}-tab`\)/);
});

test('내부 체크포인트 사유는 한국어로 표시한다', () => {
  assert.match(source, /'pre-restore': '복원 전 자동 저장'/);
  assert.match(source, /'pre-switch': '브랜치 전환 전 자동 저장'/);
  assert.match(source, /adopt: '채택'/);
});

test('데이터 정리는 영구 작업임을 확인하고 나서 실행한다', () => {
  assert.match(
    source,
    /if \(!window\.confirm\('브랜치, 태그, 보관함에서 참조하지 않는 버전 데이터를 영구 정리할까요\? 이 작업은 되돌릴 수 없습니다\.'\)\) return;\s*void perform\(\(\) => controller\.collectGarbage\(\)\);/,
  );
});

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

test('브랜치 기록은 끊기지 않는 레일과 터미널 스타일 참조를 그린다', () => {
  assert.match(source, /commit\.lanesBefore\.forEach\(\(id, fromLane\) =>/);
  assert.match(source, /path\.classList\.add\('ag-version-lane-path', `ag-version-\$\{kind\}`\)/);
  assert.match(source, /active \? `HEAD → \$\{branch\}` : branch/);
  assert.match(css, /\.ag-version-rail \{\s*opacity: 0\.62;/);
});
