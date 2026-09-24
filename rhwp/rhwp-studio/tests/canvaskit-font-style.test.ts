import assert from 'node:assert/strict';
import test from 'node:test';
import { physicalFontStyle, preferredFamilyStyleFaces, selectPreparedFontFace } from '../src/view/canvaskit-font-style.ts';
import type { LocalFontRecord } from '../src/core/local-fonts.ts';

function face(style: string, postscriptName: string): LocalFontRecord {
  return {
    family: 'Malgun Gothic',
    fullName: `Malgun Gothic ${style}`,
    postscriptName,
    style,
    displayName: `Malgun Gothic ${style}`,
    aliases: ['Malgun Gothic', '맑은 고딕', `Malgun Gothic ${style}`, postscriptName],
  };
}

test('CanvasKit chooses real styled faces without synthesizing their weight or slant', () => {
  const regular = face('Regular', 'MalgunGothic-Regular');
  const bold = face('Bold', 'MalgunGothic-Bold');
  const italic = face('Italic', 'MalgunGothic-Italic');
  const boldItalic = face('Bold Italic', 'MalgunGothic-BoldItalic');
  const available = [regular, bold, italic, boldItalic];

  assert.deepEqual(selectPreparedFontFace('맑은 고딕', regular, available, true, false), {
    record: bold, syntheticBold: false, syntheticItalic: false,
  });
  assert.deepEqual(selectPreparedFontFace('맑은 고딕', regular, available, true, true), {
    record: boldItalic, syntheticBold: false, syntheticItalic: false,
  });
  assert.deepEqual(selectPreparedFontFace('MalgunGothic-Bold', bold, available, false, false), {
    record: bold, syntheticBold: false, syntheticItalic: false,
  });
});

test('CanvasKit synthesizes only unavailable styles and avoids unwanted physical styles', () => {
  const regular = face('Regular', 'MalgunGothic-Regular');
  const boldItalic = face('Bold Italic', 'MalgunGothic-BoldItalic');
  assert.deepEqual(selectPreparedFontFace('Malgun Gothic', regular, [regular, boldItalic], true, false), {
    record: regular, syntheticBold: true, syntheticItalic: false,
  });
  assert.deepEqual(selectPreparedFontFace('Malgun Gothic', regular, [regular], false, true), {
    record: regular, syntheticBold: false, syntheticItalic: true,
  });
});

test('CanvasKit loads and selects Bold over Black and Semibold regardless of record order', () => {
  const black = face('Black', 'MalgunGothic-Black');
  const semibold = face('Semibold', 'MalgunGothic-Semibold');
  const bold = face('Bold', 'MalgunGothic-Bold');
  const regular = face('Regular', 'MalgunGothic-Regular');
  const preferred = preferredFamilyStyleFaces([black, semibold, bold, regular]);
  assert.deepEqual(preferred, [bold, regular]);
  assert.deepEqual(selectPreparedFontFace('맑은 고딕', regular, preferred, true, false), {
    record: bold, syntheticBold: false, syntheticItalic: false,
  });
  assert.deepEqual(selectPreparedFontFace('MalgunGothic-Black', black, preferred, true, false), {
    record: black, syntheticBold: false, syntheticItalic: false,
  });
});

test('BI face metadata carries bold italic style through the shared import mapping', () => {
  assert.deepEqual(physicalFontStyle(face('BI', 'MalgunGothic-BI')), {
    weight: 700, bold: true, italic: true,
  });
});
