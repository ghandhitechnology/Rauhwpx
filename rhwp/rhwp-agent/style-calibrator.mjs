import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeText, baselineLines, confidenceFor, deriveBands, splitHalfStability,
} from './style-metrics.mjs';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const ANALYSIS_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 180_000;
const REQUIRED_PAGES = 10;
const CALIBRATION_MODEL = 'gpt-5.6-sol';
const CALIBRATION_EFFORT = 'medium';
const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.pdf', '.docx', '.rtf', '.html', '.htm', '.csv', '.hwp', '.hwpx',
]);
/** 노드가 직접 읽을 수 있는 형식. 여기 없는 형식만 추출 패스를 태운다. */
const NATIVE_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.html', '.htm']);

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

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      maxItems: MAX_FILES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'extracted', 'reason'],
        properties: {
          source: { type: 'string' },
          extracted: { type: 'boolean' },
          reason: { type: 'string', maxLength: 200 },
        },
      },
    },
  },
};

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
  if (extension === '.html' || extension === '.htm') {
    return text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
  return text;
}

/** 추출 패스 프롬프트. 요약·정리 없이 원문 그대로 옮기는 것만 시킨다. */
export function buildExtractionPrompt(files) {
  const manifest = files.map((file) => `- ${file.safeName} (extracted/${file.safeName}.txt)`).join('\n');
  return `Extract the author's prose from each document below so it can be measured. This is a mechanical transcription job, not an analysis.

Files in the current directory:
${manifest}

For every file: read it, then use Write to save its body text verbatim to extracted/<same name>.txt as plain UTF-8.

- Copy the words exactly. Do not summarize, translate, reorder, correct, or reformat sentences.
- Keep paragraph breaks as blank lines. Drop page numbers, running headers and footers, watermarks, and image placeholders.
- Keep headings, list items, and table cell text on their own lines.
- If a file is unreadable or contains no authored prose, skip it, write no file for it, and report extracted=false with a short reason.

Report one entry per source file. Set reason to an empty string when extraction succeeds. Do not comment on writing quality.`;
}

/** 분석 패스 프롬프트. 계산 가능한 값은 이미 코드가 냈으므로 해석만 요구한다. */
export function buildCalibrationPrompt({ language, files, metrics }) {
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

  return `Profile the writing style of the attached samples, which the user confirms they wrote themselves. Use the Read tool on every readable file in the current directory. The profile language is ${targetLanguage}.

Files:
${manifest}

${measured}

## What this profile is for

The output is a **writing** specification. Agents will consult it while drafting new Korean office documents — reports, proposals, official letters, emails, explanatory prose — so that what they produce reads as if this author wrote it. It is not a checklist for grading finished text, and it is not a rewrite guide. Every line you emit must be something a writer can act on **before** the sentence exists.

Write directives in the imperative, aimed at the moment of composition: "open a section with the decision, then the number that forces it" — not "the author tends to be direct" and not "avoid vagueness."

## Axes

Fill this frame. One entry per axis, all seven, in this order:

${axisList}

For each axis give:
- \`observation\` — what this author actually does on this axis, in one or two sentences, in ${targetLanguage}.
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
- \`summary\` is one or two sentences in ${targetLanguage} describing the voice, for the user to read in the UI.`;
}

function runCodex(args, stdin, cwd, timeoutMs = ANALYSIS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new StyleCalibrationError('TIMEOUT', 'GPT-5.6 Sol took too long to analyze the samples. Try fewer or smaller files.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new StyleCalibrationError('CODEX_UNAVAILABLE', String(error?.message ?? error)));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        const message = stderr.trim() || `Codex exited with code ${code}`;
        const errorCode = /authenticate|oauth|login|not logged in/i.test(message)
          ? 'CODEX_UNAVAILABLE'
          : 'ANALYSIS_FAILED';
        reject(new StyleCalibrationError(errorCode, message));
      }
    });
    child.stdin.end(stdin);
  });
}

function extractStructuredResult(output) {
  try {
    // Tests and older callers may return a single structured object. Codex
    // itself emits JSONL and places the schema-constrained JSON in its final
    // agent_message item.
    try {
      const parsed = JSON.parse(output);
      if (parsed?.is_error) {
        const message = String(parsed.result || parsed.error || 'GPT-5.6 Sol failed to analyze the samples.');
        const code = /authenticate|oauth|login/i.test(message) ? 'CODEX_UNAVAILABLE' : 'ANALYSIS_FAILED';
        throw new StyleCalibrationError(code, message);
      }
      if (parsed?.structured_output) return parsed.structured_output;
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
        failure = String(event.error?.message ?? event.message ?? 'Codex calibration failed.');
      }
    }
    if (failure) {
      const code = /authenticate|oauth|login/i.test(failure) ? 'CODEX_UNAVAILABLE' : 'ANALYSIS_FAILED';
      throw new StyleCalibrationError(code, failure);
    }
    return JSON.parse(finalText);
  } catch (error) {
    if (error instanceof StyleCalibrationError) throw error;
    throw new StyleCalibrationError('INVALID_RESULT', 'GPT-5.6 Sol returned an unreadable style analysis. Please try again.');
  }
}

function codexArgs(schemaPath, sandbox) {
  return [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
    '--disable', 'image_generation', '--disable', 'multi_agent', '--disable', 'plugins',
    '--disable', 'skill_search', '--sandbox', sandbox, '--output-schema', schemaPath,
    '--model', CALIBRATION_MODEL,
    '-c', `model_reasoning_effort=${JSON.stringify(CALIBRATION_EFFORT)}`,
    '-',
  ];
}

async function gatherCorpus(checked, temp, run, extractionSchemaPath) {
  const chunks = [];
  const failed = [];
  for (const file of checked.files) {
    if (file.native) chunks.push(plainTextFromNative(file.bytes, file.extension));
  }
  const binaries = checked.files.filter((file) => !file.native);
  if (binaries.length > 0) {
    await fs.mkdir(path.join(temp, 'extracted'), { recursive: true });
    try {
      const output = await run(
        codexArgs(extractionSchemaPath, 'workspace-write'),
        buildExtractionPrompt(binaries),
        temp,
        EXTRACT_TIMEOUT_MS,
      );
      const report = extractStructuredResult(output);
      for (const entry of Array.isArray(report?.files) ? report.files : []) {
        if (!entry?.extracted) failed.push(String(entry?.source ?? ''));
      }
      for (const file of binaries) {
        try {
          chunks.push(await fs.readFile(path.join(temp, 'extracted', `${file.safeName}.txt`), 'utf8'));
        } catch {
          if (!failed.includes(file.safeName)) failed.push(file.safeName);
        }
      }
    } catch (error) {
      // 추출이 통째로 실패해도 분석 패스는 파일을 직접 읽을 수 있다. 정량 계층만
      // 포기하고, 그 사실이 프로필에 신뢰도로 남는다.
      if (error instanceof StyleCalibrationError && error.code === 'CODEX_UNAVAILABLE') throw error;
      for (const file of binaries) failed.push(file.safeName);
    }
  }
  return { text: chunks.join('\n\n').trim(), unextractable: failed };
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

export async function calibrateWritingStyle(input, { run = runCodex } = {}) {
  const checked = validateCalibrationInput(input);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-style-calibration-'));
  try {
    for (const file of checked.files) {
      await fs.writeFile(path.join(temp, file.safeName), file.bytes, { mode: 0o600 });
    }

    const extractionSchemaPath = path.join(temp, 'extraction-schema.json');
    const analysisSchemaPath = path.join(temp, 'analysis-schema.json');
    await Promise.all([
      fs.writeFile(extractionSchemaPath, JSON.stringify(EXTRACT_SCHEMA), 'utf8'),
      fs.writeFile(analysisSchemaPath, JSON.stringify(ANALYSIS_SCHEMA), 'utf8'),
    ]);
    const corpus = await gatherCorpus(checked, temp, run, extractionSchemaPath);
    let metrics = null;
    let stability = 0;
    let confidence = 'low';
    let bands = null;
    if (corpus.text.length > 0) {
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
    }

    const prompt = buildCalibrationPrompt({ ...checked, metrics });
    const output = await run(codexArgs(analysisSchemaPath, 'read-only'), prompt, temp);
    const result = extractStructuredResult(output);

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
      throw new StyleCalibrationError('INVALID_RESULT', 'GPT-5.6 Sol did not produce usable writing directives. Please try again.');
    }
    const adaptation = (Array.isArray(result?.adaptation) ? result.adaptation : [])
      .filter((entry) => entry?.genre && entry?.guidance)
      .map((entry) => ({ genre: String(entry.genre).trim(), guidance: String(entry.guidance).trim() }));
    const summary = String(result?.summary || '').slice(0, 500);

    const markdown = renderStyleMarkdown({
      language: checked.language, axes, adaptation, bands, metrics, confidence, stability, summary,
    });
    const unsupportedFiles = [...new Set([
      ...(Array.isArray(result?.unsupportedFiles) ? result.unsupportedFiles.map(String) : []),
      ...corpus.unextractable.filter(Boolean),
    ])];

    return {
      markdown,
      language: checked.language,
      sourceCount: Math.max(0, checked.files.length - unsupportedFiles.length),
      pageEstimate: Math.max(
        REQUIRED_PAGES,
        Math.round(metrics ? metrics.pageEquivalent : Number(result?.pageEquivalent) || 0),
      ),
      summary,
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
    await fs.rm(temp, { recursive: true, force: true });
  }
}
