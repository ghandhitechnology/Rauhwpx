/** 대화를 위로 읽는 동안 입력기를 한 줄로 접는 전환.
 *
 *  입력기의 아래 가장자리를 고정하고 높이만 바꾼다. 높이와 margin-top 을 같은
 *  곡선으로 반대 방향에 걸어 두 값의 합을 목적지 높이로 유지하므로, 대화 목록은
 *  첫 프레임에 한 번만 크기가 바뀌고 전환 내내 흔들리지 않는다. 안쪽 요소는
 *  이전 위치에서 새 위치로 translate 로 이어 붙여 튀지 않게 한다.
 *  전환 도중 방향이 바뀌면 현재 보이는 위치에서 새 목표로 곧바로 향한다. */

const FALLBACK_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const CLEANUP_BUFFER_MS = 50;

export interface ComposerRestingMotion {
  readonly resting: boolean;
  setResting(next: boolean): void;
  dispose(): void;
}

export function createComposerRestingMotion(opts: {
  composer: HTMLElement;
  /** 전환 중 제자리를 지켜야 하는 안쪽 요소들. 보이지 않는 요소는 건너뛴다. */
  movingParts: () => HTMLElement[];
  onChange?: (resting: boolean) => void;
}): ComposerRestingMotion {
  const { composer } = opts;
  let resting = false;
  let tweens: Animation[] = [];
  let cleanupTimer: number | null = null;

  function stop(): void {
    if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
    cleanupTimer = null;
    for (const tween of tweens) tween.cancel();
    tweens = [];
  }

  function timing(): { duration: number; easing: string } {
    const style = getComputedStyle(composer);
    const duration = Number.parseFloat(style.getPropertyValue('--ag-dur-slow')) || 300;
    const easing = style.getPropertyValue('--ag-spring').trim() || FALLBACK_EASING;
    return { duration, easing };
  }

  function animate(target: HTMLElement, keyframes: Keyframe[], duration: number, easing: string): Animation {
    // 시작 시각이 현재 프레임보다 조금 늦게 잡히면 첫 프레임에 도착 배치가
    // 비친다. backwards 로 그 틈에도 출발 키프레임을 잡아 둔다.
    try {
      return target.animate(keyframes, { duration, easing, fill: 'backwards' });
    } catch {
      // linear() 곡선을 모르는 엔진은 같은 성격의 cubic-bezier 로 대신한다.
      return target.animate(keyframes, { duration, easing: FALLBACK_EASING, fill: 'backwards' });
    }
  }

  function visibleParts(): HTMLElement[] {
    return opts.movingParts().filter((part) => part.isConnected && part.getClientRects().length > 0);
  }

  function setResting(next: boolean): void {
    if (next === resting) return;
    // 진행 중인 전환이 있으면 지금 화면에 보이는 높이·위치가 출발점이다.
    const box = composer.getBoundingClientRect();
    const fromHeight = box.height;
    const fromBottomOffsets = new Map(
      visibleParts().map((part) => [part, box.bottom - part.getBoundingClientRect().top] as const),
    );
    stop();
    resting = next;
    composer.classList.toggle('ag-resting', next);
    opts.onChange?.(next);

    const { duration, easing } = timing();
    if (fromHeight === 0 || duration < 20) return;
    const toHeight = composer.getBoundingClientRect().height;
    const delta = toHeight - fromHeight;
    if (Math.abs(delta) < 0.5) return;

    const running: Animation[] = [
      animate(composer, [
        { height: `${fromHeight}px`, marginTop: `${delta}px` },
        { height: `${toHeight}px`, marginTop: '0px' },
      ], duration, easing),
    ];
    const bottom = composer.getBoundingClientRect().bottom;
    for (const part of visibleParts()) {
      const fromBottom = fromBottomOffsets.get(part);
      if (fromBottom === undefined) continue;
      const offset = bottom - fromBottom - part.getBoundingClientRect().top;
      if (Math.abs(offset) < 0.5) continue;
      running.push(animate(part, [
        { transform: `translateY(${offset}px)` },
        { transform: 'none' },
      ], duration, easing));
    }
    tweens = running;
    const [heightTween] = running;
    const finish = (): void => {
      if (tweens[0] === heightTween) stop();
    };
    void heightTween.finished.catch(() => undefined).then(finish);
    // 멈춘 문서 타임라인에서도 자연 배치가 결국 기준이 되게 한다.
    cleanupTimer = window.setTimeout(finish, duration + CLEANUP_BUFFER_MS);
  }

  return {
    get resting() { return resting; },
    setResting,
    dispose: stop,
  };
}
