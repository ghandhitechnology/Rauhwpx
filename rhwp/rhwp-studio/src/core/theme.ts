import { userSettings, type ThemeMode } from './user-settings';

export type EffectiveTheme = 'light' | 'dark';

const THEME_QUERY = '(prefers-color-scheme: dark)';
const THEME_COLOR_META_SELECTOR = 'meta[name="theme-color"]';
const COLOR_SCHEME_META_SELECTOR = 'meta[name="color-scheme"]';

function prefersDark(): boolean {
  return window.matchMedia?.(THEME_QUERY).matches ?? false;
}

function syncThemeColorMeta(root: HTMLElement): void {
  const meta = document.querySelector<HTMLMetaElement>(THEME_COLOR_META_SELECTOR);
  if (!meta) return;
  const themeColor = getComputedStyle(document.getElementById('studio-header') ?? root)
    .getPropertyValue('--ui-bg-light').trim() || '#ffffff';
  meta.content = themeColor;
}

function syncBrowserColorScheme(root: HTMLElement, effective: EffectiveTheme): void {
  const scheme = `only ${effective}`;
  root.style.colorScheme = scheme;
  const meta = document.querySelector<HTMLMetaElement>(COLOR_SCHEME_META_SELECTOR);
  if (meta) meta.content = scheme;
}

export function getThemeMode(): ThemeMode {
  return userSettings.getThemeSettings().mode;
}

export function getEffectiveTheme(mode: ThemeMode = getThemeMode()): EffectiveTheme {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return prefersDark() ? 'dark' : 'light';
}

let switchFrame = 0;

/**
 * 테마가 실제로 바뀌는 순간 한 프레임 동안 전환을 끈다(html.theme-switching).
 * 면마다 다른 transition 시간으로 색이 번지지 않고 한 번에 바뀐다.
 * 첫 프레임에 새 색이 칠해진 뒤 다음 프레임에 클래스를 뗀다.
 */
function suppressTransitionsForSwitch(root: HTMLElement): void {
  root.classList.add('theme-switching');
  cancelAnimationFrame(switchFrame);
  switchFrame = requestAnimationFrame(() => {
    switchFrame = requestAnimationFrame(() => {
      switchFrame = 0;
      root.classList.remove('theme-switching');
    });
  });
}

export function applyTheme(mode: ThemeMode = getThemeMode()): EffectiveTheme {
  const effective = getEffectiveTheme(mode);
  const root = document.documentElement;
  const previous = root.dataset.themeEffective;
  if (previous && previous !== effective) suppressTransitionsForSwitch(root);
  root.dataset.themeMode = mode;
  root.dataset.themeEffective = effective;
  syncBrowserColorScheme(root, effective);
  syncThemeColorMeta(root);
  return effective;
}

export function setThemeMode(mode: ThemeMode): EffectiveTheme {
  userSettings.setThemeMode(mode);
  return applyTheme(mode);
}

export function syncThemeMenu(mode: ThemeMode = getThemeMode()): void {
  for (const item of document.querySelectorAll<HTMLElement>('[data-theme-mode-choice]')) {
    const active = item.dataset.themeModeChoice === mode;
    item.classList.toggle('active', active);
    item.setAttribute('aria-checked', String(active));
  }
}

export function initThemeSync(onChange?: (effective: EffectiveTheme, mode: ThemeMode) => void): () => void {
  const notify = () => {
    const mode = getThemeMode();
    const effective = applyTheme(mode);
    syncThemeMenu(mode);
    onChange?.(effective, mode);
  };

  notify();

  const media = window.matchMedia?.(THEME_QUERY);
  if (!media) return () => {};

  const onMediaChange = () => {
    if (getThemeMode() === 'system') notify();
  };
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onMediaChange);
    return () => media.removeEventListener('change', onMediaChange);
  }
  media.addListener(onMediaChange);
  return () => media.removeListener(onMediaChange);
}
