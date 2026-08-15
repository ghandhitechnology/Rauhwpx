export interface ImeInputEventData {
  inputType: string;
  data: string | null;
  isComposing: boolean;
  value: string;
}

export interface ImeCommit {
  generation: number;
  text: string;
}

function normalizeText(text: string) {
  return text.replace(/[\r\n]/g, '');
}

/**
 * 브라우저 IME 이벤트와 문서 커밋 사이의 세션 경계.
 *
 * 조합 중에는 preedit만 보관하고, finish()가 세션당 최대 한 번의 커밋을 만든다.
 * compositionend 뒤의 input은 이벤트 의미로 판별하며 시간 기반 억제를 사용하지 않는다.
 */
export class ImeSession {
  private generation = 0;
  private phase: 'idle' | 'composing' = 'idle';
  private preeditText = '';
  private cancelRequested = false;
  private pendingCommit: ImeCommit | null = null;

  get isComposing() {
    return this.phase === 'composing';
  }

  get preedit() {
    return this.preeditText;
  }

  start() {
    this.generation += 1;
    this.phase = 'composing';
    this.preeditText = '';
    this.cancelRequested = false;
    return this.generation;
  }

  update(text: string) {
    if (!this.isComposing) return '';
    this.preeditText = normalizeText(text);
    return this.preeditText;
  }

  cancel() {
    if (this.isComposing) this.cancelRequested = true;
  }

  finish(finalData: string | undefined, textareaValue: string) {
    if (!this.isComposing) return null;

    const normalizedValue = normalizeText(textareaValue);
    let text: string;
    if (this.cancelRequested) {
      text = '';
    } else if (finalData === undefined) {
      text = normalizedValue || this.preeditText;
    } else {
      const normalizedData = normalizeText(finalData);
      text = normalizedData || normalizedValue;
    }

    const commit = { generation: this.generation, text };
    this.phase = 'idle';
    this.preeditText = '';
    this.cancelRequested = false;
    this.pendingCommit = text ? commit : null;
    return commit;
  }

  /** compositionend 뒤 브라우저가 보내는 동일 커밋 input을 한 번만 소비한다. */
  consumeTrailingInput(input: ImeInputEventData) {
    const pending = this.pendingCommit;
    if (!pending) return false;

    const data = normalizeText(input.data ?? input.value);
    const compositionCommit = input.inputType === 'insertFromComposition'
      || (!input.isComposing && input.inputType === 'insertCompositionText');
    const genericCommit = !this.isComposing
      && !input.isComposing
      && (input.inputType === 'insertText' || input.inputType === '')
      && data === pending.text;

    if (compositionCommit) {
      // 늦게 온 이전 세션의 commit input도 일반 텍스트로 다시 삽입하지 않는다.
      // 현재 pending과 일치할 때만 그 토큰을 소비해 더 최신 세션의 guard를 보존한다.
      if (!data || data === pending.text) this.pendingCommit = null;
      return true;
    }
    if (genericCommit) {
      this.pendingCommit = null;
      return true;
    }

    // 다음 독립 입력이 확인되면 이전 커밋 후보는 더 이상 유효하지 않다.
    if (!input.isComposing && input.inputType !== 'deleteCompositionText') {
      this.pendingCommit = null;
    }
    return false;
  }

  clearPendingCommit() {
    this.pendingCommit = null;
  }

  reset() {
    this.phase = 'idle';
    this.preeditText = '';
    this.cancelRequested = false;
    this.pendingCommit = null;
  }
}
