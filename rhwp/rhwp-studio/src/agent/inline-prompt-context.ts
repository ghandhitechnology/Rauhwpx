/**
 * 인라인 프롬프트(문서에서 선택 → 그 자리에서 지시)의 순수 로직.
 * 선택 범위의 텍스트 추출과 에이전트에게 보낼 컨텍스트 블록 조립을 담당한다.
 * DOM/wasm 의존이 없어 node 테스트로 직접 검증한다 (tests/agent-inline-prompt.test.ts).
 */

/** 커서 좌표계의 선택 끝점 — charOffset 은 논리 오프셋(텍스트 + 인라인 컨트롤당 +1). */
export interface LogicalPoint {
  sectionIndex: number;
  paragraphIndex: number;
  charOffset: number;
}

/** 에이전트 툴 좌표계의 끝점 — charOffset 은 0-based 텍스트 오프셋. */
export interface SelPoint {
  sectionIdx: number;
  paraIdx: number;
  charOffset: number;
}

/** 텍스트 추출에 필요한 문서 접근 — 호출자가 wasm 을 주입한다. */
export interface SelectionTextProbe {
  paragraphCount(sectionIdx: number): number;
  /** 문단 텍스트 길이 (getTextRange 의 count 와 같은 좌표계) */
  paragraphLength(sectionIdx: number, paraIdx: number): number;
  text(sectionIdx: number, paraIdx: number, startTextOffset: number, count: number): string;
  /** 논리 오프셋 → 텍스트 오프셋. 변환 불가 시 원값을 돌려줘도 된다. */
  toTextOffset(sectionIdx: number, paraIdx: number, logicalOffset: number): number;
}

export interface ExtractedSelection {
  start: SelPoint;
  end: SelPoint;
  text: string;
  truncated: boolean;
}

/** 에이전트에게 보내는 선택 텍스트 상한 — 컨텍스트 낭비를 막는다. */
export const SELECTION_TEXT_MAX_CHARS = 4000;
/** 채팅 말풍선에 표시하는 발췌 상한. */
export const EXCERPT_MAX_SCALARS = 80;

/** 인라인 프롬프트 한 건에 붙는 선택 컨텍스트. */
export interface InlinePromptSelection {
  /** 말풍선에 표시할 짧은 위치 라벨 (사람 기준 1-based) */
  label: string;
  /** 말풍선에 표시할 한 줄 발췌 */
  excerpt: string;
  /** 에이전트에게 보내는 전체 컨텍스트 블록 */
  contextBlock: string;
}

export interface InlinePromptSubmission {
  prompt: string;
  selection: InlinePromptSelection;
}

export type InlinePromptSendResult = { ok: true } | { ok: false; reason: string };

/**
 * 본문 선택 범위(논리 오프셋)의 텍스트를 문단 단위로 추출한다.
 * 문단 사이는 '\n' 으로 잇고, maxChars 를 넘으면 잘라낸다.
 */
export function extractSelectionText(
  start: LogicalPoint,
  end: LogicalPoint,
  probe: SelectionTextProbe,
  maxChars: number = SELECTION_TEXT_MAX_CHARS,
): ExtractedSelection {
  const startText = probe.toTextOffset(start.sectionIndex, start.paragraphIndex, start.charOffset);
  const endText = probe.toTextOffset(end.sectionIndex, end.paragraphIndex, end.charOffset);
  const parts: string[] = [];
  let total = 0;
  let truncated = false;

  outer: for (let sec = start.sectionIndex; sec <= end.sectionIndex; sec++) {
    const firstPara = sec === start.sectionIndex ? start.paragraphIndex : 0;
    const lastPara = sec === end.sectionIndex
      ? end.paragraphIndex
      : probe.paragraphCount(sec) - 1;
    for (let para = firstPara; para <= lastPara; para++) {
      const from = sec === start.sectionIndex && para === start.paragraphIndex ? startText : 0;
      const to = sec === end.sectionIndex && para === end.paragraphIndex
        ? endText
        : probe.paragraphLength(sec, para);
      let count = Math.max(0, to - from);
      if (total + count > maxChars) {
        count = Math.max(0, maxChars - total);
        truncated = true;
      }
      parts.push(count > 0 ? probe.text(sec, para, from, count) : '');
      total += count;
      if (truncated) break outer;
    }
  }

  return {
    start: { sectionIdx: start.sectionIndex, paraIdx: start.paragraphIndex, charOffset: startText },
    end: { sectionIdx: end.sectionIndex, paraIdx: end.paragraphIndex, charOffset: endText },
    text: parts.join('\n'),
    truncated,
  };
}

/** 공백·줄바꿈을 접어 한 줄 발췌를 만든다. */
export function selectionExcerpt(text: string, maxScalars: number = EXCERPT_MAX_SCALARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const scalars = [...collapsed];
  return scalars.length > maxScalars ? scalars.slice(0, maxScalars - 1).join('') + '…' : collapsed;
}

/** 말풍선용 위치 라벨 — 사람이 읽는 값이라 1-based 로 표기한다. */
export function selectionLabel(start: SelPoint, end: SelPoint): string {
  if (start.sectionIdx === end.sectionIdx) {
    return start.paraIdx === end.paraIdx
      ? `문단 ${start.paraIdx + 1}`
      : `문단 ${start.paraIdx + 1}–${end.paraIdx + 1}`;
  }
  return `구역 ${start.sectionIdx + 1} 문단 ${start.paraIdx + 1} – 구역 ${end.sectionIdx + 1} 문단 ${end.paraIdx + 1}`;
}

/** 추출 결과를 채팅 표시용 메타와 에이전트용 컨텍스트 블록으로 조립한다. */
export function buildInlineSelection(extracted: ExtractedSelection): InlinePromptSelection {
  const { start, end } = extracted;
  const lines = [
    '[선택 컨텍스트]',
    '사용자가 편집기에서 아래 범위를 선택한 채 이 요청을 보냈다.',
    `- 범위: sectionIdx ${start.sectionIdx} paraIdx ${start.paraIdx} charOffset ${start.charOffset}`
      + ` → sectionIdx ${end.sectionIdx} paraIdx ${end.paraIdx} charOffset ${end.charOffset}`,
    '- 오프셋은 0-based 텍스트 오프셋 (get_text_range/replace_text 와 같은 좌표계)',
    `- 선택 텍스트${extracted.truncated ? ' (길어서 앞부분만 표시)' : ''}:`,
    '<<<SELECTION',
    extracted.text,
    'SELECTION>>>',
    '',
    '아래 지시는 위 선택 범위를 대상으로 한다.',
  ];
  return {
    label: selectionLabel(start, end),
    excerpt: selectionExcerpt(extracted.text),
    contextBlock: lines.join('\n'),
  };
}
