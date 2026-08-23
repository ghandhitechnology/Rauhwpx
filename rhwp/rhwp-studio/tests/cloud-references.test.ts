import assert from 'node:assert/strict';
import test from 'node:test';

import { collectUsedCloudReferenceIds } from '../src/cloud/references.ts';
import type { ThreadMessage } from '../src/agent/threads.ts';

test('cloud reference scope contains only attached and tool-observed file IDs', () => {
  const unrelatedAttachment: ThreadMessage = {
    role: 'user',
    text: '아직 처리 중',
    attachments: [{
      stageId: 'stage-pending',
      fileId: 'pending-file',
      name: 'pending.pdf',
      mimeType: 'application/pdf',
      size: 1,
      status: 'processing',
    }],
  };
  const messages: ThreadMessage[] = [
    {
      role: 'user',
      text: '이 파일을 사용해줘',
      attachments: [{
        stageId: 'stage-ready',
        fileId: 'attached-file',
        name: 'ready.pdf',
        mimeType: 'application/pdf',
        size: 3,
        status: 'ready',
      }],
    },
    unrelatedAttachment,
    {
      role: 'assistant',
      kind: 'activity',
      text: '',
      activityId: 'activity-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      tools: [{
        callId: 'tool-1',
        tool: 'reference.read',
        argsJson: '{"referenceId":"tool-reference"}',
        status: 'completed',
        resultPreview: '{"fileId":"result-file"}',
        elapsedMs: 1,
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
        title: '참고자료 확인',
        role: 'reader',
        workflowName: '',
        status: 'completed',
        activity: '',
        summary: '',
        totalTokens: 1,
        toolUses: 1,
        durationMs: 1,
        tools: [{
          callId: 'tool-2',
          tool: 'reference.read',
          argsJson: "{'fileId':'subagent-file'}",
          status: 'completed',
          resultPreview: '',
          elapsedMs: 1,
        }],
      }],
    },
  ];

  assert.deepEqual(collectUsedCloudReferenceIds({ messages }), [
    'attached-file',
    'tool-reference',
    'result-file',
    'subagent-file',
  ]);
  assert.equal(collectUsedCloudReferenceIds({ messages }).includes('pending-file'), false);
});
