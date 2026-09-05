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

test('버전 입력 대화상자는 페이지가 닫히거나 해제될 때 취소된다', () => {
  assert.match(source, /interface VersionTextPrompt \{\s*promise: Promise<string \| null>;\s*cancel\(\): void;/);
  assert.match(source, /let activeTextPrompt: VersionTextPrompt \| null = null;/);
  assert.match(source, /activeTextPrompt = prompt;/);
  assert.equal((source.match(/activeTextPrompt\?\.cancel\(\);/g) ?? []).length, 3);
});

test('수동 커밋은 같은 내용일 때 태그 또는 변경 없음 경로를 사용한다', () => {
  const controller = readSource('../src/versioning/controller.ts');
  assert.match(controller, /#createCheckpoint\(\{ reason: 'manual', message \}\)/);
  assert.doesNotMatch(controller, /reason: 'manual', message, allowSameContent: true/);
});

test('전체 화면 뒤 버전 페이지를 여는 지연 타이머는 완료와 해제 때 정리된다', () => {
  const sidebar = readSource('../src/ui/agent-sidebar/index.ts');
  assert.match(sidebar, /let deferredVersionsOpenTimer: number \| null = null/);
  assert.match(sidebar, /deferredVersionsOpenTimer = window\.setTimeout\(\(\) => \{\s*deferredVersionsOpenTimer = null;/);
  assert.match(sidebar, /if \(deferredVersionsOpenTimer !== null\) \{\s*window\.clearTimeout\(deferredVersionsOpenTimer\);\s*deferredVersionsOpenTimer = null;/);
});

test('사용자 용어는 체크포인트 대신 Git 커밋으로 통일한다', () => {
  const controller = readSource('../src/versioning/controller.ts');
  assert.match(source, /const checkpointButton = el\('button', 'ag-versions-primary', '\+ 커밋'\)/);
  assert.match(source, /checkpointButton\.setAttribute\('aria-label', '새 커밋 만들기'\)/);
  assert.match(source, /title: '커밋 메시지 수정'/);
  assert.doesNotMatch(source, /체크포인트/);
  assert.doesNotMatch(controller, /체크포인트/);
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
});

test('숨긴 버전 영역은 구성 요소 display 규칙보다 우선한다', () => {
  assert.match(css, /\.ag-versions-page \[hidden\] \{\s*display: none !important;\s*\}/);
});

test('Git 버전 관리자에는 기존 이력 탭을 중복 표시하지 않는다', () => {
  assert.doesNotMatch(source, /\{ id: 'legacy', label: '이전 기록' \}/);
  assert.doesNotMatch(source, /const legacyPanel =/);
  assert.doesNotMatch(source, /function renderLegacy\(/);
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

test('내부 커밋 사유는 한국어로 표시한다', () => {
  assert.match(source, /'pre-restore': '복원 전 자동 저장'/);
  assert.match(source, /'pre-switch': '브랜치 전환 전 자동 저장'/);
  assert.match(source, /adopt: '채택'/);
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



test('컨트롤러는 저장소 기본 브랜치와 정렬된 고유 head로 그래프를 고정한다', () => {
  const controller = readSource('../src/versioning/controller.ts');
  assert.match(controller, /orderBranchHeadFrontier\(\s*branchRefs,\s*this\.#repository\?\.defaultBranch \?\? null,\s*this\.#activeBranch/);
  assert.match(controller, /\.filter\(\(id\) => loadedCommitIds\.has\(id\)\)/);
  assert.match(controller, /layoutCommitGraph\(this\.#commits, \[\], preferredHeads\)/);
  assert.match(controller, /isDefault: branch\.name === this\.#repository\?\.defaultBranch/);
  assert.doesNotMatch(controller, /isDefault: branch\.name === 'main'/);
});

test('브랜치 탭은 평평한 ref 행과 축약된 동작을 유지한다', () => {
  assert.match(source, /const row = el\('article', 'ag-versions-ref-row'\)/);
  assert.match(source, /row\.dataset\.branchName = branch\.name/);
  assert.match(source, /merge\.dataset\.versionAction = 'merge'/);
  assert.match(source, /const mergeDirection = `\$\{branch\.name\} → \$\{current\.activeBranch \?\? '현재'\}`/);
  assert.match(source, /const mergeLabel = `병합: \$\{mergeDirection\}`/);
  assert.match(source, /const merge = el\('button', 'ag-versions-primary', mergeLabel\)/);
  assert.match(source, /switchButton\.dataset\.versionAction = 'switch'/);
  assert.match(source, /rename\.dataset\.versionAction = 'rename'/);
  assert.match(source, /remove\.dataset\.versionAction = 'delete'/);
  assert.match(source, /merge\.setAttribute\('aria-label', `\$\{branch\.name\}에서 \$\{current\.activeBranch \?\? '현재 브랜치'\}로 병합`\)/);
  assert.match(source, /if \(!branch\.isActive && !branch\.isDefault\)/);
  assert.match(source, /controller\.resumeMerge\(draft\.id\)/);
  assert.match(source, /controller\.discardMergeDraft\(draft\.id\)/);
  assert.match(css, /\.ag-versions-ref-row \{[\s\S]*border-bottom:/);
  assert.match(css, /\.ag-versions-ref-actions button \{[\s\S]*min-height: 25px;/);
  assert.doesNotMatch(css, /:has\(/);
});

test('병합 동작은 방향과 접근 가능한 이름을 유지한다', () => {
  assert.match(source, /mergeButton\.setAttribute\('aria-label', mergeLabel\)/);
  assert.match(source, /commit\.isHead && branch === current\.activeBranch \? `HEAD \$\{branch\}` : `브랜치 \$\{branch\}`/);
  assert.match(source, /merge\.dataset\.versionTitle = mergeLabel/);
});
