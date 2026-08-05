import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const ANALYSIS_TIMEOUT_MS = 120_000;
const MAX_STYLE_MARKDOWN_CHARS = 24_000;
const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.pdf', '.docx', '.rtf', '.html', '.htm', '.csv', '.hwp', '.hwpx',
]);

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['enoughSample', 'pageEquivalent', 'summary', 'unsupportedFiles', 'styleMarkdown'],
  properties: {
    enoughSample: { type: 'boolean' },
    pageEquivalent: { type: 'number', minimum: 0 },
    summary: { type: 'string', maxLength: 500 },
    unsupportedFiles: { type: 'array', maxItems: MAX_FILES, items: { type: 'string' } },
    styleMarkdown: { type: 'string', maxLength: MAX_STYLE_MARKDOWN_CHARS },
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
  return { name, bytes, safeName: `${String(index + 1).padStart(2, '0')}-${stem.slice(0, 80)}${extension}` };
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

export function buildCalibrationPrompt({ language, files }) {
  const targetLanguage = language === 'ko' ? 'Korean' : 'English';
  const manifest = files.map((file) => `- ${file.safeName} (original name: ${file.name})`).join('\n');
  return `Analyze the attached writing samples, which the user confirms were written entirely by them. Use the Read tool to inspect every readable file in the current directory. The calibration language is ${targetLanguage}.\n\nFiles:\n${manifest}\n\nFirst assess only the readable authored prose. Set enoughSample=true only when it is roughly equivalent to at least 10 ordinary pages. Put files you cannot reliably read in unsupportedFiles and do not infer style from filenames or metadata. If the sample is insufficient, return an empty styleMarkdown and a concise recovery message in summary.\n\nWhen enoughSample is true, produce a concrete, compact style.md in ${targetLanguage}. Keep it under 2,000 words. Analyze recurring habits rather than subject matter: paragraph and sentence structures, clause order, openings and transitions, rhythm and sentence-length distribution, preferred words and phrases, word-choice mappings for recurring rhetorical jobs, directness, concrete versus abstract expression, inferred academic/reading level without diagnosing the author, punctuation, whitespace, headings, lists, emphasis, parentheticals, and formality shifts. Include a compact adaptation matrix for formal reports, emails, explanatory prose, and persuasive writing. End with operating rules for agents. Merge overlapping observations and omit weak or one-off patterns.\n\nProtect the user from uncanny imitation: never reproduce a full sentence from the samples, never quote more than four consecutive source words, omit names and private facts, do not invent quirks unsupported by repetition, and instruct agents to preserve the user's authorship while adapting to audience, genre, and formality. The Markdown must be specific enough to guide future document drafting, but should not claim certainty where the evidence is mixed.`;
}

function runClaude(args, stdin, cwd, timeoutMs = ANALYSIS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new StyleCalibrationError('TIMEOUT', 'Opus 5 took too long to analyze the samples. Try fewer or smaller files.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new StyleCalibrationError('OPUS_UNAVAILABLE', String(error?.message ?? error)));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new StyleCalibrationError('ANALYSIS_FAILED', stderr.trim() || `Claude exited with code ${code}`));
    });
    child.stdin.end(stdin);
  });
}

function extractStructuredResult(output) {
  try {
    const parsed = JSON.parse(output);
    if (parsed?.is_error) {
      const message = String(parsed.result || parsed.error || 'Opus 5 failed to analyze the samples.');
      const code = /authenticate|oauth|login/i.test(message) ? 'OPUS_UNAVAILABLE' : 'ANALYSIS_FAILED';
      throw new StyleCalibrationError(code, message);
    }
    return parsed.structured_output ?? JSON.parse(parsed.result);
  } catch (error) {
    if (error instanceof StyleCalibrationError) throw error;
    throw new StyleCalibrationError('INVALID_RESULT', 'Opus 5 returned an unreadable style analysis. Please try again.');
  }
}

export async function calibrateWritingStyle(input, { run = runClaude } = {}) {
  const checked = validateCalibrationInput(input);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-style-calibration-'));
  try {
    for (const file of checked.files) {
      await fs.writeFile(path.join(temp, file.safeName), file.bytes, { mode: 0o600 });
    }
    const prompt = buildCalibrationPrompt(checked);
    const output = await run([
      '-p', '--safe-mode', '--output-format', 'json', '--disable-slash-commands',
      '--tools', 'Read', '--model', 'opus', '--effort', 'medium',
      '--json-schema', JSON.stringify(RESULT_SCHEMA),
    ], prompt, temp);
    const result = extractStructuredResult(output);
    if (!result?.enoughSample) {
      const unsupported = Array.isArray(result?.unsupportedFiles) && result.unsupportedFiles.length
        ? ` Unreadable: ${result.unsupportedFiles.join(', ')}.`
        : '';
      throw new StyleCalibrationError(
        'INSUFFICIENT_SAMPLE',
        `${String(result?.summary || 'At least 10 pages of readable writing are required.')}${unsupported}`,
      );
    }
    if (typeof result.styleMarkdown !== 'string' || result.styleMarkdown.trim().length < 200) {
      throw new StyleCalibrationError('INVALID_RESULT', 'Opus 5 did not produce a complete style guide. Please try again.');
    }
    return {
      markdown: result.styleMarkdown.trim(),
      language: checked.language,
      sourceCount: checked.files.length - (Array.isArray(result.unsupportedFiles) ? result.unsupportedFiles.length : 0),
      pageEstimate: Math.max(10, Math.round(Number(result.pageEquivalent) || 0)),
      summary: String(result.summary || '').slice(0, 500),
    };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
