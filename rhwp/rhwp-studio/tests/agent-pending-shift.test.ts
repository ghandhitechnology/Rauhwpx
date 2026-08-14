import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftPointAfterInsert, shiftPointAfterDelete } from '../src/agent/pending-edits.ts';
import type { DocRange } from '../src/agent/types.ts';

const singleLineIns = {
  paraIdx: 2, charOffset: 5, addedParas: 0, endParaIdx: 2, endCharOffset: 8, textLen: 3,
};

const multiLineIns = {
  // "ab\ncd" 를 (2,5) 에 삽입 → 끝 (3,2), addedParas 1
  paraIdx: 2, charOffset: 5, addedParas: 1, endParaIdx: 3, endCharOffset: 2, textLen: 5,
};

test('shiftPointAfterInsert: 이전 문단은 불변', () => {
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 1, charOffset: 9 }, singleLineIns),
    { paraIdx: 1, charOffset: 9 });
});

test('shiftPointAfterInsert: 삽입 지점 이전/정확히 그 지점은 불변 (strictly-after)', () => {
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 2, charOffset: 3 }, singleLineIns),
    { paraIdx: 2, charOffset: 3 });
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 2, charOffset: 5 }, singleLineIns),
    { paraIdx: 2, charOffset: 5 });
});

test('shiftPointAfterInsert: 같은 문단 뒤쪽은 textLen 만큼 이동 (단일 라인)', () => {
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 2, charOffset: 6 }, singleLineIns),
    { paraIdx: 2, charOffset: 9 });
});

test('shiftPointAfterInsert: 같은 문단 뒤쪽은 삽입 끝으로 이동 (멀티 라인)', () => {
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 2, charOffset: 7 }, multiLineIns),
    { paraIdx: 3, charOffset: 4 });
});

test('shiftPointAfterInsert: 이후 문단은 addedParas 만큼 이동', () => {
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 5, charOffset: 1 }, multiLineIns),
    { paraIdx: 6, charOffset: 1 });
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 5, charOffset: 1 }, singleLineIns),
    { paraIdx: 5, charOffset: 1 });
});

const del: DocRange = {
  sectionIdx: 0, startParaIdx: 2, startCharOffset: 3, endParaIdx: 4, endCharOffset: 2,
};

test('shiftPointAfterDelete: 시작 이전은 불변', () => {
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 1, charOffset: 8 }, del),
    { paraIdx: 1, charOffset: 8 });
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 2, charOffset: 3 }, del),
    { paraIdx: 2, charOffset: 3 });
});

test('shiftPointAfterDelete: 범위 내부는 시작점으로 clamp', () => {
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 2, charOffset: 9 }, del),
    { paraIdx: 2, charOffset: 3 });
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 3, charOffset: 0 }, del),
    { paraIdx: 2, charOffset: 3 });
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 4, charOffset: 1 }, del),
    { paraIdx: 2, charOffset: 3 });
});

test('shiftPointAfterDelete: 끝 문단의 끝 이후는 시작점 기준으로 이어붙인다', () => {
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 4, charOffset: 2 }, del),
    { paraIdx: 2, charOffset: 3 });
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 4, charOffset: 7 }, del),
    { paraIdx: 2, charOffset: 8 });
});

test('shiftPointAfterDelete: 이후 문단은 삭제된 문단 수만큼 당겨진다', () => {
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 6, charOffset: 4 }, del),
    { paraIdx: 4, charOffset: 4 });
});

test('shiftPointAfterDelete: 단일 문단 삭제', () => {
  const one: DocRange = {
    sectionIdx: 0, startParaIdx: 1, startCharOffset: 2, endParaIdx: 1, endCharOffset: 5,
  };
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 1, charOffset: 1 }, one),
    { paraIdx: 1, charOffset: 1 });
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 1, charOffset: 4 }, one),
    { paraIdx: 1, charOffset: 2 });
  assert.deepEqual(shiftPointAfterDelete({ paraIdx: 1, charOffset: 8 }, one),
    { paraIdx: 1, charOffset: 5 });
});

test('replace_range 시나리오: 삭제 마크 끝 = 삽입 지점이면 삽입 텍스트를 삼키지 않는다', () => {
  // delete-mark (0, p1:2 ~ p1:6) 후 (p1,6) 에 "XY" pending-insert
  const markEnd = { paraIdx: 1, charOffset: 6 };
  const ins = { paraIdx: 1, charOffset: 6, addedParas: 0, endParaIdx: 1, endCharOffset: 8, textLen: 2 };
  assert.deepEqual(shiftPointAfterInsert(markEnd, ins), { paraIdx: 1, charOffset: 6 });
});

// ─── 시작 경계 규칙 (재작성 패턴 버그 수정) ─────────────────

test('시작 경계: 삽입 지점과 정확히 같은 시작은 삽입 길이만큼 밀린다 (단일 라인)', () => {
  // 마크 시작 (2,5) 에 "abc" 삽입 → 마크의 기존 텍스트는 (2,8) 부터
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 2, charOffset: 5 }, singleLineIns, true),
    { paraIdx: 2, charOffset: 8 });
});

test('시작 경계: 삽입 지점과 정확히 같은 시작은 삽입 끝으로 밀린다 (멀티 라인)', () => {
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 2, charOffset: 5 }, multiLineIns, true),
    { paraIdx: 3, charOffset: 2 });
});

test('시작 경계: 삽입 지점보다 앞이면 불변', () => {
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 2, charOffset: 4 }, singleLineIns, true),
    { paraIdx: 2, charOffset: 4 });
  assert.deepEqual(shiftPointAfterInsert({ paraIdx: 1, charOffset: 9 }, multiLineIns, true),
    { paraIdx: 1, charOffset: 9 });
});
