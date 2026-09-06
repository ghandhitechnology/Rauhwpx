import type { SidebarBridge } from '../../agent/bridge.ts';
import type { UsageSummary } from '../../agent/types.ts';
import { formatRelativeTime, formatResetAt } from './usage-format.ts';
import { createIcon } from './icons.ts';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

/** 공식 계정 한도와 일회성 리셋 확인을 설정 화면 수명에 묶는다. */
export function createProviderQuota(bridge: SidebarBridge, accept: (usage: UsageSummary) => void, refresh: () => void) {
  const element = node('div', 'ag-provider-quotas');
  const feedback = node('p', 'ag-settings-note');
  feedback.setAttribute('role', 'status');
  let summary: UsageSummary | null = null;
  let busy = false;
  let refreshing = false;
  let disposed = false;
  const resetStorageKey = 'rhwp-codex-pending-reset';
  let confirmation: { key: string; account: string } | null = null;
  try {
    const stored = JSON.parse(localStorage.getItem(resetStorageKey) ?? 'null');
    if (stored && typeof stored.key === 'string' && typeof stored.account === 'string') confirmation = stored;
  } catch { /* 저장소를 사용할 수 없으면 소비 전에 다시 확인한다. */ }
  function clearConfirmation() {
    confirmation = null;
    try { localStorage.removeItem(resetStorageKey); } catch { /* 이미 확인된 결과는 화면에 반영한다. */ }
  }

  async function consume() {
    if (!confirmation || busy) return;
    const request = confirmation;
    try {
      localStorage.setItem(resetStorageKey, JSON.stringify(request));
    } catch {
      feedback.textContent = '리셋 요청을 저장하지 못했어요. 브라우저 저장소를 사용할 수 있는지 확인해 주세요.';
      feedback.hidden = false;
      return;
    }
    busy = true;
    feedback.textContent = '리셋을 적용하고 있어요…';
    render(summary);
    try {
      const result = await bridge.consumeCodexReset(request.key, request.account);
      if (disposed) return;
      clearConfirmation();
      summary = result.usage;
      accept(result.usage);
      feedback.textContent = {
        reset: '한도를 리셋했어요.', nothingToReset: '리셋할 사용량이 없어요.',
        noCredit: '사용할 리셋 크레딧이 없어요.', alreadyRedeemed: '이미 처리한 리셋이에요.',
      }[result.outcome];
    } catch (error) {
      if (disposed) return;
      feedback.textContent = `리셋을 확인하지 못했어요. 다시 시도해 주세요. ${error instanceof Error ? error.message : ''}`;
    } finally {
      busy = false;
      if (!disposed) render(summary);
    }
  }

  function render(value: UsageSummary | null) {
    summary = value;
    if (confirmation && summary?.limits?.codex.accountKey && summary.limits.codex.accountKey !== confirmation.account && !busy) clearConfirmation();
    const cards = (['claude', 'codex'] as const).map((agent) => {
      const quota = summary?.limits?.[agent];
      const card = node('section', 'ag-settings-quota-card');
      card.dataset.provider = agent;
      const header = node('div', 'ag-settings-quota-header');
      const identity = node('div', 'ag-settings-quota-identity');
      identity.append(node('h3', 'ag-settings-quota-title', agent === 'claude' ? 'Claude' : 'Codex'));
      if (quota?.planType) identity.append(node('span', 'ag-settings-row-detail', quota.planType));
      const actions = node('div', 'ag-settings-quota-header-actions');
      const refreshButton = node('button', 'ag-settings-quota-refresh');
      refreshButton.type = 'button';
      refreshButton.dataset.action = 'refresh-usage';
      refreshButton.title = `${agent === 'claude' ? 'Claude' : 'Codex'} 사용량 새로고침`;
      refreshButton.setAttribute('aria-label', refreshButton.title);
      refreshButton.disabled = refreshing;
      refreshButton.setAttribute('aria-busy', String(refreshing));
      refreshButton.append(createIcon('refresh'));
      refreshButton.onclick = refresh;
      actions.append(node('span', 'ag-settings-usage-updated', quota?.updatedAt ? `${formatRelativeTime(quota.updatedAt)} 조회` : '아직 조회하지 않았어요'), refreshButton);
      header.append(identity, actions);
      card.append(header);
      const stale = !!quota?.updatedAt && Date.now() - quota.updatedAt > 120_000;
      card.dataset.state = quota?.status ?? 'unavailable';
      if (quota?.status !== 'ok' || stale) {
        card.append(node('p', 'ag-settings-note', quota?.status === 'error'
          ? `한도를 불러오지 못했어요. ${quota.error ?? '새로고침해 주세요.'}`
          : stale ? '이전 조회 결과예요. 새로고침해 주세요.' : '연결된 계정의 한도 정보를 사용할 수 없어요.'));
      }
      for (const [key, label] of [['session', '5시간'], ['week', '주간 한도']] as const) {
        if (agent === 'codex' && key === 'session' && quota?.planType?.trim().toLowerCase() === 'pro') continue;
        const window = quota?.[key];
        const percent = window?.percent;
        const remaining = typeof percent === 'number' && Number.isFinite(percent)
          ? Math.max(0, Math.min(100, 100 - percent)) : null;
        const meter = node('div', 'ag-settings-quota-meter');
        meter.append(node('div', 'ag-settings-quota-caption', `${label}: ${remaining === null ? '정보 없음' : `${Math.round(remaining)}% 남음`}`));
        const track = node('div', 'ag-settings-quota-track');
        track.setAttribute('role', 'meter');
        track.setAttribute('aria-label', `${agent} ${label} 남은 한도`);
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        track.setAttribute('aria-valuetext', remaining === null ? '정보 없음' : `${Math.round(remaining)}% 남음`);
        if (remaining !== null) track.setAttribute('aria-valuenow', String(remaining));
        const fill = node('div', 'ag-settings-quota-fill');
        fill.style.width = `${remaining ?? 0}%`;
        fill.dataset.health = remaining === null ? 'unknown' : remaining <= 15 ? 'low' : remaining <= 40 ? 'medium' : 'high';
        track.append(fill);
        meter.append(track);
        const reset = node('div', 'ag-settings-usage-updated', formatResetAt(window?.resetsAt) || '리셋 시간 정보 없음');
        if (window?.resetsAt) reset.title = new Date(window.resetsAt).toLocaleString();
        meter.append(reset);
        card.append(meter);
      }
      if (agent === 'codex' && quota && (quota.resetCredits || confirmation)) {
        const credits = quota.resetCredits;
        if (credits) card.append(node('p', 'ag-settings-note', `보관한 리셋 ${credits.availableCount}개${credits.nextExpiresAt ? `, 다음 만료 ${new Date(credits.nextExpiresAt).toLocaleString()}` : ''}`));
        const canReset = (credits?.availableCount ?? 0) > 0 && quota.status === 'ok' && !!quota.accountKey && !stale;
        if (confirmation) {
          card.append(node('p', 'ag-settings-note', '보관한 리셋 1개를 사용해 Codex 한도를 리셋할까요?'));
          const confirm = node('button', 'ag-settings-primary', busy ? '리셋 중…' : '리셋 1개 사용');
          confirm.type = 'button';
          confirm.dataset.action = 'confirm-reset';
          // 응답이 끊긴 뒤 잔액이 0이 되어도 같은 요청의 결과는 다시 확인할 수 있다.
          confirm.disabled = busy || quota.accountKey !== confirmation.account;
          confirm.onclick = () => void consume();
          const cancel = node('button', 'ag-settings-btn', '취소');
          cancel.type = 'button';
          cancel.disabled = busy;
          cancel.onclick = () => {
            // 실패한 요청 키는 다음 확인에서도 재사용한다.
            feedback.textContent = '';
            confirmation = null;
            render(summary);
          };
          card.append(confirm, cancel);
        } else {
          const reset = node('button', 'ag-settings-btn', '보관한 리셋 사용…');
          reset.type = 'button';
          reset.dataset.action = 'request-reset';
          reset.disabled = busy || !canReset;
          reset.onclick = () => {
            let pending: { key: string; account: string } | null = null;
            try { pending = JSON.parse(localStorage.getItem(resetStorageKey) ?? 'null'); } catch { /* 소비 전에 저장을 확인한다. */ }
            confirmation = pending?.account === quota.accountKey && typeof pending.key === 'string' ? pending
              : { key: globalThis.crypto?.randomUUID?.() ?? `reset-${Date.now()}-${Math.random().toString(36).slice(2)}`, account: quota.accountKey! };
            feedback.textContent = '';
            render(summary);
          };
          card.append(reset);
        }
      }
      return card;
    });
    for (const [provider, label] of [['openrouter', 'OpenRouter'], ['grok', 'Grok'], ['opencode', 'OpenCode']] as const) {
      const balance = summary?.balances?.[provider];
      const card = node('section', 'ag-settings-quota-card ag-settings-balance-card');
      card.dataset.provider = provider;
      card.dataset.state = balance?.status ?? 'unavailable';
      const header = node('div', 'ag-settings-quota-header');
      const identity = node('div', 'ag-settings-quota-identity');
      identity.append(node('h3', 'ag-settings-quota-title', label));
      if (balance?.source) identity.append(node('span', 'ag-settings-row-detail', balance.source));
      const actions = node('div', 'ag-settings-quota-header-actions');
      const button = node('button', 'ag-settings-quota-refresh');
      button.type = 'button';
      button.dataset.action = 'refresh-usage';
      button.title = `${label} 잔액 새로고침`;
      button.setAttribute('aria-label', button.title);
      button.disabled = refreshing;
      button.setAttribute('aria-busy', String(refreshing));
      button.append(createIcon('refresh'));
      button.onclick = refresh;
      actions.append(node('span', 'ag-settings-usage-updated', balance?.updatedAt ? `${formatRelativeTime(balance.updatedAt)} 조회` : '아직 조회하지 않았어요'), button);
      header.append(identity, actions);
      card.append(header);
      const knownBalance = typeof balance?.balanceUsd === 'number' && Number.isFinite(balance.balanceUsd);
      if (knownBalance) {
        const amount = node('div', 'ag-settings-balance-amount', new Intl.NumberFormat('en-US', {
          style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4,
        }).format(balance!.balanceUsd!));
        amount.append(node('span', 'ag-settings-row-detail', '남은 크레딧'));
        card.append(amount);
      }
      const windows = [...(balance?.windows ?? [])];
      if (knownBalance && typeof balance?.totalCreditsUsd === 'number' && balance.totalCreditsUsd > 0) {
        windows.unshift({ label: '잔액', remainingPercent: Math.max(0, Math.min(100, balance.balanceUsd! / balance.totalCreditsUsd * 100)), resetsAt: null });
      }
      for (const window of windows) {
        const windowLabel = window.label === '단기 한도' ? '5시간' : window.label;
        const meter = node('div', 'ag-settings-quota-meter');
        meter.append(node('div', 'ag-settings-quota-caption', `${windowLabel}: ${Math.round(window.remainingPercent)}% 남음`));
        const track = node('div', 'ag-settings-quota-track');
        track.setAttribute('role', 'meter');
        track.setAttribute('aria-label', `${label} ${windowLabel}`);
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        track.setAttribute('aria-valuenow', String(window.remainingPercent));
        const fill = node('div', 'ag-settings-quota-fill');
        fill.style.width = `${window.remainingPercent}%`;
        fill.dataset.health = window.remainingPercent <= 15 ? 'low' : window.remainingPercent <= 40 ? 'medium' : 'high';
        track.append(fill);
        meter.append(track);
        if (window.resetsAt) meter.append(node('div', 'ag-settings-usage-updated', formatResetAt(window.resetsAt)));
        card.append(meter);
      }
      const stale = !!balance?.updatedAt && Date.now() - balance.updatedAt > 120_000;
      if (balance?.status !== 'ok' || stale || (!knownBalance && windows.length === 0)) {
        card.append(node('p', 'ag-settings-note', balance?.error || (stale
          ? '이전 조회 결과예요. 새로고침해 주세요.'
          : balance?.status === 'error' ? '잔액을 불러오지 못했어요.' : '연결된 계정의 잔액 정보를 사용할 수 없어요.')));
      }
      cards.push(card);
    }
    feedback.hidden = !feedback.textContent;
    element.replaceChildren(...cards, feedback);
  }
  return { element, render, setRefreshing(value: boolean) {
    refreshing = value;
    for (const button of element.querySelectorAll<HTMLButtonElement>('.ag-settings-quota-refresh')) {
      button.disabled = value;
      button.setAttribute('aria-busy', String(value));
    }
  }, dispose() { disposed = true; confirmation = null; } };
}
