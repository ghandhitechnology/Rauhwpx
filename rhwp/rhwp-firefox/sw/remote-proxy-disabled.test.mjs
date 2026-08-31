import assert from 'node:assert/strict';

const originalBrowser = globalThis.browser;
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.browser = {
  runtime: { getURL: (pathname = '') => `moz-extension://test/${pathname}` },
};
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error('extension background fetch must stay disabled');
};

try {
  const { messageHandlers } = await import(`./message-router.js?disabled=${Date.now()}`);
  const viewer = {
    url: 'moz-extension://test/viewer.html?url=https%3A%2F%2Fexample.com%2Fa.hwp',
    tab: { id: 8 },
    frameId: 0,
    documentId: 'viewer-document',
  };
  for (const url of [
    'https://example.com/a.hwp',
    'http://93.184.216.34/a.hwp',
    'https://example.com/redirect.hwp',
  ]) {
    assert.deepEqual(messageHandlers['fetch-file-start']({ url }, viewer), {
      error: 'Privileged remote fetch is disabled; a server/native fetcher with DNS pinning is required.',
      code: 'REMOTE_PROXY_UNAVAILABLE',
      requirement: 'SERVER_FETCH_REQUIRED',
    });
  }
  const webSender = { url: 'https://attacker.example/page', tab: { id: 9 } };
  assert.equal((await messageHandlers['extract-thumbnail']({ url: 'https://example.com/a.hwp' }, webSender)).code,
    'REMOTE_PROXY_UNAVAILABLE');
  assert.equal(fetchCalls, 0);
} finally {
  globalThis.browser = originalBrowser;
  globalThis.fetch = originalFetch;
}

console.log('Firefox remote proxy fail-closed tests passed');
