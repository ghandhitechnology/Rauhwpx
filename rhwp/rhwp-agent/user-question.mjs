import crypto from 'node:crypto';
import { z } from 'zod/v3';

export const USER_QUESTION_LIMITS = Object.freeze({
  questions: 4,
  options: 4,
  header: 12,
  question: 500,
  label: 80,
  description: 240,
  otherText: 2_000,
});

const boundedText = (name, max) => z.string().trim().min(1, `${name} is required`).max(max);

export const MCP_USER_QUESTION_SHAPE = Object.freeze({
  questions: z.array(z.object({
    id: boundedText('question id', 128),
    header: boundedText('header', USER_QUESTION_LIMITS.header),
    question: boundedText('question', USER_QUESTION_LIMITS.question),
    options: z.array(z.object({
      label: boundedText('option label', USER_QUESTION_LIMITS.label),
      description: boundedText('option description', USER_QUESTION_LIMITS.description),
    }).strict()).min(2).max(USER_QUESTION_LIMITS.options),
    multiSelect: z.boolean().optional(),
    allowOther: z.boolean().optional(),
  }).strict()).min(1).max(USER_QUESTION_LIMITS.questions),
});

const optionSchema = z.object({
  id: boundedText('option id', 128),
  label: boundedText('option label', USER_QUESTION_LIMITS.label),
  description: boundedText('option description', USER_QUESTION_LIMITS.description),
}).strict();

const questionSchema = z.object({
  id: boundedText('question id', 128),
  header: boundedText('header', USER_QUESTION_LIMITS.header),
  question: boundedText('question', USER_QUESTION_LIMITS.question),
  mode: z.enum(['single', 'multiple']),
  options: z.array(optionSchema).min(2).max(USER_QUESTION_LIMITS.options),
  allowOther: z.boolean(),
}).strict();

export const PROVIDER_USER_QUESTION_REQUEST_SCHEMA = z.object({
  providerRequestId: boundedText('provider request id', 256),
  questions: z.array(questionSchema).min(1).max(USER_QUESTION_LIMITS.questions),
  parentTaskId: z.string().min(1).max(256).optional(),
}).strict();

function interactionError(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  return error;
}

function assertUnique(items, key, code, message) {
  const seen = new Set();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw interactionError(code, message(value));
    seen.add(value);
  }
}

export function normalizeProviderUserQuestionRequest(input) {
  let request;
  try {
    request = PROVIDER_USER_QUESTION_REQUEST_SCHEMA.parse(input);
  } catch (error) {
    if (error?.name === 'ZodError') {
      throw interactionError('INVALID_USER_QUESTION', error.issues.map((issue) => issue.message).join('; '));
    }
    throw error;
  }
  assertUnique(request.questions, (question) => question.id, 'DUPLICATE_QUESTION_ID', (id) => `Duplicate question id: ${id}`);
  for (const question of request.questions) {
    assertUnique(question.options, (option) => option.id, 'DUPLICATE_OPTION_ID', (id) => `Duplicate option id in ${question.id}: ${id}`);
    assertUnique(question.options, (option) => option.label.toLocaleLowerCase(), 'DUPLICATE_OPTION_LABEL', (label) => `Duplicate option label in ${question.id}: ${label}`);
  }
  return structuredClone(request);
}

export function normalizeMcpUserQuestionRequest(args, providerRequestId) {
  const parsed = z.object(MCP_USER_QUESTION_SHAPE).strict().parse(args);
  return normalizeProviderUserQuestionRequest({
    providerRequestId: String(providerRequestId),
    questions: parsed.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      mode: question.multiSelect ? 'multiple' : 'single',
      options: question.options.map((option, index) => ({
        id: `option-${index + 1}`,
        label: option.label,
        description: option.description,
      })),
      allowOther: question.allowOther !== false,
    })),
  });
}

export function createUserQuestionInteraction({
  request,
  interactionId = crypto.randomUUID(),
  agent,
  source,
  threadId,
  turnId,
  now = () => new Date().toISOString(),
}) {
  const normalized = normalizeProviderUserQuestionRequest(request);
  const createdAt = now();
  return Object.freeze({
    interactionId,
    providerRequestId: normalized.providerRequestId,
    threadId,
    turnId,
    agent,
    source,
    createdAt,
    updatedAt: createdAt,
    questions: normalized.questions,
  });
}

export function validateUserQuestionAnswers(interaction, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw interactionError('INVALID_USER_QUESTION_ANSWER', 'answers must be an object');
  }
  const expectedIds = new Set(interaction.questions.map((question) => question.id));
  const receivedIds = Object.keys(input);
  if (receivedIds.length !== expectedIds.size || receivedIds.some((id) => !expectedIds.has(id))) {
    throw interactionError('INVALID_USER_QUESTION_ANSWER', 'answers must contain every question exactly once');
  }
  const answers = {};
  for (const question of interaction.questions) {
    const raw = input[question.id];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw interactionError('INVALID_USER_QUESTION_ANSWER', `answer for ${question.id} must be an object`);
    }
    const selectedOptionIds = Array.isArray(raw.selectedOptionIds) ? raw.selectedOptionIds : [];
    if (selectedOptionIds.some((id) => typeof id !== 'string')) {
      throw interactionError('INVALID_USER_QUESTION_ANSWER', `selected options for ${question.id} must be strings`);
    }
    if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
      throw interactionError('INVALID_USER_QUESTION_ANSWER', `selected options for ${question.id} must be unique`);
    }
    const allowed = new Set(question.options.map((option) => option.id));
    if (selectedOptionIds.some((id) => !allowed.has(id))) {
      throw interactionError('INVALID_USER_QUESTION_ANSWER', `answer for ${question.id} contains an unknown option`);
    }
    const otherText = typeof raw.otherText === 'string' ? raw.otherText.trim() : '';
    if (otherText.length > USER_QUESTION_LIMITS.otherText) {
      throw interactionError('INVALID_USER_QUESTION_ANSWER', `custom answer for ${question.id} exceeds ${USER_QUESTION_LIMITS.otherText} characters`);
    }
    if (otherText && !question.allowOther) {
      throw interactionError('INVALID_USER_QUESTION_ANSWER', `question ${question.id} does not allow a custom answer`);
    }
    const choiceCount = selectedOptionIds.length + (otherText ? 1 : 0);
    if (choiceCount === 0) {
      throw interactionError('INVALID_USER_QUESTION_ANSWER', `question ${question.id} requires an answer`);
    }
    if (question.mode === 'single' && choiceCount !== 1) {
      throw interactionError('INVALID_USER_QUESTION_ANSWER', `question ${question.id} accepts one answer`);
    }
    answers[question.id] = {
      selectedOptionIds: [...selectedOptionIds],
      ...(otherText ? { otherText } : {}),
    };
  }
  return answers;
}

export function userQuestionAnswersForMcp(interaction, answers) {
  return Object.fromEntries(interaction.questions.map((question) => {
    const answer = answers[question.id];
    const labels = answer.selectedOptionIds.map((id) => question.options.find((option) => option.id === id)?.label).filter(Boolean);
    return [question.id, { selected: labels, ...(answer.otherText ? { otherText: answer.otherText } : {}) }];
  }));
}

export function sameUserQuestionRequest(left, right) {
  return left.providerRequestId === right.providerRequestId
    && JSON.stringify(left.questions) === JSON.stringify(right.questions);
}
