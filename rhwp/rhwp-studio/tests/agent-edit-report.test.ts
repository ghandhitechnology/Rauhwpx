// 버려지거나 되돌리지 못한 대기 편집을 에이전트에게 알리는 경로를 고정한다:
// 턴 중이면 다음 도구 결과의 editReport 로, 턴 밖이면 허브(chat-edit-report)로 보낸다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// bridge.ts 는 오버레이 css 를 함께 들여온다 — node 테스트에서는 빈 모듈로 대체한다.
registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');
const { editReportNote, describeDrops } = await import('../src/agent/pending-edits.ts');

const drop = (cause: 'table-changed' | 'revert-failed', summary: string) => ({ opId: summary, cause, summary });

test('drift reports name the real cause and only reach the agent when edits stay or vanish', () => {
  const drops = [drop('table-changed', 'setCellProps @s0 p3'), drop('revert-failed', 'tableStructure(delete_row) @s0 p3')];
  assert.equal(describeDrops(drops, true), '2 ops left in the document: table changed, edited after staging');
  assert.equal(describeDrops(drops.slice(0, 1), false), '1 op outside the undo step: table changed');

  const rejected = editReportNote({
    type: 'invalidated', reason: describeDrops(drops, true), changeSetId: 'cs-1',
    droppedOpIds: drops.map((d) => d.opId), drops, leftInDocument: true,
  });
  assert.match(rejected!, /stay in the document: setCellProps @s0 p3 \(table changed\); tableStructure\(delete_row\) @s0 p3 \(edited after staging\)/);

  // 승인에서 undo 항목만 빠진 편집은 문서에 그대로 반영돼 있다 — 알릴 것이 없다.
  assert.equal(editReportNote({
    type: 'invalidated', reason: 'x', changeSetId: 'cs-1', droppedOpIds: ['a'], drops: drops.slice(0, 1), leftInDocument: false,
  }), null);
  assert.equal(editReportNote({ type: 'invalidated', reason: 'approval failed' }), null);
  assert.match(editReportNote({ type: 'invalidated', reason: 'undo/redo' })!, /discarded \(undo\/redo\)[\s\S]*Re-read/);
});

test('an in-turn edit report rides on the next tool result once; outside a turn it goes to the hub', async () => {
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  const responses: any[] = [];
  const frames: any[] = [];
  Object.assign(bridge, {
    activeProviderTurnId: 'turn-active', turnRunning: true,
    activeToolRequests: 0, activeToolRequestControllers: new Map(),
    pendingUserQuestion: null, pendingQuestionCancellation: null,
    workflow: 'direct', phase: 'direct', activeAgent: 'claude',
    executor: { execute: async () => ({ revision: 7 }) }, syncEditingLease: () => {},
    sendJson: (frame: unknown) => { frames.push(frame); return true; },
    sendToolResponse: (response: unknown) => { responses.push(response); },
  });
  const request = (id: number) => bridge.handleToolRequest({
    id, tool: 'get_structure', args: {}, agent: 'claude', providerTurnId: 'turn-active',
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  bridge.queueEditReport('Your staged edits were discarded (undo/redo).');
  assert.deepEqual(frames, [], '턴 중에는 허브로 보내지 않는다');
  request(1);
  await settle();
  request(2);
  await settle();
  assert.deepEqual(responses[0].result, { revision: 7, editReport: ['Your staged edits were discarded (undo/redo).'] });
  assert.deepEqual(responses[1].result, { revision: 7 }, '한 번 보고한 내용은 다시 싣지 않는다');

  bridge.queueEditReport('left over');
  bridge.turnRunning = false;
  bridge.flushEditReport();
  bridge.queueEditReport('after the turn');
  assert.deepEqual(frames.map((frame) => [frame.type, frame.notes]), [
    ['chat-edit-report', ['left over']],
    ['chat-edit-report', ['after the turn']],
  ]);
});
