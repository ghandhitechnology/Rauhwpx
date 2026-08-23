import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOUD_TIMELINE_SCHEMA,
  exportCloudTimeline,
  importCloudTimeline,
  parseCloudTimeline,
} from '../src/cloud/timeline.ts';
import type { ChatThread } from '../src/agent/threads.ts';

function thread(): ChatThread {
  return {
    id: 'thread-cloud',
    title: '클라우드 작업',
    titleRequested: true,
    createdAt: 10,
    updatedAt: 20,
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    workflow: 'direct',
    docKey: 'before.hwpx',
    documentId: 'doc-before',
    activeTemplateId: null,
    messages: [
      { role: 'user', text: '표를 고쳐줘', messageId: 'user-1', delivery: 'accepted-cloud' },
      {
        role: 'assistant',
        kind: 'activity',
        text: '',
        activityId: 'activity-1',
        status: 'completed',
        startedAt: 100,
        completedAt: 130,
        tools: [{
          callId: 'tool-1',
          tool: 'hwpctl.set_text',
          argsJson: '{"text":"완료"}',
          status: 'completed',
          resultPreview: 'ok',
          elapsedMs: 30,
        }],
      },
      {
        role: 'assistant',
        kind: 'tasks',
        text: '',
        taskGroupId: 'tasks-1',
        status: 'completed',
        tasks: [{
          taskId: 'task-1',
          taskKind: 'agent',
          title: '검증',
          role: 'verifier',
          workflowName: '',
          status: 'completed',
          activity: '문서를 확인했습니다.',
          summary: '오류 없음',
          totalTokens: 120,
          toolUses: 1,
          durationMs: 500,
          tools: [],
        }],
      },
      { role: 'assistant', text: '작업을 마쳤습니다.', agent: 'codex' },
    ],
  };
}

test('portable cloud timeline round-trips visible messages, tools and subagents', () => {
  const exported = exportCloudTimeline(thread(), '2026-08-23T11:00:00.000Z');
  const parsed = parseCloudTimeline(structuredClone(exported));

  assert.equal(parsed?.schema, CLOUD_TIMELINE_SCHEMA);
  assert.equal(parsed?.thread.messages.length, 4);
  assert.equal(parsed?.thread.messages[1]?.kind, 'activity');
  assert.equal(parsed?.thread.messages[2]?.kind, 'tasks');
  assert.notEqual(parsed?.thread.messages, exported.thread.messages);
});
test('timeline import keeps local identity while adopting remote transcript', () => {
  const imported = importCloudTimeline(exportCloudTimeline(thread(), '2026-08-23T11:00:00.000Z'), {
    id: 'local-thread',
    docKey: 'current.hwpx',
    documentId: 'doc-current',
  });
  assert.equal(imported?.id, 'local-thread');
  assert.equal(imported?.docKey, 'current.hwpx');
  assert.equal(imported?.documentId, 'doc-current');
  assert.equal(imported?.messages.at(-1)?.text, '작업을 마쳤습니다.');
});

test('timeline parser rejects incompatible envelopes', () => {
  const exported = exportCloudTimeline(thread());
  assert.equal(parseCloudTimeline({ ...exported, version: 2 }), null);
  assert.equal(parseCloudTimeline({ ...exported, schema: 'other.timeline' }), null);
  assert.equal(parseCloudTimeline({ ...exported, exportedAt: 'not-a-date' }), null);
});
