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

const params = new URLSearchParams(location.search);
const status = document.querySelector<HTMLOutputElement>('#preview-status')!;
const report = (message: string) => {
  status.value = message;
  showToast({ message, durationMs: 2500 });
};
const mock = createMockBridge(report);
if (params.get('services') === 'setup') mock.setServices(false);
const eventBus = new EventBus();
const versions = createMockVersions(report);
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
const sidebar = initAgentSidebar({
  bridge: mock.bridge,
  eventBus,
  getDocumentContext: () => ({
    documentId,
    documentName,
    selectionLabel: null,
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

const scenarioSelect = document.querySelector<HTMLSelectElement>('#scenario')!;
for (const name of scenarios)
  scenarioSelect.add(new Option(name[0].toUpperCase() + name.slice(1), name));
const initialScenario = params.get('scenario');
if (scenarios.includes(initialScenario as Scenario))
  scenarioSelect.value = initialScenario!;
mock.setScenario(scenarioSelect.value as Scenario);
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
    if (anchor && !anchor.getAttribute('href')?.startsWith('#')) {
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
  eventBus.emit('settings:open', { destination: 'editing' });
if (params.get('page') === 'versions') sidebar.openVersions();

// Typed hooks for browser checks and custom scenario scripts.
const preview = { ...mock, sidebar, versions, eventBus };
Object.assign(window, { sidebarPreview: preview });
window.addEventListener('pagehide', () => {
  sidebar.dispose();
  mock.bridge.dispose();
  versions.dispose?.();
});
