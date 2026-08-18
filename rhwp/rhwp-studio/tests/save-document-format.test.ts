import test from 'node:test';
import assert from 'node:assert/strict';

import { exportDocumentForFormat } from '../src/command/save-document-format.ts';

test('선택한 SaveFormat 하나가 대응하는 exporter만 호출한다', () => {
  const calls: string[] = [];
  const exporter = {
    exportHml: () => {
      calls.push('hml');
      return new TextEncoder().encode(
        '<HWPML xmlns="http://www.hancom.co.kr/hwpml/2011/core"><HEAD/></HWPML>',
      );
    },
    exportHwp: () => {
      calls.push('hwp');
      return new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    },
    exportHwpx: () => {
      calls.push('hwpx');
      return new Uint8Array([0x50, 0x4B, 0x03, 0x04]);
    },
  };

  assert.equal(exportDocumentForFormat(exporter, 'hml')[0], 0x3C);
  assert.equal(exportDocumentForFormat(exporter, 'hwp')[0], 0xD0);
  assert.equal(exportDocumentForFormat(exporter, 'hwpx')[0], 0x50);
  assert.deepEqual(calls, ['hml', 'hwp', 'hwpx']);
});

test('잘못되거나 빈 exporter 결과는 기존 파일을 쓰기 전에 거부한다', () => {
  const exporter = {
    exportHml: () => new Uint8Array(),
    exportHwp: () => new Uint8Array([0x50, 0x4B, 0x03, 0x04]),
    exportHwpx: () => new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
  };

  assert.throws(() => exportDocumentForFormat(exporter, 'hml'), /기존 파일은 변경하지 않았습니다/);
  assert.throws(() => exportDocumentForFormat(exporter, 'hwp'), /파일 형식\(hwpx\)/);
  assert.throws(() => exportDocumentForFormat(exporter, 'hwpx'), /파일 형식\(hwp\)/);
});
