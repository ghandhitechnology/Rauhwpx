import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Exercise the installed production API without booting the document engine.
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = main.indexOf('function installCloudDocumentRuntimeApi(');
const end = main.indexOf('\nasync function applyCloudResult', start);
assert.ok(start >= 0 && end > start);
const source = stripTypeScriptTypes(main.slice(start, end).replace('import.meta',
  '({ env: { VITE_RHWP_CLOUD_RUNTIME: "1" } })'));

function fixture() {
  const secret = 'a'.repeat(43);
  let emit: (event: unknown) => void = () => {};
  let activeTools = 0;
  let interruptions = 0;
  const window: any = { location: {
    hostname: '127.0.0.1', origin: 'http://127.0.0.1', search: `?cloudRuntime=1&bootstrap=${secret}`,
  } };
  const bridge = {
    onEvent: (listener: typeof emit) => { emit = listener; },
    interruptIfIdle() {
      if (activeTools > 0) return false;
      interruptions++;
      return true;
    },
  };
  const install = new Function('window', 'document', 'eventBus',
    `let cloudDocumentPublishingEnabled = false;\n${source}\nreturn installCloudDocumentRuntimeApi;`)(
    window, { documentElement: { dataset: {} } }, { on() {} },
  );
  assert.equal(install(bridge), true);
  return {
    api: window.rauhwpxCloudRuntime, secret,
    emit: (event: unknown) => emit(event),
    activeTools: (value: number) => { activeTools = value; },
    interruptions: () => interruptions,
  };
}

test('a 250-event drain cannot interrupt while newer events remain buffered', () => {
  const { api, secret, emit, interruptions } = fixture();
  for (let index = 0; index < 251; index++) emit({ type: 'agent', event: { type: 'text-delta', text: 'x' } });
  const first = api.drainEvents(secret, 0);
  assert.equal(first.length, 250);
  assert.equal(api.interruptIfIdle(secret, first.at(-1).seq).interrupted, false);
  assert.equal(interruptions(), 0);
  const rest = api.drainEvents(secret, 250);
  assert.equal(rest.length, 1);
  assert.equal(api.interruptIfIdle(secret, rest.at(-1).seq).interrupted, true);
  assert.equal(interruptions(), 1);
});

test('events and tool requests arriving after drain both prevent unsafe interruption', () => {
  const { api, secret, emit, activeTools, interruptions } = fixture();
  emit({ type: 'agent', event: { type: 'turn-start' } });
  const cursor = api.drainEvents(secret, 0).at(-1).seq;
  emit({ type: 'agent', event: { type: 'tool-call', callId: 'late' } });
  assert.equal(api.interruptIfIdle(secret, cursor).interrupted, false);
  activeTools(1);
  const current = api.drainEvents(secret, cursor).at(-1).seq;
  assert.equal(api.interruptIfIdle(secret, current).interrupted, false);
  assert.equal(interruptions(), 0);
  activeTools(0);
  assert.equal(api.interruptIfIdle(secret, current).interrupted, true);
});

test('idle interruption requires the bootstrap secret and an exact numeric cursor', () => {
  const { api, secret, interruptions } = fixture();
  assert.throws(() => api.interruptIfIdle('wrong', 0), /authentication failed/);
  for (const cursor of [undefined, null, '0', -1, 0.5, 1]) {
    assert.equal(api.interruptIfIdle(secret, cursor).interrupted, false);
  }
  assert.equal(interruptions(), 0);
});
