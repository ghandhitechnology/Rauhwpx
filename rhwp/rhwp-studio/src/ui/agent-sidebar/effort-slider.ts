/**
 * 추론 강도 슬라이더 — 프로바이더/모델이 주는 강도 목록(약함 → 강함)을 디텐트로
 * 깔고, 스프링 물리로 따라오는 엄지를 얹는다. 드래그 중에는 디텐트 자석이 원시
 * 위치를 눈금 쪽으로 휘어 붙여 살짝 저항이 느껴지고, 놓으면 가장 가까운 눈금에
 * 가벼운 오버슈트와 함께 스냅한다. 눈금 수는 setOptions 로 언제든 바뀐다.
 */

import './effort-slider.css';

import type { AgentEffortOption } from '../../agent/models.ts';

export interface EffortSliderOptions {
  /** 드래그를 놓거나 키보드·클릭으로 눈금이 바뀌어 확정될 때. */
  onChange: (id: string) => void;
  /** 드래그 중 가장 가까운 눈금이 바뀔 때(라벨 미리보기용). */
  onPreview?: (id: string) => void;
  ariaLabel?: string;
}

export interface EffortSlider {
  root: HTMLElement;
  /**
   * 눈금 목록(약함 → 강함)과 현재 값을 교체한다. onChange 는 부르지 않는다.
   * 목록이 이전과 같으면 자리만 애니메이션으로 옮긴다.
   */
  setOptions(options: readonly AgentEffortOption[], selectedId: string): void;
  /** 값만 바꾼다 — 애니메이션은 하고 onChange 는 부르지 않는다. */
  setValue(id: string): void;
  value(): string;
  setDisabled(disabled: boolean): void;
}

/** 엄지 반지름(px) — CSS 의 --ag-eslider-pad 와 같은 값이어야 한다. */
const PAD = 14;
/** 드래그 추종 스프링 — 일부러 살짝 무겁게 잡아 '마찰' 감을 만든다. */
const DRAG_STIFFNESS = 620;
const DRAG_DAMPING_RATIO = 1.15;
/** 놓았을 때 스냅 스프링 — 가벼운 오버슈트로 '딸깍' 감을 만든다. */
const SNAP_STIFFNESS = 340;
const SNAP_DAMPING_RATIO = 0.8;
/** 디텐트 자석 지수 — 클수록 눈금 근처에서 더 오래 머문다. */
const MAGNET_EXPONENT = 2.4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createEffortSlider(config: EffortSliderOptions): EffortSlider {
  const root = document.createElement('div');
  root.className = 'ag-eslider';
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-orientation', 'horizontal');
  if (config.ariaLabel) root.setAttribute('aria-label', config.ariaLabel);

  const track = document.createElement('div');
  track.className = 'ag-eslider-track';
  const fill = document.createElement('div');
  fill.className = 'ag-eslider-fill';
  const thumb = document.createElement('div');
  thumb.className = 'ag-eslider-thumb';
  const valueEl = document.createElement('span');
  valueEl.className = 'ag-eslider-value';
  track.append(fill, thumb);
  root.append(track, valueEl);

  let options: AgentEffortOption[] = [];
  let dots: HTMLElement[] = [];
  let index = 0; // 확정된 눈금
  let previewIndex = -1; // 드래그 중 가장 가까운 눈금
  let pos = 0; // 눈금 단위 연속 위치
  let vel = 0;
  let target = 0;
  let dragging = false;
  let disabled = false;
  let raf = 0;
  let lastTime = 0;
  const reduceMotion =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  function denom(): number {
    return Math.max(1, options.length - 1);
  }

  function clampIndex(value: number): number {
    return clamp(Math.round(value), 0, Math.max(0, options.length - 1));
  }

  function render(): void {
    const f = clamp(pos / denom(), 0, 1);
    track.style.setProperty('--f', String(f));
    for (let i = 0; i < dots.length; i += 1) {
      dots[i]!.classList.toggle('ag-passed', i / denom() <= f + 1e-4);
    }
  }

  function step(now: number): void {
    const dt = Math.min(0.032, Math.max(0.001, (now - lastTime) / 1000));
    lastTime = now;
    const stiffness = dragging ? DRAG_STIFFNESS : SNAP_STIFFNESS;
    const ratio = dragging ? DRAG_DAMPING_RATIO : SNAP_DAMPING_RATIO;
    const damping = 2 * Math.sqrt(stiffness) * ratio;
    vel += (stiffness * (target - pos) - damping * vel) * dt;
    pos += vel * dt;
    if (!dragging && Math.abs(target - pos) < 0.001 && Math.abs(vel) < 0.02) {
      pos = target;
      vel = 0;
      render();
      raf = 0;
      return;
    }
    render();
    raf = requestAnimationFrame(step);
  }

  function kick(): void {
    if (reduceMotion?.matches) {
      pos = target;
      vel = 0;
      render();
      return;
    }
    if (raf === 0) {
      lastTime = performance.now();
      raf = requestAnimationFrame(step);
    }
  }

  function rawFromPointer(e: PointerEvent): number {
    const rect = track.getBoundingClientRect();
    const usable = Math.max(1, rect.width - PAD * 2);
    return clamp((e.clientX - rect.left - PAD) / usable, 0, 1) * denom();
  }

  /** 눈금 근처(|d|<0.5)에서 원시 위치를 눈금 쪽으로 휘어 붙인다 — 디텐트 자석. */
  function magnet(raw: number): number {
    const nearest = Math.round(raw);
    const d = raw - nearest;
    return nearest + 0.5 * Math.sign(d) * Math.pow(Math.abs(d) * 2, MAGNET_EXPONENT);
  }

  function syncAria(i: number): void {
    root.setAttribute('aria-valuenow', String(i));
    const label = options[i]?.label ?? '';
    root.setAttribute('aria-valuetext', label);
    valueEl.textContent = label;
  }

  function setPreview(i: number, pulse: boolean): void {
    if (i === previewIndex) return;
    previewIndex = i;
    syncAria(i);
    const dot = dots[i];
    if (pulse && dot && !reduceMotion?.matches) {
      dot.classList.remove('ag-tick');
      void dot.offsetWidth;
      dot.classList.add('ag-tick');
    }
    if (pulse) config.onPreview?.(options[i]?.id ?? '');
  }

  function commit(i: number): void {
    setPreview(i, true);
    if (i === index) return;
    index = i;
    const id = options[i]?.id;
    if (id) config.onChange(id);
  }

  root.addEventListener('pointerdown', (e) => {
    if (disabled || options.length < 2 || e.button !== 0) return;
    e.preventDefault();
    root.focus();
    root.setPointerCapture(e.pointerId);
    dragging = true;
    root.classList.add('ag-dragging');
    const raw = rawFromPointer(e);
    target = magnet(raw);
    setPreview(clampIndex(raw), true);
    kick();
  });
  root.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const raw = rawFromPointer(e);
    target = magnet(raw);
    setPreview(clampIndex(raw), true);
    kick();
  });
  const release = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('ag-dragging');
    const final = clampIndex(rawFromPointer(e));
    target = final;
    kick();
    commit(final);
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);

  root.addEventListener('keydown', (e) => {
    if (disabled || options.length < 2) return;
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = index + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    else return;
    e.preventDefault();
    target = clampIndex(next);
    kick();
    commit(clampIndex(next));
  });

  function moveTo(i: number): void {
    index = i;
    target = i;
    previewIndex = -1;
    setPreview(i, false);
    kick();
  }

  function setOptions(list: readonly AgentEffortOption[], selectedId: string): void {
    const same =
      list.length === options.length && list.every((o, i) => o.id === options[i]!.id);
    if (!same) {
      options = [...list];
      dots = options.map((_, i) => {
        const dot = document.createElement('span');
        dot.className = 'ag-eslider-dot';
        dot.style.setProperty('--df', String(i / denom()));
        return dot;
      });
      track.replaceChildren(fill, ...dots, thumb);
      root.setAttribute('aria-valuemin', '0');
      root.setAttribute('aria-valuemax', String(Math.max(0, options.length - 1)));
      root.classList.toggle('ag-single', options.length < 2);
    }
    const idx = Math.max(0, options.findIndex((o) => o.id === selectedId));
    if (same) {
      moveTo(idx);
      return;
    }
    // 눈금 구성이 바뀌면 이어질 애니메이션이 무의미하다 — 자리로 바로 놓는다.
    index = idx;
    pos = idx;
    target = idx;
    vel = 0;
    previewIndex = -1;
    setPreview(idx, false);
    render();
  }

  return {
    root,
    setOptions,
    setValue(id: string): void {
      const idx = options.findIndex((o) => o.id === id);
      if (idx < 0 || idx === index) return;
      moveTo(idx);
    },
    value(): string {
      return options[index]?.id ?? '';
    },
    setDisabled(next: boolean): void {
      disabled = next;
      root.classList.toggle('ag-disabled', next);
      root.setAttribute('aria-disabled', next ? 'true' : 'false');
      root.tabIndex = next ? -1 : 0;
      if (next && dragging) {
        dragging = false;
        root.classList.remove('ag-dragging');
        target = index;
        kick();
      }
    },
  };
}
