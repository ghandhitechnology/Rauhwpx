import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// settings.ts 는 CSS 를 가져오므로 Node 에서 불러올 수 없다 — 계기판 숫자
// 규칙만 css 없는 모듈에서 실제로 검증하고, DOM 계약은 소스 텍스트로 본다.
import { formatRelativeTime, formatResetAt, formatTokens } from '../src/ui/agent-sidebar/usage-format.ts';
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
const settingsCss = readSource('../src/ui/agent-sidebar/settings.css');
const css = readSource('../src/ui/agent-sidebar/agent-sidebar.css');
const icons = readSource('../src/ui/agent-sidebar/icons.ts');

test('설정과 버전 페이지는 무대에 다른 페이지와 나란히 선다', () => {
  assert.match(
    source,
    /stage\.append\(\s*workspaceBar,\s*chatPage,\s*threadsPage,\s*skillsPage,\s*referenceLibrary\.page,\s*settingsPage,\s*versionsPage,\s*reviewColumn,\s*planColumn,\s*railResize,\s*reviewResize,?\s*\)/,
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
  assert.match(source, /function setSettingsPanelOpen\(open: boolean\): void/);
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
  assert.match(source, /option\.local === 'settings'[^\n]*setSettingsPanelOpen\(true\)/);
  assert.match(source, /text === '\/settings'[^\n]*setSettingsPanelOpen\(true\)/);
  assert.ok(source.indexOf("if (text === '/settings')") < source.indexOf('recordUserMessage(messageText,'));
});

test('설정은 보안·연결·기본 설정·글쓰기 보정·템플릿·사용량 묶음이다', () => {
  for (const title of ['보안·개인정보', '연결', '기본 설정', '글쓰기 보정', '템플릿', '사용량']) {
    assert.match(settings, new RegExp(`createSection\\('${title}'\\)`));
  }
  assert.match(settings, /renderPrivacySnapshot\(privacyRoot/);
  assert.match(settingsCss, /\.ag-settings-section-title/);
  assert.match(settingsCss, /\.ag-privacy-disclosure/);
});

test('템플릿 설정은 추가·이름 변경·교체·확인 삭제를 제공한다', () => {
  assert.match(settings, /requestTemplateName\('템플릿 추가'/);
  assert.match(settings, /bridge\.addTemplate\(file, name\)/);
  assert.match(settings, /bridge\.renameTemplate\(id, name\)/);
  assert.doesNotMatch(settings, /window\.prompt/);
  assert.match(settings, /bridge\.replaceTemplate\(id, file\)/);
  assert.match(settings, /window\.confirm\(`“\$\{template\.name\}” 템플릿을 삭제할까요\?`\)/);
  assert.match(settings, /bridge\.deleteTemplate\(id\)/);
});

test('연결 묶음은 허브 상태와 프로바이더 상태, 세 동작을 갖는다', () => {
  assert.match(settings, /void bridge\.reconnectNow\(\)/);
  assert.doesNotMatch(settings, /ensureDesktopAgentHub/);
  assert.match(settings, /hubReconnect\.disabled = connectionState === 'connected'/);
  assert.doesNotMatch(
    settings,
    /hubReconnect\.disabled = connectionState === 'connected' \|\| connectionState === 'connecting'/,
  );
  assert.match(settings, /'상태 새로고침'/);
  assert.match(settings, /void refreshProviders\(true\)/);
  assert.match(settings, /bridge\.requestProviderStatus\(refresh\)/);
  assert.match(settings, /el\('button', 'ag-settings-btn', '세션 다시 시작'\)/);
  assert.match(settings, /reconnectSession\(\)/);
  // 프로바이더 행은 버전 또는 오류 사유를 그대로 말한다.
  assert.match(settings, /health\.version \?\? '설치됨'/);
  assert.match(settings, /health\.error \?\? '실행할 수 없어요'/);
  assert.match(settingsCss, /\.ag-settings-dot\[data-state='connected'\]/);
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
  assert.match(settings, /detected \|\| setup\?\.connected \|\| setup\?\.setupComplete \? '재설정' : '설정'/);
  assert.match(settings, /const detected = providers\?\.\[agent\]\?\.available === true/);
  assert.match(settings, /const available = detected \|\| status\?\.available === true \|\| status\?\.installed === true/);
  assert.match(settings, /const connected = detected \|\| status\?\.connected === true \|\| status\?\.setupComplete === true/);
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
    /setupLoginCancel\.addEventListener\('click', \(\) => \{\s*if \(setupAgent\) bridge\.cancelAgentSetup\(setupAgent\);/,
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
  assert.match(settings, /if \(ev\.authUrl\) setupAuthUrl = ev\.authUrl;\s*if \(ev\.userCode\) setupUserCode = ev\.userCode;/);
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

test('기본 설정은 select 셋이고 저장 후 사이드바에 알린다', () => {
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
  assert.match(settings, /prefs = saveAgentPrefs\(partial\)/);
  assert.match(settings, /applyDefaults\(prefs\)/);
  assert.match(settings, /'새 대화부터 적용돼요\.'/);
  // 전체 접근을 기본값으로 굳히려면 한 번 확인한다.
  assert.match(settings, /next === 'unrestricted' && !window\.confirm\(UNRESTRICTED_DEFAULT_WARNING\)/);
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

test('요금제 선택값은 프로바이더별로 다르고 허브에 저장된다', () => {
  assert.match(settings, /claude: \[\s*\{ id: 'pro', label: 'Pro' \},\s*\{ id: 'max5x', label: 'Max 5x' \},\s*\{ id: 'max20x', label: 'Max 20x' \},\s*\{ id: 'api', label: 'API' \},\s*\]/);
  assert.match(settings, /codex: \[\s*\{ id: 'plus', label: 'Plus' \},\s*\{ id: 'pro', label: 'Pro' \},\s*\{ id: 'api', label: 'API' \},\s*\]/);
  assert.match(settings, /bridge\.setUsagePlan\(agent, plan\.value\)/);
  assert.match(settings, /usage = summary;\s*renderUsage\(\);/);
});

test('사용량 미터는 5시간·주간·오늘·모델별을 보여주고 80%에서 경고로 넘어간다', () => {
  assert.match(settings, /buildMeter\('5시간'/);
  assert.match(settings, /buildMeter\('주간'/);
  assert.match(settings, /오늘 · \$\{formatTokens\(providerUsage\.day\.weightedTokens\)\}/);
  assert.match(settings, /'모델별'/);
  assert.match(settings, /const METER_WARN_PERCENT = 80;/);
  assert.match(settings, /if \(percent >= METER_WARN_PERCENT\) row\.classList\.add\('ag-settings-meter-warn'\)/);
  // 막대는 100% 를 넘겨도 가득 찬 상태로 멈춘다.
  assert.match(settings, /Math\.min\(100, Math\.max\(0, percent\)\)/);
  assert.match(settingsCss, /\.ag-settings-meter-warn \.ag-settings-meter-fill/);
  assert.match(settingsCss, /color-mix\(in srgb, var\(--ag-err\)/);
});

test('사용량 묶음에서 CLIProxyAPI 를 연결할 수 있다', () => {
  assert.match(settings, /document\.createTextNode\('CLIProxyAPI'\)/);
  assert.match(settings, /createTextField\('주소'/);
  assert.match(settings, /createTextField\('관리 키'/);
  assert.match(settings, /placeholder: 'http:\/\/127\.0\.0\.1:8317'/);
  assert.match(settings, /bridge\.connectCliproxy\(cliproxyUrl\.input\.value, cliproxyKey\.input\.value\)/);
  assert.match(settings, /bridge\.disconnectCliproxy\(\)/);
  assert.match(settings, /void refreshUsage\(true\)/);
  assert.match(settings, /실제 사용량을 보여줘요/);
  assert.match(settings, /remote-management\.secret-key/);
  assert.match(settings, /ui\.plan\.hidden = actual/);
  assert.match(settings, /actual \? '실제' : '추정'/);
  assert.match(settingsCss, /\.ag-settings-input/);
  assert.match(settingsCss, /\.ag-settings-cliproxy-error/);
});

test('한도가 없으면 누적치만 말한다', () => {
  assert.match(settings, /\$\{formatTokens\(window_\.weightedTokens\)\} 토큰 · \$\{window_\.turns\}턴/);
});

test('사이드바가 설정 탭에 이벤트를 흘려준다', () => {
  assert.match(source, /settingsPanel\.handleEvent\(e\)/);
  assert.match(settings, /case 'provider-status':\s*providers = ev\.providers/);
  assert.match(settings, /case 'usage-report':\s*usage = ev\.usage/);
  assert.match(settings, /case 'writing-style-status':\s*case 'writing-style-result':/);
  assert.match(settings, /case 'connection':\s*connectionState = ev\.state/);
  // 열 때 최신값을 다시 받는다.
  assert.match(settings, /void refreshProviders\(false\);\s*void refreshUsage\(\);/);
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
});

test('설정의 채움 버튼도 손그림 윤곽을 쓴다', () => {
  const filled = css.match(/[^{}]+\{[^}]*filter:\s*var\(--ag-sketch-line\)[^}]*\}/gs) ?? [];
  const selectors = filled.map((rule) => rule.slice(0, rule.indexOf('{'))).join('\n');
  for (const sel of ['.ag-settings-primary', '.ag-conn-banner-retry', '.ag-hub-retry-btn']) {
    assert.ok(selectors.includes(sel), `${sel} should use the sketch filter`);
  }
});

test('Grok · Cursor 는 프로바이더 목록 · 라벨 · 아이콘 · 강조색을 모두 갖춘다', () => {
  // 연결 목록과 입력기 피커는 다섯 프로바이더를 같은 순서로 세운다.
  assert.deepEqual([...PROVIDER_ORDER], ['claude', 'codex', 'pi', 'grok', 'cursor']);
  assert.equal(AGENT_LABEL.grok, 'Grok');
  assert.equal(AGENT_LABEL.cursor, 'Cursor');
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
  assert.deepEqual([...MASK_ICON_AGENTS], ['codex', 'pi', 'grok', 'cursor']);
  // 마스크가 아닌 프로바이더만 이미지 경로를 갖는다.
  assert.equal(PROVIDER_ICON_SRC.claude, '/icons/provider-claude.png');
  assert.equal(PROVIDER_ICON_SRC.grok, undefined);
  assert.equal(PROVIDER_ICON_SRC.cursor, undefined);
  assert.match(css, /\.ag-provider-icon-mask\[data-agent='grok'\][\s\S]*?provider-grok\.svg/);
  assert.match(css, /\.ag-provider-icon-mask\[data-agent='cursor'\][\s\S]*?provider-cursor\.svg/);
  // 강조색은 라이트/다크 팔레트에 모두 있고 data-agent 로 갈린다.
  assert.equal((css.match(/--ag-grok:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-cursor:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-grok-wash:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-cursor-wash:/g) ?? []).length, 2);
  assert.match(css, /\.ag-root\[data-agent='grok'\] \{\s*--ag-accent: var\(--ag-grok\);/);
  assert.match(css, /\.ag-root\[data-agent='cursor'\] \{\s*--ag-accent: var\(--ag-cursor\);/);
  assert.match(css, /\.ag-plan-card\.ag-grok,\n\.ag-plan-card\.ag-cursor/);
  assert.match(css, /\.ag-review-card\.ag-grok,\n\.ag-review-card\.ag-cursor/);
});

test('기본 제공자 선택은 다섯 프로바이더를 그대로 저장한다', () => {
  // 예전 코드는 모르는 값을 claude 로 접어 Grok/Cursor 선택을 삼켰다.
  assert.match(settings, /const agent = PROVIDER_ORDER\.find\(\(name\) => name === value\) \?\? 'claude'/);
  assert.doesNotMatch(settings, /value === 'codex' \|\| value === 'pi' \? value : 'claude'/);
  // 요금제 미터는 구독 한도가 있는 둘만 갖는다.
  assert.match(settings, /type PlanAgent = 'claude' \| 'codex'/);
  assert.match(settings, /const PLAN_AGENTS: readonly PlanAgent\[\] = \['claude', 'codex'\]/);
});

test('grok · cursor 사용량도 세션 · 오늘 · 주간 토큰으로 보인다', () => {
  assert.match(settings, /const API_USAGE_AGENTS: readonly AgentName\[\] = \['grok', 'cursor'\]/);
  assert.match(settings, /function renderApiUsage\(\): void/);
  assert.match(settings, /renderPiUsage\(\);\s*\n\s*renderApiUsage\(\);/);
  assert.match(settings, /세션 · \$\{formatTokens\(providerUsage\.session\.weightedTokens\)\} 토큰 · \$\{providerUsage\.session\.turns\}턴/);
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
  assert.match(settings, /fillSelectGrouped\(modelField\.select, modelGroupsForAgent\(prefs\.defaultAgent\)\)/);
  // 입력기 모델 메뉴도 같은 그룹 머리글을 쓴다.
  assert.match(source, /modelGroupsForAgent\(selectedAgent\)/);
  assert.match(source, /ag-llm-group-label/);
  assert.match(css, /\.ag-llm-group-label \{[\s\S]*?flex-basis: 100%/);
});

test('설정 모달은 프로바이더별 설치 안내와 API 키 힌트를 갖는다', () => {
  assert.match(settings, /const SETUP_INSTALL_NOTE: Record<AgentName, string>/);
  assert.match(settings, /cursor: 'Cursor CLI를 공식 설치 스크립트로 앱 전용 폴더에 설치합니다\.'/);
  assert.match(settings, /grok: 'Grok CLI와 실행에 필요한 패키지를 앱 전용 폴더에 설치합니다\.'/);
  assert.match(settings, /const API_KEY_PLACEHOLDER: Record<AgentName, string>/);
  assert.match(settings, /grok: 'xai-…'/);
  assert.match(settings, /cursor: 'API 키'/);
  assert.match(settings, /setupInstallNote\.textContent = SETUP_INSTALL_NOTE\[agent\]/);
  assert.match(settings, /setupKey\.input\.placeholder = API_KEY_PLACEHOLDER\[agent\]/);
});
