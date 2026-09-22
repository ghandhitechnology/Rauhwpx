import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSse } from '../src/cloud/browser-protocol.ts';

const maximum = 2 * 1024 * 1024;
const oversized = { code: 'SSE_PAYLOAD_INVALID', retryable: false };

test('SSE bounds complete events and incomplete tails, including ignored fields and UTF-8 bytes', () => {
  for (const raw of ['data: ' + 'x'.repeat(maximum), ':' + 'x'.repeat(maximum),
    'ignored: ' + '한'.repeat(Math.ceil(maximum / 3))]) {
    assert.throws(() => parseSse(raw + '\n\n'), oversized);
    assert.throws(() => parseSse(raw), oversized);
    const first = parseSse(raw.slice(0, 1024));
    assert.throws(() => parseSse(first.rest + raw.slice(1024)), oversized);
  }
});

test('SSE accepts large batches of individually bounded frames and preserves proof fields', () => {
  const raw = 'id: 7\nevent: agent.event\nrauhwpx-sha256: digest\nrauhwpx-signature: signature\ndata: ';
  const data = 'x'.repeat(maximum - raw.length);
  const parsed = parseSse((raw + data + '\n\n').repeat(3) + 'data: tail');
  assert.equal(parsed.frames.length, 3);
  assert.deepEqual(parsed.frames[0], { id: '7', event: 'agent.event', digest: 'digest', signature: 'signature', data });
  assert.equal(parsed.rest, 'data: tail');
});

test('SSE preserves CRLF framing across every split, including at the byte limit', () => {
  const raw = 'data: ' + 'x'.repeat(maximum - 6);
  for (const delimiter of ['\n\n', '\r\n\r\n']) {
    for (let split = 1; split < delimiter.length; split++) {
      const first = parseSse(raw + delimiter.slice(0, split));
      assert.equal(first.frames.length, 0);
      const second = parseSse(first.rest + delimiter.slice(split));
      assert.equal(second.frames[0].data.length, maximum - 6);
      assert.equal(second.rest, '');
    }
  }
  let rest = '';
  const frames = [];
  for (const character of 'id: 1\r\ndata: 한글\r\ndata: text\r\n\r\n') {
    const parsed = parseSse(rest + character);
    rest = parsed.rest;
    frames.push(...parsed.frames);
  }
  assert.equal(frames[0].data, '한글\ntext');
});
