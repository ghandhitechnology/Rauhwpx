import {
  normalizeProviderUserQuestionRequest,
  validateUserQuestionAnswers,
} from '../user-question.mjs';

export const CURSOR_ASK_QUESTION_METHOD = 'cursor/ask_question';
export const CODEX_REQUEST_USER_INPUT_METHOD = 'item/tool/requestUserInput';
export const GROK_ASK_USER_QUESTION_METHODS = Object.freeze([
  'x.ai/ask_user_question',
  '_x.ai/ask_user_question',
]);

export class ProviderUserInputCodecError extends Error {
  constructor(provider, message, code = 'INVALID_PROVIDER_USER_QUESTION') {
    super(`${provider}: ${message}`);
    this.name = 'ProviderUserInputCodecError';
    this.code = code;
    this.provider = provider;
  }
}

function fail(provider, message, code) {
  throw new ProviderUserInputCodecError(provider, message, code);
}

function record(value, provider, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(provider, `${field} must be an object`);
  }
  return value;
}

function string(value, provider, field) {
  if (typeof value !== 'string' || !value.trim()) fail(provider, `${field} must be a non-empty string`);
  return value.trim();
}

function array(value, provider, field) {
  if (!Array.isArray(value)) fail(provider, `${field} must be an array`);
  return value;
}

function boundedOptions(value, provider, field) {
  const options = array(value, provider, field);
  if (options.length < 2 || options.length > 4) fail(provider, `${field} must contain 2-4 options`);
  return options;
}

function providerRequest(value, provider) {
  try {
    return normalizeProviderUserQuestionRequest(value);
  } catch (error) {
    fail(provider, error?.message ?? String(error), error?.code);
  }
}

function compactHeader(value, fallback) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return text.slice(0, 12);
}

function stableId(value, fallback, provider, field) {
  const id = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (id.length > 128) fail(provider, `${field} exceeds 128 characters`);
  return id;
}

function answerValues(question, answer) {
  const labels = answer.selectedOptionIds.map((id) => {
    const option = question.options.find((entry) => entry.id === id);
    if (!option) fail('host', `answer for ${question.id} contains unknown option ${id}`);
    return option.label;
  });
  if (answer.otherText) labels.push(answer.otherText);
  return labels;
}

function assertUniqueQuestionText(request, provider) {
  const seen = new Set();
  for (const question of request.questions) {
    if (seen.has(question.question)) {
      fail(provider, `duplicate question text cannot be represented in the native response: ${question.question}`);
    }
    seen.add(question.question);
  }
}

function answeredOutcome(outcome, provider) {
  const value = record(outcome, provider, 'outcome');
  if (value.status === 'cancelled' || value.status === 'expired') return null;
  if (value.status !== 'answered') fail(provider, `unsupported outcome status ${String(value.status)}`);
  return record(value.answers, provider, 'outcome.answers');
}

function assertCompleteAnswers(request, answers, provider) {
  try {
    validateUserQuestionAnswers(request, answers);
  } catch (error) {
    fail(provider, error?.message ?? String(error), error?.code);
  }
}

/** @param {{agentRole?:string,parentTaskId?:string,agentID?:string}} [context] */
export function isRootUserInputContext({ agentRole, parentTaskId, agentID } = {}) {
  const role = String(agentRole ?? '');
  return !parentTaskId && !agentID && (role === 'chat' || role === 'root');
}

export async function requestProviderUserInput(opts, request, signal, context = {}) {
  if (typeof opts?.requestUserInput !== 'function') {
    fail('host', 'native requestUserInput capability is unavailable', 'USER_INPUT_UNAVAILABLE');
  }
  if (!isRootUserInputContext({ agentRole: opts.agentRole, parentTaskId: request.parentTaskId, ...context })) {
    fail('host', 'native user questions are restricted to the root agent', 'SUBAGENT_USER_INPUT_DENIED');
  }
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const outcome = await new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(opts.requestUserInput(request, signal)).then(resolve, reject).finally(() => {
      signal?.removeEventListener('abort', onAbort);
    });
  });
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  return outcome;
}

/** @param {unknown} input @param {{requestId?:string,toolUseID?:string}} [context] */
export function decodeClaudeAskUserQuestion(input, { requestId, toolUseID } = {}) {
  const provider = 'claude';
  const raw = record(input, provider, 'input');
  const questions = array(raw.questions, provider, 'questions');
  const id = string(requestId ?? toolUseID, provider, 'request id');
  const normalized = providerRequest({
    providerRequestId: id,
    questions: questions.map((value, questionIndex) => {
      const question = record(value, provider, `questions[${questionIndex}]`);
      return {
        id: `question-${questionIndex + 1}`,
        header: string(question.header, provider, `questions[${questionIndex}].header`),
        question: string(question.question, provider, `questions[${questionIndex}].question`),
        mode: question.multiSelect === true ? 'multiple' : 'single',
        options: boundedOptions(question.options, provider, `questions[${questionIndex}].options`).map((value, optionIndex) => {
          const option = record(value, provider, `questions[${questionIndex}].options[${optionIndex}]`);
          return {
            id: `option-${optionIndex + 1}`,
            label: string(option.label, provider, `questions[${questionIndex}].options[${optionIndex}].label`),
            description: string(option.description, provider, `questions[${questionIndex}].options[${optionIndex}].description`),
          };
        }),
        allowOther: true,
      };
    }),
  }, provider);
  assertUniqueQuestionText(normalized, provider);
  return { request: normalized, input: structuredClone(raw) };
}

export function encodeClaudeAskUserQuestion(decoded, outcome) {
  const answers = answeredOutcome(outcome, 'claude');
  if (!answers) {
    return {
      behavior: 'deny',
      message: outcome?.status === 'expired' ? 'The user question expired.' : 'The user cancelled the question.',
      interrupt: outcome?.status === 'cancelled',
    };
  }
  assertCompleteAnswers(decoded.request, answers, 'claude');
  const providerAnswers = {};
  for (const question of decoded.request.questions) {
    const values = answerValues(question, answers[question.id]);
    providerAnswers[question.question] = question.mode === 'multiple' ? values.join(', ') : values[0];
  }
  return {
    behavior: 'allow',
    updatedInput: { ...decoded.input, answers: providerAnswers },
  };
}

export function createClaudeAskUserQuestionPermissionHandler(opts) {
  if (typeof opts?.requestUserInput !== 'function' || !isRootUserInputContext({ agentRole: opts.agentRole })) {
    return null;
  }
  return async (toolName, input, context) => {
    if (toolName !== 'AskUserQuestion') {
      return { behavior: 'deny', message: `Interactive permission is unavailable for ${toolName}.`, interrupt: false };
    }
    if (!isRootUserInputContext({ agentRole: opts.agentRole, agentID: context?.agentID })) {
      return { behavior: 'deny', message: 'Subagents cannot ask the user questions.', interrupt: false };
    }
    const decoded = decodeClaudeAskUserQuestion(input, context);
    const outcome = await requestProviderUserInput(opts, decoded.request, context.signal, {
      agentID: context.agentID,
    });
    return encodeClaudeAskUserQuestion(decoded, outcome);
  };
}

function rpcRequest(frame, provider, methods) {
  const value = record(frame, provider, 'frame');
  if (value.jsonrpc !== undefined && value.jsonrpc !== '2.0') fail(provider, 'jsonrpc must be 2.0');
  if (!methods.includes(value.method)) fail(provider, `unsupported method ${String(value.method)}`);
  if (value.id === undefined || value.id === null) fail(provider, 'request id is required');
  return { id: value.id, method: value.method, params: record(value.params, provider, 'params') };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function decodeCursorAskQuestionFrame(frame) {
  const provider = 'cursor';
  const rpc = rpcRequest(frame, provider, [CURSOR_ASK_QUESTION_METHOD]);
  const toolCallId = string(rpc.params.toolCallId, provider, 'params.toolCallId');
  const questions = array(rpc.params.questions, provider, 'params.questions');
  const request = providerRequest({
    providerRequestId: toolCallId,
    questions: questions.map((value, questionIndex) => {
      const question = record(value, provider, `questions[${questionIndex}]`);
      const questionId = stableId(question.id, `question-${questionIndex + 1}`, provider, `questions[${questionIndex}].id`);
      return {
        id: questionId,
        header: compactHeader(rpc.params.title, `Question ${questionIndex + 1}`),
        question: string(question.prompt, provider, `questions[${questionIndex}].prompt`),
        mode: question.allowMultiple === true ? 'multiple' : 'single',
        options: boundedOptions(question.options, provider, `questions[${questionIndex}].options`).map((value, optionIndex) => {
          const option = record(value, provider, `questions[${questionIndex}].options[${optionIndex}]`);
          const label = string(option.label, provider, `questions[${questionIndex}].options[${optionIndex}].label`);
          return {
            id: stableId(option.id, `option-${optionIndex + 1}`, provider, `questions[${questionIndex}].options[${optionIndex}].id`),
            label,
            description: label,
          };
        }),
        // Cursor ACP has no free-text answer channel. Do not offer an answer
        // that cannot be represented in the native response.
        allowOther: false,
      };
    }),
  }, provider);
  return { id: rpc.id, method: rpc.method, params: structuredClone(rpc.params), request };
}

export function encodeCursorAskQuestionFrame(decoded, outcome) {
  const answers = answeredOutcome(outcome, 'cursor');
  if (!answers) {
    return rpcResult(decoded.id, {
      outcome: outcome?.status === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: 'skipped', reason: 'The user question expired.' },
    });
  }
  assertCompleteAnswers(decoded.request, answers, 'cursor');
  return rpcResult(decoded.id, {
    outcome: {
      outcome: 'answered',
      answers: decoded.request.questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: [...answers[question.id].selectedOptionIds],
      })),
    },
  });
}

export async function handleCursorAskQuestionFrame(opts, frame, signal, context = {}) {
  const decoded = decodeCursorAskQuestionFrame(frame);
  const outcome = await requestProviderUserInput(opts, decoded.request, signal, context);
  return encodeCursorAskQuestionFrame(decoded, outcome);
}

export function decodeCodexRequestUserInputFrame(frame) {
  const provider = 'codex';
  const rpc = rpcRequest(frame, provider, [CODEX_REQUEST_USER_INPUT_METHOD]);
  const itemId = string(rpc.params.itemId, provider, 'params.itemId');
  const questions = array(rpc.params.questions, provider, 'params.questions');
  const request = providerRequest({
    providerRequestId: itemId,
    questions: questions.map((value, questionIndex) => {
      const question = record(value, provider, `questions[${questionIndex}]`);
      if (question.isSecret === true) fail(provider, 'secret questions are not supported by the card UI');
      return {
        id: stableId(question.id, `question-${questionIndex + 1}`, provider, `questions[${questionIndex}].id`),
        header: string(question.header, provider, `questions[${questionIndex}].header`),
        question: string(question.question, provider, `questions[${questionIndex}].question`),
        mode: 'single',
        options: boundedOptions(question.options, provider, `questions[${questionIndex}].options`).map((value, optionIndex) => {
          const option = record(value, provider, `questions[${questionIndex}].options[${optionIndex}]`);
          return {
            id: `option-${optionIndex + 1}`,
            label: string(option.label, provider, `questions[${questionIndex}].options[${optionIndex}].label`),
            description: string(option.description, provider, `questions[${questionIndex}].options[${optionIndex}].description`),
          };
        }),
        allowOther: question.isOther !== false,
      };
    }),
  }, provider);
  return { id: rpc.id, method: rpc.method, params: structuredClone(rpc.params), request };
}

export function encodeCodexRequestUserInputFrame(decoded, outcome) {
  const answers = answeredOutcome(outcome, 'codex');
  if (!answers) return rpcResult(decoded.id, { answers: {} });
  assertCompleteAnswers(decoded.request, answers, 'codex');
  return rpcResult(decoded.id, {
    answers: Object.fromEntries(decoded.request.questions.map((question) => {
      const answer = answers[question.id];
      const values = answer.selectedOptionIds.map((id) => question.options.find((option) => option.id === id)?.label).filter(Boolean);
      if (answer.otherText) values.push(`user_note: ${answer.otherText}`);
      return [question.id, { answers: values }];
    })),
  });
}

export async function handleCodexRequestUserInputFrame(opts, frame, signal, context = {}) {
  const decoded = decodeCodexRequestUserInputFrame(frame);
  const outcome = await requestProviderUserInput(opts, decoded.request, signal, context);
  return encodeCodexRequestUserInputFrame(decoded, outcome);
}

export function decodeGrokAskUserQuestionFrame(frame) {
  const provider = 'grok';
  const rpc = rpcRequest(frame, provider, GROK_ASK_USER_QUESTION_METHODS);
  // Grok 1.0.x has emitted both direct params and a private-extension wrapper
  // containing the logical method plus params. Accept either captured shape.
  const params = rpc.params.params && typeof rpc.params.method === 'string'
    ? (() => {
      if (!GROK_ASK_USER_QUESTION_METHODS.includes(rpc.params.method)) {
        fail(provider, `unsupported wrapped method ${rpc.params.method}`);
      }
      return record(rpc.params.params, provider, 'params.params');
    })()
    : rpc.params;
  const toolCallId = string(params.toolCallId, provider, 'params.toolCallId');
  const questions = array(params.questions, provider, 'params.questions');
  const request = providerRequest({
    providerRequestId: toolCallId,
    questions: questions.map((value, questionIndex) => {
      const question = record(value, provider, `questions[${questionIndex}]`);
      return {
        id: stableId(question.id, `question-${questionIndex + 1}`, provider, `questions[${questionIndex}].id`),
        header: compactHeader(undefined, `Question ${questionIndex + 1}`),
        question: string(question.question, provider, `questions[${questionIndex}].question`),
        mode: question.multiSelect === true ? 'multiple' : 'single',
        options: boundedOptions(question.options, provider, `questions[${questionIndex}].options`).map((value, optionIndex) => {
          const option = record(value, provider, `questions[${questionIndex}].options[${optionIndex}]`);
          return {
            id: stableId(option.id, `option-${optionIndex + 1}`, provider, `questions[${questionIndex}].options[${optionIndex}].id`),
            label: string(option.label, provider, `questions[${questionIndex}].options[${optionIndex}].label`),
            description: typeof option.description === 'string' && option.description.trim()
              ? option.description.trim()
              : string(option.label, provider, `questions[${questionIndex}].options[${optionIndex}].label`),
          };
        }),
        allowOther: true,
      };
    }),
  }, provider);
  assertUniqueQuestionText(request, provider);
  return { id: rpc.id, method: rpc.method, params: structuredClone(params), request };
}

export function encodeGrokAskUserQuestionFrame(decoded, outcome) {
  const answers = answeredOutcome(outcome, 'grok');
  if (!answers) return rpcResult(decoded.id, { outcome: 'cancelled' });
  assertCompleteAnswers(decoded.request, answers, 'grok');
  const providerAnswers = {};
  const annotations = {};
  for (const question of decoded.request.questions) {
    const answer = answers[question.id];
    const labels = answer.selectedOptionIds.map((id) => question.options.find((option) => option.id === id)?.label).filter(Boolean);
    if (answer.otherText) {
      labels.push('Other');
      annotations[question.question] = { notes: answer.otherText };
    }
    providerAnswers[question.question] = labels;
  }
  return rpcResult(decoded.id, {
    outcome: 'accepted',
    answers: providerAnswers,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  });
}

export async function handleGrokAskUserQuestionFrame(opts, frame, signal, context = {}) {
  const decoded = decodeGrokAskUserQuestionFrame(frame);
  const outcome = await requestProviderUserInput(opts, decoded.request, signal, context);
  return encodeGrokAskUserQuestionFrame(decoded, outcome);
}

function methodAvailable(capabilities, method) {
  if (!capabilities) return false;
  if (capabilities === true) return true;
  if (Array.isArray(capabilities)) return capabilities.includes(method);
  if (capabilities instanceof Set) return capabilities.has(method);
  if (typeof capabilities === 'object') {
    if (capabilities[method] === true) return true;
    const methods = capabilities.methods ?? capabilities.supportedMethods;
    return methodAvailable(methods, method);
  }
  return false;
}

export function codexDefaultModeUserInputEnabled(features) {
  const list = Array.isArray(features) ? features : features?.features;
  if (!Array.isArray(list)) return false;
  return list.some((feature) => {
    if (typeof feature === 'string') return feature === 'default_mode_request_user_input';
    return feature?.name === 'default_mode_request_user_input' && feature.enabled === true;
  });
}

export function selectCodexUserInputTransport(opts, capabilities = {}) {
  if (typeof opts?.requestUserInput !== 'function' || !isRootUserInputContext({ agentRole: opts.agentRole })) return 'legacy-mcp';
  if (capabilities.transport !== 'app-server' || !methodAvailable(capabilities, CODEX_REQUEST_USER_INPUT_METHOD)) return 'legacy-mcp';
  const nativePlanPhase = opts.workflow === 'plan' && opts.phase === 'planning';
  if (!nativePlanPhase && !codexDefaultModeUserInputEnabled(capabilities.features)) return 'legacy-mcp';
  return 'native-app-server';
}

export function selectCursorUserInputTransport(opts, capabilities = {}) {
  if (typeof opts?.requestUserInput !== 'function' || !isRootUserInputContext({ agentRole: opts.agentRole })) return 'legacy-mcp';
  return capabilities.transport === 'acp' && methodAvailable(capabilities, CURSOR_ASK_QUESTION_METHOD)
    ? 'native-acp'
    : 'legacy-mcp';
}

export function selectGrokUserInputTransport(opts, capabilities = {}) {
  if (typeof opts?.requestUserInput !== 'function' || !isRootUserInputContext({ agentRole: opts.agentRole })) {
    return { transport: 'legacy-mcp' };
  }
  if (capabilities.transport !== 'acp' || capabilities.askUserTimeoutDisabled !== true) {
    return { transport: 'legacy-mcp' };
  }
  const method = GROK_ASK_USER_QUESTION_METHODS.find((candidate) => methodAvailable(capabilities, candidate));
  return method ? { transport: 'native-acp', method } : { transport: 'legacy-mcp' };
}
