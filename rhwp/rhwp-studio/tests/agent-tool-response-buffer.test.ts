// 끊긴 사이에 끝난 tool-response 를 붙잡아 두는 버퍼와, 브리지가 그것을 물린 자리를 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// bridge.ts 는 오버레이 css 를 함께 들여온다 — node 테스트에서는 빈 모듈로 대체한다.
registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { ToolResponseBuffer } = await import('../src/agent/bridge.ts');
const bridgeSource = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');

test('ToolResponseBuffer: 담은 순서대로 흘려보내고 비운다', () => {
  const buffer = new ToolResponseBuffer();
  buffer.push({ id: 1 });
  buffer.push({ id: 2 });
  assert.equal(buffer.size, 2);
  assert.deepEqual(buffer.drain(), [{ id: 1 }, { id: 2 }]);
  assert.equal(buffer.size, 0);
  assert.deepEqual(buffer.drain(), []);
});

test('ToolResponseBuffer: 한계를 넘으면 가장 오래된 것부터 버린다', () => {
  const buffer = new ToolResponseBuffer(2);
  buffer.push({ id: 1 });
  buffer.push({ id: 2 });
  buffer.push({ id: 3 });
  assert.equal(buffer.size, 2);
  assert.deepEqual(buffer.drain(), [{ id: 2 }, { id: 3 }]);
});

test('ToolResponseBuffer: 보관 기한이 지난 프레임은 흘리지 않는다', () => {
  const buffer = new ToolResponseBuffer(8, 30_000);
  buffer.push({ id: 1 }, 0);
  buffer.push({ id: 2 }, 20_000);
  assert.deepEqual(buffer.drain(31_000), [{ id: 2 }]);
});

test('ToolResponseBuffer: clear 는 남은 프레임을 모두 버린다', () => {
  const buffer = new ToolResponseBuffer();
  buffer.push({ id: 1 });
  buffer.clear();
  assert.equal(buffer.size, 0);
});

test('브리지는 전송 실패한 tool-response 를 버퍼에 넣고 재연결 때 흘려보낸다', () => {
  assert.match(bridgeSource, /private sendToolResponse\(frame: unknown\): void \{\s*if \(this\.sendJson\(frame\)\) return;\s*this\.toolResponses\.push\(frame\);/);
  assert.match(bridgeSource, /this\.setState\('connected'\);[\s\S]{0,200}this\.flushToolResponses\(\);/);
  assert.doesNotMatch(bridgeSource, /this\.sendJson\(\{ v: AGENT_PROTOCOL_VERSION, type: 'tool-response'/);
});

test('스튜디오 소켓 URL 은 페이지 인스턴스 id 를 함께 보낸다', () => {
  assert.match(bridgeSource, /&instance=\$\{encodeURIComponent\(STUDIO_INSTANCE_ID\)\}/);
  assert.match(bridgeSource, /const STUDIO_INSTANCE_ID = /);
});
