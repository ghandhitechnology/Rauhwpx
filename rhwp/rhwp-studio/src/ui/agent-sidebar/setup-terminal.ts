import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

/** 모델 연결 전용 터미널. 닫으면 출력과 입력 상태를 모두 지운다. */
export function createSetupTerminal(options: {
  input: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  cancel: () => void;
}) {
  const root = document.createElement('div');
  root.className = 'ag-setup-terminal';
  root.hidden = true;
  const header = document.createElement('div');
  header.className = 'ag-setup-terminal-header';
  const title = document.createElement('span');
  title.textContent = 'OpenCode 로그인';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ag-settings-btn';
  cancel.textContent = '취소';
  cancel.addEventListener('click', options.cancel);
  header.append(title, cancel);
  const hint = document.createElement('p');
  hint.className = 'ag-setup-terminal-hint';
  hint.textContent = '↑ ↓ 선택 · Enter 확인';
  const screen = document.createElement('div');
  screen.className = 'ag-setup-terminal-screen';
  screen.setAttribute('aria-label', 'OpenCode 로그인 터미널');
  root.append(header, hint, screen);
  let terminal: Terminal | null = null;
  let pending = '';
  let generation = 0;
  let loading = false;
  let ready = false;
  let fit: (() => void) | null = null;
  let lastSize = '';
  const observer = new ResizeObserver(() => fit?.());
  observer.observe(screen);
  const themeObserver = new MutationObserver(() => fit?.());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });

  async function open(provider = 'OpenCode') {
    title.textContent = `${provider} 로그인`;
    screen.setAttribute('aria-label', `${provider} 로그인 터미널`);
    root.hidden = false;
    if (terminal) { fit?.(); return; }
    if (loading) return;
    loading = true;
    const current = generation;
    try {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-web-links')]);
      if (generation !== current) return;
      const addon = new FitAddon();
      terminal = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        disableStdin: !ready, scrollback: 500, screenReaderMode: true, allowProposedApi: false, rows: 16, cols: 60 });
      terminal.loadAddon(addon);
      terminal.loadAddon(new WebLinksAddon((_event, uri) => {
        try {
          const url = new URL(uri);
          if (url.protocol === 'https:' || url.protocol === 'http:') window.open(url.href, '_blank', 'noopener,noreferrer');
        } catch { /* 잘못된 링크는 열지 않는다. */ }
      }));
      terminal.open(screen);
      terminal.onData(data => {
        // Bound paste frames without dropping the tail of longer pasted keys.
        for (let i = 0; i < data.length; i += 512) options.input(data.slice(i, i + 512));
      });
      // Escape belongs to the login program; the visible cancel button closes it.
      screen.addEventListener('keydown', stopKeyPropagation);
      fit = () => {
        if (!terminal || root.hidden || screen.clientWidth < 20) return;
        const style = getComputedStyle(screen);
        terminal.options.theme = { background: style.backgroundColor, foreground: style.color, cursor: style.color };
        addon.fit();
        const size = `${terminal.cols}:${terminal.rows}`;
        if (size !== lastSize) { lastSize = size; options.resize(terminal.cols, terminal.rows); }
      };
      fit();
      if (pending) { terminal.write(pending, () => terminal?.scrollToBottom()); pending = ''; }
      terminal.focus();
    } catch {
      if (current === generation) screen.textContent = '로그인 창을 열지 못했어요. 취소 후 API 키로 연결해 주세요.';
    } finally { if (current === generation) loading = false; }
  }
  function stopKeyPropagation(event: KeyboardEvent) { event.stopPropagation(); }
  function close() {
    generation += 1;
    loading = false;
    ready = false;
    root.hidden = true;
    terminal?.dispose();
    terminal = null;
    fit = null;
    pending = '';
    lastSize = '';
    screen.removeEventListener('keydown', stopKeyPropagation);
    screen.replaceChildren();
  }
  return {
    root, open, close,
    ready() { ready = true; if (terminal) terminal.options.disableStdin = false; lastSize = ''; fit?.(); },
    write(data: string, reset = false) {
      if (reset) { terminal?.reset(); pending = ''; }
      if (terminal) terminal.write(data, () => terminal?.scrollToBottom());
      else pending = (pending + data).slice(-65536);
    },
    dispose() { close(); observer.disconnect(); themeObserver.disconnect(); },
  };
}
