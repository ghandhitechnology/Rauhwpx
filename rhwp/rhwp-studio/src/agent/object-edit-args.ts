/**
 * edit_object / insert_shape 인자 → 엔진 속성. 엔진 호출 없이 인자와 현재 속성만 보는
 * 순수 함수라 executor 와 단위 테스트가 함께 쓴다.
 *
 * 엔진 좌표는 HWPUNIT(1/7200 inch). 그림 오프셋은 부호 있는 정수(json_i32)로, 도형 오프셋은
 * 부호 없는 32비트(json_u32)로 읽으므로 음수 오프셋은 2의 보수로 넘긴다.
 */
import { AgentToolError } from './types.ts';

export type ObjectKind = 'picture' | 'shape';
export type ZOrderOp = 'front' | 'back' | 'forward' | 'backward';
export type ShapeType = 'line' | 'rectangle' | 'ellipse' | 'textBox';

const HU_PER_MM = 7200 / 25.4;
const mmToHu = (mm: number): number => Math.round(mm * HU_PER_MM);
const huToMm = (hu: number): number => Math.round((hu / HU_PER_MM) * 10) / 10;
const MAX_MM = 1000;

/** relativeTo → [가로 기준, 세로 기준] — 세로에는 단 기준이 없어 문단으로 둔다 */
const REL_TO: Record<string, [string, string]> = {
  paper: ['Paper', 'Paper'], page: ['Page', 'Page'], column: ['Column', 'Para'], paragraph: ['Para', 'Para'],
};
const REL_NAME: Record<string, string> = { Paper: 'paper', Page: 'page', Column: 'column', Para: 'paragraph' };
const WRAP: Record<string, string> = {
  square: 'Square', topAndBottom: 'TopAndBottom', behindText: 'BehindText', inFrontOfText: 'InFrontOfText',
};
const WRAP_NAME: Record<string, string> = {
  Square: 'square', Tight: 'tight', Through: 'through', TopAndBottom: 'topAndBottom',
  BehindText: 'behindText', InFrontOfText: 'inFrontOfText',
};
const Z_ORDERS: readonly ZOrderOp[] = ['front', 'back', 'forward', 'backward'];
const SHAPES: readonly ShapeType[] = ['line', 'rectangle', 'ellipse', 'textBox'];
const CROP_SIDES = ['left', 'top', 'right', 'bottom'] as const;
const CROP_KEYS = { left: 'cropLeft', top: 'cropTop', right: 'cropRight', bottom: 'cropBottom' } as const;
/** 글자처럼 취급 전환 시 엔진이 함께 바꾸는 배치 속성 — 역연산은 전부 되돌린다 */
const PLACEMENT_KEYS = [
  'treatAsChar', 'horzRelTo', 'vertRelTo', 'horzAlign', 'vertAlign', 'horzOffset', 'vertOffset', 'textWrap',
];

/** edit_object 가 받는 편집 인자 — delete 는 나머지와 함께 쓸 수 없다 */
export const EDIT_OBJECT_ARG_KEYS = [
  'positionMode', 'xMm', 'yMm', 'relativeTo', 'wrap', 'widthMm', 'heightMm', 'keepAspect', 'cropMm', 'zOrder',
] as const;

const present = (args: Record<string, unknown>, key: string): boolean => args[key] !== undefined && args[key] !== null;

function invalid(message: string): AgentToolError {
  return new AgentToolError('INVALID_ARGS', message);
}

function mmArg(args: Record<string, unknown>, key: string, { min = -MAX_MM, allowZero = true } = {}): number | undefined {
  if (!present(args, key)) return undefined;
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > MAX_MM || (!allowZero && v === 0)) {
    throw invalid(`${key} must be a number from ${min} to ${MAX_MM}${allowZero ? '' : ' (not 0)'}`);
  }
  return v;
}

function enumArg<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  if (!present(args, key)) return undefined;
  const v = args[key];
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw invalid(`${key} must be ${allowed.join('|')}`);
  return v as T;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 엔진 오프셋 부호 복원 — 도형 게터는 u32 로 낸다 */
function signedHu(value: unknown): number {
  return num(value) | 0;
}

export interface ObjectEditPlan {
  props: Record<string, unknown>;
  prevProps: Record<string, unknown>;
  zOrder?: ZOrderOp;
}

/**
 * edit_object 인자 → set{Picture,Shape}Properties 속성과 역연산용 이전 값.
 * 글자처럼 취급 개체에 xMm/yMm/relativeTo/wrap 를 주면 떠 있는 개체로 바꾼다
 * (기준 기본 paragraph, 오프셋 기본 0, 배치 기본 square — insert_image 와 같다).
 */
export function planObjectEdit(
  args: Record<string, unknown>, kind: ObjectKind, current: Record<string, unknown>,
): ObjectEditPlan {
  const mode = enumArg(args, 'positionMode', ['inline', 'floating'] as const);
  const relativeTo = enumArg(args, 'relativeTo', Object.keys(REL_TO));
  const wrap = enumArg(args, 'wrap', Object.keys(WRAP));
  const zOrder = enumArg(args, 'zOrder', Z_ORDERS);
  const xMm = mmArg(args, 'xMm');
  const yMm = mmArg(args, 'yMm');
  const widthMm = mmArg(args, 'widthMm', { min: 0, allowZero: false });
  const heightMm = mmArg(args, 'heightMm', { min: 0, allowZero: false });
  if (present(args, 'keepAspect') && typeof args['keepAspect'] !== 'boolean') throw invalid('keepAspect must be a boolean');
  const placement = ['xMm', 'yMm', 'relativeTo', 'wrap'].filter((key) => present(args, key));
  if (mode === 'inline' && placement.length > 0) {
    throw invalid(`${placement.join('/')} place a floating object — drop positionMode "inline"`);
  }
  const offset = (mm: number): number => {
    const hu = mmToHu(mm);
    return kind === 'shape' ? hu >>> 0 : hu;
  };

  const props: Record<string, unknown> = {};
  const inline = current['treatAsChar'] === true;
  if (inline && (mode === 'floating' || placement.length > 0)) {
    const [horz, vert] = REL_TO[relativeTo ?? 'paragraph'];
    Object.assign(props, {
      treatAsChar: false,
      horzRelTo: horz, vertRelTo: vert, horzAlign: 'Left', vertAlign: 'Top',
      horzOffset: offset(xMm ?? 0), vertOffset: offset(yMm ?? 0),
      textWrap: WRAP[wrap ?? 'square'],
    });
  } else if (!inline && mode === 'inline') {
    props['treatAsChar'] = true;
  } else if (!inline) {
    if (relativeTo) {
      const [horz, vert] = REL_TO[relativeTo];
      props['horzRelTo'] = horz;
      props['vertRelTo'] = vert;
    }
    if (xMm !== undefined) {
      props['horzOffset'] = offset(xMm);
      props['horzAlign'] = 'Left';
    }
    if (yMm !== undefined) {
      props['vertOffset'] = offset(yMm);
      props['vertAlign'] = 'Top';
    }
    if (wrap) props['textWrap'] = WRAP[wrap];
  }

  const curW = num(current['width']);
  const curH = num(current['height']);
  const keep = args['keepAspect'] !== false;
  if (widthMm !== undefined) props['width'] = mmToHu(widthMm);
  if (heightMm !== undefined) props['height'] = mmToHu(heightMm);
  if (keep && widthMm !== undefined && heightMm === undefined && curW > 0) {
    props['height'] = Math.max(1, Math.round((props['width'] as number) * curH / curW));
  }
  if (keep && heightMm !== undefined && widthMm === undefined && curH > 0) {
    props['width'] = Math.max(1, Math.round((props['height'] as number) * curW / curH));
  }

  if (present(args, 'cropMm')) {
    if (kind !== 'picture') throw invalid('cropMm applies to pictures only');
    Object.assign(props, planCrop(args['cropMm'], current, widthMm === undefined && heightMm === undefined));
  }

  if (Object.keys(props).length === 0 && !zOrder) {
    throw invalid(`edit_object needs delete or at least one of ${EDIT_OBJECT_ARG_KEYS.join(', ')}`);
  }
  const prevKeys = new Set(Object.keys(props));
  if (prevKeys.has('treatAsChar')) for (const key of PLACEMENT_KEYS) prevKeys.add(key);
  const prevProps: Record<string, unknown> = {};
  for (const key of prevKeys) {
    if (current[key] !== undefined) prevProps[key] = current[key];
  }
  return { props, prevProps, ...(zOrder ? { zOrder } : {}) };
}

/**
 * cropMm {left?,top?,right?,bottom?} — 원본 이미지 기준으로 각 변에서 잘라 낼 mm.
 * 크기를 따로 주지 않으면 보이는 원본이 줄어든 만큼 표시 크기도 줄여 배율을 지킨다
 * (남은 부분이 원래 상자로 늘어나지 않게).
 */
function planCrop(
  raw: unknown, current: Record<string, unknown>, rescale: boolean,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('cropMm must be an object {left?, top?, right?, bottom?} in mm');
  }
  const rec = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(rec).filter((key) => !(CROP_SIDES as readonly string[]).includes(key));
  if (unknownKeys.length > 0) throw invalid(`unknown cropMm key ${unknownKeys.join('/')} — valid keys: ${CROP_SIDES.join(', ')}`);
  const cur = Object.fromEntries(CROP_SIDES.map((side) => [side, num(current[CROP_KEYS[side]])])) as Record<typeof CROP_SIDES[number], number>;
  const next = { ...cur };
  for (const side of CROP_SIDES) {
    const mm = mmArg(rec, side, { min: 0 });
    if (mm !== undefined) next[side] = mmToHu(mm);
  }
  const extentW = num(current['originalWidth']) > 0 ? num(current['originalWidth']) : num(current['width']);
  const extentH = num(current['originalHeight']) > 0 ? num(current['originalHeight']) : num(current['height']);
  if (extentW > 0 && next.left + next.right >= extentW) {
    throw invalid(`cropMm left + right must stay under the original width ${huToMm(extentW)}mm`);
  }
  if (extentH > 0 && next.top + next.bottom >= extentH) {
    throw invalid(`cropMm top + bottom must stay under the original height ${huToMm(extentH)}mm`);
  }
  const props: Record<string, unknown> = {
    cropLeft: next.left, cropTop: next.top, cropRight: next.right, cropBottom: next.bottom,
  };
  if (rescale && extentW > 0 && extentH > 0) {
    const visible = (extent: number, a: number, b: number): number => Math.max(1, extent - a - b);
    const w = num(current['width']);
    const h = num(current['height']);
    const newW = Math.round(w * visible(extentW, next.left, next.right) / visible(extentW, cur.left, cur.right));
    const newH = Math.round(h * visible(extentH, next.top, next.bottom) / visible(extentH, cur.top, cur.bottom));
    if (newW !== w) props['width'] = Math.max(1, newW);
    if (newH !== h) props['height'] = Math.max(1, newH);
  }
  return props;
}

/** 엔진 속성 → 에이전트가 읽는 짧은 상태 (mm) */
export function describeObject(kind: ObjectKind, props: Record<string, unknown>): Record<string, unknown> {
  const floating = props['treatAsChar'] === false;
  const out: Record<string, unknown> = {
    kind,
    widthMm: huToMm(num(props['width'])),
    heightMm: huToMm(num(props['height'])),
    positionMode: floating ? 'floating' : 'inline',
  };
  if (floating) {
    const horz = REL_NAME[String(props['horzRelTo'])] ?? String(props['horzRelTo']);
    const vert = REL_NAME[String(props['vertRelTo'])] ?? String(props['vertRelTo']);
    out['relativeTo'] = horz === vert || (horz === 'column' && vert === 'paragraph') ? horz : `${horz}/${vert}`;
    out['xMm'] = huToMm(signedHu(props['horzOffset']));
    out['yMm'] = huToMm(signedHu(props['vertOffset']));
    out['wrap'] = WRAP_NAME[String(props['textWrap'])] ?? props['textWrap'];
  }
  if (kind === 'picture') {
    const crop = Object.fromEntries(CROP_SIDES
      .map((side) => [side, huToMm(num(props[CROP_KEYS[side]]))] as const)
      .filter(([, mm]) => mm > 0));
    if (Object.keys(crop).length > 0) out['cropMm'] = crop;
  }
  return out;
}

export interface ShapeInsertPlan {
  shape: ShapeType;
  create: Record<string, unknown>;
  props: Record<string, unknown>;
}

/** HWP 색 참조 (0x00BBGGRR) */
function colorRef(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r | (g << 8) | (b << 16);
}

function colorArg(args: Record<string, unknown>, key: string): string | undefined {
  if (!present(args, key)) return undefined;
  const v = args[key];
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw invalid(`${key} must be "#RRGGBB"`);
  return v;
}

/**
 * insert_shape 인자 → createShapeControl 인자 + 생성 직후 setShapeProperties 속성.
 * 기본: 검은 선, 채우기 없음, 문단 기준 (0,0), 글 앞으로 (한컴 새 도형 기본 배치).
 */
export function planInsertShape(
  args: Record<string, unknown>, at: { sectionIdx: number; paraIdx: number; charOffset: number },
): ShapeInsertPlan {
  const shape = enumArg(args, 'shape', SHAPES);
  if (!shape) throw invalid(`shape must be ${SHAPES.join('|')}`);
  const widthMm = mmArg(args, 'widthMm', { min: 0 });
  const heightMm = mmArg(args, 'heightMm', { min: 0 });
  if (widthMm === undefined || heightMm === undefined) throw invalid('widthMm and heightMm are required');
  if (shape === 'line' ? widthMm === 0 && heightMm === 0 : widthMm === 0 || heightMm === 0) {
    throw invalid(shape === 'line' ? 'a line needs widthMm or heightMm above 0' : 'widthMm and heightMm must be above 0');
  }
  const relativeTo = enumArg(args, 'relativeTo', Object.keys(REL_TO)) ?? 'paragraph';
  const wrap = enumArg(args, 'wrap', Object.keys(WRAP)) ?? 'inFrontOfText';
  const xMm = mmArg(args, 'xMm') ?? 0;
  const yMm = mmArg(args, 'yMm') ?? 0;
  const stroke = colorArg(args, 'strokeColor') ?? '#000000';
  const fill = colorArg(args, 'fillColor');
  if (fill && shape === 'line') throw invalid('fillColor does not apply to lines');
  const [horz, vert] = REL_TO[relativeTo];
  const width = mmToHu(widthMm);
  const height = mmToHu(heightMm);
  return {
    shape,
    create: {
      sectionIdx: at.sectionIdx, paraIdx: at.paraIdx, charOffset: at.charOffset,
      width, height, horzOffset: 0, vertOffset: 0, treatAsChar: false,
      textWrap: WRAP[wrap], shapeType: shape === 'textBox' ? 'textbox' : shape,
    },
    props: {
      horzRelTo: horz, vertRelTo: vert, horzAlign: 'Left', vertAlign: 'Top',
      horzOffset: mmToHu(xMm) >>> 0, vertOffset: mmToHu(yMm) >>> 0,
      textWrap: WRAP[wrap],
      borderColor: colorRef(stroke),
      ...(fill ? { fillType: 'solid', fillBgColor: colorRef(fill) } : { fillType: 'none' }),
    },
  };
}
