import assert from 'node:assert/strict';
import {
  FetchSecurityError,
  REMOTE_THUMBNAIL_MAX_BYTES,
  fetchDocumentWithPolicy,
  isTrustedExtensionPageSender,
  isWebPageSender,
  readResponseBytesWithLimit,
  validateDocumentFetchUrl
} from './fetch-security.js';

assert.equal(REMOTE_THUMBNAIL_MAX_BYTES, 64 * 1024 * 1024);

function assertBlocked(url, reason, options = {}) {
  assert.throws(
    () => validateDocumentFetchUrl(url, options),
    (error) => error instanceof FetchSecurityError && error.reason === reason,
    `${url} should be blocked as ${reason}`
  );
}

function assertAllowed(url, expectedHost, options = {}) {
  const parsed = validateDocumentFetchUrl(url, options);
  assert.equal(parsed.hostname, expectedHost);
}

assertAllowed('https://example.com/a.hwp', 'example.com', { requireDocumentPath: true });
assertAllowed('https://example.go.kr/FileDown.do?id=123', 'example.go.kr');
assertAllowed(
  'https://github.com/owner/repo/blob/main/sample.hwpx',
  'raw.githubusercontent.com',
  { requireDocumentPath: true }
);

assertBlocked('http://127.0.0.1/blocked.hwp', 'private-host-blocked', { requireDocumentPath: true });
assertBlocked('http://localhost/blocked.hwp', 'private-host-blocked', { requireDocumentPath: true });
assertBlocked('http://192.168.0.10/blocked.hwp', 'private-host-blocked', { requireDocumentPath: true });
assertBlocked('http://169.254.169.254/latest/meta-data.hwp', 'private-host-blocked', { requireDocumentPath: true });
assertBlocked('https://intranet/blocked.hwp', 'private-host-blocked', { requireDocumentPath: true });
assertBlocked('https://safe.go.kr@evil.com/file.hwp', 'userinfo-blocked', { requireDocumentPath: true });
assertBlocked('https://example.com/download?file=blocked.hwp', 'not-document-path', { requireDocumentPath: true });
assertBlocked('http://127.0.0.1/FileDown.do?id=123', 'private-host-blocked');
assertBlocked('file:///tmp/blocked.hwp', 'scheme-blocked', { requireDocumentPath: true });

// IPv4-mapped IPv6 / NAT64 우회 차단 (URL 파서가 16진수로 축약해도)
assertBlocked('http://[::ffff:127.0.0.1]/a.hwp', 'private-host-blocked');
assertBlocked('http://[::ffff:7f00:1]/a.hwp', 'private-host-blocked');
assertBlocked('http://[::ffff:172.16.0.1]/a.hwp', 'private-host-blocked');
assertBlocked('http://[::ffff:ac10:1]/a.hwp', 'private-host-blocked');
assertBlocked('http://[::ffff:192.168.0.9]/a.hwp', 'private-host-blocked');
assertBlocked('http://[::ffff:c0a8:9]/a.hwp', 'private-host-blocked');
assertBlocked('http://[::ffff:169.254.169.254]/a.hwp', 'private-host-blocked');
assertBlocked('http://[64:ff9b::7f00:1]/a.hwp', 'private-host-blocked');
assertBlocked('http://[fe80::1]/a.hwp', 'private-host-blocked');
assertBlocked('http://[fd12::1]/a.hwp', 'private-host-blocked');
assertAllowed('https://[2606:4700::6810:85e5]/a.hwp', '[2606:4700::6810:85e5]');
assertAllowed('http://[::ffff:808:808]/a.hwp', '[::ffff:808:808]'); // ::ffff:8.8.8.8 → public

const runtimeApi = {
  runtime: {
    getURL(path = '') {
      return `chrome-extension://abc123/${path}`;
    }
  }
};

assert.equal(
  isTrustedExtensionPageSender({ url: 'chrome-extension://abc123/viewer.html?url=https%3A%2F%2Fexample.com%2Fa.hwp' }, runtimeApi),
  true
);
assert.equal(isTrustedExtensionPageSender({ url: 'https://attacker.example/a.html' }, runtimeApi), false);
assert.equal(isWebPageSender({ url: 'https://example.com/a.html', tab: { id: 1 } }), true);
assert.equal(isWebPageSender({ url: 'chrome-extension://abc123/viewer.html', tab: { id: 1 } }), false);

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return new Response(new Uint8Array([0x50, 0x4B, 0x03, 0x04]), { status: 200 });
};
await fetchDocumentWithPolicy('https://example.com/a.hwpx', { requireDocumentPath: true });
assert.equal(calls[0].init.credentials, 'omit');
assert.equal(calls[0].init.redirect, 'manual');

assert.deepEqual(
  await readResponseBytesWithLimit(new Response(new Uint8Array([1, 2, 3])), 3),
  new Uint8Array([1, 2, 3])
);
await assert.rejects(
  () => {
    let cancelReason = null;
    const response = new Response(new ReadableStream({
      cancel(reason) { cancelReason = reason; }
    }), { headers: { 'content-length': '5' } });
    return readResponseBytesWithLimit(response, 4).finally(() => {
      assert.equal(cancelReason, 'response-too-large');
    });
  },
  (error) => error instanceof FetchSecurityError && error.reason === 'response-too-large'
);
await assert.rejects(
  () => readResponseBytesWithLimit(new Response(new Uint8Array([1, 2, 3, 4, 5])), 4),
  (error) => error instanceof FetchSecurityError && error.reason === 'response-too-large'
);

globalThis.fetch = async () => new Response(null, {
  status: 302,
  headers: { Location: 'http://127.0.0.1/blocked.hwp' }
});
await assert.rejects(
  () => fetchDocumentWithPolicy('https://example.com/a.hwp', { requireDocumentPath: true }),
  (error) => error instanceof FetchSecurityError && error.reason === 'private-host-blocked'
);

globalThis.fetch = originalFetch;

console.log('fetch-security policy tests passed');
