// Throwaway: compare a scanning-first ledger and a selection-first inspector in the real sidebar.
import './connections.prototype.css';
import { createProviderIcon, AGENT_LABEL, PROVIDER_ORDER } from '../ui/agent-sidebar/providers.ts';
import { createIcon } from '../ui/agent-sidebar/icons.ts';

export function mountConnectionsPrototype() {
  const original = document.querySelector<HTMLElement>('.ag-settings-provider-list')?.parentElement;
  if (!original) return;
  original.hidden = true;
  original.style.display = 'none';
  const host = document.createElement('div');
  host.className = 'cp-host';
  original.after(host);
  let variant = new URLSearchParams(location.search).get('variant') === 'B' ? 'B' : 'A';
  let selected = 'codex';
  let expanded = '';
  const connected = new Set(['rau', 'claude', 'codex']);
  const account: Record<string, string> = { rau: 'andy@example.com', claude: 'Pro', codex: 'Pro' };
  let message = '';
  const bar = document.createElement('div');
  bar.className = 'cp-switcher';
  document.body.append(bar);
  const button = (text: string, action: () => void, className = '') => {
    const result = document.createElement('button');
    result.type = 'button'; result.className = className; result.textContent = text;
    result.onclick = action; return result;
  };
  function providerName(agent: typeof PROVIDER_ORDER[number]) {
    const name = document.createElement('span'); name.className = 'cp-name';
    name.append(createProviderIcon(agent), document.createTextNode(AGENT_LABEL[agent]));
    return name;
  }
  function details(agent: typeof PROVIDER_ORDER[number]) {
    const pane = document.createElement('div'); pane.className = 'cp-details';
    const status = document.createElement('div');
    status.innerHTML = `<strong>${connected.has(agent) ? '연결된 계정' : '모델 연결'}</strong><span>${connected.has(agent) ? (account[agent] ?? '이 기기에서 로그인됨') : `${AGENT_LABEL[agent]}를 연결해 대화를 시작하세요.`}</span>`;
    pane.append(status, button(connected.has(agent) ? '계정 변경' : '연결하기', () => {
      connected.add(agent); message = `${AGENT_LABEL[agent]}: sample account connected`; render();
    }, 'cp-action'));
    if (connected.has(agent)) pane.append(button('연결 해제', () => {
      connected.delete(agent); message = `${AGENT_LABEL[agent]}: disconnected in prototype`; render();
    }, 'cp-quiet'));
    return pane;
  }
  function render() {
    host.replaceChildren(); host.dataset.variant = variant;
    const hub = document.createElement('div'); hub.className = 'cp-hub';
    hub.innerHTML = '<span class="cp-dot"></span><strong>에이전트 허브</strong><span>연결됨</span>';
    const refresh = button('', () => { message = 'Sample connections refreshed'; render(); }, 'cp-icon');
    refresh.append(createIcon('refresh')); refresh.title = '상태 새로고침'; refresh.setAttribute('aria-label', refresh.title);
    hub.append(refresh); host.append(hub);
    if (variant === 'A') {
      const ledger = document.createElement('div'); ledger.className = 'cp-ledger';
      for (const agent of PROVIDER_ORDER) {
        const row = button('', () => { expanded = expanded === agent ? '' : agent; render(); }, 'cp-ledger-row');
        row.setAttribute('aria-expanded', String(expanded === agent));
        const state = document.createElement('span'); state.className = 'cp-state';
        state.textContent = connected.has(agent) ? (account[agent] ?? '연결됨') : '연결하기';
        const chevron = document.createElement('span'); chevron.className = 'cp-chevron'; chevron.textContent = expanded === agent ? '−' : '+';
        row.append(providerName(agent), state, chevron);
        row.dataset.connected = String(connected.has(agent));
        ledger.append(row);
        if (expanded === agent) ledger.append(details(agent));
      }
      host.append(ledger);
    } else {
      const tabs = document.createElement('div'); tabs.className = 'cp-provider-picker';
      tabs.setAttribute('aria-label', '제공자 선택');
      for (const agent of PROVIDER_ORDER) {
        const pick = button('', () => { selected = agent; render(); }, 'cp-pick');
        pick.setAttribute('aria-pressed', String(agent === selected));
        pick.append(providerName(agent));
        const dot = document.createElement('span'); dot.className = connected.has(agent) ? 'cp-dot' : 'cp-dot cp-off';
        pick.append(dot); tabs.append(pick);
      }
      host.append(tabs);
      const agent = PROVIDER_ORDER.find(item => item === selected)!;
      const inspector = document.createElement('div'); inspector.className = 'cp-inspector';
      const heading = document.createElement('div'); heading.className = 'cp-inspector-title';
      heading.append(providerName(agent));
      const status = document.createElement('span'); status.textContent = connected.has(agent) ? '연결됨' : '연결되지 않음';
      heading.append(status); inspector.append(heading, details(agent)); host.append(inspector);
    }
    const footer = document.createElement('div'); footer.className = 'cp-footer';
    footer.innerHTML = `<span>${connected.size}개 연결됨 / ${PROVIDER_ORDER.length}개 제공자</span>`;
    footer.append(button('세션 다시 시작', () => { message = 'Sample session restarted'; render(); }, 'cp-quiet'));
    host.append(footer);
    bar.replaceChildren();
    const caption = document.createElement('div'); caption.className = 'cp-caption';
    caption.innerHTML = `<strong>Connection design prototype</strong><span>${variant === 'A' ? 'A · Ledger — scan every provider, expand a row to manage.' : 'B · Inspector — pick a provider, manage it in one shared panel.'}</span><small>Sample data · ${message || `${connected.size} connected · selected: ${variant === 'A' ? expanded || 'none' : selected}`}</small>`;
    const controls = document.createElement('div'); controls.className = 'cp-controls';
    controls.append(button('←', cycle, 'cp-nav'), button('A · Ledger', () => switchTo('A'), variant === 'A' ? 'cp-current' : ''), button('B · Inspector', () => switchTo('B'), variant === 'B' ? 'cp-current' : ''), button('→', cycle, 'cp-nav'));
    for (const width of [360, 480]) controls.append(button(`${width}px`, () => {
      const url = new URL(location.href); url.searchParams.set('width', String(width)); location.href = url.href;
    }));
    bar.append(caption, controls);
  }
  function switchTo(value: string) {
    variant = value; const url = new URL(location.href); url.searchParams.set('variant', variant); history.replaceState(null, '', url); render();
  }
  function cycle() { switchTo(variant === 'A' ? 'B' : 'A'); }
  document.addEventListener('keydown', event => {
    if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); cycle(); }
  });
  render(); host.scrollIntoView({ block: 'start' });
}
