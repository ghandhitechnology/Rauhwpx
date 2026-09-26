/**
 * 사이드바 도구 행 표시 — 도구 이름·인자·결과를 사람이 읽는 짧은 문구로 바꾼다.
 *
 * DOM 없이 순수 함수만 둔다. tool-row.ts 가 그리고, 단위 테스트가 직접 부른다.
 * 좌표는 도구 계약대로 0 기반으로 받아 사람에게는 1 기반(“3문단”, “2쪽”)으로 보인다.
 * 모르는 도구나 rhwp 밖의 도구는 원래 이름과 대표 인자 하나로 떨어진다.
 */

export type ToolCategory = 'edit' | 'read' | 'check' | 'other';

export interface ToolItemView {
  label: string;
  summary: string;
}

export interface ToolCallView {
  /** 접두어(mcp__rhwp__ 등)를 뗀 이름 */
  name: string;
  /** 표시 규칙이 있는 도구인가 — 아니면 label 이 원래 이름이다 */
  known: boolean;
  category: ToolCategory;
  label: string;
  summary: string;
  /** apply_edits / read_batch 의 항목별 표시 */
  items: ToolItemView[];
}

export interface ToolItemOutcome {
  ok: boolean;
  text: string;
}

/** 결과 한 줄과 펼친 본문에 들어갈 내용. 스레드 기록에도 이 모양 그대로 저장된다. */
export interface ToolOutcomeView {
  ok: boolean;
  /** 한 줄 결과 — 없으면 빈 문자열 */
  text: string;
  /** 오류 원문 (도구가 돌려준 메시지) */
  detail?: string;
  /** 경고와 빠진 편집 같은 알림 */
  notices: string[];
  /** apply_edits / read_batch 항목별 결과 (인자 순서와 같다) */
  items?: ToolItemOutcome[];
  /** 결과 그림 (data URL) — render:'crop', render_page, verify_changes 이미지 */
  image?: string;
  /** 결과로 더 정확해진 동작 이름 (예: edit_object 가 그림이었을 때 “그림 이동”) */
  label?: string;
}

type Args = Record<string, unknown>;

interface ToolSpec {
  category: ToolCategory;
  label: string | ((a: Args) => string);
  summary?: (a: Args) => string;
}

// ─── 작은 표시 도우미 ─────────────────────────────────

function rec(value: unknown): Args {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 인용 — 따옴표 안 텍스트는 짧게 자른다. */
export function quote(text: string, max = 24): string {
  const flat = clip(text, max);
  return flat ? `“${flat}”` : '';
}

function join(parts: Array<string | null | undefined | false>, sep = ' · '): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(sep);
}

/** 비지 않은 앞의 n 개만 잇는다. */
function firstParts(parts: string[], n: number): string {
  return join(parts.filter(Boolean).slice(0, n));
}

function mm(value: unknown): string {
  const n = num(value);
  return n === null ? '' : `${Math.round(n * 10) / 10}`;
}

function inCell(a: Args): boolean {
  return a['cell'] !== undefined && a['cell'] !== null
    || (Array.isArray(a['cellPath']) && a['cellPath'].length > 0);
}

/** “3문단”, 다른 구역이면 “2구역 3문단”, 셀 안이면 “표 안 3문단”. */
function para(a: Args, key = 'paraIdx'): string {
  const p = num(a[key]);
  if (p === null) return '';
  const section = num(a['sectionIdx']);
  return join([
    section !== null && section > 0 ? `${section + 1}구역` : '',
    inCell(a) ? '표 안' : '',
    `${p + 1}문단`,
  ], ' ');
}

function paraRange(a: Args, startKey: string, endKey: string): string {
  const start = num(a[startKey]);
  const end = num(a[endKey]);
  if (start === null) return '';
  if (end === null || end === start) return para({ ...a, paraIdx: start });
  const section = num(a['sectionIdx']);
  return join([
    section !== null && section > 0 ? `${section + 1}구역` : '',
    inCell(a) ? '표 안' : '',
    `${start + 1}–${end + 1}문단`,
  ], ' ');
}

/** 앵커 표시 — 대상 텍스트와 (삽입이면) 앞/뒤. */
function anchorText(a: Args, withPosition: boolean): string {
  const anchor = rec(a['anchor']);
  const text = str(anchor['text']);
  if (!text) return '';
  const occurrence = num(anchor['occurrence']);
  const position = str(anchor['position']);
  const where = withPosition
    ? position === 'before' ? ' 앞' : position === 'replace' ? ' 자리' : ' 뒤'
    : '';
  return `${quote(text)}${where}${occurrence !== null && occurrence > 1 ? ` (${occurrence}번째)` : ''}`;
}

/** 편집 위치 — 앵커가 있으면 앵커, 아니면 문단 번호. */
function target(a: Args, withPosition = false): string {
  return anchorText(a, withPosition) || para(a);
}

function table(a: Args): string {
  const p = num(a['paraIdx']);
  if (p === null) return '';
  const section = num(a['sectionIdx']);
  return `${section !== null && section > 0 ? `${section + 1}구역 ` : ''}${p + 1}문단 표`;
}

function page(a: Args, key = 'pageIndex'): string {
  const p = num(a[key]);
  return p === null ? '' : `${p + 1}쪽`;
}

function cellAt(row: unknown, col: unknown): string {
  const r = num(row);
  const c = num(col);
  return r === null || c === null ? '' : `(${r + 1},${c + 1})`;
}

const ALIGN: Record<string, string> = {
  left: '왼쪽 정렬', right: '오른쪽 정렬', center: '가운데 정렬',
  justify: '양쪽 정렬', distribute: '배분 정렬', split: '나눔 정렬',
};

function charProps(a: Args): string {
  const flag = (key: string, on: string) => a[key] === true ? on : a[key] === false ? `${on} 해제` : '';
  const size = num(a['fontSizePt']);
  const width = num(a['widthPercent']);
  const spacing = num(a['letterSpacingPercent']);
  return firstParts([
    flag('bold', '굵게'),
    flag('italic', '기울임'),
    flag('underline', '밑줄'),
    flag('strikethrough', '취소선'),
    size !== null ? `${size}pt` : '',
    str(a['fontFamily']),
    str(a['textColor']),
    width !== null ? `장평 ${width}%` : '',
    spacing !== null ? `자간 ${spacing}%` : '',
  ], 3);
}

function paraProps(a: Args): string {
  const pct = num(a['lineSpacingPercent']);
  const pt = num(a['lineSpacingPt']);
  const before = num(a['spaceBeforePt']);
  const after = num(a['spaceAfterPt']);
  const indent = num(a['indentPt']);
  const parts = [
    ALIGN[str(a['alignment'])] ?? '',
    pct !== null ? `줄 간격 ${pct}%` : pt !== null ? `줄 간격 ${pt}pt` : '',
    before !== null ? `문단 위 ${before}pt` : '',
    after !== null ? `문단 아래 ${after}pt` : '',
    indent !== null ? indent < 0 ? `내어쓰기 ${-indent}pt` : `들여쓰기 ${indent}pt` : '',
    num(a['marginLeftPt']) !== null || num(a['marginRightPt']) !== null ? '여백' : '',
    a['pageBreakBefore'] === true ? '앞에서 쪽 나눔' : '',
    Array.isArray(a['tabStops']) ? `탭 ${a['tabStops'].length}개` : '',
    a['borders'] !== undefined ? '테두리' : '',
    a['headType'] !== undefined || a['numberingId'] !== undefined || a['bulletChar'] !== undefined ? '문단 번호' : '',
  ];
  return firstParts(parts, 3);
}

const TABLE_PROP_LABELS: Record<string, string> = {
  repeatHeader: '제목 행 반복', pageBreak: '쪽 나눔', cellSpacingMm: '셀 간격', cellPaddingMm: '셀 안 여백',
  outerMarginMm: '바깥 여백', positionMode: '배치', textWrap: '본문 배치', horizontalAlign: '가로 정렬',
  horizontalOffsetMm: '가로 위치', verticalAlign: '세로 정렬', verticalOffsetMm: '세로 위치',
  captionEnabled: '캡션', captionDirection: '캡션 위치',
};

const CELL_PROP_LABELS: Record<string, string> = {
  fillColor: '배경색', verticalAlign: '세로 정렬', isHeader: '제목 셀', widthMm: '너비', heightMm: '높이',
  paddingMm: '안 여백', textDirection: '글자 방향', protected: '보호', fieldName: '필드 이름',
};

function propList(value: unknown, labels: Record<string, string>): string {
  const keys = Object.keys(rec(value));
  if (keys.length === 0) return '';
  const named = keys.map((key) => labels[key]).filter(Boolean);
  const shown = [...new Set(named)].slice(0, 3);
  const rest = keys.length - shown.length;
  return join([...shown, rest > 0 ? (shown.length ? `외 ${rest}개` : `속성 ${rest}개`) : '']);
}

const EDIT_TABLE_OPS: Record<string, string> = {
  insert_row: '행 추가', insert_col: '열 추가', delete_row: '행 삭제', delete_col: '열 삭제',
  merge_cells: '셀 합치기', split_cell: '셀 나누기', set_column_widths: '열 너비 변경',
  fit_to_page: '표 폭 맞춤', apply_formula: '계산식 넣기', set_caption: '표 캡션',
};

const HF_SCOPE: Record<string, string> = { both: '모든 쪽', all: '모든 쪽', odd: '홀수 쪽', even: '짝수 쪽' };

const WRAP: Record<string, string> = {
  square: '어울림', topAndBottom: '자리 차지', behindText: '글 뒤로', inFrontOfText: '글 앞으로',
};

const Z_ORDER: Record<string, string> = {
  front: '맨 앞으로', back: '맨 뒤로', forward: '앞으로', backward: '뒤로',
};

const SHAPE_KINDS: Record<string, string> = {
  line: '선 그리기', rectangle: '사각형 삽입', rect: '사각형 삽입', ellipse: '타원 삽입',
  textBox: '글상자 삽입', textbox: '글상자 삽입',
};

function size(a: Args): string {
  const w = mm(a['widthMm']);
  const h = mm(a['heightMm']);
  return w && h ? `${w}×${h}mm` : w ? `너비 ${w}mm` : h ? `높이 ${h}mm` : '';
}

function position(a: Args): string {
  const x = mm(a['xMm']);
  const y = mm(a['yMm']);
  return x || y ? `x ${x || '0'} · y ${y || '0'}mm` : '';
}

/** edit_object 의 동작 — op 값이나 들어온 키로 고른다. 대상 종류는 결과가 알려 준다. */
function objectAction(a: Args): string {
  const op = str(a['op']);
  if (op === 'delete' || a['delete'] === true) return '삭제';
  if (op === 'zOrder' || a['zOrder'] !== undefined) return '순서 변경';
  if (op === 'crop' || a['crop'] !== undefined || a['cropMm'] !== undefined) return '자르기';
  if (op === 'wrap' || (a['wrap'] !== undefined && a['xMm'] === undefined && a['widthMm'] === undefined)) return '배치 변경';
  if (op === 'resize' || ((a['widthMm'] !== undefined || a['heightMm'] !== undefined) && a['xMm'] === undefined && a['yMm'] === undefined)) return '크기 조정';
  if (op === 'move' || a['xMm'] !== undefined || a['yMm'] !== undefined || a['relativeTo'] !== undefined || a['positionMode'] !== undefined) return '이동';
  return '속성 변경';
}

function objectSummary(a: Args): string {
  return join([
    para(a),
    position(a),
    size(a),
    WRAP[str(a['wrap'])] ?? '',
    Z_ORDER[str(a['zOrder'])] ?? '',
  ]);
}

function firstString(a: Args, keys: string[]): string {
  for (const key of keys) {
    const value = a[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// ─── 도구별 표시 규칙 ─────────────────────────────────

const SPECS: Record<string, ToolSpec> = {
  // 문서 읽기
  get_structure: {
    category: 'read', label: '문서 구조 읽기',
    summary: (a) => {
      const range = rec(a['range']);
      const since = num(a['sinceRevision']);
      if (num(range['fromPara']) !== null) return paraRange({ ...range }, 'fromPara', 'toPara');
      return since !== null ? `r${since} 이후 변경` : '';
    },
  },
  get_text_range: {
    category: 'read', label: '텍스트 읽기',
    summary: (a) => join([para(a), num(a['count']) !== null ? `${num(a['count'])}자` : '']),
  },
  get_selection: { category: 'read', label: '선택 영역 읽기' },
  get_fields: { category: 'read', label: '필드 목록 읽기' },
  get_document_info: { category: 'read', label: '문서 정보 읽기' },
  find_text: { category: 'read', label: '텍스트 찾기', summary: (a) => quote(str(a['query'])) },
  get_page_geometry: { category: 'read', label: '쪽 배치 읽기', summary: (a) => join([page(a), a['regionMm'] ? '일부' : '']) },
  get_para_format: { category: 'read', label: '문단 서식 읽기', summary: (a) => para(a) },
  get_char_format: { category: 'read', label: '글자 서식 읽기', summary: (a) => para(a) },
  get_table_properties: { category: 'read', label: '표 속성 읽기', summary: (a) => table(a) },
  get_table_layout: { category: 'read', label: '표 배치 읽기', summary: (a) => table(a) },
  get_engine_edit_capabilities: { category: 'read', label: '엔진 기능 찾기', summary: (a) => quote(str(a['query'])) },
  list_styles: { category: 'read', label: '스타일 목록 읽기' },
  list_numberings: { category: 'read', label: '번호 목록 읽기' },
  get_outline: { category: 'read', label: '개요 읽기' },
  list_footnotes: { category: 'read', label: '각주 목록 읽기' },
  list_bookmarks: { category: 'read', label: '책갈피 목록 읽기' },
  materialize_document_snapshot: { category: 'read', label: '문서 사본 만들기' },
  read_batch: {
    category: 'read',
    label: (a) => `${Array.isArray(a['reads']) ? a['reads'].length : 0}개 읽기`,
  },

  // 확인 (그림으로 보거나 변경을 점검)
  render_page: { category: 'check', label: '쪽 그림 보기', summary: (a) => join([page(a), a['regionMm'] ? '일부' : '']) },
  verify_changes: { category: 'check', label: '변경 확인', summary: (a) => a['includeImage'] === true ? '그림 포함' : '' },
  preview_equation: { category: 'check', label: '수식 미리보기', summary: (a) => quote(str(a['script']), 32) },
  environment_screenshot: { category: 'check', label: '화면 캡처' },

  // 문서 편집
  apply_edits: {
    category: 'edit',
    label: (a) => `${Array.isArray(a['edits']) ? a['edits'].length : 0}곳 편집`,
  },
  insert_text: {
    category: 'edit', label: '텍스트 삽입',
    summary: (a) => join([target(a, true), quote(str(a['text']))]),
  },
  delete_range: {
    category: 'edit', label: '텍스트 삭제',
    summary: (a) => anchorText(a, false) || paraRange(a, 'startParaIdx', 'endParaIdx'),
  },
  replace_range: {
    category: 'edit', label: '텍스트 바꾸기',
    summary: (a) => `${anchorText(a, false) || paraRange(a, 'startParaIdx', 'endParaIdx')} → ${quote(str(a['text'])) || '빈 텍스트'}`,
  },
  apply_char_format: {
    category: 'edit', label: '글자 서식',
    summary: (a) => join([target(a), charProps(a)]),
  },
  apply_para_format: {
    category: 'edit', label: '문단 서식',
    summary: (a) => join([target(a), paraProps(a)]),
  },
  apply_style: {
    category: 'edit', label: '스타일 적용',
    summary: (a) => join([para(a), a['styleId'] !== undefined ? `스타일 ${String(a['styleId'])}` : '']),
  },
  apply_list: {
    category: 'edit',
    label: (a) => str(a['bulletChar']) ? '글머리표 적용' : '번호 목록 적용',
    summary: (a) => join([paraRange(a, 'startParaIdx', 'endParaIdx'), str(a['bulletChar']) || str(a['format'])]),
  },
  set_field_value: {
    category: 'edit', label: '필드 값 입력',
    summary: (a) => `${str(a['name'])} = ${quote(str(a['value'])) || '빈 값'}`,
  },
  insert_page_break: { category: 'edit', label: '쪽 나누기', summary: (a) => para(a) },
  insert_footnote: {
    category: 'edit',
    label: (a) => str(a['kind']) === 'endnote' ? '미주 삽입' : '각주 삽입',
    summary: (a) => join([para(a), quote(str(a['text']))]),
  },
  edit_footnote: { category: 'edit', label: '각주 수정', summary: (a) => quote(str(a['text'])) },
  set_bookmark: {
    category: 'edit',
    label: (a) => str(a['op']) === 'delete' ? '책갈피 삭제' : str(a['op']) === 'rename' ? '책갈피 이름 변경' : '책갈피 추가',
    summary: (a) => str(a['newName']) ? `${quote(str(a['name']))} → ${quote(str(a['newName']))}` : join([quote(str(a['name'])), para(a)]),
  },
  edit_header_footer: {
    category: 'edit',
    label: (a) => str(a['which']) === 'footer' ? '꼬리말 편집' : str(a['which']) === 'both' ? '머리말·꼬리말 편집' : '머리말 편집',
    summary: (a) => {
      const lines = Array.isArray(a['lines']) ? a['lines'].map((line) => typeof line === 'string' ? line : str(rec(line)['text'])) : [];
      return join([
        HF_SCOPE[str(a['applyTo'])] ?? '',
        quote(lines.filter(Boolean).join(' / ')),
        a['pageNumber'] !== undefined ? '쪽 번호' : '',
        num(a['startPageNumber']) !== null ? `${num(a['startPageNumber'])}쪽부터` : '',
      ]);
    },
  },
  set_page_layout: {
    category: 'edit', label: '쪽 설정 변경',
    summary: (a) => join([
      str(a['paper']),
      a['landscape'] === true ? '가로' : a['landscape'] === false ? '세로' : '',
      a['marginsMm'] !== undefined ? '여백' : '',
      a['columns'] !== undefined ? '단' : '',
    ]),
  },
  create_table: {
    category: 'edit', label: '표 만들기',
    summary: (a) => {
      const cells = Array.isArray(a['cells']) ? a['cells'] : null;
      const rows = num(a['rows']) ?? cells?.length ?? null;
      const cols = num(a['cols']) ?? (cells && Array.isArray(cells[0]) ? cells[0].length : null);
      return join([para(a), rows !== null && cols !== null ? `${rows}×${cols}` : '']);
    },
  },
  edit_table: {
    category: 'edit',
    label: (a) => EDIT_TABLE_OPS[str(a['op'])] ?? '표 편집',
    summary: (a) => {
      const row = num(a['rowIdx']);
      const col = num(a['colIdx']);
      return join([
        table(a),
        row !== null ? `${row + 1}행` : '',
        col !== null ? `${col + 1}열` : '',
        str(a['op']) === 'merge_cells' ? `${cellAt(a['startRow'], a['startCol'])}–${cellAt(a['endRow'], a['endCol'])}` : '',
        str(a['formula']) ? quote(str(a['formula'])) : '',
        str(a['op']) === 'set_caption' ? quote(str(a['text'])) : '',
      ]);
    },
  },
  set_table_props: {
    category: 'edit', label: '표 속성 변경',
    summary: (a) => join([table(a), propList(a['tableProps'], TABLE_PROP_LABELS)]),
  },
  set_cell_props: {
    category: 'edit', label: '셀 속성 변경',
    summary: (a) => join([table(a), propList(a['cellProps'], CELL_PROP_LABELS)]),
  },
  set_zone_borders: {
    category: 'edit', label: '셀 테두리 변경',
    summary: (a) => {
      const start = rec(a['startCell']);
      const end = rec(a['endCell']);
      return join([table(a), `${cellAt(start['row'], start['col'])}–${cellAt(end['row'], end['col'])}`.replace(/^–$/, '')]);
    },
  },
  delete_table: { category: 'edit', label: '표 삭제', summary: (a) => table(a) },
  insert_image: {
    category: 'edit', label: '그림 삽입',
    summary: (a) => join([para(a), size(a), str(a['positionMode']) === 'floating' ? '떠 있음' : '']),
  },
  insert_equation: { category: 'edit', label: '수식 삽입', summary: (a) => join([para(a), quote(str(a['script']), 32)]) },
  insert_chart: {
    category: 'edit', label: '차트 삽입',
    summary: (a) => join([para(a), str(rec(a['spec'])['type']), size(a)]),
  },
  replace_all: {
    category: 'edit', label: '모두 바꾸기',
    summary: (a) => `${quote(str(a['query']))} → ${quote(str(a['replacement'])) || '빈 텍스트'}`,
  },
  edit_object: {
    category: 'edit',
    label: (a) => `개체 ${objectAction(a)}`,
    summary: objectSummary,
  },
  insert_shape: {
    category: 'edit',
    label: (a) => SHAPE_KINDS[str(a['shape']) || str(a['kind']) || str(a['type'])] ?? '도형 삽입',
    summary: (a) => join([para(a), position(a), size(a)]),
  },
  apply_engine_edits: {
    category: 'edit',
    label: (a) => `엔진 편집 ${Array.isArray(a['operations']) ? a['operations'].length : 0}개`,
    summary: (a) => {
      const ops = Array.isArray(a['operations']) ? a['operations'] : [];
      const methods = [...new Set(ops.map((op) => str(rec(op)['method'])).filter(Boolean))];
      return join([...methods.slice(0, 2), methods.length > 2 ? `외 ${methods.length - 2}개` : '']);
    },
  },
  prepare_engine_edit_session: { category: 'edit', label: '엔진 편집 준비', summary: (a) => str(a['method']) },

  // 서식 틀
  get_active_template: { category: 'read', label: '서식 틀 확인' },
  template_get_structure: { category: 'read', label: '서식 틀 구조 읽기' },
  template_get_text_range: { category: 'read', label: '서식 틀 텍스트 읽기', summary: (a) => para(a) },
  template_get_para_format: { category: 'read', label: '서식 틀 문단 서식 읽기', summary: (a) => para(a) },
  template_get_char_format: { category: 'read', label: '서식 틀 글자 서식 읽기', summary: (a) => para(a) },
  template_list_styles: { category: 'read', label: '서식 틀 스타일 읽기' },
  template_get_page_layout: { category: 'read', label: '서식 틀 쪽 설정 읽기' },
  template_render_page: { category: 'check', label: '서식 틀 쪽 그림 보기', summary: (a) => page(a) },
  template_apply_section_layout: { category: 'edit', label: '서식 틀 쪽 설정 적용' },
  template_apply_paragraph_format: {
    category: 'edit', label: '서식 틀 문단 서식 적용',
    summary: (a) => Array.isArray(a['targets']) ? `문단 ${a['targets'].length}곳` : '',
  },
  template_insert_block: { category: 'edit', label: '서식 틀 내용 가져오기' },

  // 지시·스킬·참고 자료
  read_agent_instructions: { category: 'read', label: '지시 읽기' },
  update_agent_instructions: { category: 'other', label: '지시 변경 제안' },
  read_product_skill: { category: 'read', label: '스킬 읽기', summary: (a) => join([str(a['name']), str(a['resourcePath']) !== 'SKILL.md' ? str(a['resourcePath']) : '']) },
  commit_product_skill: { category: 'other', label: '스킬 변경', summary: (a) => join([str(a['name']), str(a['action'])]) },
  list_harness_skills: { category: 'read', label: '하네스 스킬 목록' },
  list_reference_files: { category: 'read', label: '참고 자료 목록' },
  search_reference_files: { category: 'read', label: '참고 자료 검색', summary: (a) => quote(str(a['query'])) },
  read_reference_chunk: { category: 'read', label: '참고 자료 읽기' },
  read_reference_image: { category: 'read', label: '참고 그림 보기' },

  // 대화·계획·파일
  ask_user_question: {
    category: 'other', label: '질문하기',
    summary: (a) => {
      const first = Array.isArray(a['questions']) ? rec(a['questions'][0]) : {};
      return quote(str(first['question']) || str(first['header']), 32);
    },
  },
  present_implementation_plan: { category: 'other', label: '계획 제시', summary: (a) => quote(str(a['title']), 32) },
  update_plan_progress: { category: 'other', label: '계획 진행 갱신', summary: (a) => str(a['status']) },
  download_file: { category: 'other', label: '파일 내려받기', summary: (a) => str(a['filename']) || host(str(a['url'])) },
  publish_artifact: { category: 'other', label: '파일 내보내기', summary: (a) => str(a['fileName']) },
  publish_cloud_document: { category: 'other', label: '클라우드 게시' },
  delegate_copy_layout: { category: 'other', label: '레이아웃 복제 맡기기', summary: (a) => str(a['documentName']) },
  update_copy_layout_job: { category: 'other', label: '복제 작업 갱신', summary: (a) => str(a['phase']) },
  run_copy_layout_helper: { category: 'other', label: '복제 도우미 실행', summary: (a) => str(a['action']) },
  complete_copy_layout_job: { category: 'other', label: '복제 작업 마치기', summary: (a) => str(a['outcome']) },
  register_copy_layout_template: { category: 'other', label: '서식 틀 등록', summary: (a) => quote(str(a['name'])) },

  // 원격 브라우저
  browserbase_start: { category: 'other', label: '브라우저 시작' },
  browserbase_end: { category: 'other', label: '브라우저 종료' },
  browserbase_navigate: { category: 'other', label: '웹 페이지 열기', summary: (a) => host(str(a['url'])) },
  browserbase_act: { category: 'other', label: '브라우저 조작', summary: (a) => quote(str(a['action']), 32) },
  browserbase_observe: { category: 'other', label: '페이지 살펴보기', summary: (a) => quote(str(a['instruction']), 32) },
  browserbase_extract: { category: 'other', label: '페이지 내용 추출', summary: (a) => quote(str(a['instruction']), 32) },
};

/** rhwp 밖의 흔한 CLI 도구 — 이름만 우리말로 바꾸고 대표 인자를 보인다. */
const FOREIGN_LABELS: Record<string, string> = {
  bash: '명령 실행', command_execution: '명령 실행', shell: '명령 실행',
  read: '파일 읽기', write: '파일 쓰기', edit: '파일 수정', multiedit: '파일 수정', file_change: '파일 변경',
  grep: '파일 내용 검색', glob: '파일 찾기', ls: '폴더 보기',
  webfetch: '웹 페이지 읽기', websearch: '웹 검색', web_search: '웹 검색',
  todowrite: '할 일 정리', update_plan: '할 일 정리',
};

const FOREIGN_ARG_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt'];

/** 접두어를 떼어 rhwp 도구 이름으로 맞춘다 (mcp__rhwp__x, rhwp__x, rhwp.x, rhwp_x). */
export function baseToolName(tool: string): string {
  const stripped = tool.trim()
    .replace(/^mcp__rhwp__/, '')
    .replace(/^mcp_rhwp_/, '')
    .replace(/^rhwp(?:__|[.:/])/, '');
  if (!SPECS[stripped] && stripped.startsWith('rhwp_') && SPECS[stripped.slice(5)]) return stripped.slice(5);
  return stripped;
}

export function isKnownTool(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(SPECS, baseToolName(tool));
}

/** 표시 규칙이 있는 rhwp 도구 이름 전체 — 계약 테스트가 tools.mjs 와 맞춰 본다. */
export const PRESENTED_TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(SPECS));

export function parseToolArgs(argsJson: string): Args {
  try {
    return rec(JSON.parse(argsJson));
  } catch {
    return {};
  }
}

function describe(name: string, args: Args): { known: boolean; category: ToolCategory; label: string; summary: string } {
  const spec = SPECS[name];
  if (!spec) {
    const foreign = FOREIGN_LABELS[name.toLowerCase()];
    const lead = firstString(args, FOREIGN_ARG_KEYS);
    return {
      known: false,
      category: 'other',
      label: foreign ?? name,
      summary: lead ? clip(lead, 60) : '',
    };
  }
  let label: string;
  let summary: string;
  try {
    label = typeof spec.label === 'function' ? spec.label(args) : spec.label;
    summary = spec.summary ? spec.summary(args) : '';
  } catch {
    label = typeof spec.label === 'string' ? spec.label : name;
    summary = '';
  }
  return { known: true, category: spec.category, label, summary };
}

function batchItems(args: Args, key: 'edits' | 'reads'): Array<{ name: string; args: Args }> {
  const list = args[key];
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const entry = rec(item);
    return { name: baseToolName(str(entry['tool'])), args: rec(entry['args']) };
  });
}

/** apply_edits 요약 — 항목 동작을 세어 “텍스트 바꾸기 2 · 글자 서식 1”. 한 가지면 첫 항목 요약. */
function batchSummary(items: ToolItemView[]): string {
  if (items.length === 0) return '';
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  if (counts.size === 1) {
    const [label, count] = [...counts][0];
    return count === 1 ? items[0].summary : `${label} ${count}`;
  }
  const parts = [...counts].map(([label, count]) => count > 1 ? `${label} ${count}` : label);
  return join([...parts.slice(0, 3), parts.length > 3 ? `외 ${parts.length - 3}가지` : '']);
}

export function presentToolCall(tool: string, argsJson: string): ToolCallView {
  const name = baseToolName(tool);
  const args = parseToolArgs(argsJson);
  const head = describe(name, args);
  let items: ToolItemView[] = [];
  let summary = head.summary;
  if (name === 'apply_edits' || name === 'read_batch') {
    items = batchItems(args, name === 'apply_edits' ? 'edits' : 'reads').map((item) => {
      const view = describe(item.name, item.args);
      return { label: view.label, summary: view.summary };
    });
    summary = batchSummary(items);
  }
  return { name, known: head.known, category: head.category, label: head.label, summary, items };
}

// ─── 결과 ───────────────────────────────────────────

const ERROR_TEXT: Record<string, string> = {
  INVALID_ARGS: '인자 오류',
  REVISION_MISMATCH: '문서 버전 불일치',
  TEMPLATE_REVISION_MISMATCH: '서식 틀 버전 불일치',
  DOC_NOT_LOADED: '열린 문서 없음',
  RENDER_UNAVAILABLE: '그림으로 그릴 수 없음',
  INVALID_SCRIPT: '수식 문법 오류',
  RESULT_TOO_LARGE: '결과가 너무 큼',
  UNKNOWN_TOOL: '알 수 없는 도구',
  BOOKMARK_NOT_FOUND: '책갈피 없음',
  BOOKMARK_FAILED: '책갈피 실패',
  NOTE_NOT_FOUND: '각주 없음',
  NOTE_MULTIPARA: '여러 문단 각주는 수정 불가',
  FIELD_NOT_FOUND: '필드 없음',
  TEMPLATE_UNAVAILABLE: '서식 틀 없음',
  TEMPLATE_NOT_FOUND: '서식 틀 없음',
  TEMPLATE_TRANSFER_FAILED: '서식 틀 적용 실패',
  SKILL_NOT_FOUND: '스킬 없음',
  REFERENCE_NOT_FOUND: '참고 자료 없음',
  FILE_NOT_FOUND: '파일 없음',
  ARTIFACT_NOT_FOUND: '파일 없음',
  PLAN_NOT_FOUND: '계획 없음',
  SAFE_MODE_RAW_ENGINE: '안전 모드에서 막힘',
  SAFE_MODE_PUBLISH: '안전 모드에서 막힘',
  PENDING_SEMANTIC_EDITS: '대기 중인 편집과 충돌',
  MIXED_ENGINE_WRITE_MODE: '편집 방식을 섞을 수 없음',
  ENGINE_EDIT_UNAVAILABLE: '엔진 편집 불가',
  ENGINE_EDIT_FAILED: '엔진 편집 실패',
  CHART_RENDER_FAILED: '차트를 그리지 못함',
  SNAPSHOT_EMPTY: '빈 문서',
  TOOL_TIMEOUT: '응답 시간 초과',
  HUB_UNAVAILABLE: '허브 연결 끊김',
  NO_ACTIVE_TURN: '턴이 끝난 뒤 도착',
  TOO_MANY_INFLIGHT_CALLS: '동시 호출 초과',
  PERMISSION_DENIED: '권한 거부',
  RPC_ERROR: '실행 오류',
};

export function errorText(code: string): string {
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (code.startsWith('STALE')) return '지난 요청';
  if (code.endsWith('_NOT_FOUND')) return '대상 없음';
  if (code.endsWith('_FORBIDDEN') || code.endsWith('_UNAUTHORIZED')) return '허용되지 않음';
  return '실행 오류';
}

interface ParsedPreview {
  value: Args | null;
  error: { code: string; message: string } | null;
  hasImage: boolean;
  /** 해석하지 못한 평문 */
  text: string;
}

const ERROR_LINE = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]*)$/;

function parseTextBlock(text: string, out: ParsedPreview): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const error = ERROR_LINE.exec(trimmed);
  if (error) {
    out.error = { code: error[1], message: error[2].trim() };
    return;
  }
  if (/^permission denied for:/i.test(trimmed)) {
    out.error = { code: 'PERMISSION_DENIED', message: trimmed };
    return;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      out.value = parsed as Args;
      return;
    }
  } catch { /* 아래 평문으로 */ }
  out.text ||= trimmed;
}

function readBlocks(blocks: unknown[], out: ParsedPreview): void {
  for (const block of blocks) {
    const entry = rec(block);
    if (entry['type'] === 'image') out.hasImage = true;
    else if (entry['type'] === 'text') parseTextBlock(str(entry['text']), out);
  }
}

/**
 * 프로바이더가 넘긴 결과 미리보기(최대 2000자, 잘릴 수 있음)를 푼다.
 * Claude 는 MCP content 블록 배열, Codex 는 {content:[…]} 객체, 오류는 “CODE: message” 문자열이다.
 */
export function parseResultPreview(preview: string): ParsedPreview {
  const out: ParsedPreview = { value: null, error: null, hasImage: false, text: '' };
  const trimmed = preview.trim();
  if (!trimmed) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 잘린 JSON — 그림 블록 흔적과 오류 줄만 건진다.
    if (/"type"\s*:\s*"image"/.test(trimmed)) out.hasImage = true;
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) parseTextBlock(trimmed, out);
    return out;
  }
  if (typeof parsed === 'string') parseTextBlock(parsed, out);
  else if (Array.isArray(parsed)) readBlocks(parsed, out);
  else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Args;
    if (Array.isArray(obj['content'])) {
      readBlocks(obj['content'], out);
      const structured = rec(obj['structuredContent'] ?? obj['structured_content']);
      if (!out.value && Object.keys(structured).length > 0) out.value = structured;
    } else if (obj['error'] && typeof obj['error'] === 'object') {
      const error = rec(obj['error']);
      out.error = { code: str(error['code']) || 'RPC_ERROR', message: str(error['message']) };
    } else {
      out.value = obj;
    }
  }
  return out;
}

/** 쪽 번호 목록(0 기반)을 “2쪽”, “2–4쪽”, “2·5쪽” 으로. */
export function pagesText(pages: readonly number[]): string {
  const sorted = [...new Set(pages.filter((p) => Number.isInteger(p) && p >= 0))].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const contiguous = sorted.every((p, i) => i === 0 || p === sorted[i - 1] + 1);
  if (sorted.length === 1) return `${sorted[0] + 1}쪽`;
  if (contiguous) return `${sorted[0] + 1}–${sorted[sorted.length - 1] + 1}쪽`;
  const shown = sorted.slice(0, 3).map((p) => p + 1).join('·');
  return `${shown}${sorted.length > 3 ? '…' : ''}쪽`;
}

function numberList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

function warningText(value: unknown): string {
  if (typeof value === 'string') return value;
  const entry = rec(value);
  return str(entry['message']) || str(entry['warning']) || str(entry['kind']) || str(entry['type']) || '';
}

/**
 * 편집 뒤 결과 블록(after) — 닿은 쪽, 쪽 수 변화, 배치 경고.
 * 키 이름은 조금씩 달라도 읽히게 둔다 (pages/pagesTouched/affectedPages, pageCount{before,after}).
 */
function afterFacts(result: Args): { pages: string; pageDelta: string; warnings: string[] } {
  const after = rec(result['after']);
  const pages = numberList(after['pages'] ?? after['pagesTouched'] ?? after['touchedPages'] ?? after['affectedPages']);
  const count = after['pageCount'];
  const before = num(rec(count)['before']) ?? num(after['pageCountBefore']);
  const now = num(rec(count)['after']) ?? num(after['pageCountAfter']);
  const warnings = Array.isArray(after['warnings']) ? after['warnings'].map(warningText).filter(Boolean) : [];
  return {
    pages: pagesText(pages),
    pageDelta: before !== null && now !== null && before !== now ? `${before}→${now}쪽` : '',
    warnings,
  };
}

function imageOf(result: Args): string | undefined {
  const image = rec(result['image']);
  const data = str(image['data']);
  const mime = str(image['mimeType']);
  if (data && mime.startsWith('image/')) return `data:${mime};base64,${data}`;
  const blocks = result['mcpContent'];
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const entry = rec(block);
      if (entry['type'] === 'image' && str(entry['data']) && str(entry['mimeType']).startsWith('image/')) {
        return `data:${str(entry['mimeType'])};base64,${str(entry['data'])}`;
      }
    }
  }
  return undefined;
}

function count(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function countText(n: number | null, unit: string, empty: string): string {
  if (n === null) return '';
  return n === 0 ? empty : `${unit} ${n}개`;
}

/** 성공 결과 한 줄 — 도구마다 가장 궁금한 숫자 하나를 고른다. */
function successText(name: string, args: Args, result: Args, category: ToolCategory): string {
  const facts = afterFacts(result);
  const tail = join([facts.pages, facts.pageDelta, facts.warnings.length ? `경고 ${facts.warnings.length}` : '']);
  switch (name) {
    case 'apply_edits': {
      const applied = num(result['applied']) ?? count(result['results']) ?? count(args['edits']);
      return join([applied !== null ? `${applied}개 편집 적용` : '편집 적용', tail]);
    }
    case 'read_batch': {
      const results = Array.isArray(result['results']) ? result['results'] : [];
      const failed = results.filter((item) => rec(item)['error']).length;
      return join([`${results.length}개 읽음`, failed ? `오류 ${failed}` : '']);
    }
    case 'replace_all': {
      const replaced = num(result['replacedCount']);
      return replaced === null ? join(['바꿈', tail]) : replaced === 0 ? '바꿀 곳 없음' : join([`${replaced}곳 바꿈`, tail]);
    }
    case 'find_text': {
      const matches = count(result['matches']);
      if (matches === null) return '';
      return matches === 0 ? '찾지 못함' : `${matches}곳${result['truncated'] === true ? '+' : ''}`;
    }
    case 'get_text_range': {
      const text = str(result['text']);
      return `${text.length}자`;
    }
    case 'get_selection': {
      const text = str(result['text']);
      return text ? quote(text) : '선택 없음';
    }
    case 'get_structure':
    case 'template_get_structure':
    case 'get_document_info': {
      const pages = num(result['pageCount']);
      return join([pages !== null ? `${pages}쪽` : '', result['truncated'] === true ? '일부' : '']);
    }
    case 'list_styles':
    case 'template_list_styles':
      return countText(count(result['styles']), '스타일', '스타일 없음');
    case 'list_numberings':
      return countText(count(result['numberings']), '번호', '번호 없음');
    case 'list_bookmarks':
      return countText(count(result['bookmarks']), '책갈피', '책갈피 없음');
    case 'list_footnotes':
      return countText(count(result['notes']), '각주', '각주 없음');
    case 'get_fields':
      return countText(count(result['fields']), '필드', '필드 없음');
    case 'search_reference_files':
      return countText(count(result['results'] ?? result['matches']), '결과', '찾지 못함');
    case 'verify_changes': {
      const total = num(rec(result['counts'])['total']);
      const warnings = count(result['warnings']) ?? 0;
      return join([
        total !== null ? `편집 ${total}개` : '',
        pagesText(numberList(result['affectedPages'])),
        warnings ? `경고 ${warnings}` : '',
      ]);
    }
    case 'render_page':
    case 'template_render_page':
      return typeof result['svg'] === 'string' ? 'SVG' : '';
    case 'apply_engine_edits': {
      const applied = num(result['applied']) ?? count(result['results']);
      return join([applied !== null ? `${applied}개 적용` : '적용', tail]);
    }
    default:
      if (category === 'edit') return join(['적용', tail]);
      return '';
  }
}

function resultNotices(result: Args): string[] {
  const notices = afterFacts(result).warnings;
  if (Array.isArray(result['warnings'])) {
    for (const warning of result['warnings']) {
      const text = warningText(warning);
      if (text) notices.push(text);
    }
  }
  if (Array.isArray(result['editReport']) && result['editReport'].length > 0) {
    notices.push(...result['editReport'].filter((note): note is string => typeof note === 'string'));
  }
  return [...new Set(notices)].slice(0, 12);
}

/** apply_edits/read_batch 항목 결과 — 인자 순서대로 맞춘다. */
function itemOutcomes(name: string, args: Args, result: Args): ToolItemOutcome[] | undefined {
  if (name !== 'apply_edits' && name !== 'read_batch') return undefined;
  const items = batchItems(args, name === 'apply_edits' ? 'edits' : 'reads');
  const results = Array.isArray(result['results']) ? result['results'] : [];
  if (items.length === 0 && results.length === 0) return undefined;
  const length = Math.max(items.length, results.length);
  const out: ToolItemOutcome[] = [];
  for (let i = 0; i < length; i += 1) {
    const item = items[i] ?? { name: baseToolName(str(rec(results[i])['tool'])), args: {} };
    const itemResult = rec(results[i]);
    const error = rec(itemResult['error']);
    if (str(error['code']) || str(error['message'])) {
      out.push({ ok: false, text: errorText(str(error['code'])) });
      continue;
    }
    if (results[i] === undefined) {
      out.push({ ok: true, text: '' });
      continue;
    }
    const category = SPECS[item.name]?.category ?? 'other';
    const text = successText(item.name, item.args, itemResult, category);
    out.push({ ok: true, text: text === '적용' ? '' : text });
  }
  return out;
}

/** 실패한 apply_edits 의 “edits[3] (…) failed” 에서 몇 번째 항목이 막혔는지 읽는다. */
function failedItemIndex(message: string): number | null {
  const match = /edits\[(\d+)\]/.exec(message);
  return match ? Number(match[1]) : null;
}

function refinedLabel(name: string, args: Args, result: Args | null): string | undefined {
  if (name !== 'edit_object' || !result) return undefined;
  const kind = str(result['kind'] ?? result['objectKind'] ?? result['objectType']).toLowerCase();
  const noun = kind.includes('picture') || kind.includes('image') ? '그림'
    : kind.includes('textbox') ? '글상자'
      : kind.includes('shape') || kind.includes('line') || kind.includes('rect') || kind.includes('ellipse') ? '도형'
        : '';
  return noun ? `${noun} ${objectAction(args)}` : undefined;
}

export interface ToolResultInput {
  tool: string;
  argsJson: string;
  ok: boolean;
  /** 프로바이더 결과 미리보기 */
  preview: string;
  /** 스튜디오 실행기가 돌려준 원본 결과 (있으면 미리보기보다 우선) */
  result?: unknown;
  /** 스튜디오 실행기의 오류 */
  error?: { code: string; message: string } | null;
}

export function presentToolResult(input: ToolResultInput): ToolOutcomeView {
  const name = baseToolName(input.tool);
  const args = parseToolArgs(input.argsJson);
  const known = Object.prototype.hasOwnProperty.call(SPECS, name);
  const parsed = input.result !== undefined || input.error
    ? { value: input.error ? null : rec(input.result), error: input.error ?? null, hasImage: false, text: '' }
    : parseResultPreview(input.preview);
  const error = parsed.error ?? (!input.ok && !parsed.value ? { code: '', message: parsed.text || input.preview.trim() } : null);

  if (error || !input.ok) {
    const code = error?.code ?? '';
    const message = error?.message ?? '';
    const items = name === 'apply_edits' ? batchItems(args, 'edits') : [];
    const failedAt = failedItemIndex(message);
    return {
      ok: false,
      text: join([
        code ? errorText(code) : known ? '실행 오류' : clip(message.split('\n')[0] ?? '', 60) || '실패',
        failedAt !== null && items.length ? `${failedAt + 1}번째 항목` : '',
      ]),
      ...(message ? { detail: clip(message, 400) } : {}),
      notices: [],
      ...(failedAt !== null && items.length
        ? { items: items.map((_, i) => ({ ok: i !== failedAt, text: i === failedAt ? errorText(code) : '되돌림' })) }
        : {}),
    };
  }

  if (!known) return { ok: true, text: '', notices: [] };
  const value = parsed.value ?? {};
  const category = SPECS[name].category;
  const text = parsed.value ? successText(name, args, value, category) : category === 'edit' ? '적용' : '';
  const image = imageOf(value);
  const label = refinedLabel(name, args, parsed.value);
  const items = parsed.value ? itemOutcomes(name, args, value) : undefined;
  return {
    ok: true,
    text: text || (parsed.hasImage && !image ? '그림' : ''),
    notices: parsed.value ? resultNotices(value) : [],
    ...(items ? { items } : {}),
    ...(image ? { image } : {}),
    ...(label ? { label } : {}),
  };
}

// ─── 턴 요약 ─────────────────────────────────────────

const CATEGORY_WORD: Record<ToolCategory, string> = {
  edit: '편집',
  read: '읽기',
  check: '확인',
  other: '도구',
};

/**
 * 활동 묶음 제목 — 한 번이면 그 동작 이름, 여러 번이면 “편집 3번 · 읽기 2번”.
 * 실패가 있으면 “오류 1” 을 덧붙인다.
 */
export function summarizeActivity(tools: ReadonlyArray<{ tool: string; argsJson: string; failed?: boolean }>): string {
  if (tools.length === 0) return '도구 호출';
  const failed = tools.filter((tool) => tool.failed).length;
  if (tools.length === 1) {
    const view = presentToolCall(tools[0].tool, tools[0].argsJson);
    return join([view.label, failed ? '오류' : '']);
  }
  const counts = new Map<ToolCategory, number>();
  for (const tool of tools) {
    const category = presentToolCall(tool.tool, '{}').category;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const order: ToolCategory[] = ['edit', 'read', 'check', 'other'];
  return join([
    ...order.filter((category) => counts.has(category)).map((category) => `${CATEGORY_WORD[category]} ${counts.get(category)}번`),
    failed ? `오류 ${failed}` : '',
  ]);
}
