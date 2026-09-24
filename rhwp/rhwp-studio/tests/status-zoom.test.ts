import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { setupStatusZoomSlider } from '../src/ui/status-zoom.ts';
import { ViewportManager } from '../src/view/viewport-manager.ts';

class FakeRange extends EventTarget {
  value = '100';
  min = '';
  max = '';
  step = '';
  readonly styles = new Map<string, string>();
  readonly attributes = new Map<string, string>();
  style = { setProperty: (name: string, value: string) => this.styles.set(name, value) };
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}

test('status zoom follows viewport zoom and applies the latest drag value once per frame', () => {
  const bus = new EventBus();
  const viewport = new ViewportManager(bus);
  const range = new FakeRange();
  const label = { textContent: '', attributes: new Map<string, string>(), setAttribute(name: string, value: string) { this.attributes.set(name, value); } };
  const oldRequest = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  let scheduled: FrameRequestCallback | null = null;
  globalThis.requestAnimationFrame = (callback) => { scheduled = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { scheduled = null; };

  try {
    const dispose = setupStatusZoomSlider(
      range as unknown as HTMLInputElement,
      label as unknown as HTMLElement,
      viewport,
      bus,
    );
    assert.equal(range.min, '10');
    assert.equal(range.max, '500');
    assert.equal(range.value, '100');
    assert.equal(label.textContent, '100%');
    assert.equal(label.attributes.get('aria-label'), '확대 비율 100%, 100% 또는 쪽 맞춤으로 전환');

    range.value = '157';
    range.dispatchEvent(new Event('input'));
    range.value = '173';
    range.dispatchEvent(new Event('input'));
    assert.equal(viewport.getZoom(), 1);
    assert.equal(label.textContent, '173%');
    const update = scheduled;
    assert.ok(update);
    update(16);
    assert.equal(viewport.getZoom(), 1.73);
    assert.equal(scheduled, null);

    viewport.setZoom(5);
    assert.equal(range.value, '500');
    assert.equal(range.attributes.get('aria-valuetext'), '500%');
    assert.equal(range.styles.get('--zoom-progress'), '100%');
    viewport.setZoom(0.1);
    assert.equal(range.value, '10');
    assert.equal(range.styles.get('--zoom-progress'), '0%');

    range.value = '240';
    range.dispatchEvent(new Event('change'));
    assert.equal(viewport.getZoom(), 2.4);
    dispose();
    viewport.setZoom(1);
    assert.equal(range.value, '240');
  } finally {
    globalThis.requestAnimationFrame = oldRequest;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});
