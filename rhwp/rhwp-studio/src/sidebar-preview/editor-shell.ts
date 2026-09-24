import studioHtml from '../../index.html?raw';
import './editor-shell.css';
import { CommandRegistry } from '../command/registry.ts';
import { CommandDispatcher } from '../command/dispatcher.ts';
import type { CommandDef, CommandServices, EditorContext } from '../command/types.ts';
import type { EventBus } from '../core/event-bus.ts';
import { MenuBar } from '../ui/menu-bar.ts';
import { CommandPalette } from '../ui/command-palette.ts';
import { EditorToolbarOverflow } from '../ui/editor-toolbar-overflow.ts';
import { EditorStyleOverflow } from '../ui/editor-style-overflow.ts';

/** Mount the production chrome around a plainly simulated document page. */
export function mountEditorShell(report: (message: string) => void, eventBus: EventBus): void {
  const source = new DOMParser().parseFromString(studioHtml, 'text/html');
  const header = source.querySelector<HTMLElement>('#studio-header');
  const footer = source.querySelector<HTMLElement>('#status-bar');
  const editor = document.getElementById('editor-area');
  if (!header || !footer || !editor) throw new Error('Production editor shell markup is missing');

  document.body.classList.add('preview-editor');
  document.title = 'Editor shell preview · Rauhwpx';
  const visibleTitle = header.querySelector<HTMLElement>('#editor-document-title');
  if (visibleTitle) {
    visibleTitle.textContent = '사업 제안서.hwpx';
    visibleTitle.title = visibleTitle.textContent;
    visibleTitle.hidden = false;
  }
  document.getElementById('preview-controls')!.hidden = true;
  // The sidebar-only controls contain a placeholder with the same production ID.
  document.querySelector('#preview-controls #icon-toolbar')?.remove();

  const root = document.createElement('div');
  root.id = 'studio-root';
  const page = document.createElement('div');
  page.className = 'editor-fixture-page';
  page.innerHTML = `
    <span class="editor-fixture-label">PREVIEW FIXTURE · NO DOCUMENT ENGINE</span>
    <h2>사업 제안서</h2>
    <p>프로젝트의 목표와 범위를 정리한 샘플 문서입니다. 이 영역은 편집기 레이아웃 검토를 위한 예시 페이지입니다.</p>
    <h3>개요</h3>
    <p>팀이 같은 맥락에서 의사결정을 내릴 수 있도록 현재 상황과 다음 단계를 공유합니다.</p>
    <h3>진행 계획</h3>
    <p>1. 요구 사항 정리<br>2. 시안 검토<br>3. 구현 및 확인</p>
  `;
  const scroll = document.createElement('div');
  scroll.id = 'scroll-container';
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', 'Sample document fixture');
  scroll.append(page);
  editor.removeAttribute('aria-hidden');
  editor.append(scroll);
  root.append(header, editor, footer);
  document.body.prepend(root);

  const registry = new CommandRegistry();
  const commandElements = header.querySelectorAll<HTMLElement>('[data-cmd]');
  const definitions = new Map<string, CommandDef>();
  for (const element of commandElements) {
    const id = element.dataset.cmd!;
    if (definitions.has(id)) continue;
    const label = element.querySelector('.md-label, .tb-label')?.textContent?.trim()
      || element.getAttribute('title') || id;
    const shortcutLabel = element.querySelector('.md-shortcut')?.textContent?.trim();
    definitions.set(id, {
      id, label, ...(shortcutLabel ? { shortcutLabel } : {}),
      execute: () => {
        if (id === 'view:toolbox-basic') {
          const toolbar = header.querySelector<HTMLElement>('#icon-toolbar')!;
          const collapsed = toolbar.classList.toggle('collapsed');
          header.querySelector('.sb-collapse-btn')?.setAttribute('aria-expanded', String(!collapsed));
        }
        report(`${label} · editor fixture`);
      },
    });
  }
  registry.registerAll([...definitions.values()]);
  const context: EditorContext = {
    hasDocument: true, hasSelection: false, hasCopiedFormat: false,
    inTable: false, inCellSelectionMode: false, hasMultiCellSelection: false,
    hasTableTransposeClipboard: false, inTableObjectSelection: false,
    inPictureObjectSelection: false, canArrangeSelectedObject: false,
    canGroupSelectedObjects: false, canUngroupSelectedObject: false,
    inField: false, isEditable: true, editMode: 'normal', isFormMode: false,
    canEditFormField: false, canUndo: false, canRedo: false, zoom: 1,
    showControlCodes: false, showParagraphMarks: false, isDirty: false,
    sourceFormat: 'hwpx',
  };
  // Registered fixture commands only read eventBus/getContext. Engine service slots
  // are deliberately absent, so an engine-dependent command cannot run here.
  const fixtureServices = { eventBus, getContext: () => context } as CommandServices;
  const dispatcher = new CommandDispatcher(registry, fixtureServices, eventBus);
  new MenuBar(header.querySelector<HTMLElement>('#menu-bar')!, eventBus, dispatcher, registry);
  const palette = new CommandPalette(registry, dispatcher);
  header.querySelector('#editor-command-search')?.addEventListener('click', () => palette.open());
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === '/') {
      event.preventDefault();
      palette.open();
    }
  });
  header.querySelectorAll<HTMLElement>('.tb-btn[data-cmd], .sb-collapse-btn[data-cmd]').forEach((button) => {
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      dispatcher.dispatch(button.dataset.cmd!, { anchorEl: button });
    });
  });
  new EditorToolbarOverflow(header.querySelector<HTMLElement>('#icon-toolbar')!);
  new EditorStyleOverflow(header.querySelector<HTMLElement>('#style-bar')!);
  footer.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (button) report(`${button.title} · editor fixture`);
  });
}
