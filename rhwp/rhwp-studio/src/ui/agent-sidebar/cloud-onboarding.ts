import './cloud-onboarding.css';

import type { CloudController } from '../../cloud/desktop-cloud.ts';
import type { CloudProfileDraft, CloudServerMode, CloudSnapshot } from '../../cloud/types.ts';
import {
  appServerProvider,
  createCloudSetupState,
  defaultCloudProfileDraft,
  mapCloudSetupIssue,
  mapSandboxIssue,
  RAUCLOUD_SETUP_WAIT_MINUTES,
  reconcileCloudSetupState,
  raucloudSetupElapsed,
  snapshotProfile,
  snapshotSandbox,
  validateCloudProfileDraft,
  type CloudProfileField,
  type CloudSetupIntent,
  type CloudSetupIssue,
  type CloudSetupStage,
  type CloudSetupState,
} from './cloud-onboarding-state.ts';
import { createIcon } from './icons.ts';

export interface CloudOnboardingDeps {
  controller: CloudController;
  onRequestTransfer(): void;
  onCloseSettings(): void;
  onSetupStateChange(active: boolean): void;
}

export interface CloudOnboarding {
  settingsElement: HTMLElement;
  open(intent: CloudSetupIntent, trigger: HTMLElement): void;
  sync(snapshot: CloudSnapshot): void;
  setMutationLocked(locked: boolean): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

type DraftlessKind = 'connected' | 'sandbox-ready' | 'sandbox-tearing-down';

function hasDraft(state: CloudSetupState): state is Exclude<CloudSetupState, { kind: DraftlessKind }> {
  return state.kind !== 'connected' && state.kind !== 'sandbox-ready' && state.kind !== 'sandbox-tearing-down';
}

function operationActive(state: CloudSetupState | null): boolean {
  return state?.kind === 'installing'
    || state?.kind === 'pairing'
    || state?.kind === 'sandbox-provisioning'
    || state?.kind === 'sandbox-tearing-down';
}

function raucloudLock(snapshot: CloudSnapshot): string | null {
  const gate = snapshot.account?.raucloud;
  if (!gate || gate.kind === 'available') return null;
  switch (gate.kind) {
    case 'logged-out': return 'Rauhwpx 계정으로 로그인하면 사용할 수 있습니다.';
    case 'exhausted': return '오늘 사용 시간을 모두 사용했습니다. 다음 초기화 뒤 다시 시작할 수 있습니다.';
    case 'active-elsewhere': return `${gate.deviceName ?? '다른 기기'}에서 실행 중입니다. 그 기기에서 작업을 마친 뒤 계속할 수 있습니다.`;
    case 'unavailable': return gate.reason;
  }
}

function desktopPlatform(): string {
  const bridge = (globalThis as { rhwpDesktop?: { platform?: string } }).rhwpDesktop;
  if (bridge?.platform) return bridge.platform;
  return typeof navigator !== 'undefined' && /win/i.test(navigator.platform) ? 'win32' : '';
}

export function createCloudOnboarding(deps: CloudOnboardingDeps): CloudOnboarding {
  let snapshot = deps.controller.getSnapshot();
  let state: CloudSetupState | null = null;
  let visible = false;
  let preserveOnOpen = false;
  let trigger: HTMLElement | null = null;
  let disposed = false;
  let operationEpoch = 0;
  let inertedElements: Array<[HTMLElement, boolean]> = [];
  let requestedFocusField: CloudProfileField | 'auth' | 'transport' | null = null;
  let cachedKeyPath = '';
  let cachedHttpsEndpoint = '';
  let mutationLocked = false;
  let setupProgressTimer: ReturnType<typeof setInterval> | null = null;

  const overlay = el('div', 'ag-cloud-setup-overlay');
  overlay.hidden = true;
  const dialog = el('section', 'ag-cloud-setup-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'ag-cloud-setup-title');
  dialog.setAttribute('aria-describedby', 'ag-cloud-setup-description');
  dialog.tabIndex = -1;
  const header = el('header', 'ag-cloud-setup-header');
  const titleWrap = el('div', 'ag-cloud-setup-heading');
  const eyebrow = el('span', 'ag-cloud-setup-eyebrow', 'PRIVATE CLOUD');
  const title = el('h2', 'ag-cloud-setup-title');
  title.id = 'ag-cloud-setup-title';
  titleWrap.append(eyebrow, title);
  const closeButton = el('button', 'ag-cloud-setup-close') as HTMLButtonElement;
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Cloud 설정 닫기');
  closeButton.appendChild(createIcon('close'));
  header.append(titleWrap, closeButton);
  const liveStatus = el('p', 'ag-cloud-setup-live');
  liveStatus.setAttribute('role', 'status');
  liveStatus.setAttribute('aria-live', 'polite');
  liveStatus.setAttribute('aria-atomic', 'true');
  const body = el('div', 'ag-cloud-setup-body');
  const footer = el('footer', 'ag-cloud-setup-footer');
  dialog.append(header, liveStatus, body, footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const settingsElement = el('section', 'ag-settings-section ag-cloud-settings');
  const settingsTitle = el('h3', 'ag-settings-section-title', 'Cloud 서버');
  const settingsCard = el('div', 'ag-cloud-settings-card');
  const settingsIcon = el('span', 'ag-cloud-settings-icon');
  settingsIcon.appendChild(createIcon('cloud'));
  const settingsCopy = el('div', 'ag-cloud-settings-copy');
  const settingsStatus = el('strong', 'ag-cloud-settings-status');
  const settingsDetail = el('span', 'ag-cloud-settings-detail');
  settingsCopy.append(settingsStatus, settingsDetail);
  const settingsAction = el('button', 'ag-settings-btn ag-cloud-settings-action') as HTMLButtonElement;
  settingsAction.type = 'button';
  settingsAction.addEventListener('click', () => open('manage', settingsAction));
  settingsCard.append(settingsIcon, settingsCopy, settingsAction);
  settingsElement.append(settingsTitle, settingsCard);

  function button(label: string, tone: 'primary' | 'quiet' | 'danger' = 'quiet'): HTMLButtonElement {
    const item = el('button', `ag-cloud-setup-button ag-${tone}`, label) as HTMLButtonElement;
    item.type = 'button';
    return item;
  }

  function setState(next: CloudSetupState, announcement = ''): void {
    state = next;
    deps.onSetupStateChange(operationActive(next));
    if (announcement) liveStatus.textContent = announcement;
    renderDialog();
    syncSetupProgressTimer();
  }

  function setupProgressText(startedAt: number): string {
    return `준비 작업이 계속 실행 중입니다. ${raucloudSetupElapsed(startedAt)} 경과. 초기 설정은 최대 ${RAUCLOUD_SETUP_WAIT_MINUTES}분 걸릴 수 있습니다.`;
  }

  function updateSetupProgress(): void {
    if (state?.kind !== 'sandbox-provisioning') return;
    const message = setupProgressText(state.startedAt);
    liveStatus.textContent = message;
    const wait = body.querySelector<HTMLElement>('.ag-cloud-setup-wait');
    if (wait) wait.textContent = message;
    renderSettings();
  }

  function syncSetupProgressTimer(): void {
    if (state?.kind === 'sandbox-provisioning') {
      updateSetupProgress();
      setupProgressTimer ??= setInterval(updateSetupProgress, 1_000);
      return;
    }
    if (setupProgressTimer) clearInterval(setupProgressTimer);
    setupProgressTimer = null;
  }

  function beginOperation(): number {
    operationEpoch += 1;
    return operationEpoch;
  }

  function operationIsCurrent(operation: number): boolean {
    return !disposed && operation === operationEpoch;
  }

  function setModalIsolation(active: boolean): void {
    if (active) {
      if (inertedElements.length) return;
      inertedElements = [...document.body.children]
        .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== overlay)
        .map((node) => [node, node.inert]);
      for (const [node] of inertedElements) node.inert = true;
      return;
    }
    for (const [node, wasInert] of inertedElements) node.inert = wasInert;
    inertedElements = [];
  }

  function currentDraft(): CloudProfileDraft {
    if (!state) return defaultCloudProfileDraft(snapshotProfile(snapshot));
    if (state.kind === 'connected') return defaultCloudProfileDraft(state.profile);
    if (!hasDraft(state)) return defaultCloudProfileDraft(snapshotProfile(snapshot));
    return state.draft;
  }

  function resetConditionalDrafts(draft: CloudProfileDraft): void {
    cachedKeyPath = draft.auth.kind === 'key-file' ? draft.auth.keyPath : '';
    cachedHttpsEndpoint = draft.transport.kind === 'https' ? draft.transport.endpoint : '';
  }

  function updateDraft(update: (draft: CloudProfileDraft) => CloudProfileDraft): void {
    if (!state || !hasDraft(state)) return;
    state = { ...state, draft: update(state.draft) };
  }

  function close(restoreFocus = true): void {
    if (!visible) return;
    visible = false;
    overlay.hidden = true;
    setModalIsolation(false);
    const focusTarget = trigger;
    trigger = null;
    if (operationActive(state)) preserveOnOpen = true;
    else {
      operationEpoch += 1;
      if (!preserveOnOpen) state = null;
    }
    if (restoreFocus && focusTarget?.isConnected) focusTarget.focus();
  }

  function issueDetails(issue: CloudSetupIssue): HTMLElement {
    const details = el('details', 'ag-cloud-setup-technical');
    const summary = el('summary', '', '기술 정보');
    const detail = el('pre', '', issue.detail);
    details.append(summary, detail);
    return details;
  }

  function description(text: string): HTMLParagraphElement {
    const node = el('p', 'ag-cloud-setup-description', text);
    node.id = 'ag-cloud-setup-description';
    return node;
  }

  function callout(icon: 'check' | 'cloud', heading: string, text: string): HTMLElement {
    const node = el('div', 'ag-cloud-setup-callout');
    const iconNode = el('span', 'ag-cloud-setup-callout-icon');
    iconNode.appendChild(createIcon(icon));
    const copy = el('div');
    copy.append(el('strong', '', heading), el('p', '', text));
    node.append(iconNode, copy);
    return node;
  }

  function inputField(
    label: string,
    fieldName: CloudProfileField,
    value: string,
    options: { type?: string; placeholder?: string; autocomplete?: string; autofocus?: boolean } = {},
  ): { root: HTMLLabelElement; input: HTMLInputElement } {
    const root = el('label', 'ag-cloud-setup-field');
    const labelNode = el('span', 'ag-cloud-setup-label', label);
    const input = el('input', options.autofocus ? 'ag-cloud-setup-input ag-cloud-setup-autofocus' : 'ag-cloud-setup-input') as HTMLInputElement;
    input.type = options.type ?? 'text';
    input.dataset.cloudField = fieldName;
    input.value = value;
    input.placeholder = options.placeholder ?? '';
    if (options.autocomplete) input.setAttribute('autocomplete', options.autocomplete);
    const error = state && 'errors' in state ? state.errors[fieldName] : undefined;
    const errorId = `ag-cloud-setup-error-${fieldName}`;
    if (error) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', errorId);
    }
    root.append(labelNode, input);
    if (error) {
      const errorNode = el('span', 'ag-cloud-setup-field-error', error);
      errorNode.id = errorId;
      root.appendChild(errorNode);
    }
    return { root, input };
  }

  function profileForm(existing: boolean): HTMLFormElement {
    const draft = currentDraft();
    if (draft.auth.kind === 'key-file') cachedKeyPath = draft.auth.keyPath;
    if (draft.transport.kind === 'https') cachedHttpsEndpoint = draft.transport.endpoint;
    const form = el('form', 'ag-cloud-setup-form');
    const grid = el('div', 'ag-cloud-setup-grid');
    const host = inputField('VPS 주소', 'host', draft.host, {
      placeholder: draft.transport.kind === 'ssh-tunnel'
        ? 'mac-mini.local 또는 192.168.1.20'
        : '100.64.0.1 또는 vps-name.tailnet.ts.net',
      autocomplete: 'off',
      autofocus: true,
    });
    const user = inputField('SSH 사용자', 'sshUser', draft.sshUser, {
      placeholder: draft.transport.kind === 'ssh-tunnel' ? 'macadmin 또는 ubuntu' : 'ubuntu',
      autocomplete: 'username',
    });
    const authRoot = el('label', 'ag-cloud-setup-field');
    authRoot.appendChild(el('span', 'ag-cloud-setup-label', 'SSH 인증'));
    const auth = el('select', 'ag-cloud-setup-input') as HTMLSelectElement;
    auth.dataset.cloudField = 'auth';
    auth.append(new Option('SSH agent', 'ssh-agent'), new Option('개인 키 파일', 'key-file'));
    auth.value = draft.auth.kind;
    authRoot.appendChild(auth);
    grid.append(host.root, user.root, authRoot);
    form.appendChild(grid);

    const advanced = el('details', 'ag-cloud-setup-advanced');
    if (existing || draft.auth.kind === 'key-file' || draft.transport.kind !== 'tailscale' || Boolean(state && 'errors' in state && (state.errors.name || state.errors.sshPort || state.errors.tailscaleHttpsPort || state.errors.keyPath || state.errors.endpoint))) advanced.open = true;
    const advancedSummary = el('summary', '', '고급 설정');
    const advancedGrid = el('div', 'ag-cloud-setup-grid ag-cloud-setup-advanced-grid');
    const name = inputField('환경 이름', 'name', draft.name, { placeholder: 'My VPS' });
    const sshPort = inputField('SSH 포트', 'sshPort', String(draft.sshPort), { type: 'number' });
    sshPort.input.min = '1';
    sshPort.input.max = '65535';
    const transportRoot = el('label', 'ag-cloud-setup-field');
    transportRoot.appendChild(el('span', 'ag-cloud-setup-label', '연결 방식'));
    const transport = el('select', 'ag-cloud-setup-input') as HTMLSelectElement;
    transport.dataset.cloudField = 'transport';
    transport.append(
      new Option('일반 SSH 터널 (Mac 지원)', 'ssh-tunnel'),
      new Option('Tailscale', 'tailscale'),
      new Option('공개 HTTPS', 'https'),
    );
    transport.value = draft.transport.kind;
    transportRoot.appendChild(transport);
    const httpsPort = inputField('Tailscale HTTPS 포트', 'tailscaleHttpsPort', String(draft.tailscaleHttpsPort ?? 443), { type: 'number' });
    httpsPort.input.min = '1';
    httpsPort.input.max = '65535';
    advancedGrid.append(name.root, sshPort.root, transportRoot);
    if (draft.transport.kind === 'tailscale') advancedGrid.appendChild(httpsPort.root);
    let endpoint: ReturnType<typeof inputField> | null = null;
    if (draft.transport.kind === 'https') {
      endpoint = inputField('Cloud HTTPS 주소', 'endpoint', draft.transport.endpoint || cachedHttpsEndpoint, {
        placeholder: 'https://cloud.example.com/rauhwpx-cloud',
        autocomplete: 'url',
      });
      advancedGrid.appendChild(endpoint.root);
    }
    let keyPath: ReturnType<typeof inputField> | null = null;
    if (draft.auth.kind === 'key-file') {
      keyPath = inputField('개인 키 파일', 'keyPath', draft.auth.keyPath || cachedKeyPath, {
        placeholder: desktopPlatform() === 'win32' ? 'C:\\Users\\me\\.ssh\\id_ed25519' : '/Users/me/.ssh/id_ed25519',
      });
      advancedGrid.appendChild(keyPath.root);
    }
    advanced.append(advancedSummary, advancedGrid);
    form.appendChild(advanced);

    const read = (): void => {
      if (keyPath) cachedKeyPath = keyPath.input.value;
      if (endpoint) cachedHttpsEndpoint = endpoint.input.value;
      updateDraft((current) => ({
        ...current,
        name: name.input.value,
        host: host.input.value,
        sshUser: user.input.value,
        sshPort: Number(sshPort.input.value),
        tailscaleHttpsPort: Number(httpsPort.input.value),
        auth: auth.value === 'key-file'
          ? { kind: 'key-file', keyPath: keyPath?.input.value ?? cachedKeyPath }
          : { kind: 'ssh-agent' },
        transport: transport.value === 'https'
          ? { kind: 'https', endpoint: endpoint?.input.value ?? cachedHttpsEndpoint }
          : transport.value === 'ssh-tunnel'
            ? { kind: 'ssh-tunnel' }
            : { kind: 'tailscale' },
      }));
    };
    for (const input of [host.input, user.input, auth, name.input, sshPort.input, transport, httpsPort.input, endpoint?.input, keyPath?.input]) {
      input?.addEventListener('input', read);
      input?.addEventListener('change', () => {
        read();
        if (input === auth || input === transport) {
          requestedFocusField = input === auth ? 'auth' : 'transport';
          renderDialog();
        }
      });
    }
    return form;
  }

  function submitOnEnter(form: HTMLFormElement): void {
    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || !(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      form.requestSubmit();
    });
  }

  async function checkConnection(): Promise<void> {
    if (!state || !hasDraft(state)) return;
    const draft = defaultCloudProfileDraft(state.draft);
    const errors = validateCloudProfileDraft(draft);
    if (Object.keys(errors).length) {
      setState({ kind: 'editing', draft, intent: state.intent, errors }, '입력한 연결 정보를 확인하세요.');
      return;
    }
    const intent = state.intent;
    const operation = beginOperation();
    setState({ kind: 'checking', draft, intent }, 'VPS 연결을 확인하고 있습니다.');
    try {
      await deps.controller.testProfile(draft);
      if (!operationIsCurrent(operation)) return;
      setState({ kind: 'ready-to-install', draft, intent }, 'VPS에 연결할 수 있습니다.');
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      setState({ kind: 'check-failed', draft, intent, issue: mapCloudSetupIssue(error, draft.transport.kind) }, 'VPS 연결을 확인하지 못했습니다.');
    }
  }

  async function install(): Promise<void> {
    if (!state || state.kind !== 'ready-to-install') return;
    const { draft, intent } = state;
    const operation = beginOperation();
    setState({ kind: 'installing', draft, intent, stage: 'installing' }, 'VPS에 Cloud 환경을 설치하고 있습니다.');
    try {
      const provisioned = await deps.controller.provision('stable', draft);
      if (!operationIsCurrent(operation)) return;
      const profile = snapshotProfile(provisioned) ?? draft;
      setState({ kind: 'connected', profile, intent }, 'Cloud 환경이 준비되었습니다.');
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      setState({ kind: 'install-failed', draft, intent, issue: mapCloudSetupIssue(error, draft.transport.kind), retry: 'install' }, 'Cloud 환경 설치를 마치지 못했습니다.');
    }
  }

  async function pairExisting(): Promise<void> {
    if (!state || state.kind !== 'existing') return;
    const draft = defaultCloudProfileDraft(state.draft);
    const pairingCode = state.pairingCode.trim().toUpperCase();
    const errors = validateCloudProfileDraft(draft, { existing: true, pairingCode });
    if (Object.keys(errors).length) {
      setState({ ...state, draft, pairingCode, errors }, '입력한 서버 ID와 페어링 코드를 확인하세요.');
      return;
    }
    const intent = state.intent;
    const operation = beginOperation();
    setState({ kind: 'pairing', draft, intent, pairingCode }, '설치된 Cloud 환경과 페어링하고 있습니다.');
    try {
      const verified = await deps.controller.pair(pairingCode, draft);
      if (!operationIsCurrent(operation)) return;
      setState({ kind: 'connected', profile: snapshotProfile(verified) ?? draft, intent }, 'Cloud 환경이 연결되었습니다.');
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      setState({
        kind: 'install-failed',
        draft,
        intent,
        issue: mapCloudSetupIssue(error, draft.transport.kind),
        retry: 'pair',
        pairingCode: '',
      }, '설치된 Cloud 환경에 연결하지 못했습니다.');
    }
  }

  async function selectMode(mode: CloudServerMode): Promise<void> {
    if (!state || state.kind !== 'choose') return;
    state = { ...state, mode };
    renderDialog();
    await deps.controller.selectServerMode(mode).catch(() => {
      liveStatus.textContent = '선택한 서버 방식을 저장하지 못했습니다. 다시 시도해 주세요.';
    });
  }

  function openSandboxStep(draft: CloudProfileDraft, intent: CloudSetupIntent): void {
    const locked = raucloudLock(snapshot);
    if (locked) {
      liveStatus.textContent = locked;
      return;
    }
    const provider = appServerProvider(snapshot);
    if (!provider || !provider.configured) {
      setState(
        { kind: 'sandbox-unavailable', draft, intent, provider },
        'Raucloud를 사용할 수 없습니다.',
      );
      return;
    }
    setState({ kind: 'sandbox-intro', draft, intent, provider });
  }

  async function spawnSandbox(): Promise<void> {
    if (!state || (state.kind !== 'sandbox-intro' && state.kind !== 'sandbox-failed')) return;
    const locked = raucloudLock(snapshot);
    if (locked) {
      liveStatus.textContent = locked;
      return;
    }
    const { draft, intent } = state;
    const providerId = state.kind === 'sandbox-intro' ? state.provider.providerId : undefined;
    const operation = beginOperation();
    setState({ kind: 'sandbox-provisioning', draft, intent, startedAt: Date.now() }, 'Raucloud를 준비하고 있습니다.');
    try {
      const next = await deps.controller.spawnSandbox(providerId);
      if (!operationIsCurrent(operation)) return;
      const ready = snapshotSandbox(next);
      if (!ready) {
        setState({
          kind: 'sandbox-failed',
          draft,
          intent,
          issue: mapSandboxIssue(new Error(next.server.message ?? 'App sandbox is not ready')),
          phase: 'spawn',
        }, 'Raucloud를 준비하지 못했습니다.');
        return;
      }
      setState(
        { kind: 'sandbox-ready', intent, name: ready.name, sandbox: ready.sandbox },
        'Raucloud가 준비되었습니다.',
      );
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      setState({
        kind: 'sandbox-failed',
        draft,
        intent,
        issue: mapSandboxIssue(error),
        phase: 'spawn',
      }, 'Raucloud를 준비하지 못했습니다.');
    }
  }

  async function teardownSandbox(): Promise<void> {
    if (!state || (state.kind !== 'sandbox-ready' && state.kind !== 'sandbox-failed')) return;
    const { intent } = state;
    const name = state.kind === 'sandbox-ready' ? state.name : snapshotSandbox(snapshot)?.name ?? 'Raucloud';
    const draft = state.kind === 'sandbox-failed' ? state.draft : defaultCloudProfileDraft(snapshotProfile(snapshot));
    const operation = beginOperation();
    setState({ kind: 'sandbox-tearing-down', intent, name }, 'Raucloud를 종료하고 있습니다.');
    try {
      const next = await deps.controller.teardownSandbox();
      if (!operationIsCurrent(operation)) return;
      const released = next.sandbox?.unmanaged === true;
      const settled = createCloudSetupState(next, intent);
      setState(
        released && settled.kind === 'choose'
          ? { ...settled, notice: `${name}의 연결만 놓았습니다. 남은 서버는 공급자 콘솔에서 직접 삭제하세요.` }
          : settled,
        released
          ? '연결을 놓았습니다. 남은 서버는 공급자 콘솔에서 직접 삭제하세요.'
          : 'Raucloud를 종료했습니다.',
      );
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      setState({
        kind: 'sandbox-failed',
        draft,
        intent,
        issue: mapSandboxIssue(error),
        phase: 'teardown',
      }, 'Raucloud를 종료하지 못했습니다.');
    }
  }

  /** 공급자에게 직접 물어 화면을 되살린다. 실패 화면에 갇힌 사용자가 앱을 다시 시작하지 않아도 되게 한다. */
  async function refreshSandbox(): Promise<void> {
    if (!state || (state.kind !== 'sandbox-ready' && state.kind !== 'sandbox-failed')) return;
    const { intent } = state;
    const draft = state.kind === 'sandbox-failed' ? state.draft : defaultCloudProfileDraft(snapshotProfile(snapshot));
    const phase = state.kind === 'sandbox-failed' ? state.phase : 'spawn';
    const operation = beginOperation();
    liveStatus.textContent = 'Raucloud 상태를 확인하고 있습니다.';
    try {
      const next = await deps.controller.sandboxStatus();
      if (!operationIsCurrent(operation)) return;
      setState(createCloudSetupState(next, intent), 'Raucloud 상태를 확인했습니다.');
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      setState({ kind: 'sandbox-failed', draft, intent, issue: mapSandboxIssue(error), phase },
        'Raucloud 상태를 확인하지 못했습니다.');
    }
  }

  function serverOption(
    mode: CloudServerMode,
    heading: string,
    text: string,
    selected: boolean,
    note = '',
    disabled = false,
  ): HTMLButtonElement {
    const option = el('button', 'ag-cloud-setup-option') as HTMLButtonElement;
    option.type = 'button';
    option.dataset.serverMode = mode;
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(selected));
    option.disabled = disabled;
    option.setAttribute('aria-disabled', String(disabled));
    if (selected) option.classList.add('ag-selected');
    const copy = el('div', 'ag-cloud-setup-option-copy');
    copy.append(el('strong', '', heading), el('p', '', text));
    if (note) copy.appendChild(el('span', 'ag-cloud-setup-option-note', note));
    option.append(copy);
    option.addEventListener('click', () => {
      if (!disabled) void selectMode(mode);
    });
    return option;
  }

  function renderDialog(): void {
    if (!state) return;
    body.replaceChildren();
    footer.replaceChildren();
    closeButton.textContent = '';
    closeButton.appendChild(createIcon('close'));
    const busy = operationActive(state);
    closeButton.setAttribute('aria-label', busy ? '설정을 숨기고 작업 계속' : 'Cloud 설정 닫기');
    dialog.setAttribute('aria-busy', String(busy || state.kind === 'checking'));

    const back = button('뒤로');
    const cancel = button(busy ? '숨기기' : '취소');
    cancel.addEventListener('click', () => close());
    closeButton.onclick = () => close();

    if (state.kind === 'choose') {
      const { draft, intent, mode } = state;
      const provider = appServerProvider(snapshot);
      const appHostedLock = raucloudLock(snapshot);
      title.textContent = 'Cloud 서버 선택';
      body.append(description('에이전트가 앱을 닫아도 계속 작업할 서버를 고르세요. 나중에 바꿀 수 있습니다.'));
      if (state.notice) body.append(callout('cloud', '남은 서버를 확인하세요', state.notice));
      const options = el('div', 'ag-cloud-setup-options');
      options.setAttribute('role', 'radiogroup');
      options.setAttribute('aria-label', 'Cloud 서버 선택');
      options.append(
        serverOption(
          'app-hosted',
          'Raucloud',
          'Rauhwpx가 샌드박스를 만들고 이 기기에 연결합니다.',
          mode === 'app-hosted',
          provider
            ? provider.configured
              ? appHostedLock ?? `${provider.displayName} 사용 가능`
              : '이 빌드에서는 아직 사용할 수 없습니다'
            : '이 빌드에는 포함되지 않았습니다',
          Boolean(appHostedLock),
        ),
        serverOption(
          'self-hosted',
          '내 서버 사용',
          '보유한 Ubuntu 또는 Debian VPS에 개인 Cloud 환경을 설치합니다.',
          mode === 'self-hosted',
          'SSH와 비밀번호 없는 sudo가 필요합니다',
        ),
      );
      body.appendChild(options);
      const primary = button('계속', 'primary');
      primary.disabled = mode === 'app-hosted' && Boolean(appHostedLock);
      if (primary.disabled) primary.textContent = '계정 로그인 필요';
      primary.addEventListener('click', () => {
        if (mode === 'app-hosted') openSandboxStep(draft, intent);
        else setState({ kind: 'intro', draft, intent });
      });
      footer.append(cancel, primary);
    } else if (state.kind === 'sandbox-intro') {
      const { draft, intent, provider } = state;
      const appHostedLock = raucloudLock(snapshot);
      title.textContent = 'Raucloud 사용';
      body.append(
        description('Rauhwpx가 샌드박스를 만들고 이 기기에 연결합니다.'),
        callout('cloud', provider.displayName, '파일과 작업 상태를 샌드박스로 전송합니다. 서버를 종료하면 샌드박스도 삭제됩니다.'),
      );
      back.addEventListener('click', () => setState({ kind: 'choose', draft, intent, mode: 'app-hosted' }));
      const primary = button('서버 만들기', 'primary');
      primary.disabled = Boolean(appHostedLock);
      if (appHostedLock) body.append(callout('cloud', 'Raucloud를 사용할 수 없음', appHostedLock));
      primary.addEventListener('click', () => { void spawnSandbox(); });
      footer.append(back, cancel, primary);
    } else if (state.kind === 'sandbox-unavailable') {
      const { draft, intent, provider } = state;
      title.textContent = 'Raucloud를 사용할 수 없습니다';
      body.append(
        description('이 빌드에는 Raucloud 설정이 없습니다. 내 서버를 연결하면 지금 바로 사용할 수 있습니다.'),
        callout(
          'cloud',
          provider ? `${provider.displayName} 설정 필요` : 'Raucloud 없음',
          provider?.missingConfig.length
            ? `운영자가 ${provider.missingConfig.join(', ')}을 설정해야 합니다.`
            : '앱을 업데이트하거나 내 서버를 사용하세요.',
        ),
      );
      back.addEventListener('click', () => setState({ kind: 'choose', draft, intent, mode: 'app-hosted' }));
      const primary = button('내 서버 사용', 'primary');
      primary.addEventListener('click', () => setState({ kind: 'intro', draft, intent }));
      footer.append(back, cancel, primary);
    } else if (state.kind === 'sandbox-provisioning') {
      title.textContent = 'Raucloud 준비 중';
      body.append(
        description('샌드박스를 만들고 이 기기를 연결하고 있습니다. 서버 생성과 첫 시작에는 몇 분이 걸릴 수 있습니다.'),
        el('div', 'ag-cloud-setup-indeterminate'),
        el('p', 'ag-cloud-setup-wait', setupProgressText(state.startedAt)),
      );
      const working = button('준비 중...', 'primary');
      working.disabled = true;
      footer.append(cancel, working);
    } else if (state.kind === 'sandbox-tearing-down') {
      title.textContent = 'Raucloud 종료 중';
      body.append(
        description(`${state.name}을 종료하고 저장된 연결 정보를 지우고 있습니다.`),
        el('div', 'ag-cloud-setup-indeterminate'),
      );
      footer.append(cancel);
    } else if (state.kind === 'sandbox-failed') {
      const { draft, intent, issue, phase } = state;
      const live = Boolean(snapshotSandbox(snapshot));
      title.textContent = phase === 'teardown'
        ? 'Raucloud를 종료하지 못했습니다'
        : 'Raucloud를 준비하지 못했습니다';
      body.append(
        description(phase === 'teardown'
          ? '샌드박스가 아직 남아 있습니다. 문제를 해결한 뒤 다시 종료하세요.'
          : '다시 시도하거나 내 서버를 연결해 계속할 수 있습니다.'),
        callout('cloud', issue.title, issue.guidance),
        issueDetails(issue),
      );
      footer.append(cancel);
      const refresh = button('상태 확인');
      refresh.addEventListener('click', () => { void refreshSandbox(); });
      if (phase === 'teardown') {
        footer.append(refresh);
        const teardown = button('다시 종료', 'danger');
        teardown.addEventListener('click', () => { void teardownSandbox(); });
        footer.append(teardown);
        const backToChoice = button('서버 다시 선택', 'primary');
        backToChoice.addEventListener('click', () => setState({ kind: 'choose', draft, intent, mode: 'app-hosted' }));
        footer.append(backToChoice);
      } else {
        const useOwn = button('내 서버 사용');
        useOwn.addEventListener('click', () => setState({ kind: 'intro', draft, intent }));
        footer.append(useOwn);
        if (live) {
          footer.append(refresh);
          const teardown = button('서버 종료', 'danger');
          teardown.addEventListener('click', () => { void teardownSandbox(); });
          footer.append(teardown);
        }
        const retry = button('다시 시도', 'primary');
        retry.addEventListener('click', () => { void spawnSandbox(); });
        footer.append(retry);
      }
    } else if (state.kind === 'sandbox-ready') {
      const { intent, name, sandbox } = state;
      const appHostedLock = raucloudLock(snapshot);
      title.textContent = 'Raucloud가 준비되었습니다';
      body.append(
        callout('check', name, sandbox.host || sandbox.sandboxId),
        description('이제 작업을 Cloud로 보내면 앱을 닫아도 앱 샌드박스에서 에이전트가 계속 작업합니다.'),
      );
      if (snapshot.server.message) {
        body.appendChild(callout('cloud', '서버 상태', snapshot.server.message));
      }
      const refresh = button('상태 확인');
      refresh.addEventListener('click', () => { void refreshSandbox(); });
      const teardown = button('서버 종료', 'danger');
      teardown.addEventListener('click', () => { void teardownSandbox(); });
      footer.append(refresh);
      const primary = button(intent === 'transfer' ? 'Cloud로 계속' : '완료', 'primary');
      if (intent === 'transfer' && appHostedLock) {
        primary.disabled = true;
        primary.textContent = '새 작업을 시작할 수 없음';
        body.append(callout('cloud', '새 작업을 시작할 수 없음', appHostedLock));
      }
      primary.addEventListener('click', () => {
        if (intent === 'transfer') {
          close(false);
          deps.onCloseSettings();
          deps.onRequestTransfer();
        } else close(true);
      });
      footer.append(teardown, primary);
    } else if (state.kind === 'intro') {
      const { draft, intent } = state;
      title.textContent = '내 VPS에서 Cloud 시작하기';
      body.append(
        description('Rauhwpx가 원격 Mac mini 또는 Linux VPS에 개인 Cloud 환경을 설치합니다. 일반 SSH, Tailscale, 공개 HTTPS를 지원하며 앱을 닫아도 에이전트는 계속 작업합니다.'),
        callout('cloud', '내 서버에서만 실행', '문서와 작업 상태는 사용자가 선택한 VPS로 전송됩니다.'),
      );
      const requirements = el('div', 'ag-cloud-setup-requirements');
      requirements.append(el('strong', '', '준비할 것'));
      const list = el('ul');
      for (const requirement of ['Apple silicon macOS 14 이상 또는 Ubuntu/Debian', 'SSH agent 또는 개인 키 파일', '비밀번호 없이 sudo를 실행할 수 있는 SSH 사용자']) {
        list.appendChild(el('li', '', requirement));
      }
      requirements.appendChild(list);
      body.appendChild(requirements);
      const primary = button('VPS 연결', 'primary');
      primary.addEventListener('click', () => setState({ kind: 'editing', draft, intent, errors: {} }));
      const existing = button('이미 설치한 환경 연결');
      existing.addEventListener('click', () => setState({ kind: 'existing', draft, intent, errors: {}, pairingCode: '' }));
      back.addEventListener('click', () => setState({ kind: 'choose', draft, intent, mode: 'self-hosted' }));
      footer.append(back, existing, primary);
    } else if (state.kind === 'editing') {
      title.textContent = 'VPS 연결 정보';
      body.append(description(state.draft.transport.kind === 'tailscale'
        ? 'Tailscale에서 보이는 VPS 주소와 SSH 정보를 입력하세요. 공개 인터넷 주소는 필요하지 않습니다.'
        : state.draft.transport.kind === 'ssh-tunnel'
          ? 'Mac mini 또는 Linux 호스트의 일반 SSH 정보를 입력하세요. Tailscale과 공개 포트는 필요하지 않습니다.'
          : 'VPS의 SSH 정보와 Cloud 서비스의 공개 HTTPS 주소를 입력하세요.'));
      const form = profileForm(false);
      form.addEventListener('submit', (event) => { event.preventDefault(); void checkConnection(); });
      submitOnEnter(form);
      body.appendChild(form);
      const intent = state.intent;
      back.addEventListener('click', () => setState({ kind: 'intro', draft: currentDraft(), intent }));
      const primary = button('연결 확인', 'primary');
      primary.addEventListener('click', () => form.requestSubmit());
      footer.append(back, cancel, primary);
    } else if (state.kind === 'checking') {
      title.textContent = 'VPS 연결 확인';
      body.append(
        description(state.draft.transport.kind === 'tailscale'
          ? `${state.draft.host}에 SSH로 연결해 운영체제, sudo, Tailscale을 확인하고 있습니다.`
          : `${state.draft.host}에 일반 SSH로 연결해 운영체제와 sudo 권한을 확인하고 있습니다.`),
        el('div', 'ag-cloud-setup-indeterminate'),
        el('p', 'ag-cloud-setup-wait', '보통 몇 초 안에 끝납니다.'),
      );
      footer.append(cancel);
    } else if (state.kind === 'check-failed' || state.kind === 'install-failed') {
      const installFailure = state.kind === 'install-failed';
      title.textContent = installFailure ? 'Cloud 설정을 마치지 못했습니다' : 'VPS 연결을 확인하세요';
      body.append(
        description('문제를 해결한 뒤 다시 시도하거나 연결 정보를 수정하세요.'),
        callout('cloud', state.issue.title, state.issue.guidance),
        issueDetails(state.issue),
      );
      const { draft, intent } = state;
      const edit = button('연결 정보 수정');
      edit.addEventListener('click', () => setState({ kind: 'editing', draft, intent, errors: {} }));
      const retry = button(
        state.kind === 'install-failed' ? state.retry === 'pair' ? '새 코드 입력' : '다시 설치' : '다시 확인',
        'primary',
      );
      retry.addEventListener('click', () => {
        if (!state || !hasDraft(state)) return;
        if (installFailure) {
          if (state.kind === 'install-failed' && state.retry === 'pair') {
            setState({
              kind: 'existing',
              draft: state.draft,
              intent: state.intent,
              errors: {},
              pairingCode: '',
            });
            return;
          }
          setState({ kind: 'ready-to-install', draft: state.draft, intent: state.intent });
          void install();
        } else void checkConnection();
      });
      footer.append(cancel, edit, retry);
    } else if (state.kind === 'ready-to-install') {
      const { draft, intent } = state;
      title.textContent = '연결할 수 있습니다';
      body.append(
        callout('check', 'VPS 준비 확인 완료', `${state.draft.host}에 안전하게 연결할 수 있습니다.`),
        description('이제 Rauhwpx Cloud 서비스를 설치하고 이 기기를 자동으로 연결합니다.'),
      );
      back.addEventListener('click', () => setState({ kind: 'editing', draft, intent, errors: {} }));
      const primary = button('Cloud 환경 설치', 'primary');
      primary.addEventListener('click', () => { void install(); });
      footer.append(back, cancel, primary);
    } else if (state.kind === 'installing') {
      const stageCopy: Record<CloudSetupStage, [string, string]> = {
        installing: ['Cloud 환경 설치 중', 'VPS에 서비스를 설치하고 연결을 확인하고 있습니다. 이 창을 숨겨도 설치는 계속됩니다.'],
      };
      const [heading, detail] = stageCopy[state.stage];
      title.textContent = heading;
      body.append(description(detail), el('div', 'ag-cloud-setup-indeterminate'));
      footer.append(cancel);
    } else if (state.kind === 'existing') {
      const intent = state.intent;
      title.textContent = '설치된 환경 연결';
      body.append(description('직접 설치한 환경의 서버 ID와 일회용 페어링 코드를 사용합니다. VPS에서 아래 명령을 실행해 10분 동안 유효한 새 코드를 만드세요.'));
      const command = el('div', 'ag-cloud-setup-command');
      const commandText = 'sudo rauhwpx-cloud pairing create rauhwpx-desktop';
      command.appendChild(el('code', '', commandText));
      const copy = button('명령 복사');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(commandText);
          liveStatus.textContent = '페어링 명령을 복사했습니다.';
          copy.textContent = '복사됨';
        } catch {
          liveStatus.textContent = '명령을 복사하지 못했습니다. 명령을 직접 선택해 복사하세요.';
        }
      });
      command.appendChild(copy);
      body.appendChild(command);
      const form = profileForm(true);
      const identity = inputField('서버 ID 키', 'serverPublicKey', state.draft.serverPublicKey ?? '', { placeholder: 'ed25519:…', autocomplete: 'off' });
      const pairingCode = inputField('페어링 코드', 'pairingCode', state.pairingCode, { placeholder: 'ABCD-EFGH-JKLM', autocomplete: 'one-time-code' });
      identity.input.addEventListener('input', () => updateDraft((draft) => ({ ...draft, serverPublicKey: identity.input.value.trim() })));
      pairingCode.input.addEventListener('input', () => {
        if (state?.kind === 'existing') state = { ...state, pairingCode: pairingCode.input.value.toUpperCase() };
      });
      form.append(identity.root, pairingCode.root);
      form.addEventListener('submit', (event) => { event.preventDefault(); void pairExisting(); });
      submitOnEnter(form);
      body.appendChild(form);
      back.addEventListener('click', () => setState({ kind: 'intro', draft: currentDraft(), intent }));
      const primary = button('환경 연결', 'primary');
      primary.addEventListener('click', () => form.requestSubmit());
      footer.append(back, cancel, primary);
    } else if (state.kind === 'pairing') {
      title.textContent = 'Cloud 환경 연결 중';
      body.append(description(`${state.draft.host}의 서버 ID를 확인하고 이 기기를 페어링하고 있습니다.`), el('div', 'ag-cloud-setup-indeterminate'));
      footer.append(cancel);
    } else {
      title.textContent = 'Cloud가 준비되었습니다';
      body.append(
        callout('check', state.profile.name, state.profile.host),
        description(`${state.profile.transport.kind === 'tailscale' ? 'Tailscale로 연결되었습니다.' : state.profile.transport.kind === 'ssh-tunnel' ? '안전한 SSH 터널로 연결되었습니다.' : '공개 HTTPS 주소로 연결되었습니다.'} 이제 작업을 Cloud로 보내면 앱을 닫아도 원격 호스트에서 에이전트가 계속 작업합니다.`),
      );
      const primary = button(state.intent === 'transfer' ? 'Cloud로 계속' : '완료', 'primary');
      if (state.intent === 'manage') {
        const { profile, intent } = state;
        const edit = button('연결 정보 수정');
        edit.addEventListener('click', () => setState({ kind: 'editing', draft: profile, intent, errors: {} }));
        footer.appendChild(edit);
      }
      primary.addEventListener('click', () => {
        const transfer = state?.kind === 'connected' && state.intent === 'transfer';
        if (transfer) {
          close(false);
          deps.onCloseSettings();
          deps.onRequestTransfer();
        } else close(true);
      });
      footer.append(primary);
    }

    if (visible) queueMicrotask(() => {
      if (!visible) return;
      const requested = requestedFocusField
        ? dialog.querySelector<HTMLElement>(`[data-cloud-field="${requestedFocusField}"]`)
        : null;
      requestedFocusField = null;
      const preferred = requested ?? dialog.querySelector<HTMLElement>('.ag-cloud-setup-autofocus');
      if (preferred) preferred.focus();
      else if (!dialog.contains(document.activeElement)) dialog.focus();
    });
  }

  function renderSettings(): void {
    settingsAction.disabled = !snapshot.available || mutationLocked;
    if (!snapshot.available) {
      settingsStatus.textContent = '이 빌드에서는 사용할 수 없습니다';
      settingsDetail.textContent = 'Cloud 지원 데스크톱 앱이 필요합니다.';
      settingsAction.textContent = '설정';
      return;
    }
    if (snapshot.profile.kind === 'unconfigured') {
      const provider = appServerProvider(snapshot);
      const appHostedLock = raucloudLock(snapshot);
      settingsAction.textContent = '설정';
      if (snapshot.server.lifecycle === 'provisioning') {
        settingsStatus.textContent = '서버 준비 중';
        settingsDetail.textContent = state?.kind === 'sandbox-provisioning'
          ? `${raucloudSetupElapsed(state.startedAt)}째 Raucloud를 만들고 있습니다.`
          : 'Raucloud를 만들고 있습니다.';
        settingsAction.textContent = '진행 보기';
        return;
      }
      settingsStatus.textContent = '설정되지 않음';
      settingsDetail.textContent = provider?.configured
        ? appHostedLock
          ? `${appHostedLock} 내 서버는 로그인 없이 연결할 수 있습니다.`
          : 'Raucloud 또는 내 서버에서 에이전트를 계속 실행합니다.'
        : '내 VPS에서 에이전트를 계속 실행합니다.';
      return;
    }
    const labels = {
      ready: '연결됨',
      testing: '연결 확인 중',
      error: '연결에 문제가 있습니다',
      unknown: '연결 상태 확인 필요',
    } as const;
    const lifecycleLabels = {
      provisioning: '서버 준비 중',
      'tearing-down': '서버 종료 중',
      error: '서버에 문제가 있습니다',
    } as const;
    const lifecycle = snapshot.server.lifecycle;
    const appHostedLock = snapshot.profile.mode === 'app-hosted' ? raucloudLock(snapshot) : null;
    const sandboxLabel = lifecycle === 'provisioning' || lifecycle === 'tearing-down' || lifecycle === 'error'
      ? lifecycleLabels[lifecycle]
      : null;
    settingsStatus.textContent = appHostedLock
      ? 'Raucloud 사용 제한'
      : snapshot.profile.mode === 'app-hosted' && sandboxLabel
        ? sandboxLabel
        : labels[snapshot.profile.connection];
    settingsDetail.textContent = snapshot.profile.mode === 'app-hosted'
      ? appHostedLock ?? `Raucloud · ${snapshot.profile.name}${snapshot.profile.sandbox.host ? `, ${snapshot.profile.sandbox.host}` : ''}`
      : `내 서버 · ${snapshot.profile.profile.name}, ${snapshot.profile.profile.host}`;
    settingsAction.textContent = '관리';
  }

  function open(intent: CloudSetupIntent, nextTrigger: HTMLElement): void {
    if (mutationLocked) return;
    trigger = nextTrigger;
    const preservedFailure = preserveOnOpen
      && (state?.kind === 'install-failed' || state?.kind === 'sandbox-failed');
    if (!operationActive(state) && !preservedFailure) {
      state = createCloudSetupState(snapshot, intent);
      resetConditionalDrafts(hasDraft(state) ? state.draft : currentDraft());
    }
    deps.onSetupStateChange(operationActive(state));
    preserveOnOpen = false;
    visible = true;
    overlay.hidden = false;
    setModalIsolation(true);
    liveStatus.textContent = '';
    renderDialog();
    syncSetupProgressTimer();
  }

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const containFocus = (event: FocusEvent): void => {
    if (!visible || dialog.contains(event.target as Node)) return;
    const first = dialog.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary');
    (first ?? dialog).focus();
  };
  document.addEventListener('focusin', containFocus);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target !== overlay) return;
    event.preventDefault();
    const first = dialog.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary');
    (first ?? dialog).focus();
  });

  renderSettings();
  return {
    settingsElement,
    open,
    sync(next) {
      snapshot = next;
      const previous = state;
      const wasActive = operationActive(state);
      if (state) state = reconcileCloudSetupState(state, next);
      const active = operationActive(state);
      if (active !== wasActive) deps.onSetupStateChange(active);
      syncSetupProgressTimer();
      renderSettings();
      if (visible && state !== previous) renderDialog();
    },
    setMutationLocked(locked) {
      mutationLocked = locked;
      if (locked) close(false);
      renderSettings();
    },
    dispose() {
      disposed = true;
      operationEpoch += 1;
      if (setupProgressTimer) clearInterval(setupProgressTimer);
      setupProgressTimer = null;
      deps.onSetupStateChange(false);
      close(false);
      setModalIsolation(false);
      document.removeEventListener('focusin', containFocus);
      overlay.remove();
    },
  };
}
