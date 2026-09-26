import assert from 'node:assert/strict';
import test from 'node:test';
import { equationFontFamilies, equationLocalFontFace } from '../src/core/equation-font.ts';
import type { LocalFontRecord } from '../src/core/local-fonts.ts';

test('legacy equations retain their source face and prefer real Times italic fallback', () => {
  assert.deepEqual(equationFontFamilies('HYhwpEQ').slice(0, 4), [
    'HYhwpEQ', 'Times New Roman', 'Times', 'STIX Two Text',
  ]);
  for (const family of ['Latin Modern Math', 'Cambria Math', 'STIX Two Math']) {
    assert.equal(equationFontFamilies(family)[0], family);
  }
});

test('equation variables and numbers choose distinct real italic and upright faces', () => {
  const records: LocalFontRecord[] = ['Bold', 'Italic', 'Regular', 'Bold Italic'].map(style => ({
    family: 'Times New Roman',
    fullName: `Times New Roman ${style}`,
    postscriptName: `Times-${style}`,
    style,
    displayName: 'Times New Roman',
    aliases: ['Times New Roman'],
  }));
  assert.equal(equationLocalFontFace(records, 'Times New Roman', true, false)?.style, 'Italic');
  assert.equal(equationLocalFontFace(records, 'Times New Roman', false, false)?.style, 'Regular');
  assert.equal(equationLocalFontFace(records, 'Times New Roman', true, true)?.style, 'Bold Italic');
  assert.equal(equationLocalFontFace(records, 'Cambria Math', false, false), undefined);
});

test('legacy math cmap keeps intrinsic italic, roman, digits and Greek distinct', async () => {
  const { legacyEquationRuns } = await import('../src/core/equation-font.ts');
  assert.deepEqual(legacyEquationRuns('pif1+αΩL', true), [
    { text: '\ue0f4\ue0ed\ue0ea\ue034\ue048\ue09d\ue09c', italic: false },
    { text: '\ue00b', italic: true },
  ]);
  assert.deepEqual(legacyEquationRuns('pα', false), [{ text: '\ue029α', italic: false }]);
});

/** 최소 SFNT: format4 cmap의 한 문자만 가진다. 누락 글립 경계도 검증한다. */
function fontWithGlyph(code: number, glyphId = 1): ArrayBuffer {
  const bytes = new ArrayBuffer(96);
  const v = new DataView(bytes);
  const u16 = (offset: number, value: number) => v.setUint16(offset, value);
  const u32 = (offset: number, value: number) => v.setUint32(offset, value);
  u32(0, 0x00010000); u16(4, 2);
  u32(12, 0x6d617870); u32(20, 44); u32(24, 6); u16(48, 2);
  u32(28, 0x636d6170); u32(36, 52); u32(40, 44);
  u16(54, 1); u16(56, 3); u16(58, 1); u32(60, 12);
  const t = 64;
  u16(t, 4); u16(t + 2, 32); u16(t + 6, 4);
  u16(t + 14, code); u16(t + 16, 0xffff);
  u16(t + 20, code); u16(t + 22, 0xffff);
  u16(t + 24, (glyphId - code) & 0xffff); u16(t + 26, 1);
  return bytes;
}

test('legacy PUA is allowed only for a loaded exact face whose cmap covers the text', async () => {
  const { createEquationFontResolver } = await import('../src/core/equation-font.ts');
  let record: LocalFontRecord | null = null;
  const resolver = createEquationFontResolver(() => record, () => fontWithGlyph(0xe0f4));
  assert.equal(resolver('HYhwpEQ', '\ue0f4'), null);
  record = { family: 'HyhwpEQ', fullName: 'HyhwpEQ', postscriptName: 'HyhwpEQ', style: 'Regular', displayName: 'HyhwpEQ', aliases: ['HYhwpEQ'] };
  assert.equal(resolver('HYhwpEQ', '\ue0f4'), null, 'saved detection metadata alone must not enable PUA');
  record.runtimeFamily = '__imported_hy';
  assert.equal(resolver('HYhwpEQ', '\ue0f4'), '__imported_hy');
  assert.equal(resolver('HYhwpEQ', '\ue0f4\ue0ed'), null, 'subset missing i must use original Unicode fallback');
  assert.equal(resolver('Times New Roman', '\ue0f4'), null);
});

test('cmap validation rejects malformed data and out-of-range glyph IDs', async () => {
  const { sfntCoversText } = await import('../src/core/sfnt-cmap.ts');
  assert.equal(sfntCoversText(fontWithGlyph(0xe0f4), '\ue0f4'), true);
  assert.equal(sfntCoversText(fontWithGlyph(0xe0f4, 0), '\ue0f4'), false);
  assert.equal(sfntCoversText(fontWithGlyph(0xe0f4, 0xffff), '\ue0f4'), false);
  assert.equal(sfntCoversText(new ArrayBuffer(2), '\ue0f4'), false);
});

test('HFT bank lookup requires an imported exact face and leaves uncovered glyphs to fallback', async () => {
  const { createEquationFontResolver } = await import('../src/core/equation-font.ts');
  const record: LocalFontRecord = { family: 'HSUSFL', fullName: 'HSUSFL', postscriptName: 'HSUSFL', style: 'Regular', displayName: 'HSUSFL', aliases: ['HSUSFL'], runtimeFamily: '__imported_greek' };
  const resolver = createEquationFontResolver(() => record, () => fontWithGlyph(0x03bb));
  assert.equal(resolver('HSUSFL', 'λ'), '__imported_greek');
  assert.equal(resolver('HSUSFL', 'x'), null);
  assert.equal(resolver('HSUSRI', 'λ'), null, 'a substituted face must not enable a different bank');
});

test('legacy Unicode literals use actual font cell metrics rather than a fixed size factor', async () => {
  const { sfntEmToCellRatio } = await import('../src/core/sfnt-cmap.ts');
  const { createEquationLiteralFontResolver } = await import('../src/core/equation-font.ts');
  const old = new Uint8Array(fontWithGlyph(0x03bb));
  const bytes = new ArrayBuffer(240); const data = new Uint8Array(bytes); const v = new DataView(bytes);
  data.set(old.subarray(0, 44)); data.set(old.subarray(44), 76);
  v.setUint16(4, 4); v.setUint32(20, 76); v.setUint32(36, 84);
  v.setUint32(44, 0x68656164); v.setUint32(52, 128); v.setUint32(56, 54);
  v.setUint32(60, 0x68686561); v.setUint32(68, 184); v.setUint32(72, 36);
  v.setUint16(146, 1000); v.setInt16(188, 1070); v.setInt16(190, -230);
  assert.equal(sfntEmToCellRatio(bytes), 1000 / 1300);
  assert.equal(sfntEmToCellRatio(new ArrayBuffer(4)), null);
  const record: LocalFontRecord = { family: 'HCR Batang', fullName: 'HCR Batang', postscriptName: 'HCRBatang', style: 'Regular', displayName: 'HCR Batang', aliases: [], runtimeFamily: '__imported_literal' };
  const resolve = createEquationLiteralFontResolver(() => record, () => bytes);
  assert.deepEqual(resolve('λ'), { family: '__imported_literal', emScale: 1000 / 1300 });
  assert.equal(resolve('Δ'), null, 'missing Unicode literal keeps fallback');
});

test('수식 측정은 실제 글립의 잉크와 굵기 및 run 커닝을 보존한다', async () => {
  const { createEquationTextMeasurer } = await import('../src/core/equation-font.ts');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const calls: Array<{ text: string; font: string }> = [];
  const context = { font: '', measureText(text: string) { calls.push({ text, font: this.font }); return { width: text.length === 2 ? 13 : 8, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length === 2 ? 15 : 10 }; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => context }) } });
  try {
    const record: LocalFontRecord = { family: 'HYhwpEQ', fullName: 'HYhwpEQ', postscriptName: 'HYhwpEQ', style: 'Regular', displayName: 'HYhwpEQ', aliases: [], runtimeFamily: '__hy' };
    const measure = createEquationTextMeasurer(name => name === 'HYhwpEQ' ? record : null, () => fontWithGlyph(0xe0f4));
    assert.deepEqual(measure('HYhwpEQ', 'p', 16, true, false, true), { advance: 8, inkLeft: 0, inkRight: 10 });
    assert.deepEqual(measure('HYhwpEQ', 'pp', 16, true, false, true, true), { advance: 13, inkLeft: 0, inkRight: 15 });
    assert.equal(calls[1].text, '\ue0f4\ue0f4');
    assert.equal(calls[1].font, 'bold 16.000px "__hy"');
    assert.equal(calls[0].text, '\ue0f4');
    assert.equal(calls[0].font, '16.000px "__hy"', 'intrinsic italic glyph must not be slanted twice');
    assert.equal(measure('HYhwpEQ', 'i', 16, true, false, true), null);
    assert.equal(measure('HYhwpEQ', 'p', 16, true, true, true), null, 'missing HFT keeps offline layout fallback');
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
