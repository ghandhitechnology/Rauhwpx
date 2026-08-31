/**
 * 첫 실행 마법사 — Rau 로그인/민트가 기본 길이고, 실패하면 같은 화면에서
 * BYOK 를 고르거나 편집기로 바로 간다. 실제 로그인·설치는 설정 모달을,
 * 보정은 기존 캘리브레이션 창을 그대로 연다.
 */
import './initial-setup.css';

import {
  applyFirstRunDefaultAgent,
} from '../../agent/agent-prefs.ts';
import type { AgentName, AgentSetupStatusMap, SidebarEvent } from '../../agent/types.ts';
import { AGENT_LABEL, createProviderIcon, PROVIDER_ORDER } from '../agent-sidebar/providers.ts';
import {
  isByokAgent,
  isProviderConfigured,
  isRauFirstRunFailure,
  previewModelLabels,
  PROVIDER_VENDOR,
  RAU_FAILURE_FORWARD_COPY,
  SUGGESTED_AGENT,
} from './catalog.ts';
import {
  completeInitialSetup,
  loadInitialSetup,
  shouldForceRauFailurePreview,
  shouldShowInitialSetup,
  type InitialSetupRecord,
  type InitialSetupStorage,
} from './state.ts';

type SetupStage = 'providers' | 'calibration';

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

export interface InitialSetupDeps {
  openAgentSetup: (agent: AgentName) => void;
  beginAgentConnect?: (agent: AgentName) => void;
  /** 실패 경로에서 설정 모달을 닫아 마법사 카드가 다시 보이게 한다. */
  closeAgentSetup?: () => void;
  openCalibration: (options?: { elevate?: boolean }) => void;
  storage?: InitialSetupStorage | null;
}

export interface InitialSetupUi {
  element: HTMLElement;
  open(): void;
  close(): void;
  handleEvent(event: SidebarEvent): void;
  notifyCalibrationClosed(completed: boolean): void;
  notifySetupAbandoned(info: { agent?: AgentName | null; code?: string; message?: string }): void;
  dispose(): void;
}

export function createInitialSetup(deps: InitialSetupDeps): InitialSetupUi {
  const { openAgentSetup, beginAgentConnect, closeAgentSetup, openCalibration, storage } = deps;
  let disposed = false;
  let record: InitialSetupRecord = loadInitialSetup(storage);
  let stage: SetupStage = 'providers';
  let setupStatuses: AgentSetupStatusMap | null = null;
  let rauFailureActive = false;
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
  progress.append(el('span', 'rhwp-setup-progress-bar'), el('span', 'rhwp-setup-progress-bar'));
  nav.append(back, brand, progress);

  const chrome = el('header', 'rhwp-setup-chrome');
  const heading = el('div', 'rhwp-setup-heading');
  const title = el('h1', 'rhwp-setup-title', '모델을 연결하세요');
  title.id = 'rhwp-setup-title';
  heading.append(title);
  const step = el('span', 'rhwp-setup-step', '1 / 2');
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
    if (isByokAgent(agent)) card.dataset.byok = 'true';
    const logo = el('div', 'rhwp-setup-card-logo');
    logo.appendChild(createProviderIcon(agent));
    const name = el('h2', 'rhwp-setup-card-name', AGENT_LABEL[agent]);
    const vendor = el('p', 'rhwp-setup-card-vendor', PROVIDER_VENDOR[agent]);
    const models = el('ul', 'rhwp-setup-card-models');
    for (const label of previewModelLabels(agent)) {
      models.appendChild(el('li', '', label));
    }
    const action = el('button', 'rhwp-setup-card-action', agent === 'rau' ? 'Rau로 시작' : '설정');
    action.type = 'button';
    action.addEventListener('click', () => (beginAgentConnect ?? openAgentSetup)(agent));
    card.append(logo, name, vendor, models, action);
    grid.appendChild(card);
    cards.set(agent, { root: card, action });
  }
  const recovery = el('aside', 'rhwp-setup-recovery');
  recovery.hidden = true;
  recovery.setAttribute('role', 'status');
  recovery.setAttribute('aria-live', 'polite');
  const recoveryCopy = el('p', 'rhwp-setup-recovery-copy', RAU_FAILURE_FORWARD_COPY.body);
  recovery.append(recoveryCopy);
  providersPanel.append(recovery, grid);

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

  dialog.append(nav, chrome, providersPanel, calPanel, footer);
  overlay.appendChild(dialog);

  function configuredAgents(): AgentName[] {
    return PROVIDER_ORDER.filter((agent) => isProviderConfigured(agent, setupStatuses));
  }

  function configuredCount(): number {
    return configuredAgents().length;
  }

  function connectActionLabel(agent: AgentName, configured: boolean): string {
    if (configured) return '연결됨';
    if (agent === 'rau') return rauFailureActive ? RAU_FAILURE_FORWARD_COPY.retry : 'Rau로 시작';
    return '설정';
  }

  function renderCards(): void {
    dialog.dataset.recovery = rauFailureActive ? 'true' : 'false';
    recovery.hidden = !rauFailureActive;
    skip.textContent = rauFailureActive ? RAU_FAILURE_FORWARD_COPY.skip : '나중에 하기';
    skip.classList.toggle('rhwp-setup-footer-btn', rauFailureActive);
    skip.classList.toggle('rhwp-setup-text-btn', !rauFailureActive);
    skip.dataset.kind = rauFailureActive ? 'next' : '';
    if (rauFailureActive && stage === 'providers') {
      title.textContent = RAU_FAILURE_FORWARD_COPY.title;
    }
    for (const agent of PROVIDER_ORDER) {
      const card = cards.get(agent);
      if (!card) continue;
      const configured = isProviderConfigured(agent, setupStatuses);
      card.root.dataset.configured = configured ? 'true' : 'false';
      card.root.dataset.recoveryOption = rauFailureActive && isByokAgent(agent) ? 'true' : 'false';
      card.action.textContent = connectActionLabel(agent, configured);
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
    next.title = ready
      ? '문체 보정으로'
      : rauFailureActive
        ? '다른 모델을 연결하거나 편집기로 계속을 누르세요'
        : '모델 한 곳을 연결하거나 나중에 하기를 누르세요';
    status.textContent = ready
      ? `${configuredCount()}곳 연결됨`
      : rauFailureActive
        ? RAU_FAILURE_FORWARD_COPY.status
        : '아직 연결한 모델이 없습니다';
  }

  function showStage(nextStage: SetupStage): void {
    stage = nextStage;
    const providers = nextStage === 'providers';
    providersPanel.hidden = !providers;
    calPanel.hidden = providers;
    footer.hidden = !providers;
    back.hidden = providers;
    dialog.dataset.stage = nextStage;
    step.textContent = providers ? '1 / 2' : '2 / 2';
    title.textContent = providers
      ? (rauFailureActive ? RAU_FAILURE_FORWARD_COPY.title : '모델을 연결하세요')
      : '문체를 맞추세요';
    if (providers) renderCards();
  }

  function goBack(): void {
    if (stage !== 'calibration') return;
    showStage('providers');
    window.requestAnimationFrame(() => next.focus());
  }

  function finish(partial: Pick<InitialSetupRecord, 'providerStep' | 'calibrationStep'>): void {
    applyFirstRunDefaultAgent(configuredAgents(), storage ?? null);
    record = completeInitialSetup(partial, storage);
    close();
  }

  function skipToEditor(): void {
    finish({
      providerStep: configuredCount() > 0 ? 'configured' : 'skipped',
      calibrationStep: 'skipped',
    });
  }

  function enterRauFailureRecovery(): void {
    if (disposed || !overlay.isConnected) return;
    if (stage !== 'providers') showStage('providers');
    const already = rauFailureActive;
    rauFailureActive = true;
    if (!already) closeAgentSetup?.();
    renderCards();
    window.requestAnimationFrame(() => skip.focus());
  }

  function skipProviders(): void {
    if (rauFailureActive) {
      skipToEditor();
      return;
    }
    record = { ...record, providerStep: record.providerStep === 'configured' ? 'configured' : 'skipped' };
    showStage('calibration');
  }

  function goNext(): void {
    if (configuredCount() === 0) return;
    record = { ...record, providerStep: 'configured' };
    showStage('calibration');
  }

  function skipCalibration(): void {
    finish({
      providerStep: configuredCount() > 0 ? 'configured' : 'skipped',
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
    if (shouldForceRauFailurePreview()) {
      rauFailureActive = true;
      renderCards();
    }
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
      if (event.type === 'agent-setup-error') {
        if (isRauFirstRunFailure(event)) enterRauFailureRecovery();
        return;
      }
      if (event.type !== 'agent-setup-status') return;
      setupStatuses = event.statuses;
      if (isProviderConfigured('rau', setupStatuses)) rauFailureActive = false;
      if (stage === 'providers') renderCards();
    },
    notifyCalibrationClosed(completed: boolean): void {
      if (disposed || !overlay.isConnected || stage !== 'calibration') return;
      if (!completed) return;
      finish({
        providerStep: configuredCount() > 0 ? 'configured' : 'skipped',
        calibrationStep: 'done',
      });
    },
    notifySetupAbandoned(info: { agent?: AgentName | null; code?: string; message?: string }): void {
      if (disposed) return;
      if (isRauFirstRunFailure(info)) enterRauFailureRecovery();
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
