import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { AgentTypewriterReveal } from '../src/agent/typewriter-reveal.ts';

function setup(t: TestContext) {
  class Element {
    style: Record<string, string> = {};
    className = '';
    classList = { add() {}, remove() {} };
    parentElement: Element | null = null;
    clientWidth = 600;
    children = new Set<Element>();
    appendChild(child: Element) { child.parentElement = this; this.children.add(child); }
    remove() { this.parentElement?.children.delete(this); this.parentElement = null; }
    addEventListener() {}
    removeEventListener() {}
  }
  const content = new Element();
  const host = new Element();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    document: {
      createElement: () => new Element(),
      getElementById: (id: string) => id === 'scroll-content' ? content : host,
    },
    requestAnimationFrame: (cb: FrameRequestCallback) => { frames.set(++nextFrame, cb); return nextFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const eventBus = new EventBus();
  const selectionProbes: number[] = [];
  const caretProbes: number[] = [];
  const reveal = new AgentTypewriterReveal({
    eventBus,
    wasm: {
      getSelectionRects: (_section: number, para: number) => {
        selectionProbes.push(para);
        return [{ pageIndex: 0, x: 0, y: para * 20, width: 50, height: 16 }];
      },
      getCursorRect: (_section: number, para: number, offset: number) => {
        caretProbes.push(para);
        return { pageIndex: 0, x: offset * 10, y: para * 20, height: 16 };
      },
      getTextRange: () => 'hello',
      getParagraphLength: () => 5,
    } as never,
    canvasView: {
      getViewportManager: () => ({
        getZoom: () => 1, getViewportSize: () => ({ height: 800 }), getScrollY: () => 0,
        setScrollTop() {},
      }),
      getVirtualScroll: () => ({
        pageCount: 1, getPageLeft: () => 0, getPageWidth: () => 600, getPageOffset: () => 0,
      }),
    } as never,
  });
  t.after(() => {
    reveal.dispose();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    reveal, frames, content, selectionProbes, caretProbes,
    insert(para: number) {
      eventBus.emit('agent-text-inserted', {
        agent: 'claude', text: 'hello', range: {
          sectionIdx: 0, startParaIdx: para, endParaIdx: para, startCharOffset: 0, endCharOffset: 5,
        },
      });
    },
  };
}

test('100 parallel inserts probe only the recent eight after the final synchronous mutation', async (t) => {
  const h = setup(t);
  for (let index = 0; index < 100; index++) h.insert(index);
  assert.equal(h.selectionProbes.length, 0, 'no probes during the mutation batch');
  await Promise.resolve();
  assert.deepEqual(h.selectionProbes, [92, 93, 94, 95, 96, 97, 98, 99]);
  assert.equal(h.caretProbes.length, 16, 'one reveal caret and one range-end caret per retained item');
  assert.equal(h.frames.size, 1);
  assert.equal(h.content.children.size, 9, 'one caret and eight covers');
});

test('finish cancels queued geometry work and a later edit still starts its own reveal', async (t) => {
  const h = setup(t);
  h.insert(0);
  h.reveal.finishAll();
  h.insert(1);
  await Promise.resolve();
  assert.deepEqual(h.selectionProbes, [1]);
  assert.equal(h.frames.size, 1);
});

test('disposing before the microtask prevents detached DOM and animation work', async (t) => {
  const h = setup(t);
  h.insert(0);
  h.reveal.dispose();
  await Promise.resolve();
  assert.equal(h.selectionProbes.length, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.content.children.size, 0);
});

test('returning from a background tab completes old reveals without probing them', async (t) => {
  const h = setup(t);
  h.insert(0);
  await Promise.resolve();
  h.selectionProbes.length = 0;
  h.caretProbes.length = 0;
  const [id, callback] = [...h.frames][0];
  h.frames.delete(id);
  callback(performance.now() + 2100);
  assert.equal(h.selectionProbes.length, 0);
  assert.equal(h.caretProbes.length, 0);
  assert.equal(h.frames.size, 0);
  for (const child of h.content.children) {
    if (child.className === 'ag-reveal-cover') assert.equal(child.style.display, 'none');
  }
});
