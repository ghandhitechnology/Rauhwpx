import type { SkillCommitOutcome } from '../../agent/types.ts';

function appendPixelHeading(root: HTMLElement, label: string): void {
  const heading = document.createElement('div');
  heading.className = 'ag-skill-editor-heading';
  const pixel = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  pixel.setAttribute('viewBox', '0 0 12 12');
  pixel.setAttribute('aria-hidden', 'true');
  pixel.setAttribute('class', 'ag-skill-editor-pixel');
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
  title.textContent = label;
  heading.append(pixel, title);
  root.appendChild(heading);
}

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
  appendPixelHeading(root, options.name);
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
  root.append(textarea, footer);
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

function skillMarkdown(name: string, description: string, body: string): string {
  const safeDescription = description.replaceAll('"', '\\"');
  return `---\nname: ${name || 'new-skill'}\ndescription: "${safeDescription}"\n---\n\n${body}`;
}

export function createNewSkillEditor(options: {
  commit(name: string, description: string, body: string): Promise<SkillCommitOutcome>;
  close(): void;
  saved(outcome: Extract<SkillCommitOutcome, { ok: true }>): void;
}) {
  const root = document.createElement('section');
  root.className = 'ag-skill-editor ag-skill-new-editor';
  root.setAttribute('aria-label', '새 스킬 만들기');
  appendPixelHeading(root, '새 스킬 만들기');

  const intro = document.createElement('p');
  intro.className = 'ag-skill-editor-intro';
  intro.textContent = 'Markdown으로 바로 작성하고, 저장하면 스킬 목록에 추가됩니다.';

  const fields = document.createElement('div');
  fields.className = 'ag-skill-editor-fields';
  const name = document.createElement('input');
  name.className = 'ag-skill-editor-name';
  name.type = 'text';
  name.placeholder = 'skill-name';
  name.setAttribute('aria-label', '스킬 이름');
  name.autocomplete = 'off';
  name.spellcheck = false;
  const description = document.createElement('input');
  description.className = 'ag-skill-editor-description';
  description.type = 'text';
  description.placeholder = '이 스킬이 언제 쓰이는지 한 줄로 설명하세요';
  description.setAttribute('aria-label', '스킬 설명');
  fields.append(name, description);

  const bodyLabel = document.createElement('label');
  bodyLabel.className = 'ag-skill-editor-body-label';
  bodyLabel.textContent = '지시문';
  const textarea = document.createElement('textarea');
  textarea.className = 'ag-skill-editor-input';
  textarea.setAttribute('aria-label', '스킬 지시');
  textarea.placeholder = '스킬이 따라야 할 지시를 Markdown으로 작성하세요.';
  textarea.spellcheck = false;
  bodyLabel.appendChild(textarea);

  const artifact = document.createElement('article');
  artifact.className = 'ag-skill-editor-artifact';
  artifact.setAttribute('aria-label', 'SKILL.md 미리보기');
  const artifactHead = document.createElement('div');
  artifactHead.className = 'ag-skill-editor-artifact-head';
  artifactHead.append(
    Object.assign(document.createElement('span'), { textContent: 'SKILL.md' }),
    Object.assign(document.createElement('span'), { className: 'ag-skill-editor-artifact-badge', textContent: 'artifact' }),
  );
  const code = document.createElement('code');
  const pre = document.createElement('pre');
  pre.appendChild(code);
  artifact.append(artifactHead, pre);

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
  save.textContent = '스킬 저장';
  footer.append(status, cancel, save);
  root.append(intro, fields, bodyLabel, artifact, footer);

  let busy = false;
  let closed = false;
  let commitError = '';
  const sync = () => {
    const validName = /^[a-z0-9][a-z0-9-]*$/.test(name.value.trim());
    const validDescription = description.value.trim().length > 0;
    const validBody = textarea.value.trim().length > 0;
    save.disabled = busy || !validName || !validDescription || !validBody;
    cancel.disabled = busy;
    name.disabled = busy;
    description.disabled = busy;
    textarea.readOnly = busy;
    code.textContent = skillMarkdown(name.value.trim(), description.value.trim(), textarea.value);
    root.setAttribute('aria-busy', String(busy));
    if (!busy && commitError) status.textContent = commitError;
    else if (!busy && name.value.trim() && !validName) status.textContent = '이름은 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.';
    else if (!busy && validName && !validDescription) status.textContent = '스킬 설명을 입력하세요.';
    else if (!busy && validName && validDescription && !validBody) status.textContent = '스킬 지시문을 입력하세요.';
    else if (!busy) status.textContent = '';
  };
  const close = () => { if (!busy) { closed = true; options.close(); } };
  const commit = async () => {
    if (save.disabled) return;
    busy = true;
    status.textContent = '';
    save.textContent = '저장 중…';
    sync();
    try {
      const outcome = await options.commit(name.value.trim(), description.value.trim(), textarea.value);
      if (closed) return;
      if (!outcome.ok) {
        commitError = outcome.message;
        status.textContent = commitError;
        return;
      }
      closed = true;
      options.saved(outcome);
    } catch {
      commitError = '저장하지 못했습니다. 다시 시도해 주세요.';
      status.textContent = commitError;
    } finally {
      busy = false;
      save.textContent = '스킬 저장';
      sync();
    }
  };
  for (const input of [name, description, textarea]) input.addEventListener('input', () => {
    commitError = '';
    sync();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void commit();
    }
  });
  cancel.addEventListener('click', close);
  save.addEventListener('click', () => void commit());
  sync();
  requestAnimationFrame(() => name.focus());
  return { root };
}
