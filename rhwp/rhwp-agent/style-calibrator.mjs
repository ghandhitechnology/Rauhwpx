import spawn from 'cross-spawn';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRouterReady } from './agents/title.mjs';
import {
  isolatedProcessEnv,
  processTreeSpawnOptions,
  terminateProcessTree,
} from './process-tree.mjs';
import { extractReferenceText, markupToText, SUPPORTED_REFERENCE_EXTENSIONS } from './reference-extractor.mjs';
import {
  analyzeText, baselineLines, confidenceFor, deriveBands, splitHalfStability,
} from './style-metrics.mjs';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const ANALYSIS_TIMEOUT_MS = 8 * 60_000;
const MAX_TASK_TIMEOUT_MS = 20 * 60_000;
const MAX_CLI_OUTPUT_BYTES = 8 * 1024 * 1024;
const REQUIRED_PAGES = 10;
const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.pdf', '.docx', '.rtf', '.html', '.htm', '.csv', '.hwp', '.hwpx',
]);
/** 노드가 직접 읽을 수 있는 형식. 여기 없는 형식만 추출 패스를 태운다. */
const NATIVE_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.html', '.htm']);
const LOCAL_EXTRACTION_EXTENSIONS = new Set(SUPPORTED_REFERENCE_EXTENSIONS);

/**
 * 문체 축. personal-humanizer-maker 의 축 분류를 그대로 쓰되, 판별이 아니라
 * 작성을 위한 지시문을 받는다.
 */
export const STYLE_AXES = [
  { id: 'sentence_architecture', ko: '문장 구조', en: 'Sentence architecture' },
  { id: 'register_modality', ko: '어조와 종결', en: 'Register and modality' },
  { id: 'lexical_register', ko: '어휘 선택', en: 'Lexical register' },
  { id: 'cohesion_argument', ko: '연결과 논지 전개', en: 'Cohesion and argument' },
  { id: 'stance_voice', ko: '태도와 화자', en: 'Stance and voice' },
  { id: 'figuration', ko: '비유와 예시', en: 'Figuration and illustration' },
  { id: 'formatting', ko: '서식과 배치', en: 'Formatting and layout' },
];

const AXIS_IDS = STYLE_AXES.map((axis) => axis.id);

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['enoughSample', 'pageEquivalent', 'summary', 'unsupportedFiles', 'axes', 'adaptation'],
  properties: {
    enoughSample: { type: 'boolean' },
    pageEquivalent: { type: 'number', minimum: 0 },
    summary: { type: 'string', maxLength: 500 },
    unsupportedFiles: { type: 'array', maxItems: MAX_FILES, items: { type: 'string' } },
    axes: {
      type: 'array',
      maxItems: 7,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['axis', 'evidenceCount', 'observation', 'directives', 'patterns'],
        properties: {
          axis: { type: 'string', enum: AXIS_IDS },
          evidenceCount: { type: 'integer', minimum: 0 },
          observation: { type: 'string', maxLength: 400 },
          directives: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 300 } },
          patterns: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 200 } },
        },
      },
    },
    adaptation: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['genre', 'guidance'],
        properties: {
          genre: { type: 'string', maxLength: 40 },
          guidance: { type: 'string', maxLength: 300 },
        },
      },
    },
  },
};

export class StyleCalibrationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'StyleCalibrationError';
  }
}

function safeExtension(name) {
  return path.extname(String(name || '')).toLowerCase();
}

function decodeUpload(file, index) {
  if (!file || typeof file !== 'object') throw new StyleCalibrationError('INVALID_FILE', 'Invalid uploaded file.');
  const name = String(file.name || '').trim();
  const extension = safeExtension(name);
  if (!name || !ALLOWED_EXTENSIONS.has(extension)) {
    throw new StyleCalibrationError('UNSUPPORTED_FILE', `${name || `File ${index + 1}`} is not a supported writing sample.`);
  }
  if (typeof file.content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) {
    throw new StyleCalibrationError('INVALID_FILE', `${name} has invalid file data.`);
  }
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length === 0) throw new StyleCalibrationError('EMPTY_FILE', `${name} is empty.`);
  if (bytes.length > MAX_FILE_BYTES) throw new StyleCalibrationError('FILE_TOO_LARGE', `${name} exceeds 20 MB.`);
  const stem = path.basename(name, extension).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'sample';
  return {
    name,
    bytes,
    extension,
    native: NATIVE_TEXT_EXTENSIONS.has(extension),
    safeName: `${String(index + 1).padStart(2, '0')}-${stem.slice(0, 80)}${extension}`,
  };
}

export function validateCalibrationInput(input) {
  const language = input?.language === 'en' ? 'en' : input?.language === 'ko' ? 'ko' : null;
  if (!language) throw new StyleCalibrationError('INVALID_LANGUAGE', 'Choose Korean or English.');
  if (!Array.isArray(input?.files) || input.files.length === 0 || input.files.length > MAX_FILES) {
    throw new StyleCalibrationError('INVALID_FILES', `Upload 1-${MAX_FILES} writing samples.`);
  }
  const files = input.files.map(decodeUpload);
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > MAX_TOTAL_BYTES) throw new StyleCalibrationError('FILES_TOO_LARGE', 'Writing samples exceed 50 MB in total.');
  return { language, files, totalBytes: total };
}

/** 마크업만 걷어 낸다. 본문을 다시 쓰지 않는다. */
function plainTextFromNative(bytes, extension) {
  const text = bytes.toString('utf8');
  if (extension === '.html' || extension === '.htm') return markupToText(text);
  return text;
}

/**
 * 분석 패스 프롬프트. 계산 가능한 값은 이미 코드가 냈으므로 해석만 요구한다.
 * inline 은 도구 없이 도는 OpenRouter 경로용이다 — 원고가 프롬프트에 같이 실린다.
 */
export function buildCalibrationPrompt({ language, files, metrics, inline = false, preparedCorpus = false }) {
  const targetLanguage = language === 'ko' ? 'Korean' : 'English';
  const manifest = files.map((file) => `- ${file.safeName} (original name: ${file.name})`).join('\n');
  const axisList = STYLE_AXES
    .map((axis) => `- ${axis.id} — ${language === 'ko' ? axis.ko : axis.en}`)
    .join('\n');
  const measured = metrics
    ? `A deterministic profiler already measured this corpus. These numbers are settled; do not restate, recompute, or contradict them. Read them as context for what to interpret.

\`\`\`json
${JSON.stringify(metrics, null, 2)}
\`\`\`

Explain what the numbers cannot: why the author writes this way, what job each habit does, and what a writer must decide to produce prose that reads as theirs.`
    : 'No quantitative profile is available for this corpus, so judge the sample scale yourself and keep every claim conservative.';

  const access = inline
    ? 'The sample text is included at the end of this message.'
    : (preparedCorpus
      ? 'Use the Read tool on calibration-corpus.txt. It contains the locally extracted sample prose with a heading between source files.'
      : 'Use the Read tool on every readable file in the current directory.');

  return `Profile the writing style of the attached samples, which the user confirms they wrote themselves. ${access} The profile language is ${targetLanguage}.

Files:
${manifest}

${measured}

## What this profile is for

The output is a **writing** specification. Agents will consult it while drafting new Korean office documents — reports, proposals, official letters, emails, explanatory prose — so that what they produce reads as if this author wrote it. It is not a checklist for grading finished text, and it is not a rewrite guide. Every line you emit must be something a writer can act on **before** the sentence exists.

## Read for feel first

Before you fill any axis, read the corpus the way a reader would: where the prose speeds up and where it slows down, how long the author stays with one thought, how a paragraph opens and how it lets go, whether the voice sits close to the reader or keeps its distance, what a sentence sounds like when it lands. The measured numbers describe the skeleton; your job is the gait. A directive earns its place when following it makes new text **feel** like this author on the page, not merely match their statistics — so when you must choose between a habit that is easy to count and a habit that carries the voice, profile the one that carries the voice.

Write directives in the imperative, aimed at the moment of composition: "open a section with the decision, then the number that forces it" — not "the author tends to be direct" and not "avoid vagueness." When a habit exists to create a feeling — pace, warmth, bluntness, restraint — name the feeling the directive is protecting, so a drafting agent knows what to preserve when the rule and the sentence collide.

## Axes

Fill this frame. One entry per axis, all seven, in this order:

${axisList}

For each axis give:
- \`observation\` — what this author actually does on this axis and how it reads, in one or two sentences, in ${targetLanguage}.
- \`directives\` — 2 to 5 imperative instructions a drafting agent can follow. Concrete over abstract. Name the author's actual constructions, positions, and choices.
- \`patterns\` — up to 3 short shapes the author reuses, written as reusable templates with the content blanked (for example "<수치> 기준으로 <판단>. <조건>이면 <대안>." ), never as a sentence copied from the sample.
- \`evidenceCount\` — how many distinct places in the sample support this axis. Count honestly; 0 is a valid answer.

If the author shows no distinctive habit on an axis, say so and give an empty \`directives\` list. Do not manufacture a rule to fill the frame, and do not repeat generic good-writing advice that any writer would follow.

## Adaptation

Give up to four entries covering formal report, email, explanatory prose, and persuasive writing: what carries over from this author's habits into that genre, and what the genre overrides. Genre convention wins over personal habit; say which parts bend.

## Boundaries

- Never reproduce a sentence from the samples, and never quote more than four consecutive words of the author's text.
- Omit personal names, organizations, and private facts. Style only — subject matter is not the profile.
- Do not diagnose the author, and do not infer education, background, or personality.
- Do not invent a quirk from a single occurrence. A habit needs repetition.
- Where the evidence is mixed, say it is mixed rather than picking a side.
- Put files you could not read in \`unsupportedFiles\`. Do not infer anything from filenames or metadata.
- \`summary\` is one or two sentences in ${targetLanguage} describing how the voice feels to read, for the user to read in the UI.`;
}

function adaptiveTimeout(baseMs, totalBytes = 0) {
  const sizeAllowance = Math.ceil(Math.max(0, Number(totalBytes) || 0) / (10 * 1024 * 1024)) * 2 * 60_000;
  return Math.min(MAX_TASK_TIMEOUT_MS, baseMs + sizeAllowance);
}

/** Race-safe CLI runner. It settles on close so stderr is fully drained and escalates termination. */
function runCli(command, args, stdin, cwd, timeoutMs, unavailableCode, deps = {}) {
  return new Promise((resolve, reject) => {
    const spawnProcess = deps.spawnProcess ?? spawn;
    const terminateProcess = deps.terminateProcess ?? terminateProcessTree;
    let child;
    try {
      child = spawnProcess(command, args, {
        ...processTreeSpawnOptions(),
        cwd,
        env: isolatedProcessEnv(deps),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new StyleCalibrationError(unavailableCode, String(error?.message ?? error)));
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let inputError = null;
    let processError = null;
    let stopping = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      terminateProcess(child, { graceMs: 5_000 });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CLI_OUTPUT_BYTES) {
        outputExceeded = true;
        stop();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.once('error', (error) => {
      processError = String(error?.message ?? error);
      if (child.pid) stop();
      else finish(new StyleCalibrationError(unavailableCode, processError));
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(new StyleCalibrationError(
          'TIMEOUT',
          `The selected model did not finish within ${Math.round(timeoutMs / 60_000)} minutes. The calibration was stopped safely; you can retry with fewer or smaller files.`,
        ));
      } else if (outputExceeded) {
        finish(new StyleCalibrationError('OUTPUT_TOO_LARGE', 'The selected model produced too much output to use safely. Please retry.'));
      } else if (inputError) {
        finish(new StyleCalibrationError('ANALYSIS_FAILED', `Could not send samples to ${command}: ${inputError}`));
      } else if (processError) {
        finish(new StyleCalibrationError(unavailableCode, processError));
      } else if (code === 0) finish(null, stdout);
      else {
        const message = stderr.trim() || `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
        const errorCode = /authenticate|oauth|login|not logged in/i.test(message)
          ? unavailableCode
          : 'ANALYSIS_FAILED';
        finish(new StyleCalibrationError(errorCode, message));
      }
    });
    child.stdin.on('error', (error) => {
      if (!timedOut) {
        inputError = String(error?.message ?? error);
        stop();
      }
    });
    try { child.stdin.end(stdin); }
    catch (error) { finish(new StyleCalibrationError('ANALYSIS_FAILED', String(error?.message ?? error))); }
  });
}

function runCodex(args, stdin, cwd, timeoutMs = ANALYSIS_TIMEOUT_MS, deps = {}) {
  return runCli('codex', args, stdin, cwd, timeoutMs, 'CODEX_UNAVAILABLE', deps);
}

function runClaude(args, stdin, cwd, timeoutMs = ANALYSIS_TIMEOUT_MS, deps = {}) {
  return runCli('claude', args, stdin, cwd, timeoutMs, 'CLAUDE_UNAVAILABLE', deps);
}

function extractStructuredResult(output, unavailableCode = 'CODEX_UNAVAILABLE') {
  try {
    // Tests and older callers may return a single structured object. Codex
    // itself emits JSONL and places the schema-constrained JSON in its final
    // agent_message item.
    try {
      const parsed = JSON.parse(output);
      if (parsed?.is_error) {
        const message = String(parsed.result || parsed.error || 'The selected model failed to analyze the samples.');
        const code = /authenticate|oauth|login/i.test(message) ? unavailableCode : 'ANALYSIS_FAILED';
        throw new StyleCalibrationError(code, message);
      }
      if (parsed?.structured_output) return parsed.structured_output;
      if (parsed?.result && typeof parsed.result === 'object') return parsed.result;
      if (!parsed?.type) return parsed;
    } catch (error) {
      if (error instanceof StyleCalibrationError) throw error;
    }
    let finalText = '';
    let failure = '';
    for (const line of String(output).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        finalText = String(event.item.text ?? '');
      } else if (event.type === 'turn.failed') {
        failure = String(event.error?.message ?? event.message ?? 'Calibration failed.');
      }
    }
    if (failure) {
      const code = /authenticate|oauth|login/i.test(failure) ? unavailableCode : 'ANALYSIS_FAILED';
      throw new StyleCalibrationError(code, failure);
    }
    return JSON.parse(finalText);
  } catch (error) {
    if (error instanceof StyleCalibrationError) throw error;
    throw new StyleCalibrationError('INVALID_RESULT', 'The selected model returned an unreadable style analysis. Please try again.');
  }
}

function codexArgs(schemaPath, sandbox, { model, effort } = {}) {
  return [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
    '--disable', 'image_generation', '--disable', 'multi_agent', '--disable', 'plugins',
    '--disable', 'skill_search', '--sandbox', sandbox, '--output-schema', schemaPath,
    ...(model ? ['--model', model] : []),
    ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    '-',
  ];
}

function claudeArgs(schema, sandbox, cwd, { model, effort } = {}) {
  const normalized = cwd.replace(/\\/g, '/').replace(/^\/+/, '');
  const tools = sandbox === 'workspace-write' ? 'Read,Write' : 'Read';
  const allow = [`Read(//${normalized}/**)`, ...(sandbox === 'workspace-write' ? [`Write(//${normalized}/**)`] : [])];
  return [
    '-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    '--setting-sources', '', '--disable-slash-commands', '--tools', tools,
    '--permission-mode', 'dontAsk', '--settings', JSON.stringify({ permissions: { allow } }),
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ];
}

async function gatherCorpus(checked, temp, {
  projectRoot = null, onProgress = () => {}, extractText = extractReferenceText,
} = {}) {
  const chunks = [];
  const sources = [];
  const failed = [];
  for (const [index, file] of checked.files.entries()) {
    const progressState = file.native ? 'reading' : 'extracting';
    onProgress({
      state: progressState, phase: progressState, activity: file.native ? 'reading-sample' : 'extracting-text',
      detail: `${file.native ? 'Reading' : 'Extracting text from'} ${file.name}`,
      completed: index, total: checked.files.length,
    });
    try {
      let text = '';
      if (file.native) {
        text = plainTextFromNative(file.bytes, file.extension);
      } else if (LOCAL_EXTRACTION_EXTENSIONS.has(file.extension)) {
        const extracted = await extractText({
          bytes: file.bytes,
          filePath: path.join(temp, file.safeName),
          name: file.name,
          projectRoot,
        });
        text = extracted.text;
      } else if (file.extension === '.rtf') {
        // RTF control words are removed locally. Unicode escapes keep their text value.
        text = file.bytes.toString('utf8')
          .replace(/\\u(-?\d+)\??/g, (_, value) => String.fromCharCode((Number(value) + 65536) % 65536))
          .replace(/\\'[0-9a-f]{2}/gi, ' ')
          .replace(/\\(?:par|line)\b\s?/g, '\n')
          .replace(/\\[a-z]+-?\d*\s?/gi, '')
          .replace(/[{}]/g, ' ');
      }
      if (!text.trim()) throw new Error('no readable authored prose');
      const source = { name: file.name, text: text.trim() };
      sources.push(source);
      chunks.push(`--- ${source.name} ---\n${source.text}`);
    } catch (error) {
      // 사용자가 올린 이름으로 보고한다. 내부 스테이징 이름은 UI에 보이지 않는다.
      failed.push(file.name);
    }
    onProgress({
      state: progressState, phase: progressState, activity: file.native ? 'reading-sample' : 'extracting-text',
      detail: `Prepared ${index + 1} of ${checked.files.length} samples`, completed: index + 1, total: checked.files.length,
    });
  }
  const text = chunks.join('\n\n').trim();
  if (text) await fs.writeFile(path.join(temp, 'calibration-corpus.txt'), text, { encoding: 'utf8', mode: 0o600 });
  return { text, sources, unextractable: failed };
}

/** 프롬프트에 실을 원고 상한. 컨텍스트를 넘기지 않으면서 문체는 충분히 보인다. */
const OPENROUTER_CORPUS_LIMIT = 120_000;

function representativeSlice(text, budget) {
  const value = String(text ?? '');
  if (value.length <= budget) return value;
  if (budget <= 32) return value.slice(0, budget);
  const separator = '\n[…sample continues…]\n';
  const available = Math.max(1, budget - separator.length * 2);
  const firstLength = Math.ceil(available / 3);
  const middleLength = Math.floor(available / 3);
  const lastLength = available - firstLength - middleLength;
  const middleStart = Math.max(firstLength, Math.floor((value.length - middleLength) / 2));
  return [
    value.slice(0, firstLength),
    value.slice(middleStart, middleStart + middleLength),
    value.slice(-lastLength),
  ].join(separator).slice(0, budget);
}

/** Balanced prompt sampling: every source receives a share before long files consume spare room. */
export function sampleCorpusForPrompt(sources, limit = OPENROUTER_CORPUS_LIMIT) {
  const normalized = (Array.isArray(sources) ? sources : []).flatMap((source, index) => {
    const text = String(source?.text ?? '').trim();
    if (!text) return [];
    return [{ name: String(source?.name || `sample-${index + 1}`).slice(0, 160), text }];
  });
  if (normalized.length === 0 || limit <= 0) return '';
  const headers = normalized.map((source) => `--- ${source.name} ---\n`);
  const headerCost = headers.reduce((sum, header) => sum + header.length + 2, 0);
  let remaining = Math.max(0, limit - headerCost);
  const allocations = new Array(normalized.length).fill(0);
  const pending = new Set(normalized.map((_, index) => index));
  while (remaining > 0 && pending.size > 0) {
    const share = Math.max(1, Math.floor(remaining / pending.size));
    let spent = 0;
    for (const index of [...pending]) {
      const needed = normalized[index].text.length - allocations[index];
      const grant = Math.min(needed, share);
      allocations[index] += grant;
      remaining -= grant;
      spent += grant;
      if (allocations[index] >= normalized[index].text.length) pending.delete(index);
      if (remaining <= 0) break;
    }
    if (spent === 0) break;
  }
  return normalized.map((source, index) => (
    `${headers[index]}${representativeSlice(source.text, allocations[index])}`
  )).join('\n\n').slice(0, limit);
}

/** OpenRouter 는 스키마 강제 모드가 없다 — 지시문으로 요구하고 여기서 파싱한다. */
async function analyzeViaOpenRouter({ prompt, corpusText, corpusSources, model: modelId, piManager, openRouter, timeoutMs }) {
  const status = await piManager.status();
  const model = status.models.find((entry) => entry.id === modelId);
  if (!model) throw new StyleCalibrationError('MODEL_UNAVAILABLE', `The selected Pi model is not configured: ${modelId || '(none)'}.`);
  const sample = sampleCorpusForPrompt(
    Array.isArray(corpusSources) && corpusSources.length > 0
      ? corpusSources
      : [{ name: 'writing-samples', text: String(corpusText ?? '') }],
  );
  if (!sample.trim()) {
    throw new StyleCalibrationError('INSUFFICIENT_SAMPLE', 'No readable text was found in the samples.');
  }
  let text;
  try {
    text = await openRouter.chat({
      key: piManager.apiKey(),
      model: model.id,
      messages: [{
        role: 'user',
        content: [
          prompt,
          '',
          '## Samples',
          '',
          sample,
          '',
          'Return ONLY a JSON object matching this JSON Schema. No prose, no code fences.',
          JSON.stringify(ANALYSIS_SCHEMA),
        ].join('\n'),
      }],
      maxTokens: 8_000,
      timeout: timeoutMs,
    });
  } catch (error) {
    const code = error?.code === 'OPENROUTER_TIMEOUT' ? 'TIMEOUT' : (error?.code ?? 'ANALYSIS_FAILED');
    throw new StyleCalibrationError(code, String(error?.message ?? error));
  }
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  try {
    if (start < 0 || end <= start) throw new Error('no JSON object');
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new StyleCalibrationError('INVALID_RESULT', 'The model returned an unreadable style analysis. Please try again.');
  }
}

export function validateAnalysisStructure(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.enoughSample !== 'boolean'
    || !Number.isFinite(Number(result.pageEquivalent))
    || typeof result.summary !== 'string'
    || !Array.isArray(result.unsupportedFiles)
    || !Array.isArray(result.axes)
    || !Array.isArray(result.adaptation)) {
    throw new StyleCalibrationError('INVALID_RESULT', 'The selected model returned an incomplete style analysis. Please try again.');
  }
  const axes = new Map();
  for (const axis of result.axes) {
    if (!axis || !AXIS_IDS.includes(axis.axis) || axes.has(axis.axis)
      || typeof axis.observation !== 'string'
      || !Number.isFinite(Number(axis.evidenceCount))
      || !Array.isArray(axis.directives)
      || !Array.isArray(axis.patterns)) {
      throw new StyleCalibrationError('INVALID_RESULT', 'The selected model returned malformed writing-style axes. Please try again.');
    }
    axes.set(axis.axis, axis);
  }
  if (axes.size !== AXIS_IDS.length || AXIS_IDS.some((id) => !axes.has(id))) {
    throw new StyleCalibrationError('INVALID_RESULT', 'The selected model did not return all seven writing-style axes. Please try again.');
  }
  return result;
}

function orderedAxes(axes) {
  const byId = new Map((Array.isArray(axes) ? axes : []).map((axis) => [axis.axis, axis]));
  return STYLE_AXES.map((axis) => {
    const found = byId.get(axis.id) ?? {};
    const directives = (Array.isArray(found.directives) ? found.directives : [])
      .map((line) => String(line).trim()).filter(Boolean);
    const patterns = (Array.isArray(found.patterns) ? found.patterns : [])
      .map((line) => String(line).trim()).filter(Boolean);
    const evidenceCount = Number.isFinite(found.evidenceCount) ? Math.max(0, Math.round(found.evidenceCount)) : 0;
    return {
      axis: axis.id,
      title: axis,
      observation: String(found.observation ?? '').trim(),
      directives,
      patterns,
      evidenceCount,
      // 근거 수가 규칙의 강제력을 정한다. 모델이 스스로 강도를 올리지 못한다.
      strength: evidenceCount >= 8 && directives.length > 0 ? 'strict' : 'advisory',
    };
  });
}

const COVENANT = {
  ko: `이 프로필은 문장을 어떻게 쓸지만 정한다. 사실·수치·날짜·고유명사·인용·출처·인과 관계·주장의 방향은 문체를 이유로 바뀌지 않는다. 문서에 이미 있는 표기와 용어, 수신자와 장르가 요구하는 격식이 이 프로필보다 앞선다. 문체를 맞추려고 없던 주장이나 근거를 만들지 않는다.`,
  en: `This profile decides only how sentences are made. Facts, figures, dates, proper nouns, quotations, sources, causality, and the direction of a claim never change for stylistic reasons. The document's existing terminology and the formality the genre and recipient require both outrank this profile. Never invent a claim or a source to fit the voice.`,
};

const SECTION = {
  ko: {
    title: '개인 문체 프로필',
    covenant: '지키는 선',
    baselines: '기준선 (원고에서 측정)',
    axes: '작성 지시',
    adaptation: '장르별 조정',
    strict: '기본 규칙',
    advisory: '참고',
    noEvidence: '원고에서 뚜렷한 습관이 보이지 않는다. 문서와 장르 관행을 따른다.',
    patterns: '자주 쓰는 얼개',
    confidence: (level, sentences, stability) =>
      `표본 신뢰도 ${level} — 문장 ${sentences}개, 반쪽 일치도 ${stability}. 신뢰도가 낮으면 기준선을 넓게 잡고 지시는 참고로만 쓴다.`,
  },
  en: {
    title: 'Personal writing profile',
    covenant: 'Fixed boundaries',
    baselines: 'Baselines (measured from the samples)',
    axes: 'Writing directives',
    adaptation: 'Genre adaptation',
    strict: 'Rules',
    advisory: 'Advisory',
    noEvidence: 'No distinctive habit in the samples. Follow the document and the genre.',
    patterns: 'Recurring shapes',
    confidence: (level, sentences, stability) =>
      `Sample confidence ${level} — ${sentences} sentences, split-half agreement ${stability}. Lower confidence means wider baselines and advisory-only directives.`,
  },
};

/** style.md 는 코드가 만든다. 측정값과 규칙 강도가 모델 문장에 섞이지 않게 한다. */
export function renderStyleMarkdown({ language, axes, adaptation, bands, metrics, confidence, stability, summary }) {
  const lang = language === 'en' ? 'en' : 'ko';
  const t = SECTION[lang];
  const out = [`# ${t.title}`, ''];
  if (summary) out.push(summary.trim(), '');
  out.push(`## ${t.covenant}`, '', COVENANT[lang], '');

  if (bands) {
    out.push(`## ${t.baselines}`, '');
    for (const line of baselineLines(bands, lang)) out.push(`- ${line}`);
    out.push('', t.confidence(confidence, metrics.sentences, stability), '');
  }

  out.push(`## ${t.axes}`, '');
  for (const axis of axes) {
    out.push(`### ${lang === 'ko' ? axis.title.ko : axis.title.en}`, '');
    if (axis.observation) out.push(axis.observation, '');
    if (axis.directives.length === 0) {
      out.push(t.noEvidence, '');
      continue;
    }
    out.push(`**${axis.strength === 'strict' ? t.strict : t.advisory}**`, '');
    for (const directive of axis.directives) out.push(`- ${directive}`);
    if (axis.patterns.length > 0) {
      out.push('', `**${t.patterns}**`, '');
      for (const pattern of axis.patterns) out.push(`- ${pattern}`);
    }
    out.push('');
  }

  if (adaptation.length > 0) {
    out.push(`## ${t.adaptation}`, '');
    for (const entry of adaptation) out.push(`- **${entry.genre}** — ${entry.guidance}`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {object} input
 * @param {{ run?: typeof runCodex, runClaude?: typeof runClaude, useOpenRouter?: boolean,
 *   piManager?: any, openRouter?: any, projectRoot?: string, isolatedHome?: string,
 *   sessionId?: string, spawnProcess?: typeof spawn, terminateProcess?: typeof terminateProcessTree,
 *   onProgress?: (event: object) => void }} [deps]
 */
export async function calibrateWritingStyle(input, { run = runCodex, ...deps } = {}) {
  const requestedAgent = input?.agent ?? input?.provider;
  const agent = ['codex', 'claude', 'pi'].includes(requestedAgent)
    ? requestedAgent
    : (openRouterReady(deps) ? 'pi' : 'codex');
  const viaOpenRouter = agent === 'pi';
  const model = typeof input?.model === 'string' && input.model.trim() ? input.model.trim() : null;
  const effort = typeof input?.effort === 'string' && input.effort.trim() ? input.effort.trim() : null;
  if (viaOpenRouter && !openRouterReady({ ...deps, useOpenRouter: true })) {
    throw new StyleCalibrationError('PI_NOT_CONFIGURED', 'Pi and its OpenRouter key must be configured before calibration.');
  }
  if (viaOpenRouter && !model) throw new StyleCalibrationError('MODEL_UNAVAILABLE', 'Choose one of your configured Pi models.');
  const emit = (event) => {
    try { deps.onProgress?.(event); } catch {}
  };
  const checked = validateCalibrationInput(input);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-style-calibration-'));
  try {
    emit({
      state: 'preparing', phase: 'preparing', activity: 'validating-samples',
      detail: `Preparing ${checked.files.length} writing samples`, completed: 0, total: checked.files.length,
    });
    for (const file of checked.files) {
      await fs.writeFile(path.join(temp, file.safeName), file.bytes, { mode: 0o600 });
    }

    const analysisSchemaPath = path.join(temp, 'analysis-schema.json');
    await fs.writeFile(analysisSchemaPath, JSON.stringify(ANALYSIS_SCHEMA), 'utf8');
    const corpus = await gatherCorpus(checked, temp, {
      projectRoot: deps.projectRoot,
      onProgress: emit,
      extractText: deps.extractText,
    });
    let metrics = null;
    let stability = 0;
    let confidence = 'low';
    let bands = null;
    if (corpus.text.length > 0) {
      emit({
        state: 'analyzing', phase: 'measuring', activity: 'measuring-patterns',
        detail: 'Measuring sentence, paragraph, and formatting patterns', completed: 0, total: 1,
      });
      metrics = analyzeText(corpus.text, checked.language);
      // 표본 충분성은 모델의 자기 신고가 아니라 측정값으로 정한다.
      if (metrics.pageEquivalent < REQUIRED_PAGES) {
        const unreadable = corpus.unextractable.length
          ? ` Unreadable: ${corpus.unextractable.join(', ')}.`
          : '';
        throw new StyleCalibrationError(
          'INSUFFICIENT_SAMPLE',
          `Readable writing measured about ${metrics.pageEquivalent} pages; at least ${REQUIRED_PAGES} are required.${unreadable}`,
        );
      }
      stability = splitHalfStability(corpus.text, checked.language);
      confidence = confidenceFor(metrics, stability);
      bands = deriveBands(metrics, confidence);
      emit({
        state: 'analyzing', phase: 'measuring', activity: 'measuring-patterns',
        detail: 'Finished deterministic pattern measurements', completed: 1, total: 1,
      });
    }

    const prompt = buildCalibrationPrompt({
      ...checked, metrics, inline: viaOpenRouter, preparedCorpus: Boolean(corpus.text),
    });
    const timeoutMs = adaptiveTimeout(ANALYSIS_TIMEOUT_MS, checked.totalBytes);
    const analysisStartedAt = Date.now();
    const safeActivities = [
      'Comparing recurring sentence structures',
      'Mapping tone and word-choice patterns',
      'Forming reusable writing directives',
    ];
    let activityIndex = 0;
    emit({
      state: 'analyzing', phase: 'analyzing', activity: 'model-analysis',
      detail: safeActivities[0], completed: 0, total: 1, agent, model,
    });
    const activityTimer = setInterval(() => {
      activityIndex = (activityIndex + 1) % safeActivities.length;
      emit({
        state: 'analyzing', phase: 'analyzing', activity: 'model-analysis',
        detail: safeActivities[activityIndex], completed: 0, total: 1,
        elapsedMs: Date.now() - analysisStartedAt, agent, model,
      });
    }, 8_000);
    activityTimer.unref?.();
    let result;
    try {
      if (viaOpenRouter) {
        result = await analyzeViaOpenRouter({
          prompt, corpusText: corpus.text, corpusSources: corpus.sources, model, timeoutMs, ...deps,
        });
      } else if (agent === 'claude') {
        const claudeRunner = deps.runClaude ?? runClaude;
        result = extractStructuredResult(await claudeRunner(
          claudeArgs(ANALYSIS_SCHEMA, 'read-only', temp, { model, effort }), prompt, temp, timeoutMs, deps,
        ), 'CLAUDE_UNAVAILABLE');
      } else {
        result = extractStructuredResult(await run(
          codexArgs(analysisSchemaPath, 'read-only', { model, effort }), prompt, temp, timeoutMs, deps,
        ));
      }
    } finally {
      clearInterval(activityTimer);
    }
    emit({
      state: 'analyzing', phase: 'analyzing', activity: 'model-analysis',
      detail: 'Finished model analysis', completed: 1, total: 1, agent, model,
    });
    validateAnalysisStructure(result);

    // 정량 계층이 없을 때만 모델의 표본 판단에 기댄다.
    if (!metrics && !result?.enoughSample) {
      const unsupported = Array.isArray(result?.unsupportedFiles) && result.unsupportedFiles.length
        ? ` Unreadable: ${result.unsupportedFiles.join(', ')}.`
        : '';
      throw new StyleCalibrationError(
        'INSUFFICIENT_SAMPLE',
        `${String(result?.summary || `At least ${REQUIRED_PAGES} pages of readable writing are required.`)}${unsupported}`,
      );
    }

    const axes = orderedAxes(result?.axes);
    if (!axes.some((axis) => axis.directives.length > 0)) {
      throw new StyleCalibrationError('INVALID_RESULT', 'The selected model did not produce usable writing directives. Please try again.');
    }
    const adaptation = (Array.isArray(result?.adaptation) ? result.adaptation : [])
      .filter((entry) => entry?.genre && entry?.guidance)
      .map((entry) => ({ genre: String(entry.genre).trim(), guidance: String(entry.guidance).trim() }));
    const summary = String(result?.summary || '').slice(0, 500);

    emit({
      state: 'synthesizing', phase: 'composing', activity: 'building-profile',
      detail: 'Building the calibrated writing profile', completed: 0, total: 1, agent, model,
    });
    const markdown = renderStyleMarkdown({
      language: checked.language, axes, adaptation, bands, metrics, confidence, stability, summary,
    });
    // 모델은 스테이징 이름(safeName)으로 보고하므로 업로드 원본 이름으로 되돌린다.
    const originalNames = new Map(checked.files.map((file) => [file.safeName, file.name]));
    const unsupportedFiles = [...new Set([
      ...(Array.isArray(result?.unsupportedFiles) ? result.unsupportedFiles : [])
        .map((name) => originalNames.get(String(name)) ?? String(name)),
      ...corpus.unextractable.filter(Boolean),
    ])];
    emit({
      state: 'synthesizing', phase: 'composing', activity: 'building-profile',
      detail: 'Finished the calibrated writing profile', completed: 1, total: 1, agent, model,
    });

    return {
      markdown,
      language: checked.language,
      sourceCount: Math.max(0, checked.files.length - unsupportedFiles.length),
      pageEstimate: Math.max(
        REQUIRED_PAGES,
        Math.round(metrics ? metrics.pageEquivalent : Number(result?.pageEquivalent) || 0),
      ),
      summary,
      agent,
      model,
      profile: {
        version: 2,
        language: checked.language,
        confidence,
        stability,
        metrics,
        bands,
        axes: axes.map(({ title, ...rest }) => rest),
        adaptation,
        unsupportedFiles,
      },
    };
  } finally {
    // Cleanup failures must not replace a useful provider/validation error.
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
