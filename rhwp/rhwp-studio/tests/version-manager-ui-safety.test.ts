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

test('수동 커밋은 이미 저장한 내용에도 명시적인 기록을 남긴다', () => {
  const controller = readSource('../src/versioning/controller.ts');
  assert.match(controller, /#createCheckpoint\(\{ reason: 'manual', message, allowSameContent: true \}\)/);
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

test('브랜치 기록은 끊기지 않는 레일과 터미널 스타일 참조를 그린다', () => {
  assert.match(source, /commit\.lanesBefore\.forEach\(\(id, fromLane\) =>/);
  assert.match(source, /!commit\.activeLanesBefore\.includes\(id\)/);
  assert.match(source, /path\.classList\.add\('ag-version-lane-path', `ag-version-\$\{kind\}`\)/);
  assert.match(source, /active \? `HEAD> \$\{branch\}` : branch/);
  assert.match(source, /const inlineRefs = laneCount <= 6 && refs\.childElementCount === 1/);
  assert.match(source, /row\.append\(laneGraph\(commit, laneCount, inlineRefs \? refs : null\), copy\)/);
  assert.match(css, /\.ag-version-graph-refs \{[\s\S]*position: absolute;/);
  assert.match(css, /\.ag-version-rail \{\s*opacity: 0\.76;/);
});

test('그래프 행과 SVG는 같은 44px 높이를 사용한다', () => {
  assert.match(source, /const VERSION_GRAPH_ROW_HEIGHT = 44;/);
  assert.match(source, /const height = VERSION_GRAPH_ROW_HEIGHT;/);
  assert.match(css, /--ag-version-row-height: 44px;/);
  assert.match(css, /height: var\(--ag-version-row-height\);\s*min-height: var\(--ag-version-row-height\);/);
});

test('레일은 평평한 선과 안정적인 터미널 색을 사용한다', () => {
  assert.match(source, /VERSION_LANE_COLORS = \['#d7dae0', '#63d7b0', '#f2b866', '#8e9dff'/);
  assert.match(css, /stroke-linecap: square;/);
  assert.match(css, /stroke-linejoin: miter;/);
  assert.doesNotMatch(source, /ag-version-node-halo/);
  assert.doesNotMatch(css, /ag-version-node-halo/);
  assert.match(source, /Math\.min\(27, \(width - 20\) \/ \(laneCount - 1\)\)/);
  assert.match(css, /\.ag-versions-lanes \{[\s\S]*width: 100%;[\s\S]*height: 100%;/);
});

test('기록 탭은 그래프로 바뀌고 행 본문은 제목, 해시, 시간만 남긴다', () => {
  assert.match(source, /\{ id: 'history', label: '그래프' \}/);
  assert.match(source, /`\$\{commit\.shortId\}  \$\{formatGraphTime\(commit\.createdAt\)\}`/);
  assert.match(source, /return `\$\{month\}\/\$\{day\} \$\{hour\}:\$\{minute\}`/);
  assert.doesNotMatch(source, /formatTime\(commit\.createdAt\)\} · \$\{reasonLabel\(commit\.reason\)/);
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
  assert.match(source, /const merge = el\('button', 'ag-versions-primary', mergeDirection\)/);
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

test('버전 관리자는 2px 이하 모서리와 방향성 병합 이름을 사용한다', () => {
  for (const match of css.matchAll(/border-radius:\s*(\d+)px/g)) {
    assert.ok(Number(match[1]) <= 2, `round radius remains at ${match[1]}px`);
  }
  assert.match(source, /mergeButton\.setAttribute\('aria-label', mergeDirection\)/);
  assert.match(source, /mergeButton\.textContent = `… → \$\{targetBranch\}`/);
  assert.match(source, /activeBranch\.setAttribute\('aria-label', `현재 브랜치 \$\{targetBranch\} 보기`\)/);
  assert.match(source, /commit\.isHead && branch === current\.activeBranch \? `HEAD \$\{branch\}` : `브랜치 \$\{branch\}`/);
  assert.match(source, /merge\.dataset\.versionTitle = mergeDirection/);
});
