import assert from 'node:assert/strict';
import test from 'node:test';
import { isFontFamilyAvailable, filterAvailableFontFamilies } from '../src/core/font-presence.ts';

/**
 * 캔버스 글립 폭 프로브를 가짜 컨텍스트로 검증한다.
 * `installed` 에 든 서체만 generic fallback 과 다른 폭을 돌려준다.
 */
function makeProbeContext(installed: readonly string[]) {
  const installedSet = new Set(installed);
  const state = { font: '' };
  return {
    get font() {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    measureText(text: string) {
      // `72px "이름", monospace` 형태에서 첫 서체명을 뽑는다.
      const match = state.font.match(/^\d+px "([^"]+)"/);
      const family = match?.[1];
      const base = 10 * text.length;
      if (family && installedSet.has(family)) {
        return { width: base + 7 };
      }
      return { width: base };
    },
  } as unknown as Pick<CanvasRenderingContext2D, 'font' | 'measureText'>;
}

test('설치된 서체만 사용 가능으로 판정한다', () => {
  const ctx = makeProbeContext(['Apple SD Gothic Neo', 'AppleMyungjo']);

  assert.equal(isFontFamilyAvailable('Apple SD Gothic Neo', ctx), true);
  assert.equal(isFontFamilyAvailable('AppleMyungjo', ctx), true);
  // Windows 전용 서체는 macOS 프로필에서 미설치로 잡혀야 한다.
  assert.equal(isFontFamilyAvailable('맑은 고딕', ctx), false);
  assert.equal(isFontFamilyAvailable('바탕', ctx), false);
  assert.equal(isFontFamilyAvailable('굴림체', ctx), false);
});

test('존재할 수 없는 서체를 설치됨으로 오검출하지 않는다', () => {
  // document.fonts.check() 회귀 방지: 그 API 는 아래 이름들에도 true 를 준다.
  const ctx = makeProbeContext(['Apple SD Gothic Neo']);
  assert.equal(isFontFamilyAvailable('ZZZ_NoSuchFont_12345', ctx), false);
  assert.equal(isFontFamilyAvailable('AbsolutelyNotInstalled_QQQ', ctx), false);
  assert.equal(isFontFamilyAvailable('', ctx), false);
});

test('프로브 컨텍스트가 없으면 미설치로 간주한다', () => {
  const previousDocument = (globalThis as typeof globalThis & { document?: unknown }).document;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined });
  try {
    assert.equal(isFontFamilyAvailable('맑은 고딕'), false);
    assert.deepEqual(filterAvailableFontFamilies(['맑은 고딕', '바탕']), []);
  } finally {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: previousDocument,
    });
  }
});
