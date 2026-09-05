import './cloud-dashboard.css';
import type { CloudSnapshot } from '../../cloud/types.ts';
import { inferCloudLink } from '../../cloud/link.ts';
import { cloudDashboardSessions, cloudUsageSeries, readCloudUsage } from '../../cloud/usage-history.ts';
import { createIcon } from './icons.ts';
import { AGENT_LABEL } from './providers.ts';

interface CloudDashboardDeps {
  configuration: HTMLElement;
  refresh(): Promise<CloudSnapshot>;
  reconnect(): Promise<CloudSnapshot>;
  configure(trigger: HTMLElement): void;
  mutationLocked(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(text: string, className = '') {
  const node = el('button', `ag-cd-button ${className}`, text);
  node.type = 'button';
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function minutes(ms: number): string {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(Math.max(0, ms) / 60_000);
}

function formatTime(value: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(value));
  } catch { return '확인 필요'; }
}

const sessionLabels: Record<CloudSnapshot['session']['kind'], string> = {
  idle: '대기', 'waiting-local-turn': '로컬 작업 대기', transferring: '전송 중', queued: '순서 대기',
  running: '진행 중', pausing: '일시 정지 중', suspended: '일시 정지', 'taking-over': '가져오는 중',
  completed: '완료', failed: '확인 필요', cancelled: '종료',
};

export function createCloudDashboard(deps: CloudDashboardDeps) {
  let snapshot: CloudSnapshot | null = null;
  let range: 7 | 30 = 7;
  let pending = false;
  let refreshError = false;
  let disposed = false;
  let chartSignature = '';
  let sessionsSignature = '';

  const element = el('div', 'ag-cloud-dashboard');
  const content = el('div', 'ag-cd-content');
  const header = el('header', 'ag-cd-header');
  const artwork = el('div', 'ag-cd-artwork');
  const cloud = el('img', 'ag-cd-pixel-cloud');
  cloud.src = new URL('./cloud-pixel.svg', import.meta.url).href;
  cloud.alt = '';
  cloud.width = 104;
  cloud.height = 80;
  artwork.append(cloud);
  const heading = el('div', 'ag-cd-heading');
  heading.append(el('h2', 'ag-cd-title', 'Cloud Connections'),
    el('p', 'ag-cd-subtitle', 'Raucloud 사용 시간은 모든 기기에서 공유합니다.'));
  const expand = button('크게 보기', 'ag-cd-expand');
  expand.prepend(createIcon('expand'));
  expand.addEventListener('click', () => element.dispatchEvent(new CustomEvent('ag-settings-expand-request', { bubbles: true })));
  header.append(artwork, heading, expand);

  const toolbar = el('div', 'ag-cd-toolbar');
  const status = el('span', 'ag-cd-status');
  const updated = el('span', 'ag-cd-updated');
  const refresh = button('새로고침', 'ag-cd-refresh');
  const setup = button('연결 설정', 'ag-cd-setup');
  setup.addEventListener('click', () => {
    if (!pending && snapshot?.available && !deps.mutationLocked()) deps.configure(setup);
  });
  refresh.prepend(createIcon('refresh'));
  toolbar.append(status, updated, setup, refresh);
  const feedback = el('p', 'ag-cd-feedback');
  feedback.hidden = true;
  feedback.setAttribute('role', 'status');

  const stats = el('div', 'ag-cd-stats');
  function stat(label: string, className = '') {
    const card = el('section', `ag-cd-stat ${className}`);
    const value = el('strong', 'ag-cd-stat-value');
    const detail = el('p', 'ag-cd-muted');
    card.append(el('h3', 'ag-cd-stat-label', label), value, detail);
    stats.append(card);
    return { card, value, detail };
  }
  const quota = stat('오늘 남은 Raucloud 시간', 'ag-cd-quota');
  const meter = el('div', 'ag-cd-meter');
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', '오늘 남은 Raucloud 시간');
  const fill = el('div', 'ag-cd-meter-fill');
  meter.append(fill);
  const resetEta = el('p', 'ag-cd-reset');
  quota.card.append(meter, resetEta);
  const boxes = stat('연결된 Cloud 박스');

  const grid = el('div', 'ag-cd-grid');
  function panel(title: string, className: string) {
    const root = el('section', `ag-cd-panel ${className}`);
    const head = el('div', 'ag-cd-panel-head');
    head.append(el('h3', 'ag-cd-panel-title', title));
    root.append(head);
    grid.append(root);
    return { root, head };
  }
  const usage = panel('Raucloud 사용량', 'ag-cd-usage');
  const ranges = el('div', 'ag-cd-segment');
  ranges.setAttribute('role', 'group');
  ranges.setAttribute('aria-label', '사용량 조회 기간');
  const rangeButtons = ([7, 30] as const).map((days) => {
    const item = button(`${days}일`);
    item.addEventListener('click', () => { range = days; renderChart(); });
    ranges.append(item);
    return item;
  });
  usage.head.append(ranges);
  const usageTotal = el('div', 'ag-cd-usage-total');
  const chart = el('div', 'ag-cd-chart');
  const dataDetails = el('details', 'ag-cd-data');
  dataDetails.append(el('summary', '', '일별 기록 보기'));
  const dataTable = el('table');
  const caption = el('caption', '', '이 기기에서 확인한 계정 사용량');
  dataTable.append(caption);
  dataDetails.append(dataTable);
  usage.root.append(usageTotal, chart, dataDetails);

  const server = panel('Cloud 서버 연결', 'ag-cd-server');
  const serverBadge = el('span', 'ag-cd-tag');
  server.head.append(serverBadge);
  const serverIdentity = el('div', 'ag-cd-server-identity');
  const serverIcon = el('span', 'ag-cd-server-icon');
  serverIcon.append(createIcon('cloud'));
  const serverCopy = el('div');
  const serverName = el('strong');
  const serverHost = el('p', 'ag-cd-muted');
  serverCopy.append(serverName, serverHost);
  serverIdentity.append(serverIcon, serverCopy);
  const serverFacts = el('dl', 'ag-cd-facts');
  const serverNote = el('p', 'ag-cd-muted');
  const reconnect = button('다시 연결', 'ag-cd-reconnect');
  server.root.append(serverIdentity, serverFacts, serverNote, reconnect);

  const chats = panel('Cloud 대화', 'ag-cd-chats');
  const chatList = el('ul', 'ag-cd-chat-list');
  chats.root.append(chatList);

  const config = panel('서버 설정과 사용 한도', 'ag-cd-config');
  const configFacts = el('dl', 'ag-cd-facts');
  config.root.append(configFacts, deps.configuration,
    el('p', 'ag-cd-muted', '관리 버튼에서 연결 방식과 인증을 설정하세요.'));
  content.append(header, toolbar, feedback, stats, grid);
  element.append(content);

  function facts(target: HTMLElement, entries: Array<[string, string]>) {
    target.replaceChildren(...entries.flatMap(([label, value]) => [el('dt', '', label), el('dd', '', value)]));
  }

  async function run(kind: 'refresh' | 'reconnect', quiet = false) {
    if (pending || disposed || !snapshot?.available || (kind === 'reconnect' && deps.mutationLocked())) return;
    pending = true;
    if (!quiet) {
      feedback.hidden = false;
      delete feedback.dataset.kind;
      feedback.textContent = kind === 'refresh' ? '사용량과 연결 상태 확인 중…' : '서버에 다시 연결 중…';
    }
    render();
    try {
      const next = await (kind === 'refresh' ? deps.refresh() : deps.reconnect());
      if (disposed) return;
      snapshot = next;
      refreshError = false;
      feedback.hidden = quiet;
      feedback.textContent = kind === 'refresh' ? '서버 상태와 사용량을 불러왔습니다.' : '연결 상태를 확인했습니다.';
      feedback.dataset.kind = 'success';
    } catch {
      if (disposed) return;
      refreshError = true;
      feedback.hidden = false;
      feedback.textContent = '서버에 연결하지 못했습니다. 마지막으로 확인한 정보입니다.';
      feedback.dataset.kind = 'error';
    } finally {
      pending = false;
      if (!disposed) render();
    }
  }
  refresh.addEventListener('click', () => void run('refresh'));
  reconnect.addEventListener('click', () => void run('reconnect'));
  const refreshTimer = window.setInterval(() => {
    if (element.checkVisibility() && document.visibilityState === 'visible') {
      renderQuota();
      void run('refresh', true);
    }
  }, 30_000);
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') renderQuota();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function renderQuota() {
    if (!snapshot) return;
    const account = snapshot.account;
    const allowance = account?.signedIn ? account.quota : null;
    const resetAt = allowance ? Date.parse(allowance.resetAt) : NaN;
    const remainingMs = resetAt - Date.now();
    const fresh = !refreshError && allowance && remainingMs > 0;
    quota.value.replaceChildren(document.createTextNode(fresh ? minutes(allowance.remainingMs) : '—'), el('span', 'ag-cd-stat-unit', '분'));
    quota.detail.textContent = fresh ? `${minutes(allowance.dailyLimitMs)}분 중 ${minutes(allowance.usedMs)}분 사용`
      : allowance ? '사용량을 새로고침해 주세요.' : account?.signedIn ? '아직 사용 한도를 확인하지 못했습니다.' : '로그인하면 남은 시간을 볼 수 있습니다.';
    quota.detail.title = account ? `사용량 확인: ${formatTime(account.updatedAt)}` : '';
    resetEta.hidden = !Number.isFinite(resetAt);
    const totalMinutes = Math.ceil(remainingMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const duration = [hours > 0 ? `${hours}시간` : '', mins > 0 ? `${mins}분` : ''].filter(Boolean).join(' ');
    resetEta.textContent = remainingMs <= 0 ? '초기화 확인 중'
      : remainingMs <= 60_000 ? '1분 이내 초기화' : `${duration} 후 초기화`;
    resetEta.title = allowance ? `${formatTime(allowance.resetAt, allowance.timeZone)} · ${allowance.timeZone}` : '';
    meter.hidden = !fresh;
    if (fresh) {
      const remaining = Math.min(Math.max(0, allowance.remainingMs), allowance.dailyLimitMs);
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', String(allowance.dailyLimitMs / 60_000));
      meter.setAttribute('aria-valuenow', String(remaining / 60_000));
      fill.style.width = `${allowance.dailyLimitMs > 0 ? remaining / allowance.dailyLimitMs * 100 : 0}%`;
      quota.card.dataset.low = String(remaining / allowance.dailyLimitMs <= 0.15);
    }
  }

  function renderChart() {
    if (!snapshot) return;
    rangeButtons.forEach((item, index) => item.setAttribute('aria-pressed', String(range === (index === 0 ? 7 : 30))));
    const timeZone = snapshot.account?.quota?.timeZone ?? 'UTC';
    let series: ReturnType<typeof cloudUsageSeries>;
    try { series = cloudUsageSeries(readCloudUsage(snapshot.account), range, new Date(), timeZone); }
    catch { series = cloudUsageSeries([], range, new Date(), 'UTC'); }
    const signature = JSON.stringify([timeZone, series]);
    if (signature === chartSignature) return;
    chartSignature = signature;
    const known = series.filter((point) => point.sample !== null);
    const sum = known.reduce((total, point) => total + point.sample!.usedMs, 0);
    usageTotal.replaceChildren(el('strong', '', known.length ? `${minutes(sum)}분` : '기록 없음'), el('span', 'ag-cd-muted', `${range}일 중 ${known.length}일 기록`));
    const plot = svg('svg', { viewBox: '0 0 520 170', role: 'img', 'aria-label': `최근 ${range}일 Cloud 사용량. ${known.length}일 기록, 합계 ${minutes(sum)}분. 일별 기록에서 수치를 확인할 수 있습니다.` });
    const max = Math.max(30, ...known.map((point) => point.sample!.usedMs / 60_000));
    const ceiling = Math.ceil(max / 30) * 30;
    const x = (index: number) => 36 + index / (range - 1) * 468;
    const y = (ms: number) => 134 - ms / 60_000 / ceiling * 116;
    for (let row = 0; row <= 2; row++) {
      const height = 18 + row * 58;
      plot.append(svg('line', { x1: '36', x2: '504', y1: String(height), y2: String(height), class: 'ag-cd-gridline' }));
      const label = svg('text', { x: '26', y: String(height + 4), 'text-anchor': 'end', class: 'ag-cd-axis' });
      label.textContent = String(ceiling * (1 - row / 2));
      plot.append(label);
    }
    let path = '';
    let previousKnown = false;
    series.forEach((point, index) => {
      if (!point.sample) { previousKnown = false; return; }
      path += `${previousKnown ? ' L' : ' M'}${x(index)},${y(point.sample.usedMs)}`;
      previousKnown = true;
    });
    plot.append(svg('path', { d: path, class: 'ag-cd-line', fill: 'none', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    series.forEach((point, index) => {
      if (!point.sample) return;
      const dot = svg('circle', { cx: String(x(index)), cy: String(y(point.sample.usedMs)), r: '4', class: 'ag-cd-point' });
      const title = svg('title', {});
      title.textContent = `${point.date}: ${minutes(point.sample.usedMs)}분`;
      dot.append(title);
      plot.append(dot);
    });
    [0, Math.floor((range - 1) / 2), range - 1].forEach((index) => {
      const label = svg('text', { x: String(x(index)), y: '161', 'text-anchor': index === 0 ? 'start' : index === range - 1 ? 'end' : 'middle', class: 'ag-cd-axis' });
      label.textContent = series[index].date.slice(5).replace('-', '/');
      plot.append(label);
    });
    chart.replaceChildren(plot);
    if (!known.length) chart.append(el('p', 'ag-cd-chart-empty', '아직 사용 기록이 없습니다.'));
    const thead = el('thead');
    const tr = el('tr');
    ['날짜', '사용 시간', '마지막 확인'].forEach((label) => { const th = el('th', '', label); th.scope = 'col'; tr.append(th); });
    thead.append(tr);
    const tbody = el('tbody');
    [...series].reverse().forEach(({ date, sample }) => {
      const row = el('tr');
      row.append(el('td', '', date), el('td', '', sample ? `${minutes(sample.usedMs)}분` : '기록 없음'),
        el('td', '', sample ? formatTime(sample.observedAt, timeZone) : '—'));
      tbody.append(row);
    });
    dataTable.replaceChildren(caption, thead, tbody);
  }

  function renderSessions() {
    if (!snapshot) return;
    const entries = cloudDashboardSessions(snapshot);
    const signature = JSON.stringify(entries);
    if (signature === sessionsSignature) return;
    sessionsSignature = signature;
    chatList.replaceChildren();
    if (!entries.length) chatList.append(el('li', 'ag-cd-empty', '아직 Cloud 대화가 없습니다. 채팅에서 클라우드를 선택해 시작하세요.'));
    entries.forEach((entry) => {
      const item = el('li', 'ag-cd-chat');
      const provider = entry.selection?.agent;
      const mark = el('span', 'ag-cd-chat-mark');
      mark.append(createIcon('document'));
      mark.setAttribute('aria-hidden', 'true');
      const copy = el('div', 'ag-cd-chat-copy');
      copy.append(el('strong', '', entry.documentName || '이름 없는 문서'),
        el('span', 'ag-cd-muted', provider ? `${AGENT_LABEL[provider]} · ${entry.selection!.model || '기본 모델'}` : '모델 정보 없음'));
      const badge = el('span', 'ag-cd-tag', entry.kind === 'running' && entry.phase === 'waiting' ? '응답 대기' : sessionLabels[entry.kind]);
      badge.dataset.state = entry.kind;
      item.append(mark, copy, badge);
      chatList.append(item);
    });
  }

  function render() {
    if (!snapshot) return;
    const profile = snapshot.profile;
    const configured = profile.kind === 'configured';
    const link = inferCloudLink(snapshot);
    const ready = !refreshError && snapshot.available && configured && profile.connection === 'ready' && link.kind === 'ready'
      && (snapshot.server.lifecycle === 'ready' || snapshot.server.lifecycle === 'idle');
    const state = !snapshot.available ? 'unavailable'
      : snapshot.server.lifecycle === 'provisioning' || snapshot.server.lifecycle === 'tearing-down' ? 'pending'
      : !configured ? 'unconfigured' : ready ? 'ready'
      : link.kind === 'reconnecting' || link.kind === 'recreating' || profile.connection === 'testing' ? 'pending'
      : refreshError || profile.connection === 'unknown' ? 'unknown' : 'failed';
    const labels = { unavailable: 'Cloud 지원 앱에서 사용 가능', unconfigured: '연결된 서버 없음', ready: '서버 연결됨', pending: '연결 확인 중', failed: '서버 연결 확인 필요', unknown: '연결 상태 확인 필요' };
    status.textContent = labels[state];
    status.dataset.state = state;
    updated.textContent = `확인 ${formatTime(snapshot.updatedAt)}`;
    refresh.disabled = pending || !snapshot.available;
    setup.hidden = configured || !snapshot.available;
    setup.disabled = pending || deps.mutationLocked();
    refresh.setAttribute('aria-busy', String(pending));
    reconnect.hidden = !configured || ready || !snapshot.available;
    reconnect.disabled = pending || deps.mutationLocked() || state === 'pending';

    const account = snapshot.account;
    const allowance = account?.signedIn ? account.quota : null;
    renderQuota();
    boxes.value.replaceChildren(document.createTextNode(ready ? '1' : '0'), el('span', 'ag-cd-stat-unit', `/ ${configured ? '1' : '0'}`));
    boxes.detail.hidden = configured;
    boxes.detail.textContent = configured ? '' : 'Raucloud 또는 내 서버를 연결하세요.';

    serverBadge.textContent = ready ? '연결됨' : state === 'pending' ? '확인 중' : state === 'unknown' ? '확인 필요' : configured ? '연결 끊김' : '미연결';
    serverBadge.dataset.state = state;
    serverName.textContent = configured ? profile.mode === 'app-hosted' ? profile.name : profile.profile.name : '내 Cloud 박스';
    serverHost.textContent = configured ? profile.mode === 'app-hosted' ? profile.sandbox.host : profile.profile.host : '연결 설정에서 서버를 추가하세요.';
    facts(serverFacts, [
      ['서버 유형', configured ? profile.mode === 'app-hosted' ? 'Raucloud' : '내 서버' : '미설정'],
      ['리전 / 연결', configured ? profile.mode === 'app-hosted' ? profile.sandbox.region || '정보 없음' : profile.profile.transport.kind === 'ssh-tunnel' ? 'SSH 터널' : profile.profile.transport.kind === 'tailscale' ? 'Tailscale' : 'HTTPS' : '—'],
      ['Cloud 버전', configured ? profile.serviceVersion ?? '확인 필요' : '—'],
    ]);
    const gate = configured && profile.mode === 'self-hosted' ? null : account?.raucloud;
    serverNote.textContent = gate?.kind === 'active-elsewhere' ? `${gate.deviceName || '다른 기기'}에서 Raucloud를 사용 중입니다. 서버 관리에서 확인하세요.`
      : gate?.kind === 'exhausted' ? '오늘의 Raucloud 시간을 모두 사용했습니다. 초기화 후 다시 시작할 수 있습니다.'
      : gate?.kind === 'unavailable' ? gate.reason
      : gate?.kind === 'logged-out' ? 'Raucloud를 사용하려면 Rauhwpx 계정으로 로그인하세요.'
      : state === 'failed' ? '서버가 응답하지 않습니다. 다시 연결하거나 서버 설정을 확인하세요.'
      : ready ? '' : '서버 관리에서 연결을 설정하세요.';
    serverNote.hidden = !serverNote.textContent;
    facts(configFacts, [
      ['한도 초기화', allowance ? `${formatTime(allowance.resetAt, allowance.timeZone)} · ${allowance.timeZone}` : '사용량 확인 후 표시'],
      ['오늘 서버 시작', allowance ? `${allowance.coldStarts.usedToday} / ${allowance.coldStarts.dailyLimit}회` : '—'],
      ['계정 범위', configured && profile.mode === 'self-hosted' ? '내 서버는 Raucloud 한도 제외' : '모든 기기에서 Raucloud 시간 공유'],
    ]);
    renderChart();
    renderSessions();
  }

  return {
    element,
    sync(next: CloudSnapshot) { if (!disposed) { snapshot = next; refreshError = false; render(); } },
    dispose() {
      disposed = true;
      window.clearInterval(refreshTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
