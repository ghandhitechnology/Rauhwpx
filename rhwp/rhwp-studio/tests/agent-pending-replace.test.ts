/**
 * 에이전트 pending 편집 — 원자적 교체(replace) / 스칼라 오프셋 / 드리프트 오탐 수정 테스트.
 *
 * 가짜 wasm 은 모든 오프셋을 코드포인트(Unicode scalar) 단위로 처리한다 — 실제
 * wasm 과 동일한 계약이다. 문자열 slice 를 `[...s]` 기반으로 수행하므로 JS .length
 * (UTF-16)를 쓰는 구현 버그가 그대로 재현된다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolError } from '../src/agent/types.ts';
import type { DocRange } from '../src/agent/types.ts';

// ─── 코드포인트 단위 가짜 wasm ─────────────────────────────

interface FakePara {
  chars: string[];      // 코드포인트 배열
  shapes: number[];     // 코드포인트별 charShapeId
  paraShapeId: number;
}

function paraOf(text: string, shapeId = 0, paraShapeId = 1): FakePara {
  const chars = [...text];
  return { chars, shapes: chars.map(() => shapeId), paraShapeId };
}

function paraText(p: FakePara): string {
  return p.chars.join('');
}

function makeFakeWasm(initial: FakePara[]) {
  let body = initial;
  const calls: Array<{ m: string; args: unknown[] }> = [];
  const record = (m: string, ...args: unknown[]) => { calls.push({ m, args }); };
  const okJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ ok: true, ...extra });

  // 표 (paraIdx/controlIdx 키) — 구조 op 가드 테스트용
  const tables = new Map<string, { rowCount: number; colCount: number }>();
  const tkey = (p: number, c: number) => `${p}/${c}`;

  // 필드
  const fields: Array<{ fieldId: number; name: string; value: string }> = [];

  let snapshotId = 0;
  const snapshots = new Map<number, FakePara[]>();
  const cloneBody = (b: FakePara[]): FakePara[] =>
    b.map((p) => ({ chars: [...p.chars], shapes: [...p.shapes], paraShapeId: p.paraShapeId }));

  const wasm = {
    getSectionCount: () => 1,
    getParagraphCount: (_s: number) => body.length,
    getParagraphLength: (_s: number, p: number) => body[p].chars.length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) =>
      body[p].chars.slice(off, off + cnt).join(''),
    insertText: (_s: number, p: number, off: number, t: string) => {
      record('insertText', p, off, t);
      const chars = [...t];
      const inherit = off > 0 ? body[p].shapes[off - 1] : (body[p].shapes[0] ?? 0);
      body[p].chars.splice(off, 0, ...chars);
      body[p].shapes.splice(off, 0, ...chars.map(() => inherit));
      return okJson({ charOffset: off + chars.length });
    },
    splitParagraph: (_s: number, p: number, off: number) => {
      record('splitParagraph', p, off);
      const cur = body[p];
      const head: FakePara = {
        chars: cur.chars.slice(0, off), shapes: cur.shapes.slice(0, off), paraShapeId: cur.paraShapeId,
      };
      const tail: FakePara = {
        chars: cur.chars.slice(off), shapes: cur.shapes.slice(off), paraShapeId: cur.paraShapeId,
      };
      body.splice(p, 1, head, tail);
      return okJson();
    },
    deleteRange: (_s: number, sp: number, so: number, ep: number, eo: number) => {
      record('deleteRange', sp, so, ep, eo);
      const first = body[sp];
      const last = body[ep];
      const merged: FakePara = {
        chars: [...first.chars.slice(0, so), ...last.chars.slice(eo)],
        shapes: [...first.shapes.slice(0, so), ...last.shapes.slice(eo)],
        paraShapeId: first.paraShapeId,
      };
      body.splice(sp, ep - sp + 1, merged);
      return { ok: true };
    },
    getCharPropertiesAt: (_s: number, p: number, off: number) => {
      const len = body[p].chars.length;
      const shape = len === 0 ? 0 : body[p].shapes[Math.min(off, len - 1)];
      return { charShapeId: shape };
    },
    setCharShapeId: (_s: number, p: number, so: number, eo: number, id: number) => {
      record('setCharShapeId', p, so, eo, id);
      for (let i = so; i < eo && i < body[p].shapes.length; i++) body[p].shapes[i] = id;
      return okJson();
    },
    getParaPropertiesAt: (_s: number, p: number) => ({ paraShapeId: body[p].paraShapeId }),
    setParaShapeId: (_s: number, p: number, id: number) => {
      record('setParaShapeId', p, id);
      body[p].paraShapeId = id;
      return okJson();
    },
    applyParaFormat: (_s: number, p: number, json: string) => {
      record('applyParaFormat', p, json);
      try {
        const props = JSON.parse(json) as { paraShapeId?: number };
        if (typeof props.paraShapeId === 'number') body[p].paraShapeId = props.paraShapeId;
      } catch { /* ignore */ }
      return okJson();
    },
    applyCharFormat: (_s: number, p: number, so: number, eo: number, json: string) => {
      record('applyCharFormat', p, so, eo, json);
      return okJson();
    },
    setFieldValueByName: (name: string, value: string) => {
      const f = fields.find((cand) => cand.name === name);
      if (!f) return { ok: false };
      const oldValue = f.value;
      f.value = value;
      return { ok: true, fieldId: f.fieldId, oldValue, newValue: value };
    },
    getFieldList: () => fields.map((f) => ({
      fieldId: f.fieldId, fieldType: 'clickhere', name: f.name, guide: '', command: '', value: f.value,
      location: { sectionIndex: 0, paraIndex: 0 },
    })),
    // 표 구조
    addFakeTable: (paraIdx: number, controlIdx: number, rowCount: number, colCount: number) => {
      tables.set(tkey(paraIdx, controlIdx), { rowCount, colCount });
    },
    getTableDimensions: (_s: number, p: number, c: number) => {
      const t = tables.get(tkey(p, c));
      if (!t) throw new Error('표 컨트롤이 없습니다');
      return { rowCount: t.rowCount, colCount: t.colCount, cellCount: t.rowCount * t.colCount };
    },
    insertTableRow: (_s: number, p: number, c: number, _i: number, _after: boolean) => {
      const t = tables.get(tkey(p, c))!;
      t.rowCount += 1;
      return { ok: true, rowCount: t.rowCount, colCount: t.colCount };
    },
    insertTableColumn: (_s: number, p: number, c: number, _i: number, _after: boolean) => {
      const t = tables.get(tkey(p, c))!;
      t.colCount += 1;
      return { ok: true, rowCount: t.rowCount, colCount: t.colCount };
    },
    deleteTableRow: (_s: number, p: number, c: number, _i: number) => {
      const t = tables.get(tkey(p, c))!;
      t.rowCount -= 1;
      return { ok: true, rowCount: t.rowCount, colCount: t.colCount };
    },
    deleteTableColumn: (_s: number, p: number, c: number, _i: number) => {
      const t = tables.get(tkey(p, c))!;
      t.colCount -= 1;
      return { ok: true, rowCount: t.rowCount, colCount: t.colCount };
    },
    // 스냅샷
    saveSnapshot: () => {
      const id = ++snapshotId;
      snapshots.set(id, cloneBody(body));
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id);
      if (!saved) throw new Error(`snapshot ${id} not found`);
      body = cloneBody(saved);
    },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
    getSourceFormat: () => 'hwpx',
    get documentDigest() { return 'blake3:replace-test'; },
    getSelectionRects: () => [],
    renderPageSvg: () => '<svg/>',
  };
  return {
    wasm,
    calls,
    fields,
    // 사용자 편집 시뮬레이션용 직접 접근 (manager 를 우회하는 untracked drift)
    mutatePara(p: number, fn: (para: FakePara) => void) { fn(body[p]); },
    text: (p: number) => paraText(body[p]),
    shapes: (p: number) => [...body[p].shapes],
    paraShape: (p: number) => body[p].paraShapeId,
    paraCount: () => body.length,
    snapshotCount: () => snapshots.size,
  };
}

function makeManager(initial: FakePara[]) {
  const fake = makeFakeWasm(initial);
  const eventBus = new EventBus();
  const recorded: Array<{ kind: string; command: { undo(w: unknown): void; execute(w: unknown): void } }> = [];
  const inputHandler = {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    executeOperation: (desc: { kind: string; command?: never; operation?: (w: unknown) => void }) => {
      if (desc.kind === 'record') recorded.push(desc as never);
      else desc.operation?.(fake.wasm);
    },
    prepareSnapshotCapacity: () => {},
  };
  const overlayOps: Array<Array<{ kind: string }>> = [];
  const overlay = {
    setOps: (ops: Array<{ kind: string }>) => { overlayOps.push(ops.map((o) => ({ kind: o.kind }))); },
    clear: () => {},
  };
  const mgr = new PendingEditManager({
    wasm: fake.wasm as never,
    eventBus,
    inputHandler: inputHandler as never,
    canvasView: {} as never,
    overlay: overlay as never,
  });
  const events: string[] = [];
  mgr.onChange((e) => events.push(e.type));
  return { mgr, fake, recorded, overlayOps, events };
}

// ─── 원자적 교체 ─────────────────────────────────────────

test('replaceText: 하나의 op 로 기록되고 시작 지점 글자 모양이 삽입 텍스트에 적용된다', () => {
  // "hello world" — "world" 부분은 charShapeId 7
  const para = paraOf('hello ');
  const world = paraOf('world', 7);
  const merged: FakePara = {
    chars: [...para.chars, ...world.chars],
    shapes: [...para.shapes, ...world.shapes],
    paraShapeId: 1,
  };
  const { mgr, fake, overlayOps } = makeManager([merged]);

  const range: DocRange = {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 6, endParaIdx: 0, endCharOffset: 11,
  };
  const r = mgr.replaceText(range, '세상', 'claude');

  assert.equal(fake.text(0), 'hello 세상');
  assert.deepEqual(fake.shapes(0), [0, 0, 0, 0, 0, 0, 7, 7]); // 시작 지점(6)의 모양 7 상속
  assert.deepEqual(r.insertedRange, {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 6, endParaIdx: 0, endCharOffset: 8,
  });
  const sets = mgr.getChangeSets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0].ops.length, 1);
  assert.equal(sets[0].ops[0].kind, 'replace');
  // 오버레이에도 하나의 엔트리로 표시된다
  const last = overlayOps[overlayOps.length - 1];
  assert.equal(last.length, 1);
  assert.equal(last[0].kind, 'replace');
});

test('replaceText: 멀티라인 교체는 문단 분할을 수행하고 범위를 정확히 반환한다', () => {
  const { mgr, fake } = makeManager([paraOf('abcd')]);
  const r = mgr.replaceText(
    { sectionIdx: 0, startParaIdx: 0, startCharOffset: 1, endParaIdx: 0, endCharOffset: 3 },
    'X\nY',
    'claude',
  );
  assert.equal(fake.paraCount(), 2);
  assert.equal(fake.text(0), 'aX');
  assert.equal(fake.text(1), 'Yd');
  assert.deepEqual(r.insertedRange, {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 1, endParaIdx: 1, endCharOffset: 1,
  });
});

test('replaceText reject: 혼합 서식의 원본이 텍스트와 서식 모두 정확히 복원된다', () => {
  // "hello " + "wor"(5) + "ld"(9) — 혼합 서식
  const head = paraOf('hello ');
  const mid = paraOf('wor', 5);
  const tail = paraOf('ld', 9);
  const merged: FakePara = {
    chars: [...head.chars, ...mid.chars, ...tail.chars],
    shapes: [...head.shapes, ...mid.shapes, ...tail.shapes],
    paraShapeId: 1,
  };
  const { mgr, fake } = makeManager([merged]);
  const r = mgr.replaceText(
    { sectionIdx: 0, startParaIdx: 0, startCharOffset: 6, endParaIdx: 0, endCharOffset: 11 },
    'XYZ',
    'claude',
  );
  assert.equal(fake.text(0), 'hello XYZ');
  mgr.reject(r.changeSetId);
  assert.equal(fake.text(0), 'hello world');
  assert.deepEqual(fake.shapes(0), [0, 0, 0, 0, 0, 0, 5, 5, 5, 9, 9]); // 스냅샷 복원 — 혼합 서식 그대로
  assert.equal(mgr.hasPending(), false);
});

test('replaceText approve: 단일 히스토리 항목으로 채택되고 undo 가 원본을 정확히 복원한다', () => {
  const head = paraOf('hello ');
  const mid = paraOf('wor', 5);
  const tail = paraOf('ld', 9);
  const merged: FakePara = {
    chars: [...head.chars, ...mid.chars, ...tail.chars],
    shapes: [...head.shapes, ...mid.shapes, ...tail.shapes],
    paraShapeId: 1,
  };
  const { mgr, fake, recorded } = makeManager([merged]);
  const r = mgr.replaceText(
    { sectionIdx: 0, startParaIdx: 0, startCharOffset: 6, endParaIdx: 0, endCharOffset: 11 },
    'XYZ',
    'claude',
  );
  mgr.approve(r.changeSetId);
  assert.equal(mgr.hasPending(), false);
  assert.equal(fake.text(0), 'hello XYZ');
  assert.equal(recorded.length, 1); // 단일 undo 항목
  recorded[0].command.undo(fake.wasm);
  assert.equal(fake.text(0), 'hello world');
  assert.deepEqual(fake.shapes(0), [0, 0, 0, 0, 0, 0, 5, 5, 5, 9, 9]);
  recorded[0].command.execute(fake.wasm); // redo
  assert.equal(fake.text(0), 'hello XYZ');
});

test('replaceText: 다른 set 의 나중 미리보기가 있으면 폴백(역연산)으로 되돌린다', () => {
  const { mgr, fake } = makeManager([paraOf('foo bar baz', 3)]);
  const a = mgr.replaceText(
    { sectionIdx: 0, startParaIdx: 0, startCharOffset: 4, endParaIdx: 0, endCharOffset: 7 },
    'BAR',
    'claude',
  );
  mgr.endTurn();
  // 두 번째 턴 — 다른 set 의 나중 삽입
  const b = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 11 }, '!');
  assert.equal(fake.text(0), 'foo BAR baz!');

  mgr.reject(a.changeSetId);
  // A 의 교체만 되돌아가고 B 의 삽입은 유지돼야 한다
  assert.equal(fake.text(0), 'foo bar baz!');
  assert.deepEqual(fake.shapes(0).slice(4, 7), [3, 3, 3]); // 캡처한 서식으로 복원
  mgr.reject(b.changeSetId);
  assert.equal(fake.text(0), 'foo bar baz');
});

// ─── 스칼라 오프셋 (astral 문자) ──────────────────────────

test('스칼라 오프셋: emoji 가 포함된 삽입의 reject 가 정확히 되돌린다', () => {
  const { mgr, fake } = makeManager([paraOf('가😀나')]); // 3 scalars
  const r = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 2 }, 'a😀b');
  assert.equal(fake.text(0), '가😀a😀b나');
  // 스칼라 단위라면 끝 오프셋은 2 + 3 = 5 (UTF-16 이라면 6 으로 어긋남)
  assert.equal(r.insertedRange.endCharOffset, 5);
  mgr.reject(r.changeSetId);
  assert.equal(fake.text(0), '가😀나'); // "나" 가 잘리지 않아야 한다
});

test('스칼라 오프셋: emoji 범위 교체의 승인/거절이 정확하다', () => {
  const { mgr, fake } = makeManager([paraOf('가😀나')]);
  const r = mgr.replaceText(
    { sectionIdx: 0, startParaIdx: 0, startCharOffset: 1, endParaIdx: 0, endCharOffset: 2 },
    '🎉🎉',
    'claude',
  );
  assert.equal(fake.text(0), '가🎉🎉나');
  assert.equal(r.insertedRange.endCharOffset, 3);
  mgr.reject(r.changeSetId);
  assert.equal(fake.text(0), '가😀나');

  const r2 = mgr.replaceText(
    { sectionIdx: 0, startParaIdx: 0, startCharOffset: 1, endParaIdx: 0, endCharOffset: 2 },
    '🎉',
    'claude',
  );
  mgr.approve(r2.changeSetId);
  assert.equal(fake.text(0), '가🎉나');
});

// ─── 드리프트 오탐 수정 ───────────────────────────────────

test('textSample 스테일너스: 자신의 삽입 후에도 paraFormat op 이 드리프트로 오판되지 않는다', () => {
  const { mgr, fake } = makeManager([paraOf('some text here for the sample paragraph')]);
  const sample = fake.text(0).slice(0, 24);
  const fmt = mgr.addObjectOp('claude', {
    type: 'paraFormat', sectionIdx: 0, paraIdx: 0,
    propsJson: JSON.stringify({ paraShapeId: 42 }),
    prevParaShapeId: -1, charOffset: 0, textSample: sample,
  });
  assert.equal(fake.paraShape(0), 42);
  // 에이전트 자신의 후속 삽입 — 같은 문단 앞쪽에 텍스트 추가
  mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 0 }, 'NEW ');
  // reject — paraFormat 이 드리프트로 버려지면 서식이 복원되지 않는다
  mgr.reject(fmt.changeSetId);
  assert.equal(fake.paraShape(0), 1); // prevParaShapeId 로 복원
  assert.equal(fake.text(0), 'some text here for the sample paragraph'); // 삽입도 되돌아감
});

test('중첩 삽입: 안쪽 삽입이 있어도 reject 가 바깥 op 을 드리프트로 버리지 않는다', () => {
  const { mgr, fake } = makeManager([paraOf('base')]);
  const outer = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 4 }, 'ABC');
  mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 5 }, 'X'); // "baseAXBC"
  assert.equal(fake.text(0), 'baseAXBC');
  mgr.reject(outer.changeSetId);
  assert.equal(fake.text(0), 'base'); // 둘 다 되돌아가야 한다
});

test('중첩 삽입 approve: 둘 다 채택되고 단일 히스토리 항목이다', () => {
  const { mgr, fake, recorded } = makeManager([paraOf('base')]);
  const outer = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 4 }, 'ABC');
  mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 6 }, 'YY'); // "baseABYYC"
  assert.equal(fake.text(0), 'baseABYYC');
  mgr.approve(outer.changeSetId);
  assert.equal(fake.text(0), 'baseABYYC');
  assert.equal(recorded.length, 1);
});

test('멀티 문단 검증은 전체 텍스트를 비교한다 — 두 번째 문단의 사용자 수정을 감지한다', () => {
  const { mgr, fake, events } = makeManager([paraOf('first line'), paraOf('second line')]);
  const del = mgr.markDelete('claude', {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 1, endCharOffset: 11,
  });
  // 사용자가 두 번째 문단을 수정 (untracked drift) — 첫 줄 검사로는 못 잡는다
  fake.mutatePara(1, (p) => { p.chars[0] = 'S'; });
  mgr.approve(del.changeSetId);
  assert.equal(fake.text(0), 'first line'); // 삭제가 실행되지 않아야 한다
  assert.equal(fake.text(1), 'Second line');
  assert.ok(events.includes('invalidated'));
});

// ─── approve 방치 수정 ────────────────────────────────────

test('all-drifted approve: 미리보기를 방치하지 않고 채택하며 히스토리 항목을 남긴다', () => {
  const { mgr, fake, recorded, events } = makeManager([paraOf('base')]);
  const ins = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 4 }, 'AGENT');
  // 사용자가 pending 텍스트 안쪽을 수정 → 모든 op 이 드리프트된다
  fake.mutatePara(0, (p) => {
    p.chars.splice(6, 0, '!', '!');
    p.shapes.splice(6, 0, 0, 0);
  });
  assert.equal(fake.text(0), 'baseAG!!ENT');
  mgr.approve(ins.changeSetId);
  assert.equal(mgr.hasPending(), false);
  assert.equal(fake.text(0), 'baseAG!!ENT'); // 사용자 수정을 지우지 않는다
  assert.equal(recorded.length, 1); // 히스토리 항목이 남는다 (방치 아님)
  assert.ok(events.includes('approved'));
  // undo 하면 미리보기분이 제거된다
  recorded[0].command.undo(fake.wasm);
  assert.ok(!fake.text(0).includes('AG!!ENT'));
});

// ─── 새 public API ────────────────────────────────────────

test('hasPendingStructureOp: 적용된 구조 op 과 마크된 구조 op 모두 감지한다', () => {
  const { mgr, fake } = makeManager([paraOf('p0'), paraOf(''), paraOf('')]);
  fake.wasm.addFakeTable(1, 0, 2, 2);
  fake.wasm.addFakeTable(2, 0, 3, 3);
  assert.equal(mgr.hasPendingStructureOp(0, 1, 0), false);

  mgr.addObjectOp('claude', {
    type: 'tableStructure', sectionIdx: 0, tableParaIdx: 1, controlIdx: 0,
    op: 'insert_row', index: 0, after: true,
  });
  assert.equal(mgr.hasPendingStructureOp(0, 1, 0), true);  // applied-now insert_row
  assert.equal(mgr.hasPendingStructureOp(0, 2, 0), false); // 다른 표

  mgr.addObjectOp('claude', {
    type: 'tableStructureMarked', sectionIdx: 0, tableParaIdx: 2, controlIdx: 0,
    op: 'delete_row', rowIdx: 1, dims: { rowCount: 3, colCount: 3 },
  });
  assert.equal(mgr.hasPendingStructureOp(0, 2, 0), true); // 마크된 delete_row
  assert.equal(mgr.hasPendingStructureOp(0, 9, 9), false);
});

test('setFieldValue 실패: FIELD_NOT_FOUND 와 get_fields 안내를 던진다', () => {
  const { mgr } = makeManager([paraOf('x')]);
  try {
    mgr.setFieldValue('claude', '없는필드', 'v');
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof AgentToolError);
    assert.equal(e.code, 'FIELD_NOT_FOUND');
    assert.match(e.message, /get_fields/);
  }
});

test('setFieldValue 드리프트 프로브: 사용자가 값을 바꾸면 되돌리지 않는다', () => {
  const { mgr, fake } = makeManager([paraOf('x')]);
  fake.fields.push({ fieldId: 1, name: 'title', value: 'old' });
  const r = mgr.setFieldValue('claude', 'title', 'new');
  assert.equal(fake.fields[0].value, 'new');
  // 사용자가 리뷰 중 값을 직접 수정
  fake.fields[0].value = 'user-edit';
  mgr.reject(r.changeSetId);
  assert.equal(fake.fields[0].value, 'user-edit'); // old 로 덮어쓰지 않는다
});

test('describeChangeSet: 종류/적용 여부/다이제스트/좌표를 요약한다', () => {
  const { mgr } = makeManager([paraOf('base text')]);
  const ins = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 5 }, 'NEW');
  mgr.markDelete('claude', {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 4,
  });
  const d = mgr.describeChangeSet(ins.changeSetId);
  assert.equal(d.changeSetId, ins.changeSetId);
  assert.equal(d.status, 'open');
  assert.equal(d.agent, 'claude');
  assert.equal(d.ops.length, 2);
  assert.equal(d.ops[0].kind, 'insert');
  assert.equal(d.ops[0].applied, true);
  assert.match(d.ops[0].summary, /insert "NEW"/);
  assert.match(d.ops[0].summary, /p0:5-p0:8/);
  assert.equal(d.ops[1].kind, 'delete');
  assert.equal(d.ops[1].applied, false);
  // 인자 생략 시 최근 set, 없는 id 는 null
  assert.equal(mgr.describeChangeSet().changeSetId, ins.changeSetId);
  assert.equal(mgr.describeChangeSet('nope').changeSetId, null);
});

test('withMarkedOpsApplied: 마크 op 을 임시 적용하고 항상 복원한다', () => {
  const { mgr, fake } = makeManager([paraOf('keep drop rest')]);
  const ins = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 0 }, 'A ');
  mgr.markDelete('claude', {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 7, endParaIdx: 0, endCharOffset: 11,
  }); // "drop" 마크 (삽입으로 인덱스 이동 반영됨)
  mgr.endTurn();

  const seen: string[] = [];
  const out = mgr.withMarkedOpsApplied(ins.changeSetId, () => {
    seen.push(fake.text(0));
    // 재진입 — 같은 set 이면 다시 적용하지 않고 그대로 실행한다
    mgr.withMarkedOpsApplied(ins.changeSetId, () => seen.push(fake.text(0)));
    return 42;
  });
  assert.equal(out, 42);
  assert.deepEqual(seen, ['A keep  rest', 'A keep  rest']); // "drop" 삭제된 상태가 보인다
  assert.equal(fake.text(0), 'A keep drop rest'); // 복원됨
  assert.equal(mgr.hasPending(), true); // set 은 그대로 남아 있다

  // fn 이 throw 하든 복원된다
  assert.throws(() => mgr.withMarkedOpsApplied(ins.changeSetId, () => { throw new Error('boom'); }));
  assert.equal(fake.text(0), 'A keep drop rest');

  // 복원 후 approve 는 정상 동작해야 한다 (op 좌표가 깨지지 않았다)
  mgr.approve(ins.changeSetId);
  assert.equal(fake.text(0), 'A keep  rest');
});
