import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_MODELS, setOpenCodeModels } from '../src/agent/models.ts';
import type { AccountSessionStatus, AgentName, AgentSetupStatus } from '../src/agent/types.ts';
import { PROVIDER_ORDER } from '../src/ui/agent-sidebar/providers.ts';
import { BYOK_AGENTS, isProviderConfigured, isRauFirstRunFailure, previewModelLabels, PROVIDER_VENDOR, RAU_FAILURE_FORWARD_COPY, rauSignInFeedback, SUGGESTED_AGENT } from '../src/ui/initial-setup/catalog.ts';
import { completeInitialSetup, defaultInitialSetup, isInitialSetupComplete, loadInitialSetup, shouldForceInitialSetup, shouldForceRauFailurePreview, shouldShowInitialSetup, shouldSuppressInitialSetup } from '../src/ui/initial-setup/state.ts';

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

test('카드 모델 목록은 정적·동적 카탈로그를 짧게 보여 준다', () => {
  assert.deepEqual(previewModelLabels('claude'), AGENT_MODELS.claude.map((model) => model.label));
  assert.deepEqual(previewModelLabels('codex'), ['Astra', 'Sol', 'Terra', 'Luna']);
  assert.deepEqual(previewModelLabels('grok'), ['Grok 4.6', 'Grok 4.5']);
  assert.deepEqual(previewModelLabels('pi'), ['OpenRouter에서 고름', '최대 3개']);
  assert.deepEqual(previewModelLabels('cursor'), ['Auto', '구독 · API 모델']);
  assert.deepEqual(previewModelLabels('opencode'), ['Big Pickle', '연결 후 모델 자동 검색']);
  setOpenCodeModels(['anthropic/claude-sonnet-4-5']);
  try {
    assert.deepEqual(previewModelLabels('opencode'), ['anthropic/claude-sonnet-4-5']);
  } finally {
    setOpenCodeModels([]);
  }
  assert.deepEqual(previewModelLabels('rau'), ['GLM 5.3 Flash', 'DeepSeek V4 Flash', 'Qwen 3.8 Flash', 'Solar Pro 4']);
  assert.equal(SUGGESTED_AGENT, 'rau');
  assert.equal(PROVIDER_ORDER[0], 'rau');
  assert.deepEqual([...BYOK_AGENTS], ['claude', 'codex', 'pi', 'grok', 'cursor', 'opencode']);
  assert.equal(PROVIDER_VENDOR.opencode, 'Anomaly');
  for (const agent of PROVIDER_ORDER) {
    assert.ok(PROVIDER_VENDOR[agent]);
  }
});

test('연결됨은 실행 가능한 CLI와 인증을 둘 다 확인한다', () => {
  const statuses = {
    claude: status({ agent: 'claude', available: true }),
    codex: status({ agent: 'codex', connected: true }),
    pi: status({ agent: 'pi', setupComplete: true }),
    grok: status({ agent: 'grok', authenticated: true }),
    cursor: status({ agent: 'cursor', available: true, authenticated: true }),
    opencode: status({ agent: 'opencode', authenticated: true }),
    rau: status({ agent: 'rau' }),
  };
  assert.equal(isProviderConfigured('claude', statuses), false);
  assert.equal(isProviderConfigured('codex', statuses), true);
  assert.equal(isProviderConfigured('pi', statuses), true);
  assert.equal(isProviderConfigured('grok', statuses), false, '인증만 있고 CLI가 없으면 준비된 상태가 아니다');
  assert.equal(isProviderConfigured('cursor', statuses), true);
  assert.equal(isProviderConfigured('opencode', statuses), false, 'OpenCode 자격 증명만 있어도 연결 완료로 치지 않는다');
});

test('Rau 로그인·민트 실패는 같은 화면의 BYOK 경로로 접는다', () => {
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'RAU_CREDITS_TIMEOUT' }), true);
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'RAU_LOGIN_CANCELLED' }), true);
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'RAU_LOGIN_START_FAILED' }), true);
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'UNAUTHORIZED' }), true);
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'AGENT_AUTH_CANCELLED' }), true);
  assert.equal(isRauFirstRunFailure({ agent: 'rau', code: 'DEVICE_PROOF_INVALID' }), false);
  assert.equal(isRauFirstRunFailure({ agent: 'codex', code: 'AGENT_SETUP_FAILED' }), false);
  assert.equal(isRauFirstRunFailure({ agent: null, code: 'RAU_CREDITS_TIMEOUT' }), false);
  assert.deepEqual([...BYOK_AGENTS], ['claude', 'codex', 'pi', 'grok', 'cursor', 'opencode']);
  assert.match(RAU_FAILURE_FORWARD_COPY.body, /Claude, Codex, Pi, Grok, Cursor, OpenCode/);
  assert.match(RAU_FAILURE_FORWARD_COPY.body, /모델 없이 편집기로 바로 가세요/);
  assert.match(RAU_FAILURE_FORWARD_COPY.body, /문서는 그대로 열고 저장할 수 있습니다/);
  assert.equal(RAU_FAILURE_FORWARD_COPY.skip, '편집기로 계속');
  assert.doesNotMatch(RAU_FAILURE_FORWARD_COPY.body, /설정에서만|Settings-only|설정 탭에서만/);
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
});

test('실패 경로의 건너뛰기는 보정 단계 없이 편집기로 끝낸다', () => {
  assert.equal(RAU_FAILURE_FORWARD_COPY.skip, '편집기로 계속');
});
