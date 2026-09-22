/**
 * 사용자 환경설정 저장/로드 서비스
 *
 * localStorage 기반, 단일 키(rhwp-settings)에 JSON으로 저장.
 * 섹션별 확장 가능한 구조.
 */

/** 대표 글꼴 세트 (7개 언어별 글꼴) */
export interface FontSet {
  name: string;
  korean: string;
  english: string;
  chinese: string;
  japanese: string;
  other: string;
  symbol: string;
  user: string;
}

/** 글꼴 환경 설정 */
export interface FontSettings {
  /** 사용자 정의 대표 글꼴 세트 */
  fontSets: FontSet[];
  /** 최근 사용 글꼴 표시 여부 */
  showRecentFonts: boolean;
  /** 최근 사용 글꼴 표시 개수 (1~5) */
  recentFontCount: number;
  /** 최근 직접 적용한 글꼴 이름 (최신순, 최대 5개) */
  recentFonts: string[];
}

/** 앱 UI 테마 설정값 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 앱 UI 테마 설정 */
export interface ThemeSettings {
  /** 사용자가 선택한 테마 모드 */
  mode: ThemeMode;
}

/** 대화상자 UI 설정 */
export interface DialogSettings {
  /** 개체 속성 기본 탭에서 너비/높이 입력 비율을 유지할지 여부 */
  picturePropsKeepRatio: boolean;
  /** PDF 저장 전에 브라우저 인쇄 대상 선택 방법을 안내할지 여부 */
  showPdfPrintGuidance: boolean;
}

/** 보기 표시 설정 */
export interface ViewSettings {
  /** 문단부호 표시 여부 */
  showParagraphMarks: boolean;
  /** 조판부호 표시 여부 */
  showControlCodes: boolean;
  /** 짤림보기(잘림 보기) 켜짐 여부. true = 편집용지 경계 밖 오버플로 내용을 보임(잘림 미적용). */
  clipView: boolean;
}

/** 버전 관리 설정 */
export interface VersionControlSettings {
  /** 한컴 문서용 Git 스타일 버전 관리 사용 여부 */
  useHancomGit: boolean;
}

/** 복구용 자동저장 설정 */
export interface AutosaveSettings {
  /** 복구용 자동저장 사용 여부 */
  recoveryEnabled: boolean;
  /** 복구용 자동저장 간격(분) */
  recoveryIntervalMinutes: number;
  /** 입력이 멈췄을 때 자동저장 사용 여부 */
  idleSaveEnabled: boolean;
  /** 입력이 멈춘 뒤 자동저장까지 기다릴 시간(초) */
  idleDelaySeconds: number;
}

/** 전체 설정 구조 */
export interface AppSettings {
  version: number;
  font: FontSettings;
  theme: ThemeSettings;
  dialog: DialogSettings;
  view: ViewSettings;
  versionControl: VersionControlSettings;
  autosave: AutosaveSettings;
}

/** 설정 허브에서 한 번에 초안/저장하는 편집기 스칼라 설정. */
export interface EditorScalarSettings {
  font: Pick<FontSettings, 'showRecentFonts' | 'recentFontCount'>;
  theme: ThemeSettings;
  dialog: DialogSettings;
  view: ViewSettings;
  versionControl: VersionControlSettings;
  autosave: AutosaveSettings;
}

export type SettingsSaveResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** 언어 인덱스 상수 (HWP 7개 언어) */
export const LANG = {
  KOREAN: 0,
  ENGLISH: 1,
  CHINESE: 2,
  JAPANESE: 3,
  OTHER: 4,
  SYMBOL: 5,
  USER: 6,
} as const;

/** 언어 인덱스 → 한국어 라벨 */
export const LANG_LABELS = ['한글', '영문', '한자', '일어', '외국어', '기호', '사용자'] as const;

/** 언어 인덱스 → FontSet 키 매핑 */
const LANG_KEYS: (keyof Omit<FontSet, 'name'>)[] = [
  'korean', 'english', 'chinese', 'japanese', 'other', 'symbol', 'user',
];

/** 내장 기본 대표 글꼴 (편집/삭제 불가) */
export const BUILTIN_FONT_SETS: readonly FontSet[] = [
  {
    name: '함초롬',
    korean: '함초롬바탕', english: '함초롬바탕', chinese: '함초롬바탕',
    japanese: '함초롬바탕', other: '함초롬바탕', symbol: '함초롬바탕', user: '함초롬바탕',
  },
  {
    name: '함초롬돋움',
    korean: '함초롬돋움', english: '함초롬돋움', chinese: '함초롬돋움',
    japanese: '함초롬돋움', other: '함초롬돋움', symbol: '함초롬돋움', user: '함초롬돋움',
  },
  {
    name: '맑은 고딕',
    korean: '맑은 고딕', english: '맑은 고딕', chinese: '맑은 고딕',
    japanese: '맑은 고딕', other: '맑은 고딕', symbol: '맑은 고딕', user: '맑은 고딕',
  },
  {
    name: '바탕',
    korean: '바탕', english: '바탕', chinese: '바탕',
    japanese: '바탕', other: '바탕', symbol: '바탕', user: '바탕',
  },
];

const STORAGE_KEY = 'rhwp-settings';

function defaultSettings(): AppSettings {
  return {
    version: 2,
    font: {
      fontSets: [],
      showRecentFonts: true,
      recentFontCount: 3,
      recentFonts: [],
    },
    theme: {
      mode: 'system',
    },
    dialog: {
      picturePropsKeepRatio: true,
      showPdfPrintGuidance: true,
    },
    view: {
      showParagraphMarks: false,
      showControlCodes: false,
      clipView: true,
    },
    versionControl: {
      useHancomGit: true,
    },
    autosave: {
      recoveryEnabled: true,
      recoveryIntervalMinutes: 10,
      idleSaveEnabled: true,
      idleDelaySeconds: 10,
    },
  };
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeRecentFonts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const name = candidate.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
    if (normalized.length === 5) break;
  }
  return normalized;
}

function cloneEditorScalarSettings(settings: EditorScalarSettings): EditorScalarSettings {
  return {
    font: { ...settings.font },
    theme: { ...settings.theme },
    dialog: { ...settings.dialog },
    view: { ...settings.view },
    versionControl: { ...settings.versionControl },
    autosave: { ...settings.autosave },
  };
}

/** 저장된 모든 스키마 버전을 v2의 안전한 값으로 올린다. */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const parsed = raw && typeof raw === 'object' ? raw as Partial<AppSettings> : {};
  const defaults = defaultSettings();
  const dialog: Partial<DialogSettings> = parsed.dialog ?? {};
  const view: Partial<ViewSettings> = parsed.view ?? {};
  const versionControl: Partial<VersionControlSettings> = parsed.versionControl ?? {};
  const autosave: Partial<AutosaveSettings> = parsed.autosave ?? {};
  const showParagraphMarks = normalizeBoolean(view.showParagraphMarks, defaults.view.showParagraphMarks);
  const showControlCodes = showParagraphMarks
    && normalizeBoolean(view.showControlCodes, defaults.view.showControlCodes);
  return {
    version: 2,
    font: {
      ...defaults.font,
      ...(parsed.font ?? {}),
      fontSets: Array.isArray(parsed.font?.fontSets) ? parsed.font.fontSets : defaults.font.fontSets,
      showRecentFonts: normalizeBoolean(parsed.font?.showRecentFonts, defaults.font.showRecentFonts),
      recentFontCount: normalizeNumber(parsed.font?.recentFontCount, defaults.font.recentFontCount, 1, 5),
      recentFonts: normalizeRecentFonts(parsed.font?.recentFonts),
    },
    theme: { mode: normalizeThemeMode(parsed.theme?.mode) },
    dialog: {
      picturePropsKeepRatio: normalizeBoolean(dialog.picturePropsKeepRatio, defaults.dialog.picturePropsKeepRatio),
      showPdfPrintGuidance: normalizeBoolean(dialog.showPdfPrintGuidance, defaults.dialog.showPdfPrintGuidance),
    },
    view: {
      showParagraphMarks,
      showControlCodes,
      clipView: normalizeBoolean(view.clipView, defaults.view.clipView),
    },
    versionControl: {
      useHancomGit: normalizeBoolean(versionControl.useHancomGit, defaults.versionControl.useHancomGit),
    },
    autosave: {
      recoveryEnabled: normalizeBoolean(autosave.recoveryEnabled, defaults.autosave.recoveryEnabled),
      recoveryIntervalMinutes: normalizeNumber(
        autosave.recoveryIntervalMinutes,
        defaults.autosave.recoveryIntervalMinutes,
        1,
        120,
      ),
      idleSaveEnabled: normalizeBoolean(autosave.idleSaveEnabled, defaults.autosave.idleSaveEnabled),
      idleDelaySeconds: normalizeNumber(
        autosave.idleDelaySeconds,
        defaults.autosave.idleDelaySeconds,
        5,
        600,
      ),
    },
  };
}

/** 사용자 환경설정 서비스 (싱글턴) */
class UserSettingsService {
  private data: AppSettings;
  private readonly hancomGitListeners = new Set<(enabled: boolean) => void>();
  private readonly listeners = new Set<(settings: AppSettings, source: 'local' | 'external') => void>();

  constructor() {
    this.data = this.load();
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_KEY) return;
        const previousHancomGit = this.data.versionControl.useHancomGit;
        this.data = this.load();
        if (previousHancomGit !== this.data.versionControl.useHancomGit) {
          this.hancomGitListeners.forEach((listener) => listener(this.data.versionControl.useHancomGit));
        }
        this.notify('external');
      });
    }
  }

  private load(): AppSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultSettings();
      return normalizeAppSettings(JSON.parse(raw));
    } catch {
      return defaultSettings();
    }
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (error) {
      console.warn('[user-settings] 사용자 설정 저장 실패:', error);
    }
    this.notify('local');
  }

  private notify(source: 'local' | 'external'): void {
    this.listeners.forEach((listener) => listener(this.data, source));
  }

  /** 같은 창과 다른 문서 창의 사용자 설정 변경을 구독한다. */
  subscribe(listener: (settings: AppSettings, source: 'local' | 'external') => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 전체 설정 반환 */
  getAll(): AppSettings {
    return this.data;
  }

  /** 설정 허브용 방어적 스냅샷. fontSets 같은 자원은 포함하지 않는다. */
  getEditorScalarSettings(): EditorScalarSettings {
    return cloneEditorScalarSettings({
      font: {
        showRecentFonts: this.data.font.showRecentFonts,
        recentFontCount: this.data.font.recentFontCount,
      },
      theme: this.data.theme,
      dialog: this.data.dialog,
      view: this.data.view,
      versionControl: this.data.versionControl,
      autosave: this.data.autosave,
    });
  }

  /** 편집기 스칼라 설정을 단일 localStorage 쓰기로 저장한다. */
  tryApplyEditorScalarSettings(next: EditorScalarSettings): SettingsSaveResult<EditorScalarSettings> {
    const normalized = cloneEditorScalarSettings({
      font: {
        showRecentFonts: normalizeBoolean(next.font.showRecentFonts, true),
        recentFontCount: normalizeNumber(next.font.recentFontCount, 3, 1, 5),
      },
      theme: { mode: normalizeThemeMode(next.theme.mode) },
      dialog: {
        picturePropsKeepRatio: normalizeBoolean(next.dialog.picturePropsKeepRatio, true),
        showPdfPrintGuidance: normalizeBoolean(next.dialog.showPdfPrintGuidance, true),
      },
      view: {
        showParagraphMarks: normalizeBoolean(next.view.showParagraphMarks, false),
        showControlCodes: normalizeBoolean(next.view.showControlCodes, false),
        clipView: normalizeBoolean(next.view.clipView, true),
      },
      versionControl: {
        useHancomGit: normalizeBoolean(next.versionControl.useHancomGit, true),
      },
      autosave: {
        recoveryEnabled: normalizeBoolean(next.autosave.recoveryEnabled, true),
        recoveryIntervalMinutes: normalizeNumber(next.autosave.recoveryIntervalMinutes, 10, 1, 120),
        idleSaveEnabled: normalizeBoolean(next.autosave.idleSaveEnabled, true),
        idleDelaySeconds: normalizeNumber(next.autosave.idleDelaySeconds, 10, 5, 600),
      },
    });
    if (normalized.view.showControlCodes) normalized.view.showParagraphMarks = true;
    if (!normalized.view.showParagraphMarks) normalized.view.showControlCodes = false;

    const previous = this.data;
    const updated: AppSettings = {
      ...previous,
      version: 2,
      font: { ...previous.font, ...normalized.font },
      theme: normalized.theme,
      dialog: normalized.dialog,
      view: normalized.view,
      versionControl: normalized.versionControl,
      autosave: normalized.autosave,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.data = updated;
    if (previous.versionControl.useHancomGit !== updated.versionControl.useHancomGit) {
      this.hancomGitListeners.forEach((listener) => listener(updated.versionControl.useHancomGit));
    }
    this.notify('local');
    return { ok: true, value: cloneEditorScalarSettings(normalized) };
  }

  /** 글꼴 설정 반환 */
  getFontSettings(): FontSettings {
    return this.data.font;
  }

  /** 글꼴 설정 업데이트 */
  updateFontSettings(partial: Partial<FontSettings>): void {
    Object.assign(this.data.font, partial);
    this.data.font.recentFontCount = normalizeNumber(this.data.font.recentFontCount, 3, 1, 5);
    this.data.font.recentFonts = normalizeRecentFonts(this.data.font.recentFonts);
    this.save();
  }

  /** 직접 적용한 글꼴을 최신순으로 기록한다. 대표 글꼴 세트는 호출하지 않는다. */
  recordRecentFont(fontName: string): void {
    const name = fontName.trim();
    if (!name || name.startsWith('__fontset__')) return;
    this.data.font.recentFonts = normalizeRecentFonts([
      name,
      ...this.data.font.recentFonts.filter((item) => item !== name),
    ]);
    this.save();
  }

  /** 테마 설정 반환 */
  getThemeSettings(): ThemeSettings {
    return this.data.theme;
  }

  /** 테마 모드 설정 */
  setThemeMode(mode: ThemeMode): void {
    this.data.theme.mode = normalizeThemeMode(mode);
    this.save();
  }

  /** 대화상자 UI 설정 반환 */
  getDialogSettings(): DialogSettings {
    return this.data.dialog;
  }

  /** 개체 속성 기본 탭 비율 유지 설정 반환 */
  getPicturePropsKeepRatio(): boolean {
    return this.data.dialog.picturePropsKeepRatio;
  }

  /** 개체 속성 기본 탭 비율 유지 설정 */
  setPicturePropsKeepRatio(value: boolean): void {
    this.data.dialog.picturePropsKeepRatio = value;
    this.save();
  }

  /** PDF 저장 전 브라우저 인쇄 대상 안내 표시 설정 반환 */
  getShowPdfPrintGuidance(): boolean {
    return this.data.dialog.showPdfPrintGuidance;
  }

  /** PDF 저장 전 브라우저 인쇄 대상 안내 표시 설정 */
  setShowPdfPrintGuidance(value: boolean): void {
    this.data.dialog.showPdfPrintGuidance = value;
    this.save();
  }

  /** 보기 표시 설정 반환 */
  getViewSettings(): ViewSettings {
    return this.data.view;
  }

  /** 문단부호 표시 설정 */
  setShowParagraphMarks(value: boolean): void {
    this.data.view.showParagraphMarks = value;
    if (!value) this.data.view.showControlCodes = false;
    this.save();
  }

  /** 조판부호 표시 설정 */
  setShowControlCodes(value: boolean): void {
    this.data.view.showControlCodes = value;
    if (value) this.data.view.showParagraphMarks = true;
    this.save();
  }

  /** 짤림보기(잘림 보기) 켜짐 설정. true = 오버플로 내용 표시(잘림 미적용). */
  setClipView(value: boolean): void {
    this.data.view.clipView = value;
    this.save();
  }

  /** 한컴 문서용 Git 스타일 버전 관리 사용 여부 */
  getUseHancomGit(): boolean {
    return this.data.versionControl.useHancomGit;
  }

  /** 한컴 문서용 Git 스타일 버전 관리 설정 */
  setUseHancomGit(value: boolean): void {
    if (this.data.versionControl.useHancomGit === value) return;
    this.data.versionControl.useHancomGit = value;
    this.save();
    this.hancomGitListeners.forEach((listener) => listener(value));
  }

  /** 한컴용 Git 설정 변경 구독 */
  subscribeUseHancomGit(listener: (enabled: boolean) => void): () => void {
    this.hancomGitListeners.add(listener);
    return () => this.hancomGitListeners.delete(listener);
  }

  /** 복구용 자동저장 설정 반환 */
  getAutosaveSettings(): AutosaveSettings {
    return this.data.autosave;
  }

  /** 복구용 자동저장 설정 */
  updateAutosaveSettings(partial: Partial<AutosaveSettings>): void {
    this.data.autosave = {
      ...this.data.autosave,
      ...partial,
      recoveryEnabled: normalizeBoolean(
        partial.recoveryEnabled,
        this.data.autosave.recoveryEnabled,
      ),
      recoveryIntervalMinutes: normalizeNumber(
        partial.recoveryIntervalMinutes,
        this.data.autosave.recoveryIntervalMinutes,
        1,
        120,
      ),
      idleSaveEnabled: normalizeBoolean(
        partial.idleSaveEnabled,
        this.data.autosave.idleSaveEnabled,
      ),
      idleDelaySeconds: normalizeNumber(
        partial.idleDelaySeconds,
        this.data.autosave.idleDelaySeconds,
        5,
        600,
      ),
    };
    this.save();
  }

  /** 모든 대표 글꼴 세트 반환 (내장 + 사용자) */
  getAllFontSets(): FontSet[] {
    return [...BUILTIN_FONT_SETS, ...this.data.font.fontSets];
  }

  /** 사용자 정의 대표 글꼴 세트만 반환 */
  getUserFontSets(): FontSet[] {
    return this.data.font.fontSets;
  }

  /** 대표 글꼴 세트 추가 */
  addFontSet(fs: FontSet): boolean {
    const allNames = this.getAllFontSets().map(s => s.name);
    if (allNames.includes(fs.name)) return false; // 중복 이름 불가
    this.data.font.fontSets.push(fs);
    this.save();
    return true;
  }

  /** 대표 글꼴 세트 수정 (사용자 정의만) */
  updateFontSet(index: number, fs: FontSet): boolean {
    if (index < 0 || index >= this.data.font.fontSets.length) return false;
    this.data.font.fontSets[index] = fs;
    this.save();
    return true;
  }

  /** 대표 글꼴 세트 삭제 (사용자 정의만) */
  removeFontSet(index: number): boolean {
    if (index < 0 || index >= this.data.font.fontSets.length) return false;
    this.data.font.fontSets.splice(index, 1);
    this.save();
    return true;
  }

  /** FontSet의 언어 인덱스로 글꼴 이름 조회 */
  static getFontByLang(fs: FontSet, langIndex: number): string {
    return fs[LANG_KEYS[langIndex] ?? 'korean'] ?? fs.korean;
  }

  /** FontSet에 언어 인덱스로 글꼴 이름 설정 */
  static setFontByLang(fs: FontSet, langIndex: number, fontName: string): void {
    const key = LANG_KEYS[langIndex];
    if (key) (fs as any)[key] = fontName;
  }
}

/** 싱글턴 인스턴스 */
export const userSettings = new UserSettingsService();
