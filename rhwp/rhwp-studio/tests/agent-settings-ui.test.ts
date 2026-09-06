import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// settings.ts 는 CSS 를 가져오므로 Node 에서 불러올 수 없다 — 계기판 숫자
// 규칙만 css 없는 모듈에서 실제로 검증하고, DOM 계약은 소스 텍스트로 본다.
import {
  formatRelativeTime,
  formatResetAt,
  formatTokens,
  formatUsageAge,
  formatUsageReset,
} from '../src/ui/agent-sidebar/usage-format.ts';
// providers.ts 는 CSS 를 안 가져오므로 표를 텍스트가 아니라 값으로 직접 본다.
import {
  AGENT_LABEL,
  MASK_ICON_AGENTS,
  PROVIDER_ICON_SRC,
  PROVIDER_ORDER,
} from '../src/ui/agent-sidebar/providers.ts';

const readSource = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
const source = readSource('../src/ui/agent-sidebar/index.ts');
const settings = readSource('../src/ui/agent-sidebar/settings.ts');
const bridgeSource = readSource('../src/agent/bridge.ts');
const agentTypesSource = readSource('../src/agent/types.ts');
const editingSettings = readSource('../src/ui/agent-sidebar/settings-editing.ts');
const settingsCss = readSource('../src/ui/agent-sidebar/settings.css');
const css = readSource('../src/ui/agent-sidebar/agent-sidebar.css');
const buttonCss = readSource('../src/ui/agent-sidebar/sidebar-button-modern.css');
const openCodeIcon = readSource('../public/icons/provider-opencode.svg');
const icons = readSource('../src/ui/agent-sidebar/icons.ts');
const editCommandsSource = readSource('../src/command/commands/edit.ts');
const toolCommandsSource = readSource('../src/command/commands/tool.ts');
const mainSource = readSource('../src/main.ts');

test('설정과 버전 페이지는 무대에 다른 페이지와 나란히 선다', () => {
  assert.match(
    source,
    /stage\.append\(\s*workspaceBar,\s*workspaceDrawerScrim,\s*compactRailHoverTarget,\s*chatPage,\s*threadsPage,\s*skillsPage,\s*referenceLibrary\.page,\s*settingsPage,\s*versionsPage,\s*reviewColumn,\s*planColumn,\s*railResize,\s*reviewResize,?\s*\)/,
  );
  assert.match(settings, /element\.id = 'ag-settings-panel'/);
  assert.match(settings, /element\.setAttribute\('role', 'region'\)/);
  assert.match(settings, /element\.setAttribute\('aria-label', '설정'\)/);
});

test('스킬 페이지와 같은 전환 계약을 탄다', () => {
  assert.match(css, /\.ag-skills-page,\n\.ag-settings-page,\n\.ag-versions-page \{/);
  assert.match(css, /\.ag-settings-open \.ag-chat-page,/);
  assert.match(css, /\.ag-settings-open \.ag-settings-page,/);
  assert.match(css, /\.ag-fullscreen \.ag-settings-page/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.ag-settings-open \.ag-settings-page,[\s\S]*\.ag-versions-open \.ag-versions-page \{\s*transition: none;/);
});

test('목록·스킬·설정·버전 페이지는 서로를 닫는다', () => {
  assert.match(source, /function setSettingsPanelOpen\(open: boolean, destination\?: SettingsDestination\): void/);
  assert.match(source, /root\.classList\.toggle\('ag-settings-open', open\)/);
  // 설정을 열면 목록/스킬이 닫히고,
  assert.match(
    source,
    /if \(open\) \{\s*setConfigPanelOpen\(false\);\s*threadsPanelOpen = false;\s*skillsPanelOpen = false;\s*root\.classList\.remove\('ag-threads-open', 'ag-skills-open'\);\s*skillsBtn\.setAttribute\('aria-expanded', 'false'\);\s*skillsPage\.setAttribute\('aria-hidden', 'true'\);\s*closeVersionsPage\(\);/,
  );
  // 목록/스킬/참고자료/전체 화면으로 넘어가면 설정이 닫힌다.
  assert.match(source, /function closeSettingsPage\(\): void \{[\s\S]*root\.classList\.remove\('ag-settings-open'\)/);
  assert.ok((source.match(/closeSettingsPage\(\);/g) ?? []).length >= 4);
  // 설정과 참고자료 페이지는 서로를 닫는다.
  assert.match(source, /if \(open && referenceLibrary\.isOpen\(\)\) referenceLibrary\.setOpen\(false\);\s*settingsPanelOpen = open;/);
});

test('헤더에 설정(기어) 버튼이 있다', () => {
  assert.match(source, /const settingsBtn = el\('button', 'ag-header-icon-btn ag-settings-btn'\)/);
  assert.match(source, /settingsBtn\.setAttribute\('aria-label', '설정'\)/);
  assert.match(source, /settingsBtn\.setAttribute\('aria-controls', 'ag-settings-panel'\)/);
  assert.match(source, /settingsBtn\.appendChild\(createIcon\('gear'\)\)/);
  assert.match(source, /headerActions\.append\(threadsBtn, versionsBtn, settingsBtn\)/);
  assert.match(icons, /gear: 'M/);
  assert.match(icons, /refresh: 'M/);
});

test('/settings 슬래시 명령이 설정 페이지를 연다', () => {
  assert.match(source, /value: '\/settings'[^\n]*local: 'settings'/);
  assert.match(source, /option\.local === 'settings'[^\n]*requestSettingsOpen\(\)/);
  assert.match(source, /text === '\/settings'[^\n]*requestSettingsOpen\(\)/);
  assert.ok(source.indexOf("if (text === '/settings')") < source.indexOf('recordUserMessage(messageText,'));
});

test('모든 설정 진입점은 목적지를 보존하는 하나의 허브를 연다', () => {
  assert.match(toolCommandsSource, /eventBus\.emit\('settings:open', \{ destination: 'editing' \}\)/);
  assert.match(source, /eventBus\.on\('settings:open'/);
  assert.match(mainSource, /import \{ showEditingSettingsFallback \} from '\.\/ui\/agent-sidebar\/settings-editing-fallback\.ts'/);
  assert.match(
    mainSource,
    /eventBus\.on\('settings:open',[\s\S]*if \(agentSidebarReady\) return;[\s\S]*showEditingSettingsFallback/,
  );
  assert.match(mainSource, /const agentSidebar = initAgentSidebar\([\s\S]*agentSidebarReady = true;/);
  assert.match(source, /setSettingsPanelOpen\(true, destination\)/);
  assert.match(source, /function requestSettingsOpen\(destination\?: SettingsDestination\)/);
  assert.match(source, /eventBus\.emit\('settings:open', destination \? \{ destination \} : undefined\)/);
  assert.ok((source.match(/requestSettingsOpen\(\)/g) ?? []).length >= 4);
  assert.match(settings, /sessionStorage\.setItem\('rhwp-settings-destination', destination\)/);
  assert.match(settings, /open\(destination\?: SettingsDestination\)/);
});

test('집중 모드는 설정 제목·기어·대화 복귀 동작을 유지한다', () => {
  assert.match(source, /ag-workspace-settings-back/);
  assert.match(source, /ag-workspace-settings-btn/);
  assert.match(source, /workspaceTitle\.textContent = open \? '설정' : '대화'/);
  assert.match(source, /requestSettingsClose\(workspaceSettingsBtn\)/);
  assert.match(css, /\.ag-fullscreen \.ag-settings-page \{[\s\S]*grid-row: 2/);
  assert.match(css, /\.ag-fullscreen\.ag-settings-open \.ag-workspace-settings-back/);
});

test('목적지 이동과 닫기는 적용·버리기·계속 편집 선택을 거친다', () => {
  assert.match(settings, /DirtyExitChoice/);
  assert.match(settings, /'적용'/);
  assert.match(settings, /'버리기'/);
  assert.match(settings, /'계속 편집'/);
  assert.match(settings, /async function resolveDirtyExit\(\): Promise<boolean>/);
  assert.match(settings, /requestClose: resolveDirtyExit/);
  assert.match(settings, /dialog\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(settingsCss, /\.ag-settings-dirty-dialog \{[\s\S]*--ag-bg: var\(--n-surface\)[\s\S]*background: var\(--n-surface\)/);
});

test('설정 탐색은 넓은 rail과 좁은 고정 tabs로 반응한다', () => {
  assert.match(settingsCss, /\.ag-settings-layout \{[\s\S]*grid-template-columns: 176px minmax\(0, 1fr\)/);
  assert.match(settingsCss, /@container settings-hub \(max-width: 760px\)/);
  assert.match(settingsCss, /\.ag-settings-nav \{[\s\S]*flex-direction: row/);
  assert.match(settings, /navigation\.setAttribute\('role', 'tablist'\)/);
  assert.match(settings, /button\.setAttribute\('role', 'tab'\)/);
});

test('설정 적용 버튼은 카드 없이 콘텐츠 하단에 머문다', () => {
  assert.match(
    settingsCss,
    /\.ag-settings-apply-footer \{[\s\S]*position: static;[\s\S]*background: transparent;/,
  );
  const footerRule = settingsCss.match(/\.ag-settings-apply-footer \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(footerRule, /bottom:|z-index:|border:|border-radius:|box-shadow:|backdrop-filter:/);
});

test('설정은 편집·AI·연결 목적지와 업무별 묶음을 갖는다', () => {
  for (const title of ['연결', '기본 설정', '글쓰기 보정', '템플릿', '사용량']) {
    assert.match(settings, new RegExp(`createSection\\('${title}'\\)`));
  }
  for (const title of ['화면과 보기', '글꼴', '저장과 파일']) {
    assert.match(editingSettings, new RegExp(`group\\('${title}'`));
  }
  assert.match(settings, /\{ id: 'editing', label: '편집' \}/);
  assert.match(settings, /\{ id: 'ai', label: 'AI 설정' \}/);
  assert.match(settings, /\{ id: 'connections', label: 'AI 연결' \}/);
  assert.doesNotMatch(settings, /'product'/);
  assert.match(settingsCss, /\.ag-settings-section-title/);
});

test('복구 간격은 복구용 자동 저장을 켰 때만 보인다', () => {
  assert.match(
    editingSettings,
    /recoveryInterval\.root\.hidden = !draft\.autosave\.recoveryEnabled/,
  );
});

test('대표 글꼴은 접을 수 있는 압축 목록으로 보인다', () => {
  assert.match(editingSettings, /fontSetList\.hidden = true/);
  assert.match(editingSettings, /ag-settings-resource-list ag-settings-font-set-list/);
  assert.match(editingSettings, /ag-settings-resource-row ag-settings-font-set-row/);
  assert.match(settingsCss, /\.ag-settings-font-set-list \{[\s\S]*gap: 0/);
  assert.match(settingsCss, /\.ag-settings-font-set-list\[hidden\] \{\s*display: none/);
  assert.match(settingsCss, /\.ag-settings-font-set-row \{[\s\S]*min-height: 42px/);
  const externalChange = editingSettings.slice(editingSettings.indexOf('const unsubscribe = userSettings.subscribe'));
  assert.ok(externalChange.indexOf('renderFontSets();') > externalChange.indexOf('runtime.committed(external);'));
  assert.ok(externalChange.indexOf('renderFontSets();') < externalChange.indexOf('if (isDirty())'));
});

test('저장 설정은 짧은 라벨만 보이고 PDF 안내는 기본값을 쓴다', () => {
  for (const removedCopy of [
    '편집 중인 문서의 복구본을 주기적으로 만듭니다.',
    '대형 문서는 간격을 길게 두면 멈춤을 줄일 수 있습니다.',
    '입력이 멈춘 뒤 복구본을 만듭니다.',
    'PDF 저장 안내',
    '문서 템플릿과 버전 관리 방식을 선택합니다.',
  ]) {
    assert.doesNotMatch(editingSettings, new RegExp(removedCopy));
  }
  assert.match(settings, /채팅에서는 \/templates로 선택하세요\./);
  assert.doesNotMatch(settings, /HWP\/HWPX 파일을 기기 전체 템플릿으로 보관합니다/);
});

test('한컴용 Git 토글은 기본 이력과 Git 버전 관리 진입을 전환한다', () => {
  assert.match(settings, /createToggleRow\('한컴용 Git 사용하기 \(beta\)'\)/);
  assert.match(settings, /userSettings\.setUseHancomGit\(hancomGit\.input\.checked\)/);
  assert.match(settings, /instructionsSection\.body\.append\([\s\S]*hancomGit\.root/);
  assert.match(editingSettings, /userSettings\.tryApplyEditorScalarSettings\(next\)/);
  assert.match(editingSettings, /next\.versionControl\.useHancomGit = userSettings\.getUseHancomGit\(\)/);
  assert.match(settingsCss, /\.ag-settings-toggle-input:checked \+ \.ag-settings-toggle-track/);
  assert.match(source, /function openConfiguredVersionControl\(\): void/);
  assert.match(source, /!userSettings\.getUseHancomGit\(\) && openClassicVersionControl/);
  assert.match(editCommandsSource, /new HistoryDialog\(services, compareSessionStore\)/);
});

test('사이드바 버전 버튼은 한컴 Git 설정을 따르고 상단 메뉴는 항상 남는다', () => {
  assert.match(source, /versionsBtn\.hidden = !enabled/);
  assert.match(source, /applyHancomGitVisibility\(userSettings\.getUseHancomGit\(\)\)/);
  assert.match(source, /userSettings\.subscribeUseHancomGit\(applyHancomGitVisibility\)/);
  assert.match(source, /if \(!enabled && versionsPanelOpen\) closeVersionsPage\(\)/);
  assert.match(source, /dispose\(\): void \{[\s\S]*unsubscribeHancomGitVisibility\(\)/);
  assert.match(source, /versionsBtn\.addEventListener\('click',[\s\S]*openConfiguredVersionControl\(\)/);
  assert.doesNotMatch(mainSource, /gitVersionToolbarButton/);
  assert.match(editCommandsSource, /userSettings\.getUseHancomGit\(\)[\s\S]*versions:open[\s\S]*openClassicDocumentHistory/);
  assert.match(editCommandsSource, /id: 'edit:document-history'/);
});

test('템플릿 설정은 추가·이름 변경·교체·확인 삭제를 제공한다', () => {
  assert.match(
    settings,
    /aiContent\.append\(calibration\.root, instructionsSection\.root, defaults\.root, templatesSection\.root, aiFooter\)/,
  );
  assert.doesNotMatch(editingSettings, /documentResources/);
  assert.match(settings, /requestTemplateName\('템플릿 추가'/);
  assert.match(settings, /bridge\.addTemplate\(file, name\)/);
  assert.match(settings, /bridge\.renameTemplate\(id, name\)/);
  assert.doesNotMatch(settings, /window\.prompt/);
  assert.match(settings, /bridge\.replaceTemplate\(id, file\)/);
  assert.match(settings, /window\.confirm\(`“\$\{template\.name\}” 템플릿을 삭제할까요\?`\)/);
  assert.match(settings, /bridge\.deleteTemplate\(id\)/);
});

test('연결 묶음은 허브 재연결과 상태 새로고침을 제공하고 불필요한 하단 동작을 숨긴다', () => {
  assert.match(settings, /void bridge\.reconnectNow\(\)/);
  assert.doesNotMatch(settings, /ensureDesktopAgentHub/);
  assert.match(settings, /hubReconnect\.hidden = connectionState === 'connected'/);
  assert.match(settings, /hubReconnect\.disabled = connectionState === 'connected'/);
  assert.match(settings, /'상태 새로고침'/);
  assert.match(settings, /Promise\.all\(\[refreshProviders\(true\), refreshSetupStatuses\(true\)\]\)/);
  assert.match(settings, /bridge\.requestProviderStatus\(refresh\)/);
  assert.doesNotMatch(settings, /el\('button', 'ag-settings-btn', '세션 다시 시작'\)/);
  assert.doesNotMatch(settings, /reconnectSession\(\)/);
  // 접힌 행에는 계정을, 펼친 행에는 오류 사유를 표시한다.
  assert.match(settings, /label = identity \|\| '연결됨'/);
  assert.match(settings, /message = setup\?\.error \|\| health\?\.error \|\| '연결 상태를 확인해 주세요\.'/);
  assert.match(settingsCss, /\.ag-settings-dot\[data-state='connected'\]/);
});

test('Rauhwpx 계정은 Cloud와 분리된 일반 브릿지와 설정 카드로 로그인한다', () => {
  const accountTypes = agentTypesSource.slice(
    agentTypesSource.indexOf('export type AccountSessionState'),
    agentTypesSource.indexOf('/** 요금제', agentTypesSource.indexOf('export type AccountSessionState')),
  );
  const accountCard = settings.slice(
    settings.indexOf('// ── Rauhwpx 계정'),
    settings.indexOf('// ── 1. 연결'),
  );

  assert.match(accountTypes, /'signed-out' \| 'signed-in' \| 'pending' \| 'unknown'/);
  assert.doesNotMatch(accountTypes, /cloud|quota|allowance/i);
  assert.match(bridgeSource, /requestAccountStatus\(\): Promise<AccountSessionStatus \| null>/);
  assert.match(bridgeSource, /loginAccount\(\): Promise<AccountLoginStart \| null>/);
  assert.match(bridgeSource, /cancelAccountLogin\(authRunId: string\): void/);
  assert.match(bridgeSource, /logoutAccount\(\): Promise<AccountSessionStatus \| null>/);
  assert.match(bridgeSource, /function readAccountSessionStatus\([\s\S]+account: signedIn[\s\S]+email:/);
  assert.match(accountCard, /createSection\('Rauhwpx 계정'\)/);
  assert.match(accountCard, /'로그인'/);
  assert.match(accountCard, /'로그인 취소'/);
  assert.doesNotMatch(accountCard, /cloud|quota|allowance|크레딧|한도/i);
  assert.match(settings, /connectionContent\.append\(accountSection\.root, connection\.root, quotaSection\.root, browserbaseSection\.root, usageSection\.root\)/);
  assert.match(settings, /bridge\.requestAccountStatus\(\)/);
  assert.match(settings, /bridge\.loginAccount\(\)/);
  assert.match(settings, /bridge\.cancelAccountLogin\(accountAuthRunId\)/);
  assert.match(settings, /bridge\.logoutAccount\(\)/);
  assert.match(settings, /case 'account-status':[\s\S]+case 'account-login-progress':[\s\S]+case 'account-error':/);
});

test('각 프로바이더 설정은 별도 시작 화면 없이 설정 모달에서 끝난다', () => {
  assert.match(settings, /setup\.addEventListener\('click', \(\) => openAgentSetup\(agent\)\)/);
  assert.match(settings, /setupDialog\.setAttribute\('role', 'dialog'\)/);
  assert.match(settings, /setupDialog\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(settings, /bridge\.installAgent\(setupAgent\)/);
  assert.match(settings, /bridge\.authenticateAgent\(setupAgent, method/);
  assert.match(settings, /'브라우저로 로그인'/);
  assert.match(settings, /'API 키 입력'/);
  assert.match(settings, /const detected = health\?\.available === true \|\| setup\?\.available === true/);
  assert.match(settings, /const connected = setup\?\.connected === true \|\| setup\?\.setupComplete === true\s*\|\| \(detected && setup\?\.authenticated === true\)/);
  assert.match(settings, /row\.setup\.textContent = working \? '진행 상황 보기' : setup\?\.updateRequired \? '업데이트' : connected \? '계정 관리' : '연결하기'/);
  assert.match(settings, /row\.setup\.disabled = !online \|\| \(!setup && !health\)/);
  assert.match(settings, /const detected = providers\?\.\[agent\]\?\.available === true/);
  assert.match(settings, /const available = detected \|\| status\?\.available === true \|\| status\?\.installed === true/);
  assert.match(settings, /const connected = agent === 'rau'[\s\S]*agent === 'opencode'[\s\S]*available && status\?\.authenticated === true[\s\S]*detected \|\| configured/);
  assert.match(settings, /CLI 연결이 확인되었습니다/);
  assert.doesNotMatch(settings, /필요한 CLI와 인증을 한 번에 설정합니다/);
  assert.match(settings, /piOauth\.addEventListener\('click', \(\) => void startSetupAuth\('oauth'\)\)/);
  assert.doesNotMatch(settings, /body\.append\([\s\S]*piSection\.root/);
  assert.match(settingsCss, /\.ag-agent-setup-overlay/);
  assert.match(settingsCss, /\.ag-agent-setup-dialog/);
  assert.match(settingsCss, /\.ag-agent-setup-hero-title \{[\s\S]*font-size: 22px/);
  assert.match(settings, /setSetupInstallProgress\(ev\.percent, ev\.phase \?\? ev\.state\)/);
  assert.match(settings, /setPiInstallProgress\(ev\.percent, ev\.state/);
  assert.match(settings, /INSTALL_PROGRESS_CEILING/);
  assert.match(settingsCss, /transition: width 480ms cubic-bezier/);
});

test('브라우저 로그인은 인증 주소와 기기 코드를 카드 안에 직접 그린다', () => {
  // 팝업이 막혀도 사용자가 주소를 직접 열 수 있어야 한다.
  assert.match(settings, /const setupLoginBox = el\('div', 'ag-agent-login-box'\)/);
  assert.match(settings, /const setupAuthLink = el\('a', 'ag-agent-login-url'\)/);
  assert.match(settings, /setupAuthLink\.target = '_blank'/);
  assert.match(settings, /setupAuthLink\.rel = 'noopener noreferrer'/);
  // 긴 주소는 잘라 보여주고 전체는 title 로 남긴다.
  assert.match(settings, /setupAuthLink\.title = setupAuthUrl/);
  assert.match(settingsCss, /\.ag-agent-login-url \{[\s\S]*text-overflow: ellipsis/);
  // 열기 버튼은 클릭 핸들러 안에서 바로 창을 연다(제스처 안이라 차단되지 않는다).
  assert.match(
    settings,
    /setupAuthOpen\.addEventListener\('click', \(\) => \{[\s\S]*window\.open\(setupAuthUrl, '_blank', 'noopener,noreferrer'\)/,
  );
  assert.match(settings, /'브라우저에서 열기'/);
  assert.match(settings, /'주소 복사'/);
  assert.match(settings, /'코드 복사'/);
  assert.match(settings, /navigator\.clipboard\.writeText\(text\)/);
  // 보안 컨텍스트가 아니면 navigator.clipboard 가 없어서 textarea 로 넘어가고,
  // 그것마저 막히면 '복사됨' 대신 실패를 알린다.
  assert.match(settings, /if \(navigator\.clipboard\?\.writeText\)/);
  assert.match(settings, /copied = document\.execCommand\('copy'\)/);
  assert.match(settings, /button\.textContent = copied \? '복사됨' : '복사 실패'/);
  assert.match(settings, /const copied = await writeClipboardText\(text\)/);
  // 기기 코드와 안내 문구.
  assert.match(settings, /const setupUserCodeValue = el\('strong', 'ag-agent-login-code-value'\)/);
  assert.match(settings, /if \(setupUserCode\) setupUserCodeValue\.textContent = setupUserCode/);
  assert.match(settings, /'브라우저에서 이 코드를 확인해 주세요\.'/);
  assert.match(settings, /'브라우저에서 로그인을 마치면 자동으로 완료돼요\.'/);
  assert.match(settingsCss, /\.ag-agent-login-code-value \{[\s\S]*user-select: all/);
  // 로그인이 도는 동안 취소 버튼이 함께 선다.
  assert.match(settings, /el\('button', 'ag-settings-btn ag-agent-login-cancel', '로그인 취소'\)/);
  assert.match(
    settings,
    /setupLoginCancel\.addEventListener\('click', \(\) => \{\s*if \(setupAgent && setupAuthRunId\) bridge\.cancelAgentSetup\(setupAgent, setupAuthRunId\);/,
  );
  // 취소하면 방금 누른 버튼이 사라져 포커스가 <body> 로 떨어지고, Esc 를 받는
  // 덮개 밖이라 키보드로 카드를 닫을 수 없게 된다 — 다시 그릴 때 되돌린다.
  assert.match(
    settings,
    /function restoreSetupFocus\(\): void \{[\s\S]*if \(active && active !== document\.body\) return;\s*setupDialog\.focus\(\);/,
  );
  assert.match(settings, /setupCodeSubmit\.disabled = connectionState !== 'connected' \|\| !setupCode\.input\.value\.trim\(\);\s*restoreSetupFocus\(\);/);
  assert.match(settings, /renderPi\(\);\s*restoreSetupFocus\(\);/);
  // 상자는 oauth 로그인이 도는 동안에만 선다.
  assert.match(settings, /const authorizing = setupOauthPending && setupBusy;\s*setupLoginBox\.hidden = !authorizing/);
  assert.match(settings, /if \(ev\.authUrl\) setupAuthUrl = ev\.authUrl;\s*if \(ev\.userCode \|\| ev\.pairingCode\) setupUserCode = ev\.userCode \?\? ev\.pairingCode \?\? null;/);
  assert.match(settings, /if \(method === 'oauth' && started\.authUrl\) setupAuthUrl = started\.authUrl/);
  // 자동 열기 시도는 그대로 남는다.
  assert.match(settings, /maybeOpenAuthUrl\(ev\.authUrl\)/);
  // claude 인증 코드 입력칸은 로그인 상자 아래에 붙는다.
  assert.match(settings, /setupKeyBox,\s*setupLoginBox,\s*setupCodeBox,/);
  // 로그인이 끝나거나 실패하면 주소·코드를 지운다.
  assert.match(settings, /function clearSetupAuthPrompt\(\): void \{\s*setupOauthPending = false;\s*setupAuthUrl = null;\s*setupUserCode = null;/);
  assert.match(settings, /if \(ev\.state === 'done'\) clearSetupAuthPrompt\(\)/);
});

test('자동 하네스 업데이트 실패는 프로바이더 카드에 조용히 표시한다', () => {
  assert.match(settings, /if \(setup\?\.updateRequired\) \{[\s\S]*'업데이트 필요'/);
  assert.match(settings, /classList\.toggle\('ag-update-required'/);
  assert.match(settingsCss, /\.ag-settings-row-detail\.ag-update-required/);
});

test('AI 기본 설정은 Apply 전까지 초안이고 성공 후 사이드바에 알린다', () => {
  assert.match(settings, /createSelect\(\s*'기본 제공자'/);
  assert.match(settings, /createSelect\('기본 모델', \[\]\)/);
  assert.match(settings, /createSelect\('추론 강도', \[\]\)/);
  assert.match(settings, /effortField\.field\.hidden = effortOptions\.length === 0/);
  assert.match(settings, /fillSelect\(effortField\.select, \[\.\.\.effortOptions\]\.reverse\(\)\)/);
  // 줄의 display:flex 가 기본 [hidden] 을 덮으므로 따로 눌러 준다 — 없으면
  // Cursor 처럼 추론 강도가 없는 프로바이더에서 빈 줄이 남는다.
  assert.match(settingsCss, /\.ag-settings-field\[hidden\]\s*\{[^}]*display:\s*none;/s);
  assert.match(settings, /createSelect\('권한 프로필', PERMISSION_OPTIONS\)/);
  assert.match(settings, /const select = el\('select', 'ag-settings-select'\)/);
  assert.match(settings, /prefsDraft = normalizeAgentPrefs\(\{ \.\.\.prefsDraft, \.\.\.partial \}\)/);
  assert.match(settings, /const result = trySaveAgentPrefs\(nextPrefs\)/);
  assert.match(settings, /applyDefaults\(result\.value\)/);
  assert.match(settings, /'새 대화부터 적용돼요\.'/);
  assert.match(settings, /nextPrefs\.defaultPermissionProfile === 'unrestricted'[\s\S]*window\.confirm\(UNRESTRICTED_DEFAULT_WARNING\)/);
  assert.match(settings, /saveAgentInstructions\(\)[\s\S]*persistPrefs\(nextPrefs\)/);
  assert.match(settings, /agentField\.select\.disabled = aiPrefsSaving/);
  assert.match(settings, /modelField\.select\.disabled = aiPrefsSaving/);
  assert.match(settings, /effortField\.select\.disabled = aiPrefsSaving/);
  assert.match(settings, /permissionField\.select\.disabled = aiPrefsSaving/);
  assert.match(
    settings,
    /aiPrefsSaving = true;[\s\S]*try \{[\s\S]*await saveAgentInstructions\(\)[\s\S]*finally \{[\s\S]*aiPrefsSaving = false;/,
  );
});

test('사이드바는 저장된 기본값으로 시작하고 새 대화에 적용한다', () => {
  assert.match(source, /let agentPrefs: AgentPrefs = loadAgentPrefs\(\)/);
  assert.match(source, /bridge\.getActiveAgent\(\) \?\? agentPrefs\.defaultAgent/);
  assert.match(source, /resolveModelForAgent\(selectedAgent, agentPrefs\.defaultModel\)/);
  assert.match(source, /function applyDefaultSelection\(\): void/);
  assert.match(source, /applyDefaultSelection\(\);\s*const nextThread = createEmptyThread\(/);
  // 입력기 셀렉터(대화별 덮어쓰기)는 기본값을 저장하지 않는다.
  assert.doesNotMatch(source, /saveAgentPrefs/);
});

test('글쓰기 보정 상태와 진입 버튼', () => {
  assert.match(settings, /'아직 보정되지 않았어요'/);
  assert.match(settings, /const parts = \['보정됨', language, `문서 \$\{writingStyle\.sourceCount\}개`\]/);
  assert.match(settings, /calibrationStatus\.textContent = parts\.join\(' \/ '\)/);
  assert.match(settings, /문서 \$\{writingStyle\.sourceCount\}개/);
  assert.match(settings, /el\('button', 'ag-settings-primary', '보정 시작'\)/);
  assert.match(settings, /calibrationBtn\.textContent = '다시 보정'/);
  assert.match(settings, /openCalibration\(\)/);
  assert.match(source, /openCalibration: \(\) => writingStyleCalibration\.open\(\)/);
});

test('현재 대화는 슬래시로 구분하고 Pi 목록 안내는 숫자만 남긴다', () => {
  assert.match(settings, /현재 대화: \$\{AGENT_LABEL\[current\.agent\]\} \/ \$\{labelForModel\(current\.agent, current\.model\)\} \/ \$\{permission\}/);
  assert.doesNotMatch(settings, /검색으로 좁혀 보세요/);
});

test('구독 한도는 직접 조회하고 로컬 토큰 기록과 분리한다', () => {
  assert.match(settings, /createProviderQuota/);
  assert.doesNotMatch(settings, /setUsagePlan|buildMeter|USAGE_PLANS/);
  assert.match(settings, /formatUsageWindow\('Session'/);
  assert.match(settings, /formatUsageWindow\('Week'/);
});

test('프로바이더 사용량 표는 압축된 호출 수와 토큰을 표시한다', () => {
  assert.match(settings, /return `\$\{prefix\}\$\{window_\.turns\}회 \/ \$\{formatCompactTokens/);
  assert.match(settings, /const prefix = label === 'Session' \? '세션: ' : ''/);
  const modelRows = settings.match(/function buildModelRows[\s\S]*?return rows;/)?.[0] ?? '';
  assert.doesNotMatch(modelRows, /if \(agent === 'rau'\)/);
  assert.match(settings, /metrics\.join\('\ \| '\)/);
  for (const label of ['Session', 'Today', 'Week']) {
    assert.match(settings, new RegExp(`formatUsageWindow\\('${label}'`));
  }
});

test('직접 한도 새로고침은 기존 연결 목적지에 있고 프록시 설정을 제거한다', () => {
  assert.doesNotMatch(settings, /connectCliproxy|disconnectCliproxy|CLIProxyAPI|remote-management/);
  assert.match(settings, /void refreshUsage\(true\)/);
  assert.match(settings, /currentDestination !== 'connections'/);
  assert.match(settings, /document.removeEventListener\('visibilitychange', syncUsagePolling\)/);
});

test('한도가 없으면 누적치만 말한다', () => {
  assert.match(settings, /\$\{window_\.turns\}회 \/ \$\{formatCompactTokens\(window_\.weightedTokens\)\}/);
});

test('앱 전용 지시는 에이전트 변경안을 사용자 승인 전까지 분리한다', () => {
  assert.match(settings, /createSection\('지시'\)/);
  assert.doesNotMatch(settings, /Rauhwpx 채팅에만 적용됩니다/);
  assert.match(settings, /agent-instructions-draft/);
  assert.match(settings, /bridge\.confirmAgentInstructionsDraft\(draft\)/);
  assert.match(settings, /bridge\.rejectAgentInstructionsDraft\(draft\)/);
  assert.match(settings, /승인 전에는 AGENTS\.md에 저장되지 않습니다/);
  assert.doesNotMatch(settings, /AGENTS\.md · r\$\{/);
  assert.doesNotMatch(settings, /instructionsMeta/);
  assert.doesNotMatch(settings, /연결 후 불러옵니다/);
  assert.match(settingsCss, /\.ag-settings-instructions-proposal/);
});

test('사이드바가 설정 탭에 이벤트를 흘려준다', () => {
  assert.match(source, /settingsPanel\.handleEvent\(e\)/);
  assert.match(settings, /case 'provider-status':\s*providers = ev\.providers/);
  assert.match(settings, /case 'usage-report':\s*usage = ev\.usage/);
  assert.match(settings, /case 'writing-style-status':\s*case 'writing-style-result':/);
  assert.match(settings, /case 'connection':\s*connectionState = ev\.state/);
  // 열 때 최신값을 다시 받는다.
  assert.match(settings, /void refreshProviders\(false\);\s*void refreshAccount\(\);\s*void refreshAgentInstructions\(false\);\s*void refreshUsage\(\);/);
  assert.match(source, /settingsPanel\.dispose\(\)/);
});

test('토큰·시각 표기는 짧게 (폭이 흔들리지 않게)', () => {
  assert.equal(formatTokens(980), '980');
  assert.equal(formatTokens(340_000), '340K');
  assert.equal(formatTokens(1_240_000), '1.2M');
  const now = Date.now();
  assert.equal(formatRelativeTime(now, now), '방금');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5분 전');
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3시간 전');
  assert.equal(formatRelativeTime(now - 50 * 3_600_000, now), '2일 전');
  assert.equal(formatResetAt(now + 5 * 60_000, now), '5분 후 리셋');
  assert.equal(formatResetAt(now + 3 * 3_600_000, now), '3시간 후 리셋');
  assert.equal(formatResetAt(now - 1_000, now), '곧 리셋');
  assert.equal(formatUsageAge(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatUsageAge(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatUsageReset(now + 5 * 60_000, now), 'Resets in 5m');
  assert.equal(formatUsageReset(now + 3 * 3_600_000, now), 'Resets in 3h');
});

test('사이드바 버튼은 마지막에 불러온 얇고 반듯한 스타일을 공유한다', () => {
  assert.match(source, /import '\.\/sidebar-button-modern\.css';/);
  assert.ok(
    source.indexOf("import './sidebar-button-modern.css';")
      > source.indexOf("from './settings.ts';"),
  );
  assert.match(buttonCss, /--ag-button-radius: 5px/);
  assert.match(buttonCss, /\.ag-root button,[\s\S]*filter: none !important/);
  assert.match(buttonCss, /\.ag-root \.ag-settings-nav-button \{[\s\S]*min-height: 34px/);
  assert.match(buttonCss, /\.ag-root \.ag-send \{[\s\S]*height: var\(--ag-button-height\)/);
});

test('Grok · Cursor · OpenCode는 프로바이더 목록 · 라벨 · 아이콘 · 강조색을 모두 갖춘다', () => {
  // 연결 목록과 입력기 피커는 일곱 프로바이더를 같은 순서로 세운다.
  assert.deepEqual([...PROVIDER_ORDER], ['rau', 'claude', 'codex', 'pi', 'grok', 'cursor', 'opencode']);
  assert.equal(AGENT_LABEL.rau, 'Rau');
  assert.equal(AGENT_LABEL.grok, 'Grok');
  assert.equal(AGENT_LABEL.cursor, 'Cursor');
  assert.equal(AGENT_LABEL.opencode, 'OpenCode');
  // 두 화면 모두 표를 다시 베끼지 않고 공용 모듈에서 가져다 쓴다.
  for (const consumer of [settings, source]) {
    assert.match(consumer, /import \{ AGENT_LABEL, createProviderIcon, PROVIDER_ORDER \} from '\.\/providers\.ts'/);
    assert.doesNotMatch(consumer, /const AGENT_LABEL|const MASK_ICON_AGENTS|const PROVIDER_ICON_SRC/);
  }
  assert.match(settings, /for \(const agent of PROVIDER_ORDER\)/);
  assert.match(source, /for \(const agent of PROVIDER_ORDER\)/);
  // cursor 표기는 언제나 "Cursor" 다.
  assert.doesNotMatch(settings, /'Cursor Agent'|'cursor-agent'/);
  // 단색 로고는 마스크로 그리므로 마스크 목록과 CSS 규칙이 함께 있어야 한다.
  assert.deepEqual([...MASK_ICON_AGENTS], ['rau', 'codex', 'pi', 'grok', 'cursor', 'opencode']);
  // 마스크가 아닌 프로바이더만 이미지 경로를 갖는다.
  assert.equal(PROVIDER_ICON_SRC.claude, '/icons/provider-claude.png');
  assert.equal(PROVIDER_ICON_SRC.grok, undefined);
  assert.equal(PROVIDER_ICON_SRC.cursor, undefined);
  assert.equal(PROVIDER_ICON_SRC.opencode, undefined);
  assert.match(css, /\.ag-provider-icon-mask\[data-agent='rau'\][\s\S]*?rau\.png/);
  assert.match(css, /\.ag-provider-icon-mask\[data-agent='grok'\][\s\S]*?provider-grok\.svg/);
  assert.match(css, /\.ag-provider-icon-mask\[data-agent='cursor'\][\s\S]*?provider-cursor\.svg/);
  assert.match(css, /\.ag-provider-icon-mask\[data-agent='opencode'\][\s\S]*?provider-opencode\.svg/);
  assert.match(openCodeIcon, /^<svg[^>]+viewBox="0 0 512 512"/);
  assert.match(openCodeIcon, /fill-rule="evenodd"/);
  assert.doesNotMatch(openCodeIcon, /(?:href|src)=["']https?:|data:/);
  // 강조색은 라이트/다크 팔레트에 모두 있고 data-agent 로 갈린다.
  assert.equal((css.match(/--ag-rau:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-grok:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-cursor:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-opencode:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-rau-wash:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-grok-wash:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-cursor-wash:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-opencode-wash:/g) ?? []).length, 2);
  assert.match(css, /\.ag-root\[data-agent='grok'\] \{\s*--ag-accent: var\(--ag-grok\);/);
  assert.match(css, /\.ag-root\[data-agent='cursor'\] \{\s*--ag-accent: var\(--ag-cursor\);/);
  assert.match(css, /\.ag-root\[data-agent='opencode'\] \{\s*--ag-accent: var\(--ag-opencode\);/);
  assert.match(css, /\.ag-plan-card\.ag-grok,\n\.ag-plan-card\.ag-cursor,\n\.ag-plan-card\.ag-opencode/);
  assert.match(css, /\.ag-review-card\.ag-grok,\n\.ag-review-card\.ag-cursor,\n\.ag-review-card\.ag-opencode/);
});

test('기본 제공자 선택은 일곱 프로바이더를 그대로 저장한다', () => {
  // 예전 코드는 모르는 값을 claude 로 접어 Grok/Cursor 선택을 삼켰다.
  assert.match(settings, /const agent = PROVIDER_ORDER\.find\(\(name\) => name === value\) \?\? 'claude'/);
  assert.doesNotMatch(settings, /value === 'codex' \|\| value === 'pi' \? value : 'claude'/);
  // 요금제 미터는 구독 한도가 있는 둘만 갖는다.
  assert.match(settings, /type PlanAgent = 'claude' \| 'codex'/);
  assert.match(settings, /const PLAN_AGENTS: readonly PlanAgent\[\] = \['claude', 'codex'\]/);
});

test('grok · cursor · opencode 사용량도 세션 · 오늘 · 주간 토큰으로 보인다', () => {
  assert.match(settings, /const API_USAGE_AGENTS: readonly AgentName\[\] = \['grok', 'cursor', 'opencode'\]/);
  assert.match(settings, /function renderApiUsage\(\): void/);
  assert.match(settings, /renderPiUsage\(\);\s*\n\s*renderApiUsage\(\);/);
  assert.match(settings, /formatUsageWindow\('Session', providerUsage\.session\)/);
  assert.match(settings, /ui\.models\.replaceChildren\(\.\.\.buildModelRows\(providerUsage, agent\)\)/);
  // 요금제 셀렉트는 붙지 않는다 — API 사용량 한 가지뿐이다.
  assert.doesNotMatch(settings, /USAGE_PLANS\[agent\]\s*\?\?/);
  // 설정을 마쳤거나 기록이 있을 때만 자리를 차지한다.
  assert.match(settings, /ui\.root\.hidden = turns === 0/);
  assert.match(settingsCss, /\.ag-settings-usage-block\[hidden\]/);
});

test('cursor 모델 선택은 구독/API 과금 풀로 나뉘어 보인다', () => {
  // 설정 페이지의 기본 모델 셀렉트는 그룹 라벨을 optgroup 으로 그린다.
  assert.match(settings, /function fillSelectGrouped\(/);
  assert.match(settings, /fillSelectGrouped\(modelField\.select, modelGroupsForAgent\(prefsDraft\.defaultAgent\)\)/);
  // 입력기 모델 메뉴도 같은 그룹 머리글을 쓴다.
  assert.match(source, /modelGroupsForAgent\(selectedAgent\)/);
  assert.match(source, /ag-llm-group-label/);
  assert.match(css, /\.ag-llm-group-label \{[\s\S]*?flex-basis: 100%/);
});

test('Rau 는 목록 맨 앞이고 공통 테두리 · 로그인 전용 설정 · $0 전송 잠금을 갖는다', () => {
  assert.equal(PROVIDER_ORDER[0], 'rau');
  assert.match(settingsCss, /\.ag-settings-provider-row\[open\]\s*\{[^}]*border-color:\s*var\(--ag-border\)/);
  assert.match(settings, /if \(agent === 'rau'\) \{\s*\n\s*if \(oauthTitle\) oauthTitle\.textContent = 'Rau로 시작'/);
  assert.match(settings, /setupApiToggle\.hidden = true/);
  assert.match(settings, /setupKeyBox\.hidden = true/);
  assert.match(settings, /로그아웃/);
  assert.match(source, /function rauCreditsEmpty\(\): boolean/);
  assert.match(source, /체험 크레딧이 다 됐어요\. 다른 모델을 연결해 주세요\./);
  assert.match(source, /case 'usage-report':\s*\n\s*lastUsage = e\.usage/);
  assert.match(source, /if \(!rauSetupComplete && lastUsage\?\.rau\)/);
  assert.match(source, /selectedAgent === 'rau' && !rauSetupComplete/);
  assert.ok(source.indexOf("return { ok: false, reason: 'Rau 연결을 먼저 완료해 주세요' }")
    < source.indexOf('const userMessage = recordUserMessage(prompt'));
  assert.ok(source.indexOf("return { ok: false, reason: '체험 크레딧이 다 됐어요. 다른 모델을 연결해 주세요.' }")
    < source.indexOf('const userMessage = recordUserMessage(prompt'));
});

test('Rau 설정 카드는 로그인된 계정과 체험 크레딧 잔량 막대를 함께 보여 준다', () => {
  assert.match(settings, /setupAccountTitle = el\('h3', 'ag-agent-setup-section-title', '로그인된 계정'\)/);
  assert.match(settings, /setupAccountEmail\.textContent = status\?\.account/);
  assert.match(settings, /계정 이메일을 확인할 수 없습니다/);
  assert.doesNotMatch(settings, /연결된 키 \*\*\*\*/);
  assert.match(settings, /체험 크레딧을 다 썼어요\. 다른 모델을 연결해 주세요\./);
  // 잔량 막대는 사용량 갱신마다 다시 그린다.
  assert.match(settings, /renderUsage\(\): void \{\s*\n\s*quotaCards.render\(usage\);\s*\n\s*renderRauUsage\(\);\s*\n\s*renderRauAccount\(\);/);
  assert.match(settingsCss, /\.ag-agent-setup-account \{[\s\S]*?border-radius: 12px/);
  assert.match(settingsCss, /\.ag-agent-setup-account-meter \.ag-settings-meter-track \{[\s\S]*?height: 8px/);
});

test('Rau 재설정은 압축 동작만 두고 OAuth 완료를 잠깐 알린다', () => {
  assert.match(settings, /type RauAuthFeedback = 'idle' \| 'success'/);
  assert.match(settings, /'로그인이 완료되었습니다'/);
  assert.match(settings, /'계정을 확인하고 계속하세요\.'/);
  assert.match(settings, /setupDoneClose\.textContent = agent === 'rau' && rauAuthFeedback === 'success' \? '계속' : '완료'/);
  // 로컬 Rau OAuth가 진행 중이고 완료 상태가 도착한 경우에만 성공 피드백을 시작한다.
  assert.match(
    settings,
    /const rauOauthCompleted = setupAgent === 'rau'[\s\S]*rauOauthFlowInProgress[\s\S]*ev\.statuses\.rau\?\.setupComplete === true[\s\S]*setupOverlay\.getAttribute\('aria-hidden'\) === 'false'/,
  );
  assert.equal((settings.match(/showRauAuthSuccess\(\);/g) ?? []).length, 1);
  assert.match(settings, /rauAuthFeedbackTimer = setTimeout\([\s\S]*?rauAuthFeedback = 'idle';[\s\S]*?}, 1800\)/);
  assert.match(settings, /function openAgentSetup[\s\S]*resetRauAuthFeedback\(\);[\s\S]*function closeAgentSetup[\s\S]*resetRauAuthFeedback\(\)/);
  assert.match(settings, /async function startSetupAuth[\s\S]*resetRauAuthFeedback\(\);[\s\S]*rauOauthFlowInProgress = setupAgent === 'rau' && method === 'oauth'/);
  assert.match(settings, /dispose\(\): void \{[\s\S]*if \(rauAuthFeedbackTimer\) \{[\s\S]*clearTimeout\(rauAuthFeedbackTimer\)/);
  // 기존 성공 제목과 큰 체크는 다른 프로바이더용으로 남고 Rau에서만 숨는다.
  assert.match(settings, /setupDonePane\.classList\.toggle\('ag-agent-setup-rau-actions', agent === 'rau'/);
  assert.match(settingsCss, /\.ag-agent-setup-done\.ag-agent-setup-rau-actions \{[\s\S]*flex-direction: row/);
  assert.match(settingsCss, /\.ag-agent-setup-rau-actions \.ag-agent-setup-done-mark,[\s\S]*display: none/);
  assert.match(settingsCss, /\.ag-agent-setup-rau-actions > \[hidden\] \{\s*display: none/);
  assert.match(settingsCss, /\.ag-agent-setup-auth-feedback-mark \{[\s\S]*width: 20px;[\s\S]*border-radius: 5px/);
});

test('Rau 로그아웃 뒤 설치된 런타임을 연결 상태로 오인하지 않는다', () => {
  assert.match(
    settings,
    /const configured = status\?\.connected === true \|\| status\?\.setupComplete === true;\s*\n[\s\S]*const connected = agent === 'rau'\s*\? configured/,
  );
  assert.match(settings, /const connected = setup\?\.connected === true \|\| setup\?\.setupComplete === true\s*\|\| \(detected && setup\?\.authenticated === true\)/);
  assert.match(settings, /label = detected \? '로그인 필요' : '연결하기'/);
  assert.match(settings, /const statuses = await bridge\.disconnectAgent\('rau'\)/);
  assert.match(settings, /if \(statuses\) setupStatuses = statuses;[\s\S]*renderAgentSetup\(\);/);
  assert.match(settings, /prefs\.defaultAgent === 'rau'[\s\S]*const fallback = selectableAgents\(\)\[0\][\s\S]*persistPrefs\(\{[\s\S]*\.\.\.prefs,[\s\S]*defaultAgent: fallback,[\s\S]*\}, \{ preserveDraft: true \}\)/);
  assert.match(settings, /const rauWasIncomplete = setupStatuses !== null[\s\S]*rauWasIncomplete && ev\.statuses\.rau\?\.setupComplete === true/);
  assert.match(settings, /function persistPrefs[\s\S]*preserveDraft[\s\S]*previousDraft[\s\S]*applyDefaults\(result\.value\)/);
});

test('설정 모달은 프로바이더별 설치 안내와 API 키 힌트를 갖는다', () => {
  assert.match(settings, /const SETUP_INSTALL_NOTE: Record<AgentName, string>/);
  assert.match(settings, /rau: '브라우저로 로그인하면 \$5 체험 크레딧이 바로 연결됩니다\.'/);
  assert.match(settings, /cursor: 'Cursor CLI를 공식 설치 스크립트로 앱 전용 폴더에 설치합니다\.'/);
  assert.match(settings, /grok: 'Grok CLI와 실행에 필요한 패키지를 앱 전용 폴더에 설치합니다\.'/);
  assert.match(settings, /opencode: 'OpenCode CLI를 앱 전용 폴더에 설치합니다\.'/);
  assert.match(settings, /const API_KEY_PLACEHOLDER: Record<AgentName, string>/);
  assert.match(settings, /grok: 'xai-…'/);
  assert.match(settings, /cursor: 'API 키'/);
  assert.match(settings, /opencode: 'API 키'/);
  assert.match(settings, /setupInstallNote\.textContent = SETUP_INSTALL_NOTE\[agent\]/);
  assert.match(settings, /setupKey\.input\.placeholder = API_KEY_PLACEHOLDER\[agent\]/);
});

test('OpenCode 설정은 OAuth 대신 API 키만 받고 터미널 로그인을 새로고침으로 감지한다', () => {
  assert.match(settings, /const apiKeyOnly = agent === 'opencode'/);
  assert.match(settings, /setupOauth\.hidden = apiKeyOnly/);
  assert.match(settings, /setupApiToggle\.hidden = apiKeyOnly/);
  assert.match(settings, /if \(apiKeyOnly\) setupKeyBox\.hidden = false/);
  assert.match(settingsCss, /\.ag-agent-auth-card\[hidden\] \{\s*display: none;/);
  assert.match(settings, /터미널에서 opencode auth login을 마친 뒤 상태를 새로고침하면 기존 로그인을 감지합니다\./);
  assert.match(settings, /이 화면에서는 OpenCode API 키를 연결할 수 있습니다\./);
  assert.match(
    settings,
    /refreshBtn\.addEventListener\('click',[\s\S]{0,160}Promise\.all\(\[refreshProviders\(true\), refreshSetupStatuses\(true\)\]\)/,
  );
  assert.match(bridgeSource, /requestAgentSetupStatus\(refresh = false\)/);
  assert.match(bridgeSource, /type: 'agent-setup-status-request', \.\.\.\(refresh \? \{ refresh: true \} : \{\}\)/);
  assert.match(settings, /setupDoneChange\.textContent = apiKeyOnly \? 'API 키 변경' : '로그인 방식 변경'/);
  assert.match(settings, /agent === 'opencode'[\s\S]{0,80}'OpenCode CLI 자격 증명을 확인했습니다\.'/);
  assert.match(
    settings,
    /label = detected \? '로그인 필요' : '연결하기'/,
  );
  // 설치 여부와 인증 여부를 분리해, CLI만 설치된 상태를 연결 완료로 보지 않는다.
  assert.match(
    settings,
    /const connected = agent === 'rau'\s*\? configured\s*: agent === 'opencode'\s*\? configured \|\| \(available && status\?\.authenticated === true\)\s*: detected \|\| configured/,
  );
  assert.match(
    settings,
    /const available = providers\?\.\[agent\]\?\.available === true \|\| status\?\.available === true;[\s\S]*\|\| \(available && status\?\.authenticated === true\)/,
  );
  // 첫 실행 카드의 자동 연결도 OpenCode에서는 키 입력만 열며 OAuth를 시작하지 않는다.
  assert.match(
    settings,
    /async function startPreferredSetupAuth\(agent: AgentName\): Promise<void> \{\s*setupReauth = true;\s*if \(agent === 'opencode'\) \{\s*renderAgentSetup\(\);\s*setupKey\.input\.focus\(\);\s*return;\s*\}\s*await startSetupAuth\('oauth'\);/,
  );
  // 숨김 상태가 깨져도 브리지로 잘못된 OpenCode OAuth 요청을 보내지 않는다.
  assert.match(
    settings,
    /async function startSetupAuth\(method: AgentAuthMethod\): Promise<void> \{\s*if \(!setupAgent \|\| setupBusy\) return;\s*if \(setupAgent === 'opencode' && method === 'oauth'\) return;/,
  );
});

test('원격 브라우저 구역은 사용량 아래 서고, 키는 앱 수명 동안만 허브를 덮는다', () => {
  const bridge = readSource('../src/agent/bridge.ts');
  assert.match(settings, /createSection\('원격 브라우저'\)/);
  assert.match(settings, /connectionContent\.append\(accountSection\.root, connection\.root, quotaSection\.root, browserbaseSection\.root, usageSection\.root\)/);
  // 키 칸은 비밀번호 칸이고 자동완성에 걸리지 않는다.
  assert.match(settings, /createTextField\('Browserbase 키', \{\s*type: 'password',\s*placeholder: 'bb_live_…',\s*autocomplete: 'new-password',\s*\}\)/);
  assert.match(settings, /createTextField\('Gemini 키', \{\s*type: 'password',\s*placeholder: 'AIza…',\s*autocomplete: 'new-password',\s*\}\)/);
  assert.match(settings, /createTextField\('프로젝트 ID', \{ placeholder: '비우면 계정에서 골라요' \}\)/);
  // 적용은 허브 검증을 거치고, 성공한 if (status) 안에서만 보관·칸 비우기가 일어난다.
  const submit = settings.match(
    /async function submitBrowserbase\(\): Promise<void> \{[\s\S]*?\n  async function resetBrowserbase/,
  )?.[0] ?? '';
  const success = submit.match(/if \(status\) \{[\s\S]*?\n    \} else if \(!browserbaseMessage\)/)?.[0] ?? '';
  assert.match(success, /saveBrowserbaseOverride\(\{ \.\.\.override,/);
  assert.match(success, /browserbaseKey\.input\.value = '';/);
  assert.match(success, /browserbaseGemini\.input\.value = '';/);
  assert.doesNotMatch(submit.slice(0, submit.indexOf(success)), /saveBrowserbaseOverride/);
  assert.doesNotMatch(submit.slice(submit.indexOf(success) + success.length), /saveBrowserbaseOverride/);
  // 자동으로 채워진 옛 프로젝트 ID는 새 키와 섞지 않는다.
  assert.match(settings, /browserbaseKey\.input\.addEventListener\('input',[\s\S]*if \(browserbaseProjectAutoFilled\) \{[\s\S]*browserbaseProject\.input\.value = '';/);
  // 되돌리기는 허브가 성공한 뒤에만 브리지와 탭 보관소를 함께 비운다.
  assert.match(settings, /const status = await bridge\.clearBrowserbaseCredentials\(\);[\s\S]*if \(status\) \{\s*clearBrowserbaseOverride\(\);/);
  assert.match(bridge, /const status = await this\.request<BrowserbaseStatus>\([\s\S]*browserbase-credentials-set[\s\S]*if \(status\) this\.browserbaseOverride = candidate;/);
  // 새로고침 뒤에는 보관소의 키를 허브에 다시 심고, 브리지는 연결마다 재전송한다.
  assert.match(settings, /const storedBrowserbase = loadBrowserbaseOverride\(\);\s*if \(storedBrowserbase\) \{[\s\S]*bridge\.setBrowserbaseCredentials\(storedBrowserbase\)/);
  assert.match(bridge, /if \(this\.browserbaseOverride !== null\) \{\s*this\.sendJson\(\{ v: AGENT_PROTOCOL_VERSION, type: 'browserbase-credentials-set', \.\.\.this\.browserbaseOverride \}\);/);
  // 상태 줄은 키 꼬리만 보여 준다 — 키 본문은 허브가 애초에 보내지 않는다.
  assert.match(settings, /키 ····\$\{status\.keyTail \?\? ''\}/);
  assert.match(settings, /case 'browserbase-status':\s*browserbaseStatus = ev\.status;\s*renderBrowserbase\(\);/);
  assert.match(settingsCss, /\.ag-settings-status\.ag-settings-status-warn \{/);
});
