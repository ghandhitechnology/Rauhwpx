import type { SkillCommitOutcome } from '../../agent/types.ts';

export function createSkillEditor(options: {
  name: string;
  read(): Promise<{ name: string; body: string; digest: string }>;
  save(body: string, base: string): Promise<SkillCommitOutcome>;
  close(): void;
  saved(digest: string): void;
}) {
  const root = document.createElement('section');
  root.className = 'ag-skill-editor';
  root.setAttribute('aria-label', `${options.name} 편집`);
  const heading = document.createElement('div');
  heading.className = 'ag-skill-editor-heading';
  const pixel = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  pixel.setAttribute('viewBox', '0 0 12 12');
  pixel.setAttribute('aria-hidden', 'true');
  pixel.setAttribute('class', 'ag-skill-editor-pixel');
  // 작은 픽셀 연필. 장식은 편집 영역의 읽기 순서에서 제외한다.
  for (const [x, y, width, height, fill] of [
    [7, 1, 3, 2, 'var(--ag-accent)'], [6, 3, 4, 1, 'var(--ag-text)'],
    [5, 4, 4, 1, 'var(--ag-accent)'], [4, 5, 4, 1, 'var(--ag-accent)'],
    [3, 6, 4, 1, 'var(--ag-accent)'], [2, 7, 4, 1, 'var(--ag-accent)'],
    [2, 8, 3, 1, 'var(--ag-text-secondary)'], [1, 9, 3, 1, 'var(--ag-text-secondary)'],
    [1, 10, 1, 1, 'var(--ag-text)'], [8, 8, 1, 1, 'var(--ag-accent)'],
    [10, 6, 1, 1, 'var(--ag-accent)'],
  ] as const) {
    const rect = document.createElementNS(pixel.namespaceURI, 'rect');
    for (const [key, value] of Object.entries({ x, y, width, height, fill })) rect.setAttribute(key, String(value));
    pixel.append(rect);
  }
  const title = document.createElement('span');
  title.textContent = options.name;
  heading.append(pixel, title);
  const textarea = document.createElement('textarea');
  textarea.className = 'ag-skill-editor-input';
  textarea.setAttribute('aria-label', '스킬 지시');
  textarea.spellcheck = false;
  textarea.disabled = true;
  const footer = document.createElement('div');
  footer.className = 'ag-skill-editor-footer';
  const status = document.createElement('span');
  status.className = 'ag-skill-editor-status';
  status.setAttribute('role', 'status');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ag-skill-text ag-skill-editor-cancel';
  cancel.textContent = '취소';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'ag-skill-text ag-skill-editor-save';
  save.textContent = '저장';
  footer.append(status, cancel, save);
  root.append(heading, textarea, footer);
  let baseline = '';
  let digest: string | null = null;
  let busy = false;
  let closed = false;
  const sync = () => {
    save.disabled = busy || digest === null || textarea.value === baseline;
    cancel.disabled = busy;
    textarea.readOnly = busy;
    root.setAttribute('aria-busy', String(busy || digest === null));
  };
  const close = () => { if (!busy) { closed = true; options.close(); } };
  const commit = async () => {
    if (save.disabled || !digest) return;
    busy = true;
    status.textContent = '';
    save.textContent = '저장 중…';
    sync();
    try {
      const outcome = await options.save(textarea.value, digest);
      if (closed) return;
      if (!outcome.ok) {
        status.textContent = outcome.code === 'STALE'
          ? '다른 변경 사항이 있습니다. 내용을 복사한 뒤 다시 열어 주세요.'
          : outcome.message;
        return;
      }
      closed = true;
      options.saved(outcome.digest);
    } catch {
      status.textContent = '저장하지 못했습니다. 다시 시도해 주세요.';
    } finally {
      busy = false;
      save.textContent = '저장';
      sync();
    }
  };
  textarea.addEventListener('input', sync);
  root.addEventListener('keydown', (event) => {
    // Escape로 설정이 닫혀도 초안이 사라지는 듯 보이지 않도록 편집 안에서 처리한다.
    if (event.key === 'Escape') event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void commit();
    }
  });
  cancel.addEventListener('click', close);
  save.addEventListener('click', () => void commit());
  sync();
  void options.read().then((value) => {
    if (closed) return;
    baseline = value.body;
    digest = value.digest;
    textarea.value = baseline;
    textarea.disabled = false;
    sync();
    if (root.isConnected) textarea.focus();
  }).catch(() => {
    if (closed) return;
    root.setAttribute('aria-busy', 'false');
    status.textContent = '불러오지 못했습니다. 다시 열어 주세요.';
  });
  return { root };
}
