import assert from 'node:assert/strict';

const originalChrome = globalThis.chrome;
globalThis.chrome = {
  runtime: { getURL: (pathname = '') => `chrome-extension://test/${pathname}` },
};

try {
  const { dispatchRuntimeMessage, messageHandlers } = await import(`./message-router.js?test=${Date.now()}`);
  const responses = [];
  const respond = (value) => responses.push(value);

  assert.equal(dispatchRuntimeMessage(null, {}, respond), false);
  for (const type of ['__proto__', 'constructor', 'toString', 'valueOf']) {
    assert.equal(dispatchRuntimeMessage({ type }, {}, respond), false);
  }
  assert.equal(dispatchRuntimeMessage({ type: 'missing' }, {}, respond), false);
  assert.deepEqual(responses, []);

  messageHandlers['test-sync-failure'] = () => {
    throw new Error('sync failure');
  };
  assert.equal(dispatchRuntimeMessage({ type: 'test-sync-failure' }, {}, respond), false);
  assert.deepEqual(responses.pop(), { error: 'sync failure' });

  messageHandlers['test-async-failure'] = async () => {
    throw 'opaque failure';
  };
  assert.equal(dispatchRuntimeMessage({ type: 'test-async-failure' }, {}, respond), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(responses.pop(), { error: 'Message handler failed' });

  delete messageHandlers['test-sync-failure'];
  delete messageHandlers['test-async-failure'];
} finally {
  globalThis.chrome = originalChrome;
}

console.log('Chrome message router tests passed');
