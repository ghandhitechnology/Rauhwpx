import type { EventBus } from '../core/event-bus.ts';
import { MAX_ZOOM, MIN_ZOOM, type ViewportManager } from '../view/viewport-manager.ts';

/** Keep the native range control and the document zoom in step during drag, wheel, and fit. */
export function setupStatusZoomSlider(
  range: HTMLInputElement,
  label: HTMLElement,
  viewport: Pick<ViewportManager, 'getZoom' | 'setZoom'>,
  eventBus: EventBus,
): () => void {
  const min = Math.round(MIN_ZOOM * 100);
  const max = Math.round(MAX_ZOOM * 100);
  range.min = String(min);
  range.max = String(max);
  range.step = '1';

  let pendingPercent: number | null = null;
  let frame: number | null = null;

  const clampPercent = (value: number): number => Math.max(min, Math.min(max, value));
  const show = (zoom: number): void => {
    const percent = clampPercent(Math.round(zoom * 100));
    range.value = String(percent);
    range.style.setProperty('--zoom-progress', `${((percent - min) / (max - min)) * 100}%`);
    range.setAttribute('aria-valuetext', `${percent}%`);
    label.textContent = `${percent}%`;
    label.setAttribute('aria-label', `확대 비율 ${percent}%, 100% 또는 쪽 맞춤으로 전환`);
  };
  const flush = (): void => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (pendingPercent === null) return;
    const percent = pendingPercent;
    pendingPercent = null;
    if (Math.abs(viewport.getZoom() * 100 - percent) >= 0.5) {
      viewport.setZoom(percent / 100);
    }
  };
  const onInput = (): void => {
    pendingPercent = clampPercent(Number(range.value));
    show(pendingPercent / 100);
    if (frame === null) frame = requestAnimationFrame(flush);
  };
  const onChange = (): void => {
    if (pendingPercent === null) pendingPercent = clampPercent(Number(range.value));
    flush();
  };
  const offZoom = eventBus.on('zoom-changed', (zoom) => {
    // A pending drag value belongs to the pointer, even if an earlier wheel frame arrives.
    if (pendingPercent === null && typeof zoom === 'number') show(zoom);
  });

  range.addEventListener('input', onInput);
  range.addEventListener('change', onChange);
  show(viewport.getZoom());

  return () => {
    range.removeEventListener('input', onInput);
    range.removeEventListener('change', onChange);
    offZoom();
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
