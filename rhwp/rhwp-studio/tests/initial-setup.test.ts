import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AGENT_MODELS } from '../src/agent/models.ts';
import type { AccountSessionStatus, AgentName, AgentSetupStatus } from '../src/agent/types.ts';
import { PROVIDER_ORDER } from '../src/ui/agent-sidebar/providers.ts';
import {
  BYOK_AGENTS,
  isProviderConfigured,
  isRauFirstRunFailure,
  previewModelLabels,
  PROVIDER_VENDOR,
  RAU_FAILURE_FORWARD_COPY,
  rauSignInFeedback,
  SUGGESTED_AGENT,
} from '../src/ui/initial-setup/catalog.ts';
import {
  completeInitialSetup,
  defaultInitialSetup,
  isInitialSetupComplete,
  loadInitialSetup,
  shouldForceInitialSetup,
  shouldForceRauFailurePreview,
  shouldShowInitialSetup,
  shouldSuppressInitialSetup,
} from '../src/ui/initial-setup/state.ts';

const readSource = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

function memoryStore(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function status(partial: Partial<AgentSetupStatus> & { agent: AgentName }): AgentSetupStatus {
  return {
    available: false,
    connected: false,
    installed: false,
    installing: false,
    version: null,
    authenticated: false,
    authMethod: null,
    keyTail: null,
    authenticating: false,
    setupComplete: false,
    latestVersion: null,
    updateRequired: false,
    error: null,
    ...partial,
  };
}

test('첫 실행 플래그가 없으면 마법사를 보여 준다', () => {
  const storage = memoryStore();
  assert.equal(isInitialSetupComplete(storage), false);
  assert.equal(shouldShowInitialSetup(storage, ''), true);
  assert.deepEqual(loadInitialSetup(storage), defaultInitialSetup());
});

test('끝내거나 건너뛰면 다음 실행에서 다시 열리지 않는다', () => {
  const storage = memoryStore();
  completeInitialSetup({ providerStep: 'skipped', calibrationStep: 'skipped' }, storage, () => '2026-08-23T00:00:00.000Z');
  assert.equal(isInitialSetupComplete(storage), true);
  assert.equal(shouldShowInitialSetup(storage, ''), false);
  const saved = loadInitialSetup(storage);
  assert.equal(saved.providerStep, 'skipped');
  assert.equal(saved.calibrationStep, 'skipped');
  assert.equal(saved.completedAt, '2026-08-23T00:00:00.000Z');
});

test('?initial-setup=1 이면 끝난 뒤에도 다시 연다', () => {
  const storage = memoryStore();
  completeInitialSetup({ providerStep: 'configured', calibrationStep: 'done' }, storage);
  assert.equal(shouldForceInitialSetup('?initial-setup=1'), true);
  assert.equal(shouldForceInitialSetup('initial-setup'), true);
  assert.equal(shouldForceInitialSetup('?foo=1'), false);
  assert.equal(shouldForceRauFailurePreview('?initial-setup=1&rau-failure=1'), true);
  assert.equal(shouldForceRauFailurePreview('rau-failure'), true);
  assert.equal(shouldForceRauFailurePreview('?initial-setup=1'), false);
  assert.equal(shouldShowInitialSetup(storage, '?initial-setup=1'), true);
  assert.equal(shouldSuppressInitialSetup(), typeof navigator !== 'undefined' && navigator.webdriver === true);
});

test('카드 모델 목록은 현재 선택과 Pi 기본 안내를 짧게 보여 준다', () => {
  assert.deepEqual(previewModelLabels('claude'), AGENT_MODELS.claude.map((model) => model.label));
  assert.deepEqual(previewModelLabels('codex'), AGENT_MODELS.codex.map((model) => model.label));
  assert.deepEqual(previewModelLabels('pi'), ['OpenRouter에서 고름', '최대 3개']);
  assert.equal(SUGGESTED_AGENT, 'claude');
  assert.equal(PROVIDER_ORDER[0], 'claude');
  assert.deepEqual([...PROVIDER_ORDER], ['claude', 'codex', 'pi']);
  assert.deepEqual([...BYOK_AGENTS], ['claude', 'codex', 'pi']);
  assert.equal(PROVIDER_VENDOR.claude, 'Anthropic');
  for (const agent of PROVIDER_ORDER) {
    assert.ok(PROVIDER_VENDOR[agent]);
  }
});

test('연결됨은 실행 가능한 CLI와 인증을 둘 다 확인한다', () => {
  const statuses = {
    claude: status({ agent: 'claude', available: true }),
    codex: status({ agent: 'codex', connected: true }),
    pi: status({ agent: 'pi', setupComplete: true }),
  };
  assert.equal(isProviderConfigured('claude', statuses), false);
  assert.equal(isProviderConfigured('codex', statuses), true);
  assert.equal(isProviderConfigured('pi', statuses), true);
});

test('사이드바가 첫 실행 마법사를 설정 모달·보정 창에 붙인다', () => {
  const source = readSource('../src/ui/agent-sidebar/index.ts');
  const setup = readSource('../src/ui/initial-setup/initial-setup.ts');
  const css = readSource('../src/ui/initial-setup/initial-setup.css');
  const settings = readSource('../src/ui/agent-sidebar/settings.ts');
  const calibration = readSource('../src/ui/agent-sidebar/writing-style-calibration.ts');

  assert.match(source, /maybeStartInitialSetup/);
  assert.match(source, /settingsPanel\.openAgentSetup\(agent\)/);
  assert.match(source, /settingsPanel\.beginAgentConnect\(agent\)/);
  assert.match(source, /settingsPanel\.closeAgentSetup\(\)/);
  assert.match(source, /initialSetup\?\.notifySetupAbandoned\(info\)/);
  assert.match(source, /writingStyleCalibration\.open\(options\)/);
  assert.match(source, /initialSetup\?\.notifyCalibrationClosed\(result\.completed\)/);
  assert.match(settings, /openAgentSetup,/);
  assert.match(settings, /beginAgentConnect,/);
  assert.match(settings, /closeAgentSetup,/);
  assert.match(settings, /onAgentSetupAbandoned\?/);
  assert.match(settings, /code: 'RAU_LOGIN_CANCELLED'/);
  assert.match(settings, /code: 'RAU_LOGIN_START_FAILED'/);
  assert.match(settings, /await startSetupAuth\('oauth'\)/);
  assert.match(calibration, /elevate\?: boolean/);
  assert.match(calibration, /onDismiss\?: \(result: \{ completed: boolean \}\) => void/);

  assert.match(setup, /for \(const agent of PROVIDER_ORDER\)/);
  assert.match(setup, /createProviderIcon\(agent\)/);
  // 한 장짜리 카드: 제목, 프로바이더 타일(연결되면 ✓), 계속/나중에 버튼 하나.
  assert.match(setup, /const SETUP_TITLE = '모델 연결'/);
  assert.match(setup, /el\('span', 'rhwp-setup-card-check'\)/);
  assert.match(setup, /\? '계속'\s*: rauFailureActive \? RAU_FAILURE_FORWARD_COPY\.skip : '나중에'/);
  assert.match(setup, /cards\.get\(PROVIDER_ORDER\[0\]\)\?\.action\.focus\(\{ preventScroll: true \}\)/);
  // 문체 보정은 필수 2단계가 아니다 — 사이드바 칩이 이어받는다.
  assert.doesNotMatch(setup, /rhwp-setup-cal|보정 시작|말투를 맞출까요/);
  assert.doesNotMatch(setup, /rhwp-setup-status|아직 연결한 모델이 없습니다/);
  assert.doesNotMatch(setup, /rhwp-setup-kicker/);
  assert.doesNotMatch(setup, /rhwp-setup-lead/);
  assert.match(setup, /\(beginAgentConnect \?\? openAgentSetup\)\(agent\)/);
  assert.match(setup, /function enterRauFailureRecovery\(\)/);
  assert.match(setup, /function skipToEditor\(\)/);
  assert.match(setup, /applyFirstRunDefaultAgent\(configuredAgents\(\), storage \?\? null\)/);
  assert.match(setup, /dataset\.byok = 'true'/);
  assert.match(setup, /RAU_FAILURE_FORWARD_COPY/);
  assert.match(setup, /shouldForceRauFailurePreview\(\)/);
  assert.match(setup, /notifySetupAbandoned/);
  assert.match(source, /el\('span', 'ag-calibration-chip-text', '원고를 올리면 내 말투로 씁니다'\)/);
  assert.match(source, /setup\.calibrationStep === 'pending'/);
  assert.match(source, /calibrationChipOpen\.addEventListener\('click', \(\) => writingStyleCalibration\.open\(\)\)/);

  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.rhwp-setup-providers \{[\s\S]*overflow: auto/);
  assert.match(css, /\.rhwp-setup-footer \{[\s\S]*position: sticky/);
  assert.match(css, /data-recovery='true'\] \.rhwp-setup-card:not\(\[data-recovery-option='true'\]\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /overflow-anchor: none/);
  assert.match(css, /var\(--ag-spring\)/);
  assert.match(css, /url\('\/icons\/provider-codex\.png'\)/);
  assert.match(css, /url\('\/icons\/provider-pi\.svg'\)/);
  assert.doesNotMatch(css, /transition: all/);
  assert.doesNotMatch(css, /\d+ms ease(?:;|,)/);
  assert.match(css, /\.rhwp-setup-recovery\[hidden\]/);
  assert.match(css, /data-recovery-option='true'/);
  assert.match(css, /\.rhwp-setup-recovery \{/);
});

test('Rau 첫 실행 실패 경로는 꺼져 있고 BYOK 는 라이브 프로바이더만 남긴다', () => {
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'RAU_CREDITS_TIMEOUT' }), false);
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'RAU_LOGIN_CANCELLED' }), false);
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'RAU_LOGIN_START_FAILED' }), false);
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'UNAUTHORIZED' }), false);
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'AGENT_AUTH_CANCELLED' }), false);
  assert.equal(isRauFirstRunFailure({ agent: 'codex', code: 'AGENT_SETUP_FAILED' }), false);
  assert.equal(isRauFirstRunFailure({ agent: null, code: 'RAU_CREDITS_TIMEOUT' }), false);
  assert.deepEqual([...BYOK_AGENTS], ['claude', 'codex', 'pi']);
  assert.equal(RAU_FAILURE_FORWARD_COPY.body, 'Claude, Codex, Pi 중 하나를 연결합니다.');
  assert.equal(RAU_FAILURE_FORWARD_COPY.skip, '편집기로 계속');
  assert.doesNotMatch(RAU_FAILURE_FORWARD_COPY.body, /설정에서만|Settings-only|설정 탭에서만/);

  const setup = readSource('../src/ui/initial-setup/initial-setup.ts');
  assert.match(setup, /event\.type === 'agent-setup-error'/);
  assert.match(setup, /isRauFirstRunFailure\(event\)/);
  assert.match(setup, /closeAgentSetup\?\.\(\)/);
  assert.doesNotMatch(setup, /if \(!already\) closeAgentSetup/);
  assert.match(setup, /closingSetupForRecovery/);
  assert.match(
    setup,
    /if \(!closingSetupForRecovery\) \{\s*\n\s*closingSetupForRecovery = true;\s*\n\s*try \{\s*\n\s*closeAgentSetup\?\.\(\)/,
  );
  assert.match(setup, /dataset\.recoveryOption = rauFailureActive && isByokAgent\(agent\)/);
  assert.match(setup, /dataset\.byok = 'true'/);
});

test('Rau 카드가 generic account snapshot의 로그인 진행과 완료를 정확히 보여 준다', () => {
  const base: AccountSessionStatus = {
    state: 'signed-out',
    signedIn: false,
    account: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    authenticating: false,
  };

  assert.deepEqual(rauSignInFeedback({ ...base, state: 'pending', authenticating: true }, 'Rau로 시작'), {
    state: 'pending',
    label: '로그인 확인 중…',
    ariaLabel: '로그인 확인 중…',
    title: '',
  });
  assert.deepEqual(rauSignInFeedback({
    ...base,
    state: 'signed-in',
    signedIn: true,
    account: { email: 'andy@example.com' },
  }, 'Rau로 시작', false), {
    state: 'signed-in',
    label: 'Rau 연결 마침',
    ariaLabel: 'Rau 제공자 연결 마침',
    title: 'Rau 제공자 연결 마침',
  });
  assert.deepEqual(rauSignInFeedback({
    ...base,
    state: 'signed-in',
    signedIn: true,
    account: { email: 'andy@example.com' },
  }, 'Rau로 시작', true), {
    state: 'signed-in',
    label: '로그인됨',
    ariaLabel: '로그인됨. 다음 단계로 계속',
    title: '다음 단계로 계속',
  });
  assert.equal(rauSignInFeedback({ ...base, error: 'cancelled' }, '다시 시도').state, 'idle');
  assert.equal(rauSignInFeedback({ ...base, error: 'failed' }, '다시 시도').label, '다시 시도');

  const setup = readSource('../src/ui/initial-setup/initial-setup.ts');
  const css = readSource('../src/ui/initial-setup/initial-setup.css');
  assert.doesNotMatch(setup, /accountStatus\?\.signedIn === true[\s\S]{0,80}goNext\(\)/);
  assert.match(setup, /requestAccountStatus\(\)/);
  void css;
  assert.doesNotMatch(setup, /Raucloud|Railway|quota|allowance|크레딧|한도|60분|\$5/);
});

test('카드를 닫으면 편집기로 가고 보정은 사이드바 칩으로 남긴다', () => {
  const setup = readSource('../src/ui/initial-setup/initial-setup.ts');
  assert.match(
    setup,
    /function skipToEditor\(\): void \{\s*\n\s*finish\(\{\s*\n\s*providerStep: configuredCount\(\) > 0 \? 'configured' : 'skipped',\s*\n\s*calibrationStep: record\.calibrationStep === 'done' \? 'done' : 'pending',/,
  );
  assert.match(setup, /primary\.addEventListener\('click', skipToEditor\)/);
  assert.match(setup, /RAU_FAILURE_FORWARD_COPY\.skip/);
  assert.equal(RAU_FAILURE_FORWARD_COPY.skip, '편집기로 계속');
});
