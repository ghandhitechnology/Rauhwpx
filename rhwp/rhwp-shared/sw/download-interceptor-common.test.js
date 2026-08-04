// shouldInterceptDownload 단위 테스트 (#198 / #207)
//
// 실행: node --test rhwp-shared/sw/download-interceptor-common.test.js
//
// 브라우저 API 에 의존하지 않는 순수 함수만 테스트.
// Chrome(onDeterminingFilename) / Firefox(onCreated+onChanged) 양쪽에서 동일하게 사용.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { shouldInterceptDownload } from './download-interceptor-common.js';

// ─── HWP 감지 ──────────────────────────────────────────

test('hwp 파일명 감지', () => {
  assert.equal(shouldInterceptDownload({ filename: 'sample.hwp' }), true);
});

test('hwpx 파일명 감지', () => {
  assert.equal(shouldInterceptDownload({ filename: 'sample.hwpx' }), true);
});

test('대소문자 무관 감지', () => {
  assert.equal(shouldInterceptDownload({ filename: 'SAMPLE.HWP' }), true);
  assert.equal(shouldInterceptDownload({ filename: 'Sample.Hwpx' }), true);
});

test('URL 에서 hwp 감지', () => {
  assert.equal(shouldInterceptDownload({ url: 'https://example.com/doc.hwp' }), true);
});

test('URL 에서 hwpx 감지 (쿼리 문자열 포함)', () => {
  assert.equal(
    shouldInterceptDownload({ url: 'https://example.com/doc.hwpx?token=abc123' }),
    true,
  );
});

test('URL 경로에 .hwp 가 중간에 있어도 쿼리 시작이면 감지', () => {
  // 보수적: .hwp 다음에 ? 또는 끝일 때만 감지
  assert.equal(
    shouldInterceptDownload({ url: 'https://example.com/file.hwp?dl=1' }),
    true,
  );
});

test('finalUrl 감지 (redirect 후 hwp 확장자)', () => {
  assert.equal(
    shouldInterceptDownload({
      url: 'https://example.com/download.do?id=42',
      finalUrl: 'https://cdn.example.com/blob/sample.hwp',
    }),
    true,
  );
});

test('mime 감지 (haansoft)', () => {
  assert.equal(
    shouldInterceptDownload({ mime: 'application/haansoft-hwp' }),
    true,
  );
});

test('mime 감지 (x-hwp)', () => {
  assert.equal(shouldInterceptDownload({ mime: 'application/x-hwp' }), true);
});

test('mime 감지 (hwp+zip — hwpx)', () => {
  assert.equal(
    shouldInterceptDownload({ mime: 'application/hwp+zip' }),
    true,
  );
});

test('mime 대소문자 무관', () => {
  assert.equal(
    shouldInterceptDownload({ mime: 'Application/X-HWP' }),
    true,
  );
});

// ─── 미감지 (false positive 방지) ────────────────────

test('일반 이미지 미감지', () => {
  assert.equal(
    shouldInterceptDownload({ filename: 'photo.png', mime: 'image/png' }),
    false,
  );
});

test('일반 PDF 미감지', () => {
  assert.equal(
    shouldInterceptDownload({ filename: 'doc.pdf', mime: 'application/pdf' }),
    false,
  );
});

test('일반 zip 미감지', () => {
  assert.equal(
    shouldInterceptDownload({ filename: 'archive.zip', mime: 'application/zip' }),
    false,
  );
});

test('파일명 일부에 hwp 가 있어도 확장자 아니면 미감지', () => {
  // chwp.txt, hwpscript.js 등 — 확장자가 .hwp 가 아님
  assert.equal(shouldInterceptDownload({ filename: 'chwp.txt' }), false);
  assert.equal(shouldInterceptDownload({ filename: 'hwpscript.js' }), false);
});

test('빈 item 미감지', () => {
  assert.equal(shouldInterceptDownload({}), false);
});

test('null/undefined 미감지', () => {
  assert.equal(shouldInterceptDownload(null), false);
  assert.equal(shouldInterceptDownload(undefined), false);
});

test('mime 빈 문자열 안전 처리', () => {
  assert.equal(shouldInterceptDownload({ mime: '', filename: 'x.png' }), false);
});

// ─── 다중 신호 (filename + mime 조합) ────────────────

test('filename 미매치 + mime 매치', () => {
  // 임시 파일명 (예: download.bin) 으로 떨어지지만 mime 이 한컴
  assert.equal(
    shouldInterceptDownload({ filename: 'download.bin', mime: 'application/x-hwp' }),
    true,
  );
});

test('filename 미매치 + URL 매치', () => {
  assert.equal(
    shouldInterceptDownload({
      filename: 'download',
      url: 'https://example.com/file.hwp',
    }),
    true,
  );
});

// ─── 재요청 불가 패턴 (POST / 세션 의존 핸들러) ──────

test('DEXT5 핸들러 url 차단 (filename 이 hwpx 여도)', () => {
  // 실제 사례: biz.hira.or.kr 의 dext5handler.ndo POST 응답
  // filename 이 .hwpx 라도 url 이 dext5handler 면 인터셉트 포기 (빈 뷰어 탭 방지)
  assert.equal(
    shouldInterceptDownload({
      url: 'https://biz.hira.or.kr/com/dext5handler.ndo',
      filename: 'sample.hwpx',
    }),
    false,
  );
});

test('DEXT5 핸들러 referrer 차단', () => {
  // url 자체는 정상 hwp 처럼 보여도 referrer 가 DEXT5 면 차단
  assert.equal(
    shouldInterceptDownload({
      url: 'https://example.com/blob/sample.hwp',
      referrer: 'https://biz.hira.or.kr/com/dext5handler.ndo',
    }),
    false,
  );
});

test('DEXT5 변종 확장자 (.jsp/.do) 도 차단', () => {
  assert.equal(
    shouldInterceptDownload({
      url: 'https://example.com/dext5handler.jsp',
      filename: 'doc.hwp',
    }),
    false,
  );
  assert.equal(
    shouldInterceptDownload({
      url: 'https://example.com/dext5handler.do?id=1',
      filename: 'doc.hwp',
    }),
    false,
  );
});

// ─── Firefox 특화: onCreated / onChanged 단계별 시나리오 (#207) ─

test('Firefox onCreated: url만 있고 filename/mime 없어도 감지', () => {
  // browser.downloads.onCreated 시점에는 filename 이 아직 없을 수 있음
  assert.equal(
    shouldInterceptDownload({ id: 1, url: 'https://example.com/a.hwp' }),
    true,
  );
});

test('Firefox onCreated: url/filename 없고 mime 만으로 감지', () => {
  // Content-Disposition 없이 MIME 으로만 HWP 알 수 있는 경우
  assert.equal(
    shouldInterceptDownload({ id: 2, mime: 'application/x-hwp' }),
    true,
  );
});

test('Firefox onChanged: filename 확정 후 일반 파일은 미감지', () => {
  // onCreated 에서 판정 불가 → onChanged 에서 filename 확정 → 일반 zip 이면 인터셉트 포기
  assert.equal(
    shouldInterceptDownload({
      id: 3,
      filename: 'a.zip',
      url: 'https://example.com/download?id=123',
    }),
    false,
  );
});
