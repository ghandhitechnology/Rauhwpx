/**
 * 첫 실행 마법사 — 모델 한 곳 연결과 문체 보정.
 *
 * 실제 로그인·설치는 설정 탭의 모달을, 보정은 기존 캘리브레이션
 * 창을 그대로 연다. 이 화면은 고르는 자리와 건너뛰기만 맡는다.
 */
import './initial-setup.css';

import type { AgentName, AgentSetupStatusMap, SidebarEvent } from '../../agent/types.ts';
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
  openCalibration: (options?: { elevate?: boolean }) => void;
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
  const { openAgentSetup, beginAgentConnect, openCalibration, storage } = deps;
  let disposed = false;
  let record: InitialSetupRecord = loadInitialSetup(storage);
  let stage: SetupStage = 'providers';
  let setupStatuses: AgentSetupStatusMap | null = null;
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

  const calPanel = el('div', 'rhwp-setup-cal');
  calPanel.hidden = true;
  const calMark = el('div', 'rhwp-setup-cal-mark', '✎');
  calMark.setAttribute('aria-hidden', 'true');
  const calTitle = el('h2', 'rhwp-setup-cal-title', '말투를 맞출까요?');
  const calCopy = el(
    'p',
    'rhwp-setup-cal-copy',
    '원고 10페이지를 올려서 에이전트가 말투를 따라하게 할 수 있습니다.',
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

  function showStage(nextStage: SetupStage): void {
    stage = nextStage;
    const providers = nextStage === 'providers';
    providersPanel.hidden = !providers;
    calPanel.hidden = providers;
    footer.hidden = !providers;
    back.hidden = providers;
    dialog.dataset.stage = nextStage;
    step.textContent = providers ? '1 / 2' : '2 / 2';
    title.textContent = providers ? '모델을 연결하세요' : '문체를 맞추세요';
    if (providers) renderCards();
  }

  function goBack(): void {
    if (stage !== 'calibration') return;
    showStage('providers');
    window.requestAnimationFrame(() => next.focus());
  }

  function finish(partial: Pick<InitialSetupRecord, 'providerStep' | 'calibrationStep'>): void {
    record = completeInitialSetup(partial, storage);
    close();
  }

  function skipProviders(): void {
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
      if (event.type !== 'agent-setup-status') return;
      setupStatuses = event.statuses;
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
