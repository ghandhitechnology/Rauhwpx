/**
 * 우상단 슬라이드 토스트 알림 (#196).
 *
 * - 크롬(제목 막대 + 도구 모음) 바로 아래 오른쪽에 쌓인다
 * - 200ms 슬라이드·페이드, 동작 줄이기 설정에서는 페이드만
 * - 자동 페이드 (기본 8초)
 * - 사용자 닫기 버튼 (×)
 * - 선택적 액션 버튼 (텍스트 링크 스타일)
 * - 일반 재사용 가능 — 다른 안내에도 활용 가능
 */

const CONTAINER_ID = 'rhwp-toast-container';
const DEFAULT_DURATION_MS = 8000;
/** 등장·퇴장 시간. base.css 의 .rhwp-toast transition 과 같다. */
const EXIT_DURATION_MS = 200;
/** 크롬(제목 막대 + 도구 모음) 아래로 띄우는 간격 */
const CHROME_GAP_PX = 8;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** 메시지 본문 (필수). \n 줄바꿈 지원. */
  message: string;
  /** 자동 페이드 시간 (ms). 기본 8000ms. 0 이면 자동 페이드 없음 (사용자 닫기만). */
  durationMs?: number;
  /** 액션 버튼 (선택, 텍스트 링크 스타일). */
  action?: ToastAction;
  /**
   * 확인 버튼 라벨 (선택). 지정 시 우측에 명시적 확인 버튼 추가.
   * 자동 페이드를 끄고 사용자 닫기를 강제하는 용도 (durationMs: 0 와 함께 사용).
   */
  confirmLabel?: string;
}

/** 제목 막대와 도구 모음을 가리지 않도록 크롬 판 바로 아래에 둔다. */
function chromeBottom(): number {
  const header = document.getElementById('studio-header');
  const bottom = header?.getBoundingClientRect().bottom ?? 0;
  return Math.max(0, Math.round(bottom));
}

function ensureContainer(): HTMLElement {
  let container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.className = 'rhwp-toast-stack';
    document.body.appendChild(container);
  }
  container.style.top = `${chromeBottom() + CHROME_GAP_PX}px`;
  return container;
}

function createCloseIcon(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M3 3l6 6M9 3L3 9');
  svg.appendChild(path);
  return svg;
}

/**
 * 토스트 알림을 표시한다.
 *
 * @param options 메시지·지속시간·액션
 */
export function showToast(options: ToastOptions): void {
  const container = ensureContainer();
  const duration = options.durationMs ?? DEFAULT_DURATION_MS;

  const toast = document.createElement('div');
  toast.className = 'rhwp-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  // 본문
  const body = document.createElement('div');
  body.className = 'rhwp-toast-message';
  body.textContent = options.message;
  toast.appendChild(body);

  // 액션 버튼 (선택, 텍스트 링크 스타일)
  if (options.action) {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'rhwp-toast-action';
    actionBtn.textContent = options.action.label;
    actionBtn.addEventListener('click', () => {
      options.action!.onClick();
      // 액션 클릭 시 토스트 자동 닫지 않음 — confirmLabel 가 있으면 사용자가 명시적으로 닫음
      if (!options.confirmLabel) removeToast();
    });
    toast.appendChild(actionBtn);
  }

  // 확인 버튼 (선택, 강조 스타일) 또는 닫기 버튼
  if (options.confirmLabel) {
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'rhwp-toast-confirm';
    confirmBtn.textContent = options.confirmLabel;
    confirmBtn.addEventListener('click', () => removeToast());
    toast.appendChild(confirmBtn);
  } else {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'rhwp-toast-close';
    closeBtn.setAttribute('aria-label', '닫기');
    closeBtn.appendChild(createCloseIcon());
    closeBtn.addEventListener('click', () => removeToast());
    toast.appendChild(closeBtn);
  }

  container.appendChild(toast);

  // 다음 프레임에서 들어온다 — 첫 프레임은 퇴장 위치에서 칠해져야 전환이 걸린다.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('rhwp-toast-in'));
  });

  let removed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function removeToast(): void {
    if (removed) return;
    removed = true;
    if (timer) clearTimeout(timer);
    toast.classList.remove('rhwp-toast-in');
    setTimeout(() => {
      toast.remove();
    }, EXIT_DURATION_MS);
  }

  // 자동 페이드
  if (duration > 0) {
    timer = setTimeout(removeToast, duration);
  }
}
