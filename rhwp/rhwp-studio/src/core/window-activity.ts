/**
 * 창 활성 상태를 body.window-inactive 로 반영한다.
 *
 * 창이 포커스를 잃으면 선택 영역·액센트 채움이 중성 회색으로 물러난다
 * (base.css 의 "비활성 창" 절). 문서 안 iframe 으로 포커스가 옮겨 간
 * 경우에도 window blur 가 오므로, 한 틱 뒤 document.hasFocus() 로 다시
 * 확인해 실제로 창을 떠났을 때만 비활성으로 표시한다.
 */
export function initWindowActivity(): () => void {
  const body = document.body;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const sync = () => {
    pending = null;
    body.classList.toggle('window-inactive', !document.hasFocus());
  };
  const onFocus = () => {
    if (pending) clearTimeout(pending);
    pending = null;
    body.classList.remove('window-inactive');
  };
  const onBlur = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(sync, 0);
  };

  sync();
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  return () => {
    if (pending) clearTimeout(pending);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    body.classList.remove('window-inactive');
  };
}
