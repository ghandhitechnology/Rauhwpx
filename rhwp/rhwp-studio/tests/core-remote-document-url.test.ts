import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteDocumentUrlError, validateRemoteDocumentUrl } from '../src/core/remote-document-url.ts';

function assertBlocked(url: string, reason: string): void {
  assert.throws(
    () => validateRemoteDocumentUrl(url),
    (error: unknown) => error instanceof RemoteDocumentUrlError && error.reason === reason,
    `${url} should be blocked as ${reason}`,
  );
}

test('public http(s) document URLs pass validation', () => {
  const parsed = validateRemoteDocumentUrl('https://example.go.kr/FileDown.do?id=1');
  assert.equal(parsed.hostname, 'example.go.kr');
  validateRemoteDocumentUrl('http://docs.example.com/a.hwpx');
});

test('non-http schemes are rejected before any fetch', () => {
  assertBlocked('file:///Users/someone/doc.hwp', 'scheme-blocked');
  assertBlocked('javascript:alert(1)', 'scheme-blocked');
  assertBlocked('data:application/x-hwp;base64,AAAA', 'scheme-blocked');
});

test('userinfo and private hosts are rejected', () => {
  assertBlocked('https://gov.example@evil.example/a.hwp', 'userinfo-blocked');
  assertBlocked('http://127.0.0.1/a.hwp', 'private-host-blocked');
  assertBlocked('http://localhost/a.hwp', 'private-host-blocked');
  assertBlocked('http://foo.localhost/a.hwp', 'private-host-blocked');
  assertBlocked('http://nas.local/a.hwp', 'private-host-blocked');
  assertBlocked('http://192.168.0.10/a.hwp', 'private-host-blocked');
  assertBlocked('http://169.254.169.254/latest/meta-data', 'private-host-blocked');
  assertBlocked('http://intranet/a.hwp', 'private-host-blocked');
});

test('IPv4-mapped IPv6 and NAT64 bypasses are rejected even in hex form', () => {
  // URL 파서는 ::ffff:127.0.0.1 을 [::ffff:7f00:1] 로 축약한다
  assertBlocked('http://[::ffff:127.0.0.1]/a.hwp', 'private-host-blocked');
  assertBlocked('http://[::ffff:7f00:1]/a.hwp', 'private-host-blocked');
  assertBlocked('http://[::ffff:c0a8:9]/a.hwp', 'private-host-blocked');
  assertBlocked('http://[64:ff9b::7f00:1]/a.hwp', 'private-host-blocked');
  // 공용 주소는 통과
  const ok = validateRemoteDocumentUrl('http://[::ffff:808:808]/a.hwp');
  assert.equal(ok.hostname, '[::ffff:808:808]');
});
