import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasPool } from '../src/view/canvas-pool.ts';

class FakeCanvas {
  width = 300;
  height = 150;
  parentElement: { removeChild: (canvas: FakeCanvas) => void } | null = null;
}

function installFakeDocument() {
  const hadDocument = 'document' in globalThis;
  const previous = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tag: string) {
        assert.equal(tag, 'canvas');
        return new FakeCanvas();
      },
    },
  });
  return () => {
    if (!hadDocument) {
      Reflect.deleteProperty(globalThis, 'document');
      return;
    }
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: previous,
    });
  };
}

test('released canvases keep DOM reuse while bounding retained backing stores', () => {
  const restore = installFakeDocument();
  try {
    const pool = new CanvasPool(100);
    const canvases = Array.from({ length: 3 }, (_, page) => {
      const canvas = pool.acquire(page) as unknown as FakeCanvas;
      canvas.width = 8;
      canvas.height = 8;
      return canvas;
    });

    for (let page = 0; page < canvases.length; page++) pool.release(page);
    assert.equal(pool.totalCount, 3);
    assert.equal(pool.retainedBackingBytes, 8 * 8 * 4);
    assert.equal(canvases.filter((canvas) => canvas.width === 0).length, 2);

    const reused = pool.acquire(9) as unknown as FakeCanvas;
    assert.equal(reused.width, 8, 'retained backing canvas should be reused before cleared entries');
    assert.equal(pool.retainedBackingBytes, 0);
  } finally {
    restore();
  }
});

test('CanvasKit replacement releases the detached original backing store', () => {
  const restore = installFakeDocument();
  try {
    const pool = new CanvasPool();
    const current = pool.acquire(2) as unknown as FakeCanvas;
    current.width = 1200;
    current.height = 1600;
    let removed = false;
    current.parentElement = {
      removeChild(canvas) {
        assert.equal(canvas, current);
        removed = true;
        current.parentElement = null;
      },
    };
    const replacement = new FakeCanvas();

    pool.replace(
      2,
      current as unknown as HTMLCanvasElement,
      replacement as unknown as HTMLCanvasElement,
    );
    assert.equal(removed, true);
    assert.equal(current.width, 0);
    assert.equal(current.height, 0);
    assert.equal(pool.getCanvas(2), replacement);
  } finally {
    restore();
  }
});
