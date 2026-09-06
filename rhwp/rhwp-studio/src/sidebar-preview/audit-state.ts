import type { SidebarPreview } from './main.ts';

async function until<T>(read: () => T | null | false, description: string): Promise<T> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Could not open preview: ${description}`);
}

async function click(selector: string): Promise<void> {
  const button = await until(() => {
    const element = document.querySelector<HTMLButtonElement>(selector);
    return element && element.checkVisibility() && !element.disabled ? element : null;
  }, selector);
  button.click();
}

function select(id: string, value: string): void {
  const control = document.querySelector<HTMLSelectElement>(id)!;
  control.value = value;
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Prepare fixtures through the same controls used in the shipping sidebar. */
export async function applyAuditState(preview: SidebarPreview, params: URLSearchParams): Promise<void> {
  const browserbase = params.get('browserbase');
  if (browserbase === 'ready' || browserbase === 'setup' || browserbase === 'error')
    preview.setBrowserbaseState(browserbase === 'ready' ? 'connected' : browserbase);
  if (params.get('document') === 'empty') select('#document', 'empty');
  const cloudState = params.get('cloud-state');
  if (preview.cloud && (cloudState === 'logged-out' || cloudState === 'exhausted'
    || cloudState === 'self-hosted' || cloudState === 'unknown'
    || cloudState === 'unconfigured' || cloudState === 'unavailable')) {
    preview.cloud.setDashboardState(cloudState);
  }
  if (params.get('cloud-turn') === '1' || params.has('cloud-phase') || params.has('cloud-link')) {
    if (!preview.cloud || !preview.workspace) throw new Error('Cloud fixture is required');
    await click('[aria-label="프로바이더 선택"]');
    await click('.ag-provider-item[data-agent="codex"]');
    await click('.ag-header [data-workspace-mode="cloud"]');
    await until(() => preview.workspace?.mode() === 'cloud', 'Cloud execution');
    document.querySelector<HTMLButtonElement>('#play')!.click();
    await until(() => preview.cloud?.controller.getSnapshot().session.kind === 'running', 'Cloud conversation');
    preview.cloud.finishReply('사업 제안서의 예산과 일정을 검토했습니다. 수정 사항을 확인해 주세요.');
    if (params.get('cloud-turn') === '1') preview.cloud.commitTurn();
    const phase = params.get('cloud-phase');
    if (phase === 'working' || phase === 'waiting' || phase === 'suspended') preview.cloud.setConversationPhase(phase);
    if (params.get('cloud-view') !== 'local') await click('[data-document-view="cloud"]');
    const link = params.get('cloud-link');
    if (link === 'failed' || link === 'ready') preview.cloud.setLink(link);
  } else if (params.get('play') === '1') {
    await until(() => {
      const input = document.querySelector<HTMLTextAreaElement>('.ag-input');
      return input && !input.disabled;
    }, 'composer');
    document.querySelector<HTMLButtonElement>('#play')!.click();
    await until(() => preview.snapshot().running, 'sample reply');
    if (params.get('hold') !== '1' && params.get('scenario') !== 'question') {
      await until(() => !preview.snapshot().running, 'completed reply');
    }
  }
  const surface = params.get('surface');
  const surfaces: Record<string, string> = {
    skills: '.ag-skills-btn', references: '.ag-references-btn', threads: '.ag-header .ag-threads-btn',
    'provider-picker': '[aria-label="프로바이더 선택"]', 'model-picker': '[aria-label="모델 선택"]',
    'effort-picker': '[aria-label="추론 강도 선택"]', permissions: '.ag-permission-btn',
    'provider-setup': `.ag-settings-provider-row[data-agent="${['rau', 'claude', 'pi', 'grok', 'cursor', 'opencode'].includes(params.get('provider') ?? '') ? params.get('provider') : 'codex'}"] button`,
    'cloud-options': '.ag-header [data-workspace-mode="cloud"]', 'cloud-setup': '.ag-header [data-workspace-mode="cloud"]',
  };
  if (surface === 'provider-setup') {
    const rowSelector = surfaces[surface]!.replace(/ button$/, '');
    const row = await until(() => document.querySelector<HTMLDetailsElement>(rowSelector), 'provider connection');
    if (!row.open) await click(`${rowSelector} summary`);
  }
  if (surface && surfaces[surface]) await click(surfaces[surface]);
  if (params.get('terminal') === '1' && surface === 'provider-setup' && params.get('provider') === 'opencode') {
    await click('.ag-agent-setup-pane:not([hidden]) .ag-agent-setup-primary');
    await until(() => document.querySelector('.ag-setup-terminal:not([hidden]) .xterm'), 'login terminal');
  }
  const connection = params.get('connection');
  if (connection && ['connected', 'connecting', 'disconnected', 'replaced'].includes(connection)) {
    select('#connection', connection);
  }
  document.body.dataset.auditReady = 'true';
}
