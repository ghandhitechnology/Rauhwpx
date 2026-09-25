import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { AgentEditFollow } from '../src/agent/agent-edit-follow.ts';

function setup(t: TestContext, pageCount = { value: 3 }) {
  const eventBus = new EventBus();
  const probes: number[] = [];
  const scrolls: number[] = [];
  let scrollY = 0;
  const follow = new AgentEditFollow({
    eventBus,
    wasm: {
      // 문단 하나 = 100px, 한 쪽 = 10문단
      getCursorRect: (_section: number, para: number) => {
        probes.push(para);
        return { pageIndex: Math.floor(para / 10), x: 0, y: (para % 10) * 100, height: 16 };
      },
    } as never,
    canvasView: {
      getViewportManager: () => ({
        getZoom: () => 1,
        getViewportSize: () => ({ height: 800 }),
        getScrollY: () => scrollY,
        setScrollTop: (y: number) => { scrollY = y; scrolls.push(y); },
      }),
      getVirtualScroll: () => ({
        pageCount: pageCount.value, getPageOffset: (page: number) => page * 1000,
      }),
    } as never,
  });
  t.after(() => follow.dispose());
  return {
    follow, eventBus, probes, scrolls,
    insert(para: number) {
      eventBus.emit('agent-text-inserted', {
        agent: 'claude', text: 'hello', range: {
          sectionIdx: 0, startParaIdx: para, endParaIdx: para, startCharOffset: 0, endCharOffset: 5,
        },
      });
    },
  };
}

test('a burst of edits probes once and jumps to the last edit when it is off-screen', async (t) => {
  const h = setup(t);
  for (let para = 0; para < 25; para++) h.insert(para);
  assert.deepEqual(h.probes, [], 'no geometry work during the synchronous batch');
  await Promise.resolve();
  assert.deepEqual(h.probes, [24]);
  assert.deepEqual(h.scrolls, [2400 - 320]);
});

test('edits already on screen do not move the viewport', async (t) => {
  const h = setup(t);
  h.insert(3);
  await Promise.resolve();
  assert.deepEqual(h.scrolls, []);
});

test('an edit on a page not yet placed waits for the mutation layout refresh', async (t) => {
  const pageCount = { value: 1 };
  const h = setup(t, pageCount);
  h.insert(15);
  await Promise.resolve();
  assert.deepEqual(h.scrolls, []);
  pageCount.value = 2;
  h.eventBus.emit('document-layout-refreshed', { source: 'mutation' });
  assert.deepEqual(h.scrolls, [1500 - 320]);
});

test('cancel drops a pending jump', async (t) => {
  const h = setup(t);
  h.insert(20);
  h.follow.cancel();
  await Promise.resolve();
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.scrolls, []);
});
