import './browser-compat.ts';
import '../style.css';
import './preview.css';
import { initAgentSidebar } from '../ui/agent-sidebar/index.ts';
import { EventBus } from '../core/event-bus.ts';
import { applyTheme, setThemeMode } from '../core/theme.ts';
import { createMockBridge, scenarios, type Scenario } from './mock-bridge.ts';
import { createMockVersions } from './mock-versions.ts';
import { showToast } from '../ui/toast.ts';
import { userSettings } from '../core/user-settings.ts';
import { completeInitialSetup } from '../ui/initial-setup/state.ts';
import { createMockCloud } from './mock-cloud.ts';
import { listThreads, getThread, waitForThreadsPersistence } from '../agent/threads.ts';
import { createCloudWorkspace } from '../ui/cloud-workspace.ts';
import { createWorkspaceController } from '../cloud/workspace.ts';
import { isSettingsDestination } from '../ui/agent-sidebar/settings-contract.ts';
import { mountAuditNavigator } from './audit-scenarios.ts';
import { mountAuditDialogs } from './audit-dialogs.ts';
import { applyAuditState } from './audit-state.ts';

const params = new URLSearchParams(location.search);
if (params.get('usage') === 'live') {
  const description = document.querySelector('#preview-controls > p');
  if (description) description.textContent = 'Live account usage. Sample chat and documents.';
  document.title = 'Live usage audit · Rauhwpx';
}
const status = document.querySelector<HTMLOutputElement>('#preview-status')!;
const report = (message: string) => {
  status.value = message;
  showToast({ message, durationMs: 2500 });
};
const mock = createMockBridge(report);
if (params.get('services') === 'setup') mock.setServices(false);
const eventBus = new EventBus();
const versions = createMockVersions(report, params.get('history') === 'branches');
let documentId: string | null = 'preview-proposal';
let documentName: string | null = '사업 제안서.hwpx';

if (!params.has('initial-setup'))
  completeInitialSetup({
    providerStep: 'configured',
    calibrationStep: 'skipped',
  });
if (params.get('width'))
  localStorage.setItem(
    'rhwp-agent-sidebar-width-v3',
    String(Math.min(900, Math.max(280, Number(params.get('width')) || 480))),
  );
if (!localStorage.getItem('sidebar-preview-seeded')) {
  userSettings.setUseHancomGit(true);
  localStorage.setItem('sidebar-preview-seeded', '1');
}
applyTheme();
const cloud = params.get('cloud') === '1' ? createMockCloud({ dashboard: params.get('dashboard') === '1' }) : null;
mock.bridge.onEvent((event) => {
  if (event.type === 'account-status' && !event.status.authenticating)
    cloud?.setAccount(event.status.signedIn, event.status.account?.email ?? null);
});
const workspace = cloud ? createWorkspaceController({
  localRoot: document.getElementById('editor-area')!,
  cloudWorkspace: createCloudWorkspace({ display: cloud.controller }), cloud: cloud.controller,
}) : null;
document.body.classList.toggle('preview-cloud', Boolean(cloud));
const sidebar = initAgentSidebar({
  bridge: mock.bridge,
  eventBus,
  ...(cloud && workspace ? {
    cloudController: cloud.controller, workspace,
    setCloudDocumentLease: (owned) => {
      document.documentElement.dataset.cloudLease = owned ? 'cloud' : 'local';
    },
    mergeCloudCheckpoint: async (startId, checkpoint) => {
      cloud.calls.merges.push({ startId, checkpoint });
      status.value = 'Cloud 변경 병합 미리보기';
      return true;
    },
    prepareCloudTransfer: async (_startId, restart) => restart?.document ?? ({ fileName: documentName!, bytes: new Uint8Array([1, 2, 3]),
      byteLength: 3, sha256: 'a'.repeat(64) }),
  } : {}),
  getDocumentContext: () => ({
    documentId,
    documentName,
    selectionLabel: null,
    sourceFormat: 'hwpx', isNewDocument: false,
  }),
  moveToLibraryDocument: (target) => {
    documentId = target.documentId;
    documentName = target.fileName;
    eventBus.emit('document-context-changed');
  },
  versionController: versions,
  openClassicVersionControl: () =>
    report('Classic document history placeholder'),
  editorSettingsRuntime: {
    preview: (settings) => {
      applyTheme(settings.theme.mode);
    },
    committed: (settings) => {
      applyTheme(settings.theme.mode);
    },
  },
});
sidebar.root.querySelector<HTMLButtonElement>('.ag-threads-new')!.click();
mock.boot();
const cloudControls = document.querySelector<HTMLElement>('#cloud-preview-controls')!;
cloudControls.hidden = !cloud;
document.querySelector('#cloud-disconnect')!.addEventListener('click', () => cloud?.setLink('failed'));
document.querySelector('#cloud-restore')!.addEventListener('click', () => cloud?.setLink('ready'));

const scenarioSelect = document.querySelector<HTMLSelectElement>('#scenario')!;
for (const name of scenarios)
  scenarioSelect.add(new Option(name[0].toUpperCase() + name.slice(1), name));
const initialScenario = params.get('scenario');
if (scenarios.includes(initialScenario as Scenario))
  scenarioSelect.value = initialScenario!;
mock.setScenario(scenarioSelect.value as Scenario);
mock.setHold(params.get('hold') === '1');
scenarioSelect.addEventListener('change', () => {
  mock.bridge.interrupt();
  mock.bridge.setWorkflow('direct');
  mock.setScenario(scenarioSelect.value as Scenario);
  const url = new URL(location.href);
  url.searchParams.set('scenario', scenarioSelect.value);
  history.replaceState(null, '', url);
});
document.querySelector('#play')!.addEventListener('click', () => {
  const input = sidebar.root.querySelector<HTMLTextAreaElement>('.ag-input')!;
  input.value = '이 문서의 핵심 내용을 검토하고 개선해 주세요.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form?.requestSubmit();
});
const connection = document.querySelector<HTMLSelectElement>('#connection')!;
connection.addEventListener('change', () =>
  mock.setConnection(
    connection.value as ReturnType<typeof mock.bridge.getConnectionState>,
  ),
);
mock.bridge.onEvent((event) => {
  if (event.type === 'connection') connection.value = event.state;
});
const services = document.querySelector<HTMLSelectElement>('#services')!;
services.value = params.get('services') === 'setup' ? 'setup' : 'ready';
services.addEventListener('change', () => {
  mock.bridge.interrupt();
  mock.setServices(services.value === 'ready');
  eventBus.emit('settings:open', { destination: 'connections' });
});
const theme = document.querySelector<HTMLSelectElement>('#theme')!;
if (['light', 'dark', 'system'].includes(params.get('theme') ?? ''))
  setThemeMode(params.get('theme') as 'light' | 'dark' | 'system');
theme.value = userSettings.getThemeSettings().mode;
theme.addEventListener('change', () =>
  setThemeMode(theme.value as 'light' | 'dark' | 'system'),
);
document
  .querySelector<HTMLSelectElement>('#document')!
  .addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement;
    documentId = select.value === 'empty' ? null : `preview-${select.value}`;
    documentName =
      select.value === 'empty' ? null : select.selectedOptions[0].text;
    Object.assign(versions.getState(), {
      documentId,
      documentName,
      saved: !!documentId,
    });
    void versions.refresh();
    eventBus.emit('document-context-changed');
  });
document
  .querySelector('#settings')!
  .addEventListener('click', () =>
    eventBus.emit('settings:open', { destination: 'editing' }),
  );
document
  .querySelector('#versions')!
  .addEventListener('click', () => sidebar.openVersions());
document.querySelector('#reset')!.addEventListener('click', () => {
  const url = new URL(location.href);
  url.searchParams.set('reset', '1');
  location.replace(url);
});
// Keep the production focus button visible while staying within the sidebar-only scope.
sidebar.root.querySelector('.ag-fullscreen-btn')!.addEventListener(
  'click',
  (event) => {
    event.stopImmediatePropagation();
    report('Focus mode opens the full workspace in the application.');
  },
  { capture: true },
);
// External destinations are represented locally; never launch an OAuth or billing page.
window.open = () => {
  report('External page placeholder');
  return null;
};
document.addEventListener(
  'click',
  (event) => {
    const anchor = (event.target as Element).closest?.('a[href]');
    if (anchor && !anchor.hasAttribute('data-preview-navigation') && !anchor.getAttribute('href')?.startsWith('#')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      report('Linked document or external page placeholder');
    }
  },
  { capture: true },
);
if (params.get('controls') === '0')
  document.querySelector('#preview-controls')!.setAttribute('hidden', '');
if (params.get('page') === 'settings')
  eventBus.emit('settings:open', { destination: isSettingsDestination(params.get('destination')) ? params.get('destination')! : 'editing' });
if (params.get('fullscreen') === '1')
  sidebar.root.querySelector('.ag-settings-page')?.dispatchEvent(new CustomEvent('ag-settings-expand-request', { bubbles: true }));
if (params.get('page') === 'versions') sidebar.openVersions();

// Typed hooks for browser checks and custom scenario scripts.
const preview = { ...mock, sidebar, versions, eventBus, cloud, workspace,
  threadStore: { listThreads, getThread, waitForThreadsPersistence } };
export type SidebarPreview = typeof preview;
Object.assign(window, { sidebarPreview: preview });
if (params.get('audit') === '1') {
  document.body.classList.add('preview-audit');
  const controls = document.querySelector<HTMLElement>('#preview-controls')!;
  const advanced = document.createElement('details');
  advanced.className = 'audit-controls';
  const summary = document.createElement('summary');
  summary.textContent = 'Fixture controls';
  advanced.append(summary, ...controls.children);
  controls.append(advanced);
  const navigation = document.createElement('section');
  controls.prepend(navigation);
  mountAuditNavigator(navigation, params);
  const dialogs = document.createElement('section');
  controls.append(dialogs);
  mountAuditDialogs(dialogs, report);
  dialogs.hidden = true;
  const tabs = document.createElement('div');
  tabs.className = 'audit-tabs';
  for (const title of ['Scenes', 'Editor dialogs']) {
    const button = document.createElement('button');
    button.textContent = title;
    button.type = 'button';
    button.setAttribute('aria-pressed', String(title === 'Scenes'));
    button.addEventListener('click', () => {
      navigation.hidden = title !== 'Scenes';
      dialogs.hidden = title !== 'Editor dialogs';
      for (const sibling of tabs.querySelectorAll('button'))
        sibling.setAttribute('aria-pressed', String(sibling === button));
    });
    tabs.append(button);
  }
  const viewControls = document.createElement('div');
  viewControls.className = 'audit-view-controls';
  viewControls.append(theme.closest('label')!);
  const widthLabel = document.createElement('label');
  widthLabel.textContent = 'Sidebar width';
  const widthSelect = document.createElement('select');
  widthSelect.id = 'audit-width';
  for (const value of [280, 360, 480, 640, 840]) widthSelect.add(new Option(`${value}px`, String(value)));
  widthSelect.value = params.get('width') ?? '480';
  widthSelect.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('width', widthSelect.value);
    location.href = url.href;
  });
  theme.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('theme', theme.value);
    history.replaceState(null, '', url);
    params.set('theme', theme.value);
    for (const link of controls.querySelectorAll<HTMLAnchorElement>('[data-preview-navigation]')) {
      const target = new URL(link.href);
      target.searchParams.set('theme', theme.value);
      link.href = target.href;
    }
  });
  widthLabel.append(widthSelect);
  viewControls.append(widthLabel);
  controls.prepend(viewControls, tabs);
}
void applyAuditState(preview, params).catch((error: unknown) => {
  status.value = error instanceof Error ? error.message : 'Preview state could not be prepared';
  document.body.dataset.auditReady = 'error';
});
window.addEventListener('pagehide', () => {
  sidebar.dispose();
  workspace?.dispose();
  cloud?.controller.dispose();
  mock.bridge.dispose();
  versions.dispose?.();
});
