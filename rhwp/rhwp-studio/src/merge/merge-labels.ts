const TOKEN_LABELS: Readonly<Record<string, string>> = {
  document: '문서',
  documents: '문서',
  section: '구역',
  sections: '구역',
  paragraph: '문단',
  paragraphs: '문단',
  text: '글',
  formatting: '서식',
  format: '형식',
  table: '표',
  tables: '표',
  cell: '셀',
  cells: '셀',
  shape: '도형',
  shapes: '도형',
  picture: '그림',
  image: '이미지',
  chart: '차트',
  style: '스타일',
  styles: '스타일',
  resource: '리소스',
  resources: '리소스',
  control: '개체',
  controls: '개체',
  unknown: '알 수 없는',
  property: '속성',
  properties: '속성',
  setting: '설정',
  settings: '설정',
  page: '쪽',
  pages: '쪽',
  column: '단',
  columns: '단',
  header: '머리말',
  footer: '꼬리말',
  footnote: '각주',
  endnote: '미주',
  note: '주석',
  memo: '메모',
  formula: '수식',
  equation: '수식 개체',
  group: '그룹',
  connector: '연결선',
  ole: 'OLE 개체',
  numbering: '문단 번호',
  numberings: '문단 번호',
  bullet: '글머리표',
  bullets: '글머리표',
  field: '필드',
  fields: '필드',
  form: '양식',
  bookmark: '책갈피',
  font: '글꼴',
  fonts: '글꼴',
  tab: '탭',
  tabs: '탭',
  border: '테두리',
  fill: '채우기',
  character: '글자',
  auto: '자동',
  number: '번호',
  sequence: '순서',
  placement: '배치',
  crop: '자르기',
  effect: '효과',
  effects: '효과',
  byte: '바이트',
  bytes: '바이트',
  bytesbase64: '이미지 바이트',
  assetblobid: '저장된 자산 식별자',
  bindataid: '바이너리 데이터 식별자',
  reference: '참조',
  data: '데이터',
  series: '계열',
  axis: '축',
  legend: '범례',
  drawing: '그리기',
  geometry: '기하 정보',
  transform: '변환',
  type: '종류',
  kind: '종류',
  identity: '식별 정보',
  interval: '범위',
  intervals: '범위',
  structure: '구조',
  structural: '구조',
  operation: '작업',
  action: '동작',
  stream: '데이터 스트림',
  streams: '데이터 스트림',
  master: '바탕쪽',
  caption: '캡션',
  ruby: '덧말',
  hyperlink: '하이퍼링크',
  hidden: '숨김',
  comment: '설명',
  range: '범위',
  tags: '태그',
  width: '너비',
  height: '높이',
  position: '위치',
  extension: '파일 확장자',
  id: '식별자',
  key: '키',
  name: '이름',
  title: '제목',
  label: '레이블',
  description: '설명',
  hash: '해시',
  source: '소스',
  current: '현재',
  incoming: '가져올 변경',
  base: '기준',
  result: '병합 결과',
  visible: '표시',
  url: '주소',
  start: '시작',
  end: '끝',
  point: '점',
  points: '점',
  line: '선',
  layout: '배치',
  direction: '방향',
  alignment: '맞춤',
  align: '맞춤',
  left: '왼쪽',
  right: '오른쪽',
  center: '가운데',
  horizontal: '가로',
  vertical: '세로',
  top: '위',
  bottom: '아래',
  color: '색',
  size: '크기',
  bold: '굵게',
  italic: '기울임',
  underline: '밑줄',
  script: '스크립트',
  content: '내용',
  value: '값',
  values: '값',
  index: '순번',
  count: '개수',
  row: '행',
  rows: '행',
  col: '열',
  x: '가로 좌표',
  y: '세로 좌표',
  z: '깊이 좌표',
  mime: '미디어 형식',
  original: '원본',
  path: '경로',
  para: '문단',
  char: '글자',
  opaque: '내부 데이터',
  preview: '미리보기',
  file: '파일',
  common: '공통',
};

const CHOICE_LABELS: Readonly<Record<string, string>> = {
  left: '왼쪽',
  center: '가운데',
  right: '오른쪽',
  justify: '양쪽 맞춤',
  horizontal: '가로',
  vertical: '세로',
  'left-to-right': '왼쪽에서 오른쪽',
  'right-to-left': '오른쪽에서 왼쪽',
  'insert-row': '행 삽입',
  'delete-row': '행 삭제',
  'insert-column': '열 삽입',
  'delete-column': '열 삭제',
  'merge-cells': '셀 합치기',
  'split-cell': '셀 나누기',
};

const ERROR_LABELS: Readonly<Record<string, string>> = {
  CURRENT_BRANCH: '현재 브랜치는 자기 자신과 병합할 수 없습니다.',
  REF_NOT_FOUND: '병합할 브랜치를 찾을 수 없습니다.',
  MERGE_DRAFT_NOT_FOUND: '병합 초안을 찾을 수 없습니다. 병합을 다시 시작하세요.',
  MERGE_UNRESOLVED: '해결하지 않은 충돌이 남아 있습니다.',
  MERGE_VALIDATION_FAILED: '병합 결과 문서를 검증하지 못했습니다.',
  STALE_WORKSPACE: '병합하는 동안 브랜치가 변경되었습니다. 결과를 다시 확인하세요.',
  CORRUPT_BLOB: '병합에 필요한 문서 데이터를 읽을 수 없습니다.',
  REPOSITORY_NOT_FOUND: '버전 저장소를 찾을 수 없습니다.',
  VERSION_STORE_FAILED: '병합 결과를 버전 기록에 저장하지 못했습니다.',
};

function tokenParts(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLocaleLowerCase()
    .split(/[-_\s]+/)
    .filter(Boolean);
}

function knownTokenLabel(token: string): string | undefined {
  const direct = TOKEN_LABELS[token.toLocaleLowerCase()];
  if (direct) return direct;
  const translated = tokenParts(token).map((part) => TOKEN_LABELS[part]);
  return translated.length > 0 && translated.every(Boolean) ? translated.join(' ') : undefined;
}

function stableTokenCode(token: string): string {
  let hash = 2166136261;
  for (const character of token) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return String(hash >>> 0).slice(-4).padStart(4, '0');
}

export function mergeTokenLabel(token: string, fallback = '기타 속성'): string {
  const normalized = token.trim();
  if (!normalized) return fallback;
  if (/^\d+$/.test(normalized)) return `${Number(normalized) + 1}번`;
  if (normalized.startsWith('@')) return `개체 ${normalized.slice(1)}`;
  return knownTokenLabel(normalized) ?? `${fallback} #${stableTokenCode(normalized)}`;
}

export function mergePathLabel(path: readonly string[], fallback = '문서 루트'): string {
  if (path.length === 0) return fallback;
  return path.map((part) => mergeTokenLabel(part, '내부 항목')).join(' / ');
}

export function mergeChoiceLabel(value: string): string {
  return CHOICE_LABELS[value] ?? mergeTokenLabel(value, '기타 값');
}

export function mergeErrorMessage(
  cause: unknown,
  fallback = '병합 작업을 완료하지 못했습니다. 다시 시도해 주세요.',
): string {
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const localized = ERROR_LABELS[String((cause as { code?: unknown }).code)];
    if (localized) return localized;
  }
  const detail = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return /[가-힣]/.test(detail) ? detail : fallback;
}

function localizedValue(value: unknown, seen: WeakSet<object>, key?: string): unknown {
  if (ArrayBuffer.isView(value)) return `[바이너리: ${value.byteLength}바이트]`;
  if (value instanceof ArrayBuffer) return `[바이너리: ${value.byteLength}바이트]`;
  if (value === null) return '없음';
  if (typeof value === 'boolean') return value ? '예' : '아니요';
  if (typeof value === 'string') {
    if (key && /(?:alignment|align|direction|operation|action)$/i.test(key)) {
      return CHOICE_LABELS[value] ?? value;
    }
    if (key && /(?:kind|type)$/i.test(key)) return knownTokenLabel(value) ?? value;
    return value;
  }
  if (Array.isArray(value)) return value.map((child) => localizedValue(child, seen, key));
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[순환 참조]';
  seen.add(value);
  const display: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const label = mergeTokenLabel(key);
    display[label in display ? `${label} (${Object.keys(display).length + 1})` : label] = key === 'bytesBase64' && typeof child === 'string'
      ? `[base64 이미지: ${child.length}자]`
      : localizedValue(child, seen, key);
  }
  seen.delete(value);
  return display;
}

export function formatMergeValue(value: unknown): string {
  if (value === null) return '(삭제됨 / 없음)';
  if (typeof value === 'string') return value || '(빈 문자열)';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '예' : '아니요';
  try {
    return JSON.stringify(localizedValue(value, new WeakSet()), null, 2);
  } catch {
    return '(값을 표시할 수 없음)';
  }
}
