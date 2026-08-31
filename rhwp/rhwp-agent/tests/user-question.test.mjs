import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createUserQuestionInteraction,
  isAskUserQuestionTool,
  normalizeMcpUserQuestionRequest,
  normalizeProviderUserQuestionRequest,
  sameUserQuestionRequest,
  userQuestionAnswersForMcp,
  userQuestionArgsFromToolInput,
  validateUserQuestionAnswers,
} from '../user-question.mjs';

function providerRequest() {
  return {
    providerRequestId: 'provider-request-1',
    questions: [{
      id: 'format',
      header: 'Format',
      question: 'Which format should I use?',
      mode: 'single',
      options: [
        { id: 'brief', label: 'Brief', description: 'Keep it compact.' },
        { id: 'detailed', label: 'Detailed', description: 'Include supporting detail.' },
      ],
      allowOther: true,
    }],
  };
}

test('MCP questions normalize into stable canonical options', () => {
  const request = normalizeMcpUserQuestionRequest({
    questions: [{
      id: 'format',
      header: 'Format',
      question: 'Which format should I use?',
      options: [
        { label: 'Brief', description: 'Keep it compact.' },
        { label: 'Detailed', description: 'Include supporting detail.' },
      ],
      multiSelect: true,
      allowOther: false,
    }],
  }, 'mcp:8');

  assert.equal(request.providerRequestId, 'mcp:8');
  assert.equal(request.questions[0].mode, 'multiple');
  assert.equal(request.questions[0].allowOther, false);
  assert.deepEqual(request.questions[0].options.map((option) => option.id), ['option-1', 'option-2']);
});

test('MCP wrappers and provider prefixes still identify the question tool', () => {
  assert.equal(isAskUserQuestionTool('ask_user_question'), true);
  assert.equal(isAskUserQuestionTool('mcp__rhwp__ask_user_question'), true);
  assert.equal(isAskUserQuestionTool('rhwp__ask_user_question'), true);
  assert.equal(isAskUserQuestionTool('get_structure'), false);

  const inner = {
    questions: [{
      id: 'format',
      header: 'Format',
      question: 'Which format should I use?',
      options: [
        { label: 'Brief', description: 'Keep it compact.' },
        { label: 'Detailed', description: 'Include supporting detail.' },
      ],
    }],
  };
  assert.equal(userQuestionArgsFromToolInput(inner), inner);
  assert.deepEqual(
    userQuestionArgsFromToolInput({
      name: 'mcp__rhwp__ask_user_question',
      args: inner,
      toolName: 'ask_user_question',
    }),
    inner,
  );
  const wrapped = normalizeMcpUserQuestionRequest(
    userQuestionArgsFromToolInput({
      name: 'mcp__rhwp__ask_user_question',
      args: inner,
      toolCallId: '',
      toolName: 'ask_user_question',
    }),
    'scope-ticket',
  );
  assert.equal(wrapped.questions[0].id, 'format');
});

test('canonical requests reject duplicate question and option identities', () => {
  const duplicateQuestion = providerRequest();
  duplicateQuestion.questions.push(structuredClone(duplicateQuestion.questions[0]));
  assert.throws(
    () => normalizeProviderUserQuestionRequest(duplicateQuestion),
    { code: 'DUPLICATE_QUESTION_ID' },
  );

  const duplicateOption = providerRequest();
  duplicateOption.questions[0].options[1].id = 'brief';
  assert.throws(
    () => normalizeProviderUserQuestionRequest(duplicateOption),
    { code: 'DUPLICATE_OPTION_ID' },
  );
});

test('answers are complete, bounded, and match question selection rules', () => {
  const interaction = createUserQuestionInteraction({
    request: providerRequest(),
    interactionId: 'interaction-1',
    agent: 'claude',
    source: 'native',
    threadId: 'thread-1',
    turnId: 'turn-1',
    now: () => '2026-08-25T00:00:00.000Z',
  });
  assert.deepEqual(validateUserQuestionAnswers(interaction, {
    format: { selectedOptionIds: ['detailed'] },
  }), {
    format: { selectedOptionIds: ['detailed'] },
  });
  assert.throws(
    () => validateUserQuestionAnswers(interaction, {}),
    { code: 'INVALID_USER_QUESTION_ANSWER' },
  );
  assert.throws(
    () => validateUserQuestionAnswers(interaction, {
      format: { selectedOptionIds: ['brief', 'detailed'] },
    }),
    { code: 'INVALID_USER_QUESTION_ANSWER' },
  );
  assert.throws(
    () => validateUserQuestionAnswers(interaction, {
      format: { selectedOptionIds: ['unknown'] },
    }),
    { code: 'INVALID_USER_QUESTION_ANSWER' },
  );
});

test('MCP answers return labels without losing custom text', () => {
  const request = providerRequest();
  assert.deepEqual(userQuestionAnswersForMcp(request, {
    format: { selectedOptionIds: ['detailed'], otherText: 'With an appendix' },
  }), {
    format: { selected: ['Detailed'], otherText: 'With an appendix' },
  });
});

test('request retries deduplicate only the same provider request and payload', () => {
  const original = providerRequest();
  assert.equal(sameUserQuestionRequest(original, structuredClone(original)), true);
  const changed = structuredClone(original);
  changed.questions[0].question = 'Choose a different format.';
  assert.equal(sameUserQuestionRequest(original, changed), false);
  const nextRequest = structuredClone(original);
  nextRequest.providerRequestId = 'provider-request-2';
  assert.equal(sameUserQuestionRequest(original, nextRequest), false);
});

test('the hub handles user questions before the generic Studio executor', () => {
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const questionBranch = source.indexOf("if (tool === 'ask_user_question')");
  const nextToolBranch = source.indexOf("if (tool === 'delegate_copy_layout')", questionBranch);
  const genericExecutor = source.indexOf('const hubId = record.nextHubId++', questionBranch);
  assert.ok(questionBranch > 0);
  assert.ok(nextToolBranch > questionBranch);
  assert.ok(genericExecutor > questionBranch);
  assert.doesNotMatch(source.slice(questionBranch, nextToolBranch), /pendingCalls|STUDIO_TOOL_TIMEOUT_MS|type: 'tool-request'/);
});
