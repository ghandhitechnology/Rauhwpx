/**
 * edit_object / insert_shape — executor → 실제 PendingEditManager → 가짜 wasm 경로.
 *
 * 그림·도형 편집은 호출 즉시 적용되고(미리보기 = 승인 결과) 문단 보관본·스냅샷·역연산으로
 * 되돌아간다. 같은 문단의 개체 번호 이동, 문단 분할 뒤 주소 추적, 글상자 글쓰기를 함께 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import { AgentToolExecutor, mmToHu } from '../src/agent/tool-executor.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolError } from '../src/agent/types.ts';
import { planObjectEdit } from '../src/agent/object-edit-args.ts';

type Kind = 'picture' | 'shape' | 'table';
interface FakeObj {
  kind: Kind;
  /** 문단 안 글자 위치 */
  pos: number;
  props: Record<string, unknown>;
  /** 표: 0번 셀 0번 문단의 그림 */
  cellPics?: FakeObj[];
  /** 글상자 안 문단 */
  textBox?: string[];
}
interface FakePara { text: string; controls: FakeObj[] }
type PathEntry = { controlIndex: number; cellIndex: number; cellParaIndex: number };

const picture = (pos: number, extra: Record<string, unknown> = {}): FakeObj => ({
  kind: 'picture', pos,
  props: {
    width: 2835, height: 1417, treatAsChar: true, horzRelTo: 'Para', vertRelTo: 'Para',
    horzAlign: 'Left', vertAlign: 'Top', horzOffset: 0, vertOffset: 0, textWrap: 'Square',
    originalWidth: 2835, originalHeight: 1417, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0,
    zOrder: 1, description: 'logo', ...extra,
  },
});

function makeEnv(paras: FakePara[]) {
  const calls: Array<{ m: string; a: unknown[] }> = [];
  const record = (m: string, ...a: unknown[]) => { calls.push({ m, a }); };
  const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra });
  const at = (p: number, c: number): FakeObj => {
    const obj = paras[p]?.controls[c];
    if (!obj) throw new Error(`컨트롤 없음 ${p}/${c}`);
    return obj;
  };
  const typed = (p: number, c: number, kind: Kind): FakeObj => {
    const obj = at(p, c);
    if (obj.kind !== kind) throw new Error(`${kind} 아님 ${p}/${c}`);
    return obj;
  };
  const cellPic = (p: number, path: PathEntry[], c: number): FakeObj => {
    const pics = typed(p, path[0].controlIndex, 'table').cellPics ?? [];
    if (!pics[c]) throw new Error('셀 그림 없음');
    return pics[c];
  };
  const textBox = (p: number, pathJson: string): string[] => {
    const path = JSON.parse(pathJson) as PathEntry[];
    const box = at(p, path[0].controlIndex).textBox;
    if (!box) throw new Error('글상자 아님');
    return box;
  };
  const setProps = (obj: FakeObj, props: Record<string, unknown>) => {
    Object.assign(obj.props, props);
    // 엔진 migrate_picture_floating_to_inline 처럼 글자처럼 취급이 되면 오프셋을 지운다
    if (props['treatAsChar'] === true) Object.assign(obj.props, { horzOffset: 0, vertOffset: 0, horzRelTo: 'Para', vertRelTo: 'Para' });
  };
  const floating = () => paras.flatMap((p) => p.controls).filter((o) => o.kind !== 'table' && o.props['treatAsChar'] === false);

  let captureId = 0;
  const captures = new Map<number, FakePara>();
  let snapshotId = 0;
  const snapshots = new Map<number, FakePara[]>();

  const wasm = {
    getSectionCount: () => 1,
    getParagraphCount: () => paras.length,
    getParagraphLength: (_s: number, p: number) => paras[p].text.length,
    getTextRange: (_s: number, p: number, off: number, n: number) => paras[p].text.slice(off, off + n),
    insertText: (_s: number, p: number, off: number, text: string) => {
      const para = paras[p];
      para.text = para.text.slice(0, off) + text + para.text.slice(off);
      for (const c of para.controls) if (c.pos >= off) c.pos += text.length;
      return JSON.stringify(ok({ charOffset: off + text.length }));
    },
    splitParagraphLogical: (_s: number, p: number, off: number) => {
      const para = paras[p];
      const moved = para.controls.filter((c) => c.pos >= off).map((c) => ({ ...c, pos: c.pos - off }));
      paras.splice(p, 1,
        { text: para.text.slice(0, off), controls: para.controls.filter((c) => c.pos < off) },
        { text: para.text.slice(off), controls: moved });
      return JSON.stringify(ok());
    },
    deleteRange: (_s: number, sp: number, so: number, ep: number, eo: number) => {
      const first = paras[sp];
      const last = paras[ep];
      const tail = last.controls.filter((c) => c.pos >= eo).map((c) => ({ ...c, pos: c.pos - eo + so }));
      paras.splice(sp, ep - sp + 1, {
        text: first.text.slice(0, so) + last.text.slice(eo),
        controls: [...first.controls.filter((c) => c.pos <= so), ...tail],
      });
      return ok();
    },
    getControlTextPositions: (_s: number, p: number) => paras[p].controls.map((c) => c.pos),
    getPictureProperties: (_s: number, p: number, c: number) => ({ ...typed(p, c, 'picture').props }),
    getShapeProperties: (_s: number, p: number, c: number) => ({ ...typed(p, c, 'shape').props }),
    setPictureProperties: (_s: number, p: number, c: number, props: Record<string, unknown>) => {
      record('setPictureProperties', p, c, props);
      setProps(typed(p, c, 'picture'), props);
      return ok();
    },
    setShapeProperties: (_s: number, p: number, c: number, props: Record<string, unknown>) => {
      record('setShapeProperties', p, c, props);
      setProps(typed(p, c, 'shape'), props);
      return ok();
    },
    deletePictureControl: (_s: number, p: number, c: number) => {
      typed(p, c, 'picture');
      paras[p].controls.splice(c, 1);
      return ok();
    },
    deleteShapeControl: (_s: number, p: number, c: number) => {
      typed(p, c, 'shape');
      paras[p].controls.splice(c, 1);
      return ok();
    },
    changeObjectZOrder: (_s: number, p: number, c: number, op: string) => {
      record('changeObjectZOrder', p, c, op);
      const target = at(p, c);
      const zs = floating().map((o) => o.props['zOrder'] as number);
      if (op === 'front') target.props['zOrder'] = Math.max(...zs) + 1;
      else if (op === 'back') target.props['zOrder'] = Math.min(...zs) - 1;
      else {
        const cur = target.props['zOrder'] as number;
        const others = floating().filter((o) => o !== target);
        const neighbor = op === 'forward'
          ? others.filter((o) => (o.props['zOrder'] as number) > cur).sort((a, b) => (a.props['zOrder'] as number) - (b.props['zOrder'] as number))[0]
          : others.filter((o) => (o.props['zOrder'] as number) < cur).sort((a, b) => (b.props['zOrder'] as number) - (a.props['zOrder'] as number))[0];
        if (neighbor) {
          target.props['zOrder'] = neighbor.props['zOrder'];
          neighbor.props['zOrder'] = cur;
        }
      }
      return ok({ zOrder: target.props['zOrder'] });
    },
    createShapeControl: (params: Record<string, unknown>) => {
      record('createShapeControl', params);
      const p = params['paraIdx'] as number;
      const off = params['charOffset'] as number;
      const para = paras[p];
      const idx = para.controls.filter((c) => c.pos <= off).length;
      para.controls.splice(idx, 0, {
        kind: 'shape', pos: off,
        props: {
          width: params['width'], height: params['height'], treatAsChar: false, horzRelTo: 'Paper', vertRelTo: 'Paper',
          horzOffset: 0, vertOffset: 0, textWrap: params['textWrap'], zOrder: 9, fillType: 'solid',
        },
        ...(params['shapeType'] === 'textbox' ? { textBox: [''] } : {}),
      });
      return ok({ paraIdx: p, controlIdx: idx });
    },
    // ─ 셀 (0번 셀 0번 문단의 그림) ─
    getTableDimensions: (_s: number, p: number, c: number) => {
      typed(p, c, 'table');
      return { rowCount: 1, colCount: 1, cellCount: 1 };
    },
    getCellParagraphCount: () => 1,
    getCellParagraphLength: () => 0,
    getCellParagraphCountByPath: (_s: number, p: number, pathJson: string) => {
      const path = JSON.parse(pathJson) as PathEntry[];
      const obj = at(p, path[0].controlIndex);
      if (obj.kind === 'table') return 1;
      if (!obj.textBox) throw new Error('컨테이너 아님');
      return obj.textBox.length;
    },
    getCellParagraphLengthByPath: (_s: number, p: number, pathJson: string) => {
      const path = JSON.parse(pathJson) as PathEntry[];
      const obj = at(p, path[0].controlIndex);
      return obj.textBox ? obj.textBox[path.at(-1)!.cellParaIndex].length : 0;
    },
    getTextInCellByPath: (_s: number, p: number, pathJson: string, off: number, n: number) =>
      textBox(p, pathJson)[(JSON.parse(pathJson) as PathEntry[]).at(-1)!.cellParaIndex].slice(off, off + n),
    insertTextInCellByPath: (_s: number, p: number, pathJson: string, off: number, text: string) => {
      const box = textBox(p, pathJson);
      const cp = (JSON.parse(pathJson) as PathEntry[]).at(-1)!.cellParaIndex;
      box[cp] = box[cp].slice(0, off) + text + box[cp].slice(off);
      return JSON.stringify(ok({ charOffset: off + text.length }));
    },
    deleteRangeInCellByPath: (_s: number, p: number, pathJson: string, sp: number, so: number, _ep: number, eo: number) => {
      const box = textBox(p, pathJson);
      box[sp] = box[sp].slice(0, so) + box[sp].slice(eo);
      return JSON.stringify(ok());
    },
    getCellPicturePropertiesByPath: (_s: number, p: number, path: PathEntry[], c: number) => ({ ...cellPic(p, path, c).props }),
    getCellShapePropertiesByPath: () => { throw new Error('셀 도형 없음'); },
    setCellPicturePropertiesByPath: (_s: number, p: number, path: PathEntry[], c: number, props: Record<string, unknown>) => {
      record('setCellPicturePropertiesByPath', p, path, c, props);
      setProps(cellPic(p, path, c), props);
      return ok();
    },
    // ─ 되돌림 수단 ─
    captureParagraph: (_s: number, p: number) => {
      captures.set(++captureId, structuredClone(paras[p]));
      return captureId;
    },
    restoreCapturedParagraph: (id: number, _s: number, p: number) => {
      record('restoreCapturedParagraph', p);
      paras[p] = structuredClone(captures.get(id)!);
    },
    discardParagraphCapture: (id: number) => { captures.delete(id); },
    getParagraphContentDigest: (_s: number, p: number) => JSON.stringify(paras[p]),
    saveSnapshot: () => {
      snapshots.set(++snapshotId, structuredClone(paras));
      return snapshotId;
    },
    restoreSnapshot: (id: number) => {
      record('restoreSnapshot', id);
      paras.splice(0, paras.length, ...structuredClone(snapshots.get(id)!));
    },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
    getCharPropertiesAt: () => ({ fontFamily: '바탕', fontSize: 1000 }),
    getPageControlLayout: () => ({ controls: [] }),
    getFieldList: () => [],
    get pageCount() { return 1; },
  };

  const bus = new EventBus();
  const revision = new RevisionTracker(bus);
  const inputHandler = {
    executeOperation: () => {},
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
  };
  const pending = new PendingEditManager({
    wasm: wasm as never,
    eventBus: bus,
    inputHandler: inputHandler as never,
    canvasView: {} as never,
    overlay: { setOps: () => {}, clear: () => {} } as never,
  });
  const executor = new AgentToolExecutor({
    wasm: wasm as never,
    inputHandler: inputHandler as never,
    documentState: { isDirty: () => false } as never,
    revision,
    pending,
  });
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    executor.execute(tool, { expectedRevision: revision.revision, ...args }, 'claude') as Promise<Record<string, any>>;
  const staged = async (tool: string, args: Record<string, unknown>) => {
    pending.beginTurn('claude');
    const result = await call(tool, args);
    pending.endTurn('review');
    return result;
  };
  return { call, staged, pending, calls, paras };
}

async function expectErr(p: Promise<unknown>, code: string, re?: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `AgentToolError 기대, 실제: ${e}`);
    assert.equal(e.code, code);
    if (re) assert.match(e.message, re);
    return;
  }
  assert.fail(`${code} 오류를 기대했지만 성공함`);
}

const docWithPicture = (): FakePara[] => [
  { text: 'Intro text', controls: [picture(5)] },
  { text: 'Second', controls: [] },
];

test('edit_object: 글자처럼 취급 그림을 떠 있게 옮기고 크기를 바꾼다 — 거절은 문단 보관본으로 되돌린다', async () => {
  const env = makeEnv(docWithPicture());
  const before = structuredClone(env.paras);
  const r = await env.staged('edit_object', {
    sectionIdx: 0, paraIdx: 0, controlIdx: 0, xMm: 20, yMm: -5, relativeTo: 'page', widthMm: 20,
  });
  const props = env.paras[0].controls[0].props;
  assert.equal(props['treatAsChar'], false);
  assert.equal(props['horzRelTo'], 'Page');
  assert.equal(props['horzOffset'], mmToHu(20));
  assert.equal(props['vertOffset'], mmToHu(-5)); // 그림 오프셋은 부호 있는 값 그대로
  assert.equal(props['textWrap'], 'Square');
  assert.equal(props['width'], mmToHu(20));
  assert.equal(props['height'], Math.round(mmToHu(20) * 1417 / 2835)); // 한쪽만 주면 비율 유지
  assert.deepEqual(
    { mode: r.object.positionMode, rel: r.object.relativeTo, x: r.object.xMm, y: r.object.yMm, w: r.object.widthMm },
    { mode: 'floating', rel: 'page', x: 20, y: -5, w: 20 },
  );
  env.pending.reject(r.changeSetId);
  assert.deepEqual(env.paras, before);
  assert.ok(env.calls.some((c) => c.m === 'restoreCapturedParagraph'));
});

test('edit_object: 승인은 미리보기를 그대로 남기고 드리프트로 버리지 않는다', async () => {
  const env = makeEnv(docWithPicture());
  const r = await env.staged('edit_object', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, positionMode: 'floating', wrap: 'behindText' });
  const drops: unknown[] = [];
  env.pending.onChange((e) => { if (e.type === 'invalidated') drops.push(e); });
  assert.equal(env.pending.approve(r.changeSetId), true);
  assert.deepEqual(drops, []);
  assert.equal(env.paras[0].controls[0].props['textWrap'], 'BehindText');
});

test('edit_object: 사용자가 크기를 바꾼 그림은 거절 시 드리프트로 남는다', async () => {
  const env = makeEnv(docWithPicture());
  const r = await env.staged('edit_object', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, widthMm: 30 });
  const drops: Array<{ drops?: Array<{ cause: string }> }> = [];
  env.pending.onChange((e) => { if (e.type === 'invalidated') drops.push(e); });
  env.paras[0].controls[0].props['width'] = 1234; // 사용자 수정
  env.pending.reject(r.changeSetId);
  assert.equal(drops[0]?.drops?.[0]?.cause, 'object-changed');
  assert.equal(env.paras[0].controls[0].props['width'], 1234);
});

test('edit_object: cropMm 은 원본 기준으로 자르고 표시 크기를 같은 배율로 줄인다', async () => {
  const env = makeEnv(docWithPicture());
  const r = await env.staged('edit_object', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, cropMm: { left: 2.5, right: 2.5 } });
  const props = env.paras[0].controls[0].props;
  assert.equal(props['cropLeft'], mmToHu(2.5));
  assert.equal(props['cropRight'], mmToHu(2.5));
  assert.equal(props['width'], 2835 - 2 * mmToHu(2.5));
  assert.equal(props['height'], 1417);
  assert.deepEqual(r.object.cropMm, { left: 2.5, right: 2.5 });
  await expectErr(env.call('edit_object', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, cropMm: { left: 6, right: 6 } }), 'INVALID_ARGS', /original width/);
});

test('edit_object: 앞뒤 순서는 스냅샷으로 되돌리고 글자처럼 취급 개체에는 거절한다', async () => {
  const env = makeEnv([
    { text: 'A', controls: [picture(0, { treatAsChar: false, zOrder: 1 }), picture(1, { treatAsChar: false, zOrder: 2 })] },
    { text: 'B', controls: [picture(0)] },
  ]);
  const r = await env.staged('edit_object', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, zOrder: 'front' });
  assert.equal(env.paras[0].controls[0].props['zOrder'], 3);
  env.pending.reject(r.changeSetId);
  assert.equal(env.paras[0].controls[0].props['zOrder'], 1);
  assert.ok(env.calls.some((c) => c.m === 'restoreSnapshot'));
  await expectErr(env.call('edit_object', { sectionIdx: 0, paraIdx: 1, controlIdx: 0, zOrder: 'back' }), 'INVALID_ARGS', /floating/);
});

test('edit_object delete: 뒤 개체 번호를 당기고 거절하면 되살린다', async () => {
  const env = makeEnv([{ text: 'Two pictures', controls: [picture(2), picture(8, { description: 'seal' })] }]);
  const before = structuredClone(env.paras);
  env.pending.beginTurn('claude');
  const del = await env.call('edit_object', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, delete: true });
  assert.deepEqual(del.deleted, { kind: 'picture', sectionIdx: 0, paraIdx: 0, controlIdx: 0 });
  assert.equal(env.paras[0].controls.length, 1);
  // 남은 그림은 이제 0번 — 같은 턴의 편집이 새 번호로 짚는다
  const moved = await env.call('edit_object', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, widthMm: 5 });
  env.pending.endTurn('review');
  assert.equal(moved.object.controlIdx, 0);
  env.pending.reject(del.changeSetId);
  assert.deepEqual(env.paras, before);
  await expectErr(env.call('edit_object', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, delete: true, widthMm: 3 }), 'INVALID_ARGS', /delete cannot be combined/);
});

test('edit_object: 문단 분할 뒤에도 옮겨 간 개체를 짚어 되돌린다', async () => {
  const env = makeEnv(docWithPicture());
  const before = structuredClone(env.paras);
  env.pending.beginTurn('claude');
  const r = await env.call('edit_object', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, positionMode: 'floating', xMm: 10 });
  // 그림(글자 위치 5) 앞에서 문단을 나눈다 — 엔진은 그림을 새 문단 0번으로 옮긴다
  await env.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 2, text: 'X\nY' });
  env.pending.endTurn('review');
  assert.equal(env.paras[1].controls.length, 1);
  env.pending.reject(r.changeSetId);
  assert.deepEqual(env.paras, before);
});

test('edit_object: 셀 안 그림은 셀 문단 좌표와 경로 API 로 고친다', async () => {
  const table: FakeObj = { kind: 'table', pos: 0, props: {}, cellPics: [picture(0)] };
  const env = makeEnv([{ text: '', controls: [table] }]);
  const r = await env.staged('edit_object', {
    sectionIdx: 0, paraIdx: 0, controlIdx: 0, cell: { paraIdx: 0, controlIdx: 0, cellIdx: 0 }, widthMm: 8,
  });
  const set = env.calls.find((c) => c.m === 'setCellPicturePropertiesByPath')!;
  assert.deepEqual(set.a[1], [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }]);
  assert.equal(table.cellPics![0].props['width'], mmToHu(8));
  env.pending.reject(r.changeSetId);
  assert.equal((env.paras[0].controls[0].cellPics![0].props['width']), 2835);
  await expectErr(env.call('edit_object', {
    sectionIdx: 0, paraIdx: 0, controlIdx: 0, cell: { paraIdx: 0, controlIdx: 0, cellIdx: 0 }, zOrder: 'front',
  }), 'INVALID_ARGS', /floating objects in the body/);
});

test('insert_shape: 검은 선·채우기 없음으로 떠 있게 넣고 같은 문단 뒤 개체 번호를 민다', async () => {
  const env = makeEnv([{ text: 'Anchor paragraph', controls: [picture(10)] }]);
  env.pending.beginTurn('claude');
  const pic = await env.call('edit_object', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, widthMm: 12 });
  const r = await env.call('insert_shape', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, shape: 'rectangle', widthMm: 40, heightMm: 20, xMm: 5, yMm: -3,
  });
  env.pending.endTurn('review');
  assert.equal(pic.object.controlIdx, 0);
  assert.deepEqual(r.shape, { sectionIdx: 0, paraIdx: 0, controlIdx: 0 });
  const create = env.calls.find((c) => c.m === 'createShapeControl')!.a[0] as Record<string, unknown>;
  assert.equal(create['shapeType'], 'rectangle');
  assert.equal(create['treatAsChar'], false);
  const props = env.paras[0].controls[0].props;
  assert.equal(props['fillType'], 'none');
  assert.equal(props['borderColor'], 0);
  assert.equal(props['textWrap'], 'InFrontOfText');
  assert.equal(props['horzRelTo'], 'Para');
  assert.equal(props['vertOffset'], mmToHu(-3) >>> 0); // 도형 오프셋은 u32 로 넘긴다
  // 그림은 1번으로 밀렸다 — 승인 검증이 그 자리의 그림을 읽어 드리프트 없이 남긴다
  const drops: unknown[] = [];
  env.pending.onChange((e) => { if (e.type === 'invalidated') drops.push(e); });
  assert.equal(env.pending.approve(r.changeSetId), true);
  assert.deepEqual(drops, []);
  assert.equal(env.paras[0].controls[1].props['width'], mmToHu(12));
});

test('insert_shape textBox: 돌려준 셀 주소로 글을 쓰고 거절하면 글상자째 사라진다', async () => {
  const env = makeEnv([{ text: 'Body', controls: [] }]);
  const before = structuredClone(env.paras);
  env.pending.beginTurn('claude');
  const r = await env.call('insert_shape', { sectionIdx: 0, paraIdx: 0, shape: 'textBox', widthMm: 50, heightMm: 15 });
  assert.deepEqual(r.textBox, {
    cell: { paraIdx: 0, controlIdx: 0, cellIdx: 0 },
    cellPath: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }],
  });
  await env.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'Boxed', ...r.textBox });
  env.pending.endTurn('review');
  assert.deepEqual(env.paras[0].controls[0].textBox, ['Boxed']);
  env.pending.reject(r.changeSetId);
  assert.deepEqual(env.paras, before);
});

test('edit_object 와 insert_shape 는 apply_edits 배치로 한 번에 들어간다', async () => {
  const env = makeEnv(docWithPicture());
  const r = await env.staged('apply_edits', {
    edits: [
      { tool: 'edit_object', args: { sectionIdx: 0, paraIdx: 0, controlIdx: 0, positionMode: 'floating', yMm: 4 } },
      { tool: 'insert_shape', args: { sectionIdx: 0, paraIdx: 1, shape: 'line', widthMm: 100, heightMm: 0 } },
    ],
  });
  assert.equal(r.applied, 2);
  assert.equal(env.paras[1].controls[0].kind, 'shape');
  // 한 항목이 실패하면 배치 전체가 되돌아간다
  const before = structuredClone(env.paras);
  await expectErr(env.call('apply_edits', {
    edits: [
      { tool: 'insert_shape', args: { sectionIdx: 0, paraIdx: 1, shape: 'ellipse', widthMm: 10, heightMm: 10 } },
      { tool: 'edit_object', args: { sectionIdx: 0, paraIdx: 1, controlIdx: 9, widthMm: 5 } },
    ],
  }), 'INVALID_ARGS', /No picture or shape/);
  assert.deepEqual(env.paras, before);
});

test('planObjectEdit: 역연산은 글자처럼 취급 전환이 바꾸는 배치 속성을 모두 담는다', () => {
  const current = picture(0).props;
  const plan = planObjectEdit({ wrap: 'topAndBottom' }, 'picture', current);
  assert.deepEqual(Object.keys(plan.prevProps).sort(), [
    'horzAlign', 'horzOffset', 'horzRelTo', 'textWrap', 'treatAsChar', 'vertAlign', 'vertOffset', 'vertRelTo',
  ]);
  assert.throws(() => planObjectEdit({ positionMode: 'inline', xMm: 3 }, 'picture', current), /drop positionMode/);
  assert.throws(() => planObjectEdit({}, 'shape', current), /at least one of/);
  assert.throws(() => planObjectEdit({ cropMm: { left: 1 } }, 'shape', current), /pictures only/);
});
