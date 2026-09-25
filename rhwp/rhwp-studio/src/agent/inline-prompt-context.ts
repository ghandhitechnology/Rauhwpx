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

export interface CellSelectionTextProbe {
  paragraphLength(paraIdx: number): number;
  text(paraIdx: number, startTextOffset: number, count: number): string;
  toTextOffset(paraIdx: number, logicalOffset: number): number;
}

/** 에이전트에게 보내는 선택 텍스트 상한 — 컨텍스트 낭비를 막는다. */
export const SELECTION_TEXT_MAX_CHARS = 4000;
/** 채팅 말풍선에 표시하는 발췌 상한. */
export const EXCERPT_MAX_SCALARS = 80;

/** 셀 선택(캐럿 논리 오프셋)의 텍스트를 텍스트 오프셋으로 변환해 추출한다. */
export function extractCellSelectionText(
  firstPara: number,
  lastPara: number,
  startLogicalOffset: number,
  endLogicalOffset: number,
  probe: CellSelectionTextProbe,
  maxChars = SELECTION_TEXT_MAX_CHARS,
): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let remaining = maxChars;
  let truncated = false;
  for (let para = firstPara; para <= lastPara && remaining > 0; para++) {
    const length = probe.paragraphLength(para);
    const from = para === firstPara ? probe.toTextOffset(para, startLogicalOffset) : 0;
    const to = para === lastPara
      ? Math.min(probe.toTextOffset(para, endLogicalOffset), length)
      : length;
    const count = Math.min(Math.max(0, to - from), remaining);
    parts.push(probe.text(para, from, count));
    remaining -= count;
    if (from + count < to) truncated = true;
  }
  if (lastPara > firstPara && remaining === 0) truncated = true;
  return { text: parts.join('\n'), truncated };
}

/** 인라인 프롬프트 한 건에 붙는 선택 컨텍스트. */
export interface InlinePromptSelection {
  /** 말풍선에 표시할 짧은 위치 라벨 (사람 기준 1-based) */
  label: string;
  /** 말풍선에 표시할 한 줄 발췌 */
  excerpt: string;
  /** 에이전트에게 보내는 전체 컨텍스트 블록 */
  contextBlock: string;
  /** 선택한 문서 요소의 구조화된 요약. */
  items: InlinePromptItem[];
  /** 이미지·도형 선택을 실제 시각 자료로 전달할 PNG 첨부. */
  attachments?: File[];
  /** 캡처 뒤 문서가 바뀌면 오래된 주소로 보내지 않기 위한 스냅샷. */
  documentId?: string | null;
  revision?: number;
}

export interface InlineObjectAddress {
  sectionIdx: number;
  paraIdx: number;
  controlIdx: number;
  cellPath?: unknown[];
  cellIdx?: number;
  cellParaIdx?: number;
  endCellParaIdx?: number;
  innerControlIdx?: number;
  logicalOffset?: number;
}

export type InlinePromptItem =
  | {
      kind: 'text';
      selection: ExtractedSelection;
      address?: InlineObjectAddress;
      offsetConvention?: 'text' | 'logical';
    }
  | {
      kind: 'table';
      address: InlineObjectAddress;
      rowCount: number;
      colCount: number;
      cells: Array<{ row: number; col: number; rowSpan: number; colSpan: number; text: string }>;
      selectedRange?: { startRow: number; startCol: number; endRow: number; endCol: number };
      formatting?: Record<string, unknown>;
      truncated: boolean;
    }
  | {
      kind: 'equation';
      address: InlineObjectAddress;
      script: string;
      fontName?: string;
      fontSize?: number;
      description?: string;
      attachmentName?: string;
    }
  | {
      kind: 'object';
      objectType: string;
      address: InlineObjectAddress;
      description?: string;
      width?: number;
      height?: number;
      details?: Record<string, unknown>;
      attachmentName?: string;
    };

export interface InlinePromptSubmission {
  prompt: string;
  selection: InlinePromptSelection;
  /** Escape/dispose can cancel attachment staging before transport starts. */
  signal?: AbortSignal;
}

export type InlinePromptSendResult = { ok: true } | { ok: false; reason: string };
export type InlinePromptSendResponse = InlinePromptSendResult | Promise<InlinePromptSendResult>;

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
    '- 오프셋은 0-based 텍스트 오프셋 (get_text_range/replace_range 와 같은 좌표계)',
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
    items: [{ kind: 'text', selection: extracted }],
  };
}

function addressLine(address: InlineObjectAddress): string {
  const parts = [
    `sectionIdx ${address.sectionIdx}`,
    `paraIdx ${address.paraIdx}`,
    `controlIdx ${address.controlIdx}`,
  ];
  if (address.cellPath?.length) parts.push(`cellPath ${JSON.stringify(address.cellPath)}`);
  if (address.cellIdx !== undefined) parts.push(`cellIdx ${address.cellIdx}`);
  if (address.cellParaIdx !== undefined) parts.push(`cellParaIdx ${address.cellParaIdx}`);
  if (address.endCellParaIdx !== undefined) parts.push(`endCellParaIdx ${address.endCellParaIdx}`);
  if (address.innerControlIdx !== undefined) parts.push(`innerControlIdx ${address.innerControlIdx}`);
  if (address.logicalOffset !== undefined) parts.push(`logicalOffset ${address.logicalOffset}`);
  return parts.join(' ');
}

/** 셀 텍스트 선택을 replace_range 등 셀 쓰기 도구에 그대로 넘길 인자로 적는다. */
function cellToolArgs(address: InlineObjectAddress, start: SelPoint, end: SelPoint): string {
  const args: Record<string, unknown> = {
    sectionIdx: address.sectionIdx,
    cell: { paraIdx: address.paraIdx, controlIdx: address.controlIdx, cellIdx: address.cellIdx },
  };
  // 중첩 셀은 cell(최외곽)과 cellPath(최내곽까지)를 함께 넘겨야 한다.
  if ((address.cellPath?.length ?? 0) > 1) args['cellPath'] = address.cellPath;
  args['startParaIdx'] = start.paraIdx;
  args['startCharOffset'] = start.charOffset;
  args['endParaIdx'] = end.paraIdx;
  args['endCharOffset'] = end.charOffset;
  return JSON.stringify(args);
}

function itemLines(item: InlinePromptItem, index: number): string[] {
  if (item.kind === 'text') {
    const { start, end } = item.selection;
    return [
      `## ${index}. 텍스트`,
      ...(item.address ? [`- 컨테이너 주소: ${addressLine(item.address)}`] : []),
      `- 범위: paraIdx ${start.paraIdx} charOffset ${start.charOffset} → paraIdx ${end.paraIdx} charOffset ${end.charOffset}`,
      ...(item.address?.cellIdx !== undefined ? [`- 도구 인자: ${cellToolArgs(item.address, start, end)}`] : []),
      `- 오프셋 좌표계: ${item.offsetConvention ?? 'text'}`,
      `- 선택 텍스트${item.selection.truncated ? ' (길어서 앞부분만 표시)' : ''}:`,
      '<<<SELECTION',
      item.selection.text,
      'SELECTION>>>',
    ];
  }
  if (item.kind === 'table') {
    const range = item.selectedRange
      ? `\n- 선택 셀: row ${item.selectedRange.startRow}..${item.selectedRange.endRow}, col ${item.selectedRange.startCol}..${item.selectedRange.endCol}`
      : '';
    const cells = item.cells.map((cell) =>
      `- cell row ${cell.row} col ${cell.col} rowSpan ${cell.rowSpan} colSpan ${cell.colSpan}: ${JSON.stringify(cell.text)}`
    );
    return [
      `## ${index}. 표`,
      `- 주소: ${addressLine(item.address)}`,
      `- 크기: ${item.rowCount}행 × ${item.colCount}열${range}`,
      `- 셀 내용${item.truncated ? ' (길어서 일부만 표시)' : ''}:`,
      ...(item.formatting ? [`- 표 서식: ${JSON.stringify(item.formatting)}`] : []),
      ...cells,
    ];
  }
  if (item.kind === 'equation') {
    return [
      `## ${index}. 수식`,
      `- 주소: ${addressLine(item.address)}`,
      `- 스크립트: ${JSON.stringify(item.script)}`,
      ...(item.fontName ? [`- 글꼴: ${item.fontName}`] : []),
      ...(item.fontSize !== undefined ? [`- 글자 크기: ${item.fontSize}`] : []),
      ...(item.description ? [`- 설명: ${item.description}`] : []),
      ...(item.attachmentName ? [`- 렌더링 미리보기: 첨부 파일 ${item.attachmentName}`] : []),
    ];
  }
  return [
    `## ${index}. ${item.objectType} 개체`,
    `- 주소: ${addressLine(item.address)}`,
    ...(item.description ? [`- 설명: ${item.description}`] : []),
    ...(item.width !== undefined && item.height !== undefined
      ? [`- 크기: ${item.width} × ${item.height}`]
      : []),
    ...(item.details ? [`- 표시 정보: ${JSON.stringify(item.details)}`] : []),
    ...(item.attachmentName ? [`- 시각 자료: 첨부 파일 ${item.attachmentName}`] : []),
  ];
}

/** 텍스트, 표, 수식, 이미지가 섞인 선택을 하나의 편집 컨텍스트로 조립한다. */
export function buildInlineElementSelection(
  items: InlinePromptItem[],
  attachments: File[] = [],
): InlinePromptSelection {
  const kindLabel = (kind: string): string => ({
    text: '텍스트', table: '표', equation: '수식', image: '이미지',
    shape: '도형', group: '묶음', line: '선', ole: 'OLE',
  })[kind] ?? kind;
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = item.kind === 'object' ? item.objectType : item.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = [...counts].map(([kind, count]) => `${kindLabel(kind)} ${count}개`);
  const excerptParts = items.map((item) => {
    if (item.kind === 'text') return selectionExcerpt(item.selection.text, 36);
    if (item.kind === 'equation') return selectionExcerpt(item.script, 36);
    if (item.kind === 'table') return `${item.rowCount}×${item.colCount} 표`;
    return item.description || item.objectType;
  }).filter(Boolean);
  const context = [
    '[선택 컨텍스트]',
    '사용자가 편집기에서 아래 문서 요소를 선택한 채 이 요청을 보냈다.',
    '주소 값은 0-based이며 에이전트 문서 도구의 좌표계와 같다.',
    '',
    ...items.flatMap((item, index) => [...itemLines(item, index + 1), '']),
    '아래 지시는 위 선택 요소를 대상으로 한다.',
  ];
  return {
    label: labels.join(' · '),
    excerpt: selectionExcerpt(excerptParts.join(' · ')),
    contextBlock: context.join('\n'),
    items,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

export function bindInlineSelectionIdentity(
  selection: InlinePromptSelection,
  identity: { documentId: string | null; revision: number },
): InlinePromptSelection {
  const identityLine = `- 캡처 문서: ${identity.documentId ?? '(임시 문서)'}, revision ${identity.revision}`;
  const lines = selection.contextBlock.split('\n');
  lines.splice(1, 0, identityLine);
  return { ...selection, ...identity, contextBlock: lines.join('\n') };
}
