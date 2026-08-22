import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  FORM_PACK_FORMS,
  REFUSE_BINARY_HWP,
  formPackAssetUrl,
  formPackIdFromFileName,
  isFormPackDocument,
  refuseBinaryHwpExport,
  setActiveFormPack,
} from '../src/core/form-pack.ts';
import { inferExportFormat } from '../src/command/save-target.ts';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function source(path: string): string {
  return readFileSync(join(rootDir, path), 'utf8');
}

test('서식팩 파일명과 활성 문서를 식별한다', () => {
  setActiveFormPack(null);
  assert.equal(formPackIdFromFileName('품의.hwpx'), 'pumui');
  assert.equal(formPackIdFromFileName('공문.hwpx'), 'gongmun');
  assert.equal(formPackIdFromFileName('보고서.hwpx'), null);
  assert.equal(isFormPackDocument('메모.hwpx'), false);
  setActiveFormPack('pumui');
  assert.equal(isFormPackDocument('메모.hwpx'), true);
  setActiveFormPack(null);
});

test('서식팩은 바이너리 HWP 내보내기를 거부한다', () => {
  setActiveFormPack('pumui');
  assert.equal(refuseBinaryHwpExport('hwp', '품의.hwpx'), REFUSE_BINARY_HWP);
  assert.equal(refuseBinaryHwpExport('hwpx', '품의.hwpx'), null);
  assert.equal(inferExportFormat('hwpx', '품의.hwp', 'hwp', '품의.hwpx'), 'hwpx');
  setActiveFormPack(null);
  assert.equal(refuseBinaryHwpExport('hwp', '일반.hwp'), null);
});

test('파일 메뉴와 빈 화면에 공문/품의 서식이 있다', () => {
  const html = source('index.html');
  const fileCmd = source('src/command/commands/file.ts');
  assert.match(html, /data-cmd="file:open-form-pack"/);
  assert.match(html, /data-form-id="gongmun"/);
  assert.match(html, /data-form-id="pumui"/);
  assert.match(html, /id="document-form-pack-action">공문\/품의 서식/);
  assert.match(fileCmd, /id: 'file:open-form-pack'/);
  assert.deepEqual(FORM_PACK_FORMS.map((form) => form.id), ['gongmun', 'pumui']);
  assert.equal(formPackAssetUrl(FORM_PACK_FORMS[1]), `/form-pack/${encodeURIComponent('품의.hwpx')}`);
});
