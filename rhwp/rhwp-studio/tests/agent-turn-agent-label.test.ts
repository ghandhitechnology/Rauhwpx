/**
 * 리뷰 카드의 에이전트 이름은 실제로 돌고 있는 턴을 따라야 한다.
 *
 * 회귀 시나리오: Claude 턴이 도는 중에 'codex' 라벨이 붙은 도구 호출이 들어오면
 * ensureOpenSet 이 그 라벨을 믿고 열린 Claude 턴을 닫은 뒤 Codex 이름의 change-set
 * 을 새로 열었다 — 사이드바가 Claude 헤더 아래에 "Codex 편집 진행 중"을 띄웠다.
 * 허브 세션은 한 번에 하나뿐이므로, 턴이 열려 있으면 그 턴이 귀속의 기준이다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';

function makeManager() {
  const body = [{ chars: [...'hello'] }];
  const wasm = {
    getSectionCount: () => 1,
    getParagraphCount: () => body.length,
    getParagraphLength: (_s: number, p: number) => body[p].chars.length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) =>
      body[p].chars.slice(off, off + cnt).join(''),
    insertText: (_s: number, p: number, off: number, t: string) => {
      const chars = [...t];
      body[p].chars.splice(off, 0, ...chars);
      return JSON.stringify({ ok: true, charOffset: off + chars.length });
    },
    get documentDigest() { return 'blake3:doc-A'; },
  };
  return new PendingEditManager({
    wasm: wasm as never,
    eventBus: new EventBus(),
    inputHandler: {
      getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
      executeOperation: () => {},
      prepareSnapshotCapacity: () => {},
    } as never,
    canvasView: {} as never,
    overlay: { setOps: () => {}, clear: () => {} } as never,
  });
}

test('열린 턴 중의 잘못 라벨된 도구 호출은 그 턴의 에이전트로 기록된다', () => {
  const mgr = makeManager();
  mgr.beginTurn('claude');

  mgr.insertText('codex', { sectionIdx: 0, paraIdx: 0, charOffset: 5 }, '!');

  const sets = mgr.getChangeSets();
  assert.equal(sets.length, 1, '열린 턴을 버리고 새 set 을 열지 않는다');
  assert.equal(sets[0].agent, 'claude', '리뷰 카드는 돌고 있는 에이전트를 내건다');
  assert.equal(sets[0].status, 'open');
  // 오버레이 잉크 색도 같은 기준을 따른다.
  assert.equal(sets[0].ops[0].agent, 'claude');
});

test('턴이 없으면 호출 라벨대로 set 을 연다', () => {
  const mgr = makeManager();
  mgr.insertText('codex', { sectionIdx: 0, paraIdx: 0, charOffset: 5 }, '!');
  const sets = mgr.getChangeSets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0].agent, 'codex');
});
