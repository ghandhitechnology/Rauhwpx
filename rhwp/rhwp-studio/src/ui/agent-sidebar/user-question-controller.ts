import type {
  UserQuestionAnswer,
  UserQuestionInteraction,
  UserQuestionOutcome,
} from '../../agent/types.ts';

export interface UserQuestionDraftState {
  selectedOptionIdsByQuestionId: Record<string, string[]>;
  otherTextByQuestionId: Record<string, string>;
  activeQuestionIndex: number;
}

interface UserQuestionControllerOptions {
  input: HTMLTextAreaElement;
  submitAnswers(interactionId: string, answers: Record<string, UserQuestionAnswer>): string;
  stop(): void;
  onDraftChange(interaction: UserQuestionInteraction, draft: UserQuestionDraftState): void;
  onComposerModeChange(active: boolean, usesOther: boolean): void;
  onResolved(interaction: UserQuestionInteraction, outcome: UserQuestionOutcome, draft: UserQuestionDraftState): void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable], [role="textbox"]'));
}

function cloneDraft(draft: UserQuestionDraftState): UserQuestionDraftState {
  return {
    selectedOptionIdsByQuestionId: Object.fromEntries(
      Object.entries(draft.selectedOptionIdsByQuestionId).map(([id, selected]) => [id, [...selected]]),
    ),
    otherTextByQuestionId: { ...draft.otherTextByQuestionId },
    activeQuestionIndex: draft.activeQuestionIndex,
  };
}

export function createUserQuestionController(options: UserQuestionControllerOptions) {
  const root = element('section', 'ag-user-question');
  root.dataset.inactive = 'true';
  root.setAttribute('aria-label', '에이전트 질문');
  const live = element('div', 'ag-sr-only');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  root.appendChild(live);

  let interaction: UserQuestionInteraction | null = null;
  let draft: UserQuestionDraftState = {
    selectedOptionIdsByQuestionId: {},
    otherTextByQuestionId: {},
    activeQuestionIndex: 0,
  };
  let collapsed = false;
  let submitting = false;
  let responseId: string | null = null;
  let errorMessage = '';
  let autoAdvanceTimer: number | null = null;
  let composerOtherQuestionId: string | null = null;
  let visible = true;
  const bodyId = `ag-user-question-body-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

  function announce(message: string): void {
    live.textContent = '';
    queueMicrotask(() => { live.textContent = message; });
  }

  function currentQuestion() {
    return interaction?.questions[draft.activeQuestionIndex] ?? null;
  }

  function persistDraft(): void {
    if (interaction) options.onDraftChange(interaction, cloneDraft(draft));
  }

  function saveComposerOther(): void {
    if (!composerOtherQuestionId) return;
    draft.otherTextByQuestionId[composerOtherQuestionId] = options.input.value.slice(0, 2_000);
    persistDraft();
  }

  function setComposerOther(questionId: string | null, focus = false): void {
    if (composerOtherQuestionId === questionId) {
      if (focus) options.input.focus();
      return;
    }
    saveComposerOther();
    composerOtherQuestionId = questionId;
    if (questionId) {
      options.input.value = draft.otherTextByQuestionId[questionId] ?? '';
      options.input.maxLength = 2_000;
      options.input.placeholder = '직접 답변을 입력하세요';
      options.input.setAttribute('aria-label', '현재 질문의 직접 답변');
    } else {
      options.input.value = '';
      options.input.removeAttribute('maxlength');
      options.input.setAttribute('aria-label', '에이전트 메시지 입력');
    }
    options.input.dispatchEvent(new Event('input'));
    options.onComposerModeChange(Boolean(interaction), Boolean(questionId));
    if (focus && questionId) queueMicrotask(() => options.input.focus());
  }

  function selected(questionId: string): string[] {
    return draft.selectedOptionIdsByQuestionId[questionId] ?? [];
  }

  function otherSelected(questionId: string): boolean {
    return Object.prototype.hasOwnProperty.call(draft.otherTextByQuestionId, questionId);
  }

  function isAnswered(questionIndex: number): boolean {
    const question = interaction?.questions[questionIndex];
    if (!question) return false;
    return selected(question.id).length > 0 || Boolean((draft.otherTextByQuestionId[question.id] ?? '').trim());
  }

  function allAnswered(): boolean {
    return Boolean(interaction?.questions.every((_, index) => isAnswered(index)));
  }

  function selectOption(optionId: string): void {
    const question = currentQuestion();
    if (!question || submitting) return;
    setComposerOther(null);
    const before = selected(question.id);
    draft.selectedOptionIdsByQuestionId[question.id] = question.mode === 'single'
      ? [optionId]
      : before.includes(optionId)
        ? before.filter((id) => id !== optionId)
        : [...before, optionId];
    if (question.mode === 'single') delete draft.otherTextByQuestionId[question.id];
    errorMessage = '';
    persistDraft();
    render();
    if (question.mode === 'single' && draft.activeQuestionIndex < interaction!.questions.length - 1) {
      if (autoAdvanceTimer !== null) window.clearTimeout(autoAdvanceTimer);
      const delay = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
      autoAdvanceTimer = window.setTimeout(() => {
        autoAdvanceTimer = null;
        navigate(draft.activeQuestionIndex + 1);
      }, delay);
    }
  }

  function selectOther(): void {
    const question = currentQuestion();
    if (!question?.allowOther || submitting) return;
    if (question.mode === 'single') draft.selectedOptionIdsByQuestionId[question.id] = [];
    if (!otherSelected(question.id)) draft.otherTextByQuestionId[question.id] = '';
    persistDraft();
    setComposerOther(question.id, true);
    render();
  }

  function navigate(index: number): void {
    if (!interaction || submitting) return;
    saveComposerOther();
    draft.activeQuestionIndex = Math.max(0, Math.min(interaction.questions.length - 1, index));
    const question = currentQuestion();
    setComposerOther(question && otherSelected(question.id) ? question.id : null);
    persistDraft();
    errorMessage = '';
    render();
    announce(`질문 ${draft.activeQuestionIndex + 1} / ${interaction.questions.length}`);
    root.querySelector<HTMLElement>('.ag-question-prompt')?.focus({ preventScroll: true });
  }

  function buildAnswers(): Record<string, UserQuestionAnswer> | null {
    if (!interaction) return null;
    saveComposerOther();
    if (!allAnswered()) {
      errorMessage = '모든 질문에 답해 주세요.';
      render();
      announce(errorMessage);
      return null;
    }
    return Object.fromEntries(interaction.questions.map((question) => [question.id, {
      selectedOptionIds: [...selected(question.id)],
      ...((draft.otherTextByQuestionId[question.id] ?? '').trim()
        ? { otherText: draft.otherTextByQuestionId[question.id]!.trim() }
        : {}),
    }]));
  }

  function submit(): void {
    if (!interaction || submitting) return;
    const answers = buildAnswers();
    if (!answers) return;
    submitting = true;
    errorMessage = '';
    responseId = options.submitAnswers(interaction.interactionId, answers);
    render();
    announce('답변을 제출하는 중입니다.');
    options.onComposerModeChange(true, Boolean(composerOtherQuestionId));
  }

  function render(): void {
    const savedLive = live;
    root.replaceChildren(savedLive);
    if (!interaction) {
      root.dataset.inactive = 'true';
      return;
    }
    root.dataset.inactive = visible ? 'false' : 'true';
    if (!visible) return;
    root.classList.toggle('ag-collapsed', collapsed);
    const question = currentQuestion()!;
    const disclosure = element('button', 'ag-question-disclosure');
    disclosure.type = 'button';
    disclosure.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    disclosure.setAttribute('aria-controls', bodyId);
    disclosure.append(
      element('span', 'ag-question-disclosure-label', collapsed ? question.question : '에이전트 질문'),
      element('span', 'ag-question-count', `${draft.activeQuestionIndex + 1} / ${interaction.questions.length}`),
    );
    disclosure.addEventListener('click', () => {
      collapsed = !collapsed;
      render();
      announce(collapsed ? '질문을 접었습니다.' : '질문을 펼쳤습니다.');
    });
    root.appendChild(disclosure);
    if (collapsed) return;

    const body = element('div', 'ag-question-body');
    body.id = bodyId;
    const heading = element('div', 'ag-question-heading');
    heading.append(
      element('span', 'ag-question-header', question.header),
      element('span', 'ag-question-mode', question.mode === 'multiple' ? '복수 선택' : '하나 선택'),
    );
    const prompt = element('h3', 'ag-question-prompt', question.question);
    prompt.tabIndex = -1;
    const optionsGroup = element('div', 'ag-question-options');
    optionsGroup.setAttribute('role', question.mode === 'multiple' ? 'group' : 'radiogroup');
    optionsGroup.setAttribute('aria-label', question.question);
    question.options.forEach((option, index) => {
      const active = selected(question.id).includes(option.id);
      const button = element('button', 'ag-question-option');
      button.type = 'button';
      button.disabled = submitting;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.dataset.selected = active ? 'true' : 'false';
      button.append(
        element('span', 'ag-question-option-number', String(index + 1)),
        element('span', 'ag-question-option-copy'),
      );
      const copy = button.lastElementChild!;
      copy.append(
        element('strong', 'ag-question-option-label', option.label),
        element('span', 'ag-question-option-description', option.description),
      );
      button.addEventListener('click', () => selectOption(option.id));
      optionsGroup.appendChild(button);
    });
    if (question.allowOther) {
      const active = otherSelected(question.id);
      const other = element('button', 'ag-question-option ag-question-other');
      other.type = 'button';
      other.disabled = submitting;
      other.setAttribute('aria-pressed', active ? 'true' : 'false');
      other.dataset.selected = active ? 'true' : 'false';
      other.append(
        element('span', 'ag-question-option-number', String(question.options.length + 1)),
        element('span', 'ag-question-option-copy'),
      );
      other.lastElementChild!.append(
        element('strong', 'ag-question-option-label', '직접 입력'),
        element('span', 'ag-question-option-description', active && draft.otherTextByQuestionId[question.id]
          ? draft.otherTextByQuestionId[question.id]!
          : '입력창에 원하는 답을 직접 적습니다.'),
      );
      other.addEventListener('click', selectOther);
      optionsGroup.appendChild(other);
    }
    body.append(heading, prompt, optionsGroup);
    if (errorMessage) {
      const error = element('div', 'ag-question-error', errorMessage);
      error.setAttribute('role', 'alert');
      body.appendChild(error);
    }
    const actions = element('div', 'ag-question-actions');
    const stop = element('button', 'ag-question-stop', '중지');
    stop.type = 'button';
    stop.addEventListener('click', options.stop);
    const navigation = element('div', 'ag-question-navigation');
    const back = element('button', 'ag-question-back', '이전');
    back.type = 'button';
    back.disabled = submitting || draft.activeQuestionIndex === 0;
    back.addEventListener('click', () => navigate(draft.activeQuestionIndex - 1));
    navigation.appendChild(back);
    const final = draft.activeQuestionIndex === interaction.questions.length - 1;
    const next = element('button', 'ag-question-next', submitting ? '제출 중…' : final ? '제출' : '다음');
    next.type = 'button';
    next.disabled = submitting || (final ? !allAnswered() : !isAnswered(draft.activeQuestionIndex));
    next.addEventListener('click', () => final ? submit() : navigate(draft.activeQuestionIndex + 1));
    navigation.appendChild(next);
    actions.append(stop, navigation);
    root.append(body, actions);
  }

  function request(next: UserQuestionInteraction, restored?: Partial<UserQuestionDraftState>): void {
    if (interaction?.interactionId === next.interactionId
      && JSON.stringify(interaction) === JSON.stringify(next)) return;
    if (autoAdvanceTimer !== null) {
      window.clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
    // Commit the old interaction's composer text before swapping canonical
    // payloads. Clearing after assignment can leak text when question ids repeat.
    setComposerOther(null);
    interaction = next;
    draft = {
      selectedOptionIdsByQuestionId: structuredClone(restored?.selectedOptionIdsByQuestionId ?? {}),
      otherTextByQuestionId: { ...(restored?.otherTextByQuestionId ?? {}) },
      activeQuestionIndex: Math.max(0, Math.min(next.questions.length - 1, restored?.activeQuestionIndex ?? 0)),
    };
    collapsed = false;
    submitting = false;
    responseId = null;
    errorMessage = '';
    const question = currentQuestion();
    setComposerOther(question && otherSelected(question.id) ? question.id : null);
    options.onComposerModeChange(true, Boolean(composerOtherQuestionId));
    render();
    announce(`에이전트가 질문했습니다. 질문 1 / ${next.questions.length}`);
    queueMicrotask(() => root.querySelector<HTMLElement>('.ag-question-prompt')?.focus({ preventScroll: true }));
  }

  function answerResult(result: { responseId: string; ok: boolean; message?: string }): void {
    if (!interaction || responseId !== result.responseId) return;
    if (result.ok) return;
    submitting = false;
    responseId = null;
    errorMessage = result.message || '답변을 제출하지 못했습니다. 다시 시도해 주세요.';
    render();
    options.onComposerModeChange(true, Boolean(composerOtherQuestionId));
    announce(errorMessage);
    queueMicrotask(() => {
      if (composerOtherQuestionId) options.input.focus();
      else root.querySelector<HTMLButtonElement>('.ag-question-next')?.focus({ preventScroll: true });
    });
  }

  function resolve(interactionId: string, outcome: UserQuestionOutcome): void {
    if (!interaction || interaction.interactionId !== interactionId) return;
    saveComposerOther();
    const settledInteraction = interaction;
    const settledDraft = cloneDraft(draft);
    interaction = null;
    submitting = false;
    responseId = null;
    errorMessage = '';
    setComposerOther(null);
    render();
    options.onComposerModeChange(false, false);
    options.onResolved(settledInteraction, outcome, settledDraft);
    announce(outcome.status === 'answered'
      ? '답변을 제출했습니다.'
      : outcome.status === 'cancelled'
        ? '질문을 취소했습니다.'
        : '질문 요청이 만료되었습니다.');
  }

  function handleComposerInput(): void {
    if (!interaction || !composerOtherQuestionId) return;
    draft.otherTextByQuestionId[composerOtherQuestionId] = options.input.value.slice(0, 2_000);
    persistDraft();
    render();
  }

  function handleComposerSubmit(): boolean {
    if (!interaction || !composerOtherQuestionId) return false;
    saveComposerOther();
    const final = draft.activeQuestionIndex === interaction.questions.length - 1;
    if (final) submit();
    else if (isAnswered(draft.activeQuestionIndex)) navigate(draft.activeQuestionIndex + 1);
    return true;
  }

  function handleNumberKey(event: KeyboardEvent): void {
    if (!interaction || !visible || collapsed || submitting || isEditable(event.target)) return;
    const digit = Number(event.key);
    if (!Number.isInteger(digit) || digit < 1 || digit > 9) return;
    const question = currentQuestion();
    if (!question) return;
    if (digit <= question.options.length) {
      event.preventDefault();
      selectOption(question.options[digit - 1]!.id);
    } else if (digit === question.options.length + 1 && question.allowOther) {
      event.preventDefault();
      selectOther();
    }
  }

  document.addEventListener('keydown', handleNumberKey);

  return {
    root,
    hasPending: () => interaction !== null,
    usesComposerForOther: () => composerOtherQuestionId !== null,
    request,
    answerResult,
    resolve,
    handleComposerInput,
    handleComposerSubmit,
    draft: () => cloneDraft(draft),
    interaction: () => interaction,
    setVisible(next: boolean) {
      visible = next;
      render();
      options.onComposerModeChange(Boolean(interaction) && visible, Boolean(composerOtherQuestionId) && visible);
    },
    dispose() {
      if (autoAdvanceTimer !== null) window.clearTimeout(autoAdvanceTimer);
      document.removeEventListener('keydown', handleNumberKey);
      setComposerOther(null);
      root.remove();
    },
  };
}
