import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  FORM_PACK_FORMS,
  FORM_PACK_ID,
  FORM_PACK_SAVE_LINE_EN,
  FORM_PACK_SAVE_LINE_KO,
  REFUSE_BINARY_HWP,
  REFUSE_BINARY_HWP_BODY_EN,
  REFUSE_BINARY_HWP_BODY_KO,
  REFUSE_BINARY_HWP_EN,
  REFUSE_BINARY_HWP_KO,
  formPackAssetUrl,
  formPackIdFromHwpxBytes,
  isFormPackDocument,
  refuseBinaryHwpExport,
  setActiveFormPack,
} from '../src/core/form-pack.ts';
import { inferExportFormat } from '../src/command/save-target.ts';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packDir = join(rootDir, '..', 'form-pack');

function source(path: string): string {
  return readFileSync(join(rootDir, path), 'utf8');
}

test('서식팩은 ZIP 표식 id로만 식별하고 파일명은 무시한다', () => {
  setActiveFormPack(null);
  assert.equal(isFormPackDocument(), false);
  assert.equal(refuseBinaryHwpExport('hwp', '공문.hwpx'), null);
  assert.equal(refuseBinaryHwpExport('hwp', '품의.hwpx'), null);

  const pumui = readFileSync(join(packDir, '품의.hwpx'));
  const gongmun = readFileSync(join(packDir, '공문.hwpx'));
  assert.equal(formPackIdFromHwpxBytes(pumui), FORM_PACK_ID);
  assert.equal(formPackIdFromHwpxBytes(gongmun), FORM_PACK_ID);
  assert.equal(formPackIdFromHwpxBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), null);

  setActiveFormPack(FORM_PACK_ID);
  assert.equal(isFormPackDocument(), true);
  setActiveFormPack('pumui');
  assert.equal(isFormPackDocument(), false);
  setActiveFormPack(null);
});

test('서식팩은 바이너리 HWP 내보내기를 거부한다', () => {
  setActiveFormPack(FORM_PACK_ID);
  assert.equal(refuseBinaryHwpExport('hwp', '보고서.hwpx'), REFUSE_BINARY_HWP);
  assert.equal(refuseBinaryHwpExport('hwpx', '품의.hwpx'), null);
  assert.equal(inferExportFormat('hwpx', '품의.hwp', 'hwp', '품의.hwpx'), 'hwpx');
  setActiveFormPack(null);
  assert.equal(refuseBinaryHwpExport('hwp', '공문.hwp'), null);
  assert.equal(inferExportFormat('hwpx', '공문.hwp', 'hwp', '공문.hwpx'), 'hwp');
});

test('거절 안내는 제목과 본문을 나누고 업로드를 암시하지 않는다', () => {
  assert.equal(FORM_PACK_SAVE_LINE_KO, 'HWPX만 저장');
  assert.equal(FORM_PACK_SAVE_LINE_EN, 'HWPX only');
  assert.equal(REFUSE_BINARY_HWP_BODY_KO, 'HWP 저장은 막아 두었습니다. 표와 배치는 그대로입니다.');
  assert.equal(REFUSE_BINARY_HWP_BODY_EN, 'HWP save is blocked. Tables and layout stay.');
  assert.equal(REFUSE_BINARY_HWP_KO, `${FORM_PACK_SAVE_LINE_KO}\n${REFUSE_BINARY_HWP_BODY_KO}`);
  assert.equal(REFUSE_BINARY_HWP_EN, `${FORM_PACK_SAVE_LINE_EN}\n${REFUSE_BINARY_HWP_BODY_EN}`);
  assert.equal(REFUSE_BINARY_HWP, `${REFUSE_BINARY_HWP_KO}\n${REFUSE_BINARY_HWP_EN}`);
  assert.doesNotMatch(REFUSE_BINARY_HWP, /이 서식은|저장됩니다|This form is|HWPX-only/);
  assert.doesNotMatch(REFUSE_BINARY_HWP, /바이너리|경로|업로드|클라우드|한컴|Hancom|certified|launch/i);

  const rust = source('../src/form_pack.rs');
  assert.match(rust, /SAVE_LINE_KO: &str = "HWPX만 저장"/);
  assert.match(rust, /SAVE_LINE_EN: &str = "HWPX only"/);
  assert.match(rust, /REFUSE_BODY_KO: &str = "HWP 저장은 막아 두었습니다\. 표와 배치는 그대로입니다\."/);
  assert.match(rust, /REFUSE_BODY_EN: &str = "HWP save is blocked\. Tables and layout stay\."/);
  assert.doesNotMatch(rust, /이 서식은 HWPX만 저장됩니다/);

  const fileCmd = source('src/command/commands/file.ts');
  assert.match(fileCmd, /showToast\(\{ message: refused \}\)/);
  assert.doesNotMatch(fileCmd, /alert\(refused\)/);
  assert.match(fileCmd, /showToast\(\{ message: REFUSE_BINARY_HWP \}\)/);
});

test('파일 메뉴와 빈 화면에 공문/품의 서식이 있다', () => {
  const html = source('index.html');
  const fileCmd = source('src/command/commands/file.ts');
  assert.match(html, /data-cmd="file:open-form-pack"/);
  assert.match(html, /data-form-id="gongmun"/);
  assert.match(html, /data-form-id="pumui"/);
  assert.match(html, /id="document-form-pack-action">공문\/품의 서식/);
  assert.doesNotMatch(html, /document-form-pack-hint/);
  assert.match(fileCmd, /id: 'file:open-form-pack'/);
  assert.doesNotMatch(source('src/core/form-pack.ts'), /온나라.*인증|certified/i);
  assert.deepEqual(FORM_PACK_FORMS.map((form) => form.id), ['gongmun', 'pumui']);
  assert.equal(formPackAssetUrl(FORM_PACK_FORMS[1]), `/form-pack/${encodeURIComponent('품의.hwpx')}`);
});
