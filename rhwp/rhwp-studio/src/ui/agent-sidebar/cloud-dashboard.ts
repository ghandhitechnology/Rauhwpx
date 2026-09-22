import './cloud-dashboard.css';
import type { CloudSnapshot } from '../../cloud/types.ts';
import { inferCloudLink } from '../../cloud/link.ts';
import { cloudDashboardSessions } from '../../cloud/usage-history.ts';
import { createLinkProgress } from './cloud-link-progress.ts';
import { createIcon } from './icons.ts';

type Task = CloudSnapshot['sessions'][number];
interface CloudDashboardDeps {
  configuration: HTMLElement;
  refresh(): Promise<CloudSnapshot>;
  reconnect(): Promise<CloudSnapshot>;
  configure(trigger: HTMLElement): void;
  openTask(task: Task): Promise<void>;
  loginAccount?: () => Promise<{ authUrl: string } | null>;
  mutationLocked(): boolean;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
/** Saved task state is independent of the viewing connection. */
export function cloudTaskStatus(task: Task): { label: string; state: string } {
  if (task.kind === 'failed' || task.kind === 'running' && (task.wait || task.phase.startsWith('awaiting-')
    || task.phase === 'waiting' && task.turn > 0)) return { label: '확인 필요', state: 'attention' };
  if (task.kind === 'completed') return { label: '검토 준비됨', state: 'ready' };
  if (task.kind === 'suspended') return { label: task.resumable ? '일시 중지' : '종료됨', state: 'paused' };
  if (task.kind === 'cancelled') return { label: '취소됨', state: 'paused' };
  return { label: '작업 중', state: 'working' };
}
export function createCloudDashboard(deps: CloudDashboardDeps) {
  let snapshot: CloudSnapshot | null = null;
  let pending = false;
  let disposed = false;
  let sessionsSignature = '';
  let openingSession: string | null = null;
  const element = el('div', 'ag-cloud-dashboard');
  const content = el('div', 'ag-cd-content');
  const header = el('header', 'ag-cd-header');
  const toolbar = el('div', 'ag-cd-toolbar');
  function button(label: string, className: string, icon?: Parameters<typeof createIcon>[0]) {
    const node = el('button', `ag-cd-button ${className}`);
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    if (icon) node.append(createIcon(icon)); else node.textContent = label;
    return node;
  }
  const refresh = button('새로고침', 'ag-cd-refresh', 'refresh');
  const setup = button('연결 설정', 'ag-cd-setup');
  const settings = button('Cloud 설정', 'ag-cd-settings-toggle', 'gear');
  settings.setAttribute('aria-expanded', 'false');
  const feedback = el('p', 'ag-cd-feedback');
  feedback.hidden = true;
  feedback.setAttribute('role', 'status');
  const reconnectProgress = createLinkProgress();
  const chatList = el('ul', 'ag-cd-chat-list');
  chatList.setAttribute('aria-label', 'Cloud 작업');
  const configuration = el('div', 'ag-cd-config');
  configuration.hidden = false;
  const usage = el('div', 'ag-cd-usage');
  const usageHead = el('div', 'ag-cd-usage-head');
  const usageLabel = el('strong', 'ag-cd-usage-label', '오늘 사용량');
  const usageValue = el('span', 'ag-cd-usage-value');
  const usageTrack = el('div', 'ag-cd-usage-track');
  const usageFill = el('span', 'ag-cd-usage-fill');
  usageTrack.setAttribute('role', 'progressbar');
  usageTrack.setAttribute('aria-valuemin', '0');
  usageTrack.setAttribute('aria-valuemax', '100');
  usageHead.append(usageLabel, usageValue);
  usageTrack.append(usageFill);
  usage.append(usageHead, usageTrack);
  const login = button('로그인', 'ag-cd-login');
  const reconnect = button('다시 연결', 'ag-cd-reconnect');
  configuration.append(login, reconnect, deps.configuration);
  const statusCard = deps.configuration.querySelector<HTMLElement>('.ag-cloud-settings-card');
  (statusCard ?? configuration).append(usage);
  settings.hidden = true;
  setup.addEventListener('click', () => deps.configure(setup));
  toolbar.append(setup, settings, refresh);
  header.append(toolbar);
  content.append(header, feedback, reconnectProgress.element, configuration, chatList);
  element.append(content);
  function error(message: string) {
    feedback.textContent = message;
    feedback.dataset.kind = 'error';
    feedback.hidden = false;
  }
  async function run(kind: 'refresh' | 'reconnect') {
    if (pending || disposed || !snapshot?.available || kind === 'reconnect' && deps.mutationLocked()) return;
    pending = true;
    feedback.hidden = true;
    if (kind === 'reconnect') reconnectProgress.start('reconnecting');
    render();
    let failed = false;
    try {
      const next = await (kind === 'refresh' ? deps.refresh() : deps.reconnect());
      if (!disposed) snapshot = next;
    } catch {
      failed = true;
      if (!disposed) error('연결을 확인해 주세요. 마지막으로 저장된 작업입니다.');
    } finally {
      pending = false;
      if (kind === 'reconnect') reconnectProgress.settle(failed ? 'failed' : 'done');
      if (!disposed) render();
    }
  }
  refresh.addEventListener('click', () => void run('refresh'));
  reconnect.addEventListener('click', () => void run('reconnect'));
  login.addEventListener('click', async () => {
    if (!deps.loginAccount || pending || disposed) return;
    pending = true;
    render();
    try {
      const result = await deps.loginAccount();
      if (disposed) return;
      if (!result?.authUrl) throw new Error('로그인을 시작하지 못했습니다.');
      window.open(result.authUrl, '_blank', 'noopener,noreferrer');
      feedback.textContent = '브라우저에서 로그인을 마쳐 주세요.';
      delete feedback.dataset.kind;
      feedback.hidden = false;
    } catch (cause) {
      if (!disposed) error(cause instanceof Error ? cause.message : '로그인을 시작하지 못했습니다.');
    } finally { pending = false; if (!disposed) render(); }
  });
  function renderSessions() {
    if (!snapshot) return;
    const tasks = cloudDashboardSessions(snapshot);
    const signature = JSON.stringify(tasks.map(task => [task.sessionId, task.documentName, cloudTaskStatus(task)]));
    if (signature !== sessionsSignature) {
      sessionsSignature = signature;
      const focusedId = chatList.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.sessionId : undefined;
      chatList.replaceChildren();
      if (!tasks.length) {
        const empty = el('li', 'ag-cd-empty');
        const icon = createIcon('cloud');
        icon.setAttribute('aria-hidden', 'true');
        empty.append(icon, el('p', '', '채팅에서 Cloud로 작업을 맡겨 보세요.'));
        chatList.append(empty);
      }
      for (const task of tasks) {
        const row = el('li', 'ag-cd-chat');
        const open = button('', 'ag-cd-task');
        open.dataset.sessionId = task.sessionId;
        const status = cloudTaskStatus(task);
        const name = task.documentName || '이름 없는 문서';
        open.setAttribute('aria-label', `${name}, ${status.label}`);
        open.title = name;
        const mark = el('span', 'ag-cd-chat-mark');
        mark.setAttribute('aria-hidden', 'true');
        mark.append(createIcon('document'));
        const copy = el('span', 'ag-cd-chat-copy');
        const badge = el('span', 'ag-cd-task-status', status.label);
        badge.dataset.state = status.state;
        copy.append(el('strong', '', name), badge);
        open.append(mark, copy);
        open.addEventListener('click', async () => {
          if (openingSession || deps.mutationLocked()) return;
          openingSession = task.sessionId;
          render();
          try { await deps.openTask(task); }
          catch (cause) { if (!disposed) error(cause instanceof Error ? cause.message : '작업을 열지 못했습니다.'); }
          finally { openingSession = null; if (!disposed) render(); }
        });
        row.append(open);
        chatList.append(row);
        if (task.sessionId === focusedId) open.focus();
      }
    }
    chatList.querySelectorAll<HTMLButtonElement>('.ag-cd-task').forEach(row => {
      row.disabled = Boolean(openingSession) || deps.mutationLocked();
      row.setAttribute('aria-busy', String(openingSession === row.dataset.sessionId));
    });
  }
  function render() {
    if (!snapshot) return;
    refresh.disabled = pending || !snapshot.available;
    refresh.setAttribute('aria-busy', String(pending));
    setup.hidden = snapshot.profile.kind === 'configured' || !snapshot.available;
    setup.disabled = pending || deps.mutationLocked();
    reconnect.hidden = snapshot.profile.kind !== 'configured' || inferCloudLink(snapshot).kind === 'ready';
    reconnect.disabled = pending || deps.mutationLocked();
    login.hidden = snapshot.account?.signedIn === true || !deps.loginAccount;
    login.disabled = pending;
    const allowance = snapshot.account?.signedIn ? snapshot.account.quota : null;
    if (!allowance || allowance.dailyLimitMs <= 0) {
      usage.hidden = true;
    } else {
      const usedMinutes = Math.max(0, Math.floor(allowance.usedMs / 60_000));
      const limitMinutes = Math.max(0, Math.floor(allowance.dailyLimitMs / 60_000));
      const percent = Math.min(100, Math.max(0, allowance.usedMs / allowance.dailyLimitMs * 100));
      usage.hidden = false;
      usageValue.textContent = `${usedMinutes}분 / ${limitMinutes}분`;
      usageTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
      usageFill.style.width = `${percent}%`;
    }
    renderSessions();
  }
  const refreshTimer = window.setInterval(() => {
    if (element.checkVisibility() && document.visibilityState === 'visible') void run('refresh');
  }, 30_000);
  return {
    element,
    handleAccountEvent(event: { signedIn: boolean; error?: string }) {
      if (disposed) return;
      if (event.error) error(event.error); else if (event.signedIn) void run('refresh');
    },
    sync(next: CloudSnapshot) { if (!disposed) { snapshot = next; render(); } },
    dispose() { disposed = true; window.clearInterval(refreshTimer); reconnectProgress.dispose(); },
  };
}
