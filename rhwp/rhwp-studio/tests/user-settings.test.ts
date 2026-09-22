import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAppSettings, userSettings } from '../src/core/user-settings.ts';

test('개체 속성 비율 유지 설정은 rhwp-settings에 저장된다', () => {
  const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const store = new Map<string, string>();
  const mockStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  } as Storage;

  (globalThis as { localStorage?: Storage }).localStorage = mockStorage;
  try {
    userSettings.setPicturePropsKeepRatio(false);
    assert.equal(userSettings.getPicturePropsKeepRatio(), false);
    let stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.equal(stored.dialog.picturePropsKeepRatio, false);

    userSettings.setPicturePropsKeepRatio(true);
    assert.equal(userSettings.getPicturePropsKeepRatio(), true);
    stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.equal(stored.dialog.picturePropsKeepRatio, true);
  } finally {
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
});

test('PDF 저장 안내 표시 설정은 rhwp-settings에 저장되고 다시 켤 수 있다', () => {
  const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const store = new Map<string, string>();
  const mockStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  } as Storage;

  (globalThis as { localStorage?: Storage }).localStorage = mockStorage;
  try {
    userSettings.setShowPdfPrintGuidance(false);
    assert.equal(userSettings.getShowPdfPrintGuidance(), false);
    let stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.equal(stored.dialog.showPdfPrintGuidance, false);

    userSettings.setShowPdfPrintGuidance(true);
    assert.equal(userSettings.getShowPdfPrintGuidance(), true);
    stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.equal(stored.dialog.showPdfPrintGuidance, true);
  } finally {
    userSettings.setShowPdfPrintGuidance(true);
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
});

test('문단부호 표시 설정은 rhwp-settings에 저장된다', () => {
  const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const store = new Map<string, string>();
  const mockStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  } as Storage;

  (globalThis as { localStorage?: Storage }).localStorage = mockStorage;
  try {
    userSettings.setShowParagraphMarks(true);
    assert.equal(userSettings.getViewSettings().showParagraphMarks, true);
    let stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.equal(stored.view.showParagraphMarks, true);

    userSettings.setShowControlCodes(true);
    assert.equal(userSettings.getViewSettings().showControlCodes, true);
    stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.equal(stored.view.showControlCodes, true);

    userSettings.setShowParagraphMarks(false);
    assert.equal(userSettings.getViewSettings().showParagraphMarks, false);
    stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.equal(stored.view.showParagraphMarks, false);
  } finally {
    userSettings.setShowControlCodes(false);
    userSettings.setShowParagraphMarks(false);
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
});

test('짤림보기(clipView) 설정은 rhwp-settings에 저장되고 기본값은 켜짐이다', () => {
  const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const store = new Map<string, string>();
  const mockStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  } as Storage;

  (globalThis as { localStorage?: Storage }).localStorage = mockStorage;
  try {
    // 기본값: 짤림보기 켜짐(오버플로 표시)
    assert.equal(userSettings.getViewSettings().clipView, true);

    userSettings.setClipView(false);
    assert.equal(userSettings.getViewSettings().clipView, false);
    let stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.equal(stored.view.clipView, false);

    userSettings.setClipView(true);
    assert.equal(userSettings.getViewSettings().clipView, true);
    stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.equal(stored.view.clipView, true);
  } finally {
    userSettings.setClipView(true);
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
});

test('한컴용 Git 설정은 기본으로 꺼져 있고 rhwp-settings에 저장된다', () => {
  const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const store = new Map<string, string>();
  const mockStorage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.get(key) ?? null; },
    key(index: number) { return Array.from(store.keys())[index] ?? null; },
    removeItem(key: string) { store.delete(key); },
    setItem(key: string, value: string) { store.set(key, value); },
  } as Storage;

  (globalThis as { localStorage?: Storage }).localStorage = mockStorage;
  const changes: boolean[] = [];
  const unsubscribe = userSettings.subscribeUseHancomGit((enabled) => changes.push(enabled));
  try {
    assert.equal(userSettings.getUseHancomGit(), true);
    userSettings.setUseHancomGit(false);
    assert.equal(userSettings.getUseHancomGit(), false);
    assert.deepEqual(changes, [false]);
    const stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.equal(stored.versionControl.useHancomGit, false);
  } finally {
    unsubscribe();
    userSettings.setUseHancomGit(true);
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
});

test('복구용 자동저장 설정은 rhwp-settings에 저장된다', () => {
  const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const store = new Map<string, string>();
  const mockStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  } as Storage;

  (globalThis as { localStorage?: Storage }).localStorage = mockStorage;
  try {
    userSettings.updateAutosaveSettings({
      recoveryEnabled: false,
      recoveryIntervalMinutes: 30,
      idleSaveEnabled: true,
      idleDelaySeconds: 45,
    });

    const settings = userSettings.getAutosaveSettings();
    assert.equal(settings.recoveryEnabled, false);
    assert.equal(settings.recoveryIntervalMinutes, 30);
    assert.equal(settings.idleSaveEnabled, true);
    assert.equal(settings.idleDelaySeconds, 45);

    const stored = JSON.parse(store.get('rhwp-settings') ?? '{}');
    assert.deepEqual(stored.autosave, {
      recoveryEnabled: false,
      recoveryIntervalMinutes: 30,
      idleSaveEnabled: true,
      idleDelaySeconds: 45,
    });
  } finally {
    userSettings.updateAutosaveSettings({
      recoveryEnabled: true,
      recoveryIntervalMinutes: 10,
      idleSaveEnabled: true,
      idleDelaySeconds: 10,
    });
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
});

test('v1 설정은 최근 글꼴을 더한 v2로 마이그레이션되고 범위를 정규화한다', () => {
  const migrated = normalizeAppSettings({
    version: 1,
    font: { showRecentFonts: true, recentFontCount: 99, recentFonts: ['A', 'A', ' ', 'B'] },
    view: { showParagraphMarks: false, showControlCodes: true },
    autosave: { recoveryIntervalMinutes: -4, idleDelaySeconds: 9999 },
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.font.recentFontCount, 5);
  assert.deepEqual(migrated.font.recentFonts, ['A', 'B']);
  assert.deepEqual(migrated.view, {
    showParagraphMarks: false,
    showControlCodes: false,
    clipView: true,
  });
  assert.equal(migrated.autosave.recoveryIntervalMinutes, 1);
  assert.equal(migrated.autosave.idleDelaySeconds, 600);
});

test('편집 설정 스냅샷은 복제되고 저장 실패 시 메모리 값을 바꾸지 않는다', () => {
  const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const baseline = userSettings.getEditorScalarSettings();
  const changed = userSettings.getEditorScalarSettings();
  changed.view.showParagraphMarks = !baseline.view.showParagraphMarks;
  assert.notDeepEqual(changed, userSettings.getEditorScalarSettings());
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
  } as unknown as Storage;
  try {
    const result = userSettings.tryApplyEditorScalarSettings(changed);
    assert.equal(result.ok, false);
    assert.deepEqual(userSettings.getEditorScalarSettings(), baseline);
  } finally {
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
});

test('최근 글꼴 저장이 실패해도 선택 동작과 메모리 목록은 유지된다', () => {
  const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const originalWarn = console.warn;
  const original = {
    ...userSettings.getFontSettings(),
    recentFonts: [...userSettings.getFontSettings().recentFonts],
  };
  const warnings: unknown[][] = [];
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
  } as unknown as Storage;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    assert.doesNotThrow(() => userSettings.recordRecentFont('저장 실패 글꼴'));
    assert.equal(userSettings.getFontSettings().recentFonts[0], '저장 실패 글꼴');
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => null,
      setItem: () => {},
    } as unknown as Storage;
    userSettings.updateFontSettings(original);
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
});

test('최근 글꼴은 중복 없이 최신순 다섯 개만 남는다', () => {
  const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const original = { ...userSettings.getFontSettings(), recentFonts: [...userSettings.getFontSettings().recentFonts] };
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  } as unknown as Storage;
  try {
    userSettings.updateFontSettings({ recentFonts: [] });
    for (const name of ['A', 'B', 'C', 'D', 'E', 'C', 'F']) userSettings.recordRecentFont(name);
    assert.deepEqual(userSettings.getFontSettings().recentFonts, ['F', 'C', 'E', 'D', 'B']);
  } finally {
    userSettings.updateFontSettings(original);
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
});
