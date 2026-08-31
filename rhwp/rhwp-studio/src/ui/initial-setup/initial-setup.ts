/**
 * 첫 실행 마법사 — 모델 한 곳 연결과 문체 보정.
 *
 * 실제 로그인·설치는 설정 탭의 모달을, 보정은 기존 캘리브레이션
 * 창을 그대로 연다. 이 화면은 고르는 자리와 건너뛰기만 맡는다.
 */
import './initial-setup.css';

import type { AgentName, AgentSetupStatusMap, SidebarEvent } from '../../agent/types.ts';
import type { AccountSnapshot } from '../../cloud/types.ts';
import { AGENT_LABEL, createProviderIcon, PROVIDER_ORDER } from '../agent-sidebar/providers.ts';
import {
  isProviderConfigured,
  previewModelLabels,
  PROVIDER_VENDOR,
  SUGGESTED_AGENT,
} from './catalog.ts';
import {
  completeInitialSetup,
  loadInitialSetup,
  shouldShowInitialSetup,
  type InitialSetupRecord,
  type InitialSetupStorage,
} from './state.ts';

type SetupStage = 'providers' | 'account' | 'calibration';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createPixelCloudArtwork(): HTMLElement {
  const artwork = el('div', 'rhwp-setup-cloud-art');
  artwork.setAttribute('aria-hidden', 'true');
  artwork.innerHTML = `
    <svg viewBox="0 0 240 160" focusable="false" shape-rendering="crispEdges">
      <g class="rhwp-setup-cloud-stars">
        <path class="rhwp-setup-cloud-star rhwp-setup-cloud-star-a" d="M34 31h4v8h8v4h-8v8h-4v-8h-8v-4h8z" />
        <path class="rhwp-setup-cloud-star rhwp-setup-cloud-star-b" d="M195 43h3v6h6v3h-6v6h-3v-6h-6v-3h6z" />
        <rect class="rhwp-setup-cloud-star rhwp-setup-cloud-star-c" x="55" y="105" width="5" height="5" />
        <rect class="rhwp-setup-cloud-star rhwp-setup-cloud-star-d" x="205" y="91" width="4" height="4" />
      </g>
      <g class="rhwp-setup-cloud-streams">
        <path d="M21 70h18v4H21zm8 11h22v4H29z" />
        <path d="M192 70h27v4h-27zm8 11h17v4h-17z" />
      </g>
      <g class="rhwp-setup-cloud-shadow">
        <rect x="68" y="133" width="104" height="4" />
        <rect x="84" y="137" width="72" height="3" />
      </g>
      <g class="rhwp-setup-cloud-float">
        <g class="rhwp-setup-cloud-outline">
          <path d="M44 76h16V60h24V44h24V32h48v12h20v16h20v16h16v40h-16v12H60v-12H44z" />
        </g>
        <g class="rhwp-setup-cloud-body">
          <path class="rhwp-setup-cloud-main" d="M52 80h16V64h24V48h24V40h32v8h20v16h20v16h16v28h-16v12H68v-12H52z" />
          <path class="rhwp-setup-cloud-shade" d="M52 100h16v12h16v8h84v-8h20v-12h16v8h-16v12h-20v8H68v-8H52z" />
          <path class="rhwp-setup-cloud-light" d="M92 56h24V44h32v8h-24v8H92zm-24 20h16V64h8v8H76v12h-8z" />
          <path class="rhwp-setup-cloud-glint" d="M152 64h16v8h8v8h-8v-4h-16z" />
        </g>
      </g>
    </svg>
  `;
  return artwork;
}

export interface InitialSetupDeps {
  openAgentSetup: (agent: AgentName) => void;
  beginAgentConnect?: (agent: AgentName) => void;
  openCalibration: (options?: { elevate?: boolean }) => void;
  requestAccount?: () => Promise<AccountSnapshot | null>;
  loginAccount?: () => Promise<{ authUrl: string } | null>;
  storage?: InitialSetupStorage | null;
}

export interface InitialSetupUi {
  element: HTMLElement;
  open(): void;
  close(): void;
  handleEvent(event: SidebarEvent): void;
  notifyCalibrationClosed(completed: boolean): void;
  dispose(): void;
}

export function createInitialSetup(deps: InitialSetupDeps): InitialSetupUi {
  const {
    openAgentSetup,
    beginAgentConnect,
    openCalibration,
    requestAccount,
    loginAccount,
    storage,
  } = deps;
  let disposed = false;
  let record: InitialSetupRecord = loadInitialSetup(storage);
  let stage: SetupStage = 'providers';
  let setupStatuses: AgentSetupStatusMap | null = null;
  let account: AccountSnapshot | null = null;
  let accountBusy = false;
  let accountAuthPending = false;
  let accountMessage = '';
  let lastFocus: HTMLElement | null = null;

  const overlay = el('div', 'rhwp-setup-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  const dialog = el('section', 'rhwp-setup-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'rhwp-setup-title');
  dialog.tabIndex = -1;

  const nav = el('nav', 'rhwp-setup-nav');
  nav.setAttribute('aria-label', '처음 설정 진행');
  const back = el('button', 'rhwp-setup-back', '이전');
  back.type = 'button';
  back.hidden = true;
  back.setAttribute('aria-label', '모델 연결 단계로 돌아가기');
  const backIcon = el('span', 'rhwp-setup-back-icon', '←');
  backIcon.setAttribute('aria-hidden', 'true');
  back.prepend(backIcon);
  const brand = el('span', 'rhwp-setup-brand', 'Rauhwpx');
  const progress = el('div', 'rhwp-setup-progress');
  progress.setAttribute('aria-hidden', 'true');
  progress.append(
    el('span', 'rhwp-setup-progress-bar'),
    el('span', 'rhwp-setup-progress-bar'),
    el('span', 'rhwp-setup-progress-bar'),
  );
  nav.append(back, brand, progress);

  const chrome = el('header', 'rhwp-setup-chrome');
  const heading = el('div', 'rhwp-setup-heading');
  const title = el('h1', 'rhwp-setup-title', '모델을 연결하세요');
  title.id = 'rhwp-setup-title';
  heading.append(title);
  const step = el('span', 'rhwp-setup-step', '1 / 3');
  chrome.append(heading, step);

  const providersPanel = el('div', 'rhwp-setup-providers');
  const grid = el('div', 'rhwp-setup-grid');
  grid.setAttribute('role', 'list');
  const cards = new Map<AgentName, {
    root: HTMLElement;
    action: HTMLButtonElement;
  }>();

  for (const agent of PROVIDER_ORDER) {
    const card = el('article', 'rhwp-setup-card');
    card.setAttribute('role', 'listitem');
    card.dataset.agent = agent;
    card.dataset.suggested = agent === SUGGESTED_AGENT ? 'true' : 'false';
    const logo = el('div', 'rhwp-setup-card-logo');
    logo.appendChild(createProviderIcon(agent));
    const name = el('h2', 'rhwp-setup-card-name', AGENT_LABEL[agent]);
    const vendor = el('p', 'rhwp-setup-card-vendor', PROVIDER_VENDOR[agent]);
    const models = el('ul', 'rhwp-setup-card-models');
    for (const label of previewModelLabels(agent)) {
      models.appendChild(el('li', '', label));
    }
    const action = el('button', 'rhwp-setup-card-action', '설정');
    action.type = 'button';
    action.addEventListener('click', () => (beginAgentConnect ?? openAgentSetup)(agent));
    card.append(logo, name, vendor, models, action);
    grid.appendChild(card);
    cards.set(agent, { root: card, action });
  }
  providersPanel.appendChild(grid);

  const accountPanel = el('div', 'rhwp-setup-account');
  accountPanel.hidden = true;
  const accountArtwork = createPixelCloudArtwork();
  const accountContent = el('div', 'rhwp-setup-account-content');
  const accountTitle = el('h2', 'rhwp-setup-account-title', 'Rauhwpx 계정');
  const accountCopy = el(
    'p',
    'rhwp-setup-account-copy',
    '로그인하면 Raucloud를 하루 60분까지 사용하고, 계정당 $5 모델 크레딧을 받을 수 있습니다.',
  );
  const accountState = el('p', 'rhwp-setup-account-state');
  accountState.setAttribute('role', 'status');
  accountState.setAttribute('aria-live', 'polite');
  const accountActions = el('div', 'rhwp-setup-account-actions');
  const accountSkip = el('button', 'rhwp-setup-text-btn', '로그인 없이 계속');
  accountSkip.type = 'button';
  const accountLogin = el('button', 'rhwp-setup-footer-btn rhwp-setup-primary', '계정으로 로그인');
  accountLogin.type = 'button';
  accountActions.append(accountSkip, accountLogin);
  accountContent.append(accountTitle, accountCopy, accountState, accountActions);
  accountPanel.append(accountArtwork, accountContent);

  const calPanel = el('div', 'rhwp-setup-cal');
  calPanel.hidden = true;
  const calMark = el('div', 'rhwp-setup-cal-mark', '✎');
  calMark.setAttribute('aria-hidden', 'true');
  const calTitle = el('h2', 'rhwp-setup-cal-title', '말투를 맞출까요?');
  const calCopy = el(
    'p',
    'rhwp-setup-cal-copy',
    '원고 10페이지를 올리면, 에이전트가 문장 규칙이 아니라 그 목소리로 씁니다.',
  );
  const calActions = el('div', 'rhwp-setup-cal-actions');
  const calSkip = el('button', 'rhwp-setup-text-btn', '나중에 하기');
  calSkip.type = 'button';
  const calStart = el('button', 'rhwp-setup-footer-btn rhwp-setup-primary', '보정 시작');
  calStart.type = 'button';
  calStart.dataset.kind = 'next';
  calActions.append(calSkip, calStart);
  calPanel.append(calMark, calTitle, calCopy, calActions);

  const footer = el('footer', 'rhwp-setup-footer');
  const status = el('p', 'rhwp-setup-status');
  const skip = el('button', 'rhwp-setup-text-btn', '나중에 하기');
  skip.type = 'button';
  const next = el('button', 'rhwp-setup-footer-btn', '다음');
  next.type = 'button';
  next.dataset.kind = 'next';
  footer.append(status, skip, next);

  dialog.append(nav, chrome, providersPanel, accountPanel, calPanel, footer);
  overlay.appendChild(dialog);

  function configuredCount(): number {
    return PROVIDER_ORDER.filter((agent) => isProviderConfigured(agent, setupStatuses)).length;
  }

  function renderCards(): void {
    for (const agent of PROVIDER_ORDER) {
      const card = cards.get(agent);
      if (!card) continue;
      const configured = isProviderConfigured(agent, setupStatuses);
      card.root.dataset.configured = configured ? 'true' : 'false';
      card.action.textContent = configured ? '연결됨' : '설정';
      const models = card.root.querySelector('.rhwp-setup-card-models');
      if (models) {
        models.replaceChildren();
        for (const label of previewModelLabels(agent)) {
          models.appendChild(el('li', '', label));
        }
      }
    }
    const ready = configuredCount() > 0;
    next.disabled = !ready;
    next.title = ready ? '문체 보정으로' : '모델 한 곳을 연결하거나 나중에 하기를 누르세요';
    status.textContent = ready
      ? `${configuredCount()}곳 연결됨`
      : '아직 연결한 모델이 없습니다';
  }

  function renderAccount(): void {
    const signedIn = account?.signedIn === true;
    accountPanel.dataset.signedIn = String(signedIn);
    accountPanel.dataset.busy = String(accountBusy || accountAuthPending);
    accountLogin.disabled = accountBusy || accountAuthPending || !loginAccount;
    accountSkip.disabled = accountBusy;
    accountLogin.textContent = accountBusy || accountAuthPending
      ? '로그인 확인 중…'
      : signedIn
        ? '로그인됨'
        : '계정으로 로그인';
    accountLogin.setAttribute('aria-label', signedIn
      ? '로그인됨. 다음 단계로 계속'
      : accountLogin.textContent);
    accountLogin.title = signedIn ? '다음 단계로 계속' : '';
    accountState.textContent = accountMessage || (signedIn
      ? `${account?.account?.email ?? '계정'}으로 로그인했습니다. Cloud 사용량은 설정에서 확인할 수 있습니다.`
      : loginAccount
        ? ''
        : '이 환경에서는 계정 로그인을 열 수 없습니다.');
  }

  async function refreshAccount(): Promise<void> {
    if (!requestAccount || accountBusy) return;
    accountBusy = true;
    renderAccount();
    try {
      account = await requestAccount();
      accountMessage = '';
    } catch {
      account = null;
      accountMessage = '계정 상태를 확인하지 못했습니다. 로그인 없이 계속할 수 있습니다.';
    } finally {
      accountBusy = false;
      if (!disposed) renderAccount();
    }
  }

  function showStage(nextStage: SetupStage): void {
    stage = nextStage;
    const providers = nextStage === 'providers';
    providersPanel.hidden = !providers;
    accountPanel.hidden = nextStage !== 'account';
    calPanel.hidden = nextStage !== 'calibration';
    footer.hidden = !providers;
    back.hidden = providers;
    dialog.dataset.stage = nextStage;
    step.textContent = providers ? '1 / 3' : nextStage === 'account' ? '2 / 3' : '3 / 3';
    title.textContent = providers
      ? '모델을 연결하세요'
      : nextStage === 'account'
        ? 'Rauhwpx 계정에 로그인하세요'
        : '문체를 맞추세요';
    back.setAttribute('aria-label', nextStage === 'calibration'
      ? '계정 연결 단계로 돌아가기'
      : '모델 연결 단계로 돌아가기');
    if (providers) renderCards();
    if (nextStage === 'account') {
      renderAccount();
      void refreshAccount();
    }
  }

  function goBack(): void {
    if (stage === 'providers') return;
    const target = stage === 'calibration' ? 'account' : 'providers';
    showStage(target);
    window.requestAnimationFrame(() => (target === 'account' ? accountLogin : next).focus());
  }

  function finish(partial: Pick<InitialSetupRecord, 'providerStep' | 'accountStep' | 'calibrationStep'>): void {
    record = completeInitialSetup(partial, storage);
    close();
  }

  function skipProviders(): void {
    record = { ...record, providerStep: record.providerStep === 'configured' ? 'configured' : 'skipped' };
    showStage('account');
  }

  function goNext(): void {
    if (configuredCount() === 0) return;
    record = { ...record, providerStep: 'configured' };
    showStage('account');
  }

  function continueFromAccount(): void {
    record = { ...record, accountStep: account?.signedIn ? 'configured' : 'skipped' };
    showStage('calibration');
  }

  async function loginAndContinue(): Promise<void> {
    if (account?.signedIn) {
      continueFromAccount();
      return;
    }
    if (!loginAccount || accountBusy || accountAuthPending) return;
    accountBusy = true;
    renderAccount();
    try {
      const auth = await loginAccount();
      if (auth?.authUrl) {
        window.open(auth.authUrl, '_blank', 'noopener,noreferrer');
        accountAuthPending = true;
        accountMessage = '브라우저에서 로그인을 마치면 이 화면에 자동으로 반영됩니다.';
      } else {
        accountAuthPending = false;
        accountMessage = '로그인을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.';
      }
    } catch {
      accountAuthPending = false;
      accountMessage = '로그인을 시작하지 못했습니다. 로그인 없이 계속할 수 있습니다.';
    } finally {
      accountBusy = false;
      if (!disposed) renderAccount();
    }
  }

  function skipCalibration(): void {
    finish({
      providerStep: configuredCount() > 0 ? 'configured' : 'skipped',
      accountStep: account?.signedIn ? 'configured' : record.accountStep === 'configured' ? 'configured' : 'skipped',
      calibrationStep: 'skipped',
    });
  }

  function startCalibration(): void {
    openCalibration({ elevate: true });
  }

  skip.addEventListener('click', skipProviders);
  next.addEventListener('click', goNext);
  calSkip.addEventListener('click', skipCalibration);
  calStart.addEventListener('click', startCalibration);
  accountSkip.addEventListener('click', continueFromAccount);
  accountLogin.addEventListener('click', () => { void loginAndContinue(); });
  back.addEventListener('click', goBack);

  function onKeyDown(event: KeyboardEvent): void {
    if (!overlay.isConnected || !overlay.classList.contains('rhwp-setup-open')) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (stage === 'providers') skipProviders();
    else goBack();
  }

  function open(): void {
    if (disposed || overlay.isConnected) return;
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(overlay);
    overlay.setAttribute('aria-hidden', 'false');
    showStage('providers');
    requestAnimationFrame(() => {
      overlay.classList.add('rhwp-setup-open');
      dialog.focus();
    });
  }

  function close(): void {
    if (!overlay.isConnected) return;
    overlay.classList.remove('rhwp-setup-open');
    overlay.setAttribute('aria-hidden', 'true');
    lastFocus?.focus();
    window.setTimeout(() => overlay.remove(), 420);
  }

  document.addEventListener('keydown', onKeyDown);

  return {
    element: overlay,
    open,
    close,
    handleEvent(event: SidebarEvent): void {
      if (disposed) return;
      if (event.type === 'agent-setup-status') {
        setupStatuses = event.statuses;
        if (stage === 'providers') renderCards();
        return;
      }
      if (event.type === 'rau-account-status') {
        account = event.account;
        accountBusy = false;
        accountAuthPending = false;
        accountMessage = '';
        if (account.signedIn) record = { ...record, accountStep: 'configured' };
        if (stage === 'account') renderAccount();
        return;
      }
      if (event.type === 'rau-account-error' && stage === 'account') {
        accountBusy = false;
        accountAuthPending = false;
        accountMessage = event.message;
        renderAccount();
      }
    },
    notifyCalibrationClosed(completed: boolean): void {
      if (disposed || !overlay.isConnected || stage !== 'calibration') return;
      if (!completed) return;
      finish({
        providerStep: configuredCount() > 0 ? 'configured' : 'skipped',
        accountStep: account?.signedIn ? 'configured' : record.accountStep === 'configured' ? 'configured' : 'skipped',
        calibrationStep: 'done',
      });
    },
    dispose(): void {
      disposed = true;
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    },
  };
}

export function maybeStartInitialSetup(deps: InitialSetupDeps): InitialSetupUi | null {
  if (!shouldShowInitialSetup(deps.storage)) return null;
  const ui = createInitialSetup(deps);
  ui.open();
  return ui;
}
