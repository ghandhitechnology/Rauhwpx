import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCalibrationPrompt, calibrateWritingStyle, validateCalibrationInput } from '../style-calibrator.mjs';
import { WritingStyleStore } from '../writing-style.mjs';

function upload(name, text) {
  return { name, type: 'text/plain', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') };
}

test('calibration input rejects unsupported files and accepts authored text', () => {
  const checked = validateCalibrationInput({ language: 'ko', files: [upload('essay.md', '내가 직접 쓴 글입니다.')] });
  assert.equal(checked.language, 'ko');
  assert.equal(checked.files[0].name, 'essay.md');
  assert.throws(
    () => validateCalibrationInput({ language: 'ko', files: [upload('archive.zip', 'no')] }),
    (error) => error?.code === 'UNSUPPORTED_FILE',
  );
});

test('calibration prompt requires evidence, adaptation, and non-copying', () => {
  const checked = validateCalibrationInput({ language: 'en', files: [upload('sample.txt', 'A long sample')] });
  const prompt = buildCalibrationPrompt(checked);
  assert.match(prompt, /at least 10 ordinary pages/i);
  assert.match(prompt, /never reproduce a full sentence/i);
  assert.match(prompt, /formality/i);
  assert.match(prompt, /under 2,000 words/i);
});

test('calibration uses Opus 5 alias and returns a portable profile', async () => {
  let argsSeen = [];
  const result = await calibrateWritingStyle(
    { language: 'ko', files: [upload('essay.txt', '충분히 긴 원고라고 가정합니다.')] },
    {
      run: async (args, prompt, cwd) => {
        argsSeen = args;
        assert.match(prompt, /Korean/);
        assert.equal((await fs.readdir(cwd)).length, 1);
        return JSON.stringify({
          structured_output: {
            enoughSample: true,
            pageEquivalent: 12,
            summary: '간결한 문장과 구체적인 예시가 반복됩니다.',
            unsupportedFiles: [],
            styleMarkdown: `# 개인 문체 가이드\n\n${'구체적인 작성 규칙입니다. '.repeat(20)}`,
          },
        });
      },
    },
  );
  assert.deepEqual(argsSeen.slice(argsSeen.indexOf('--model'), argsSeen.indexOf('--model') + 2), ['--model', 'opus']);
  assert.deepEqual(argsSeen.slice(argsSeen.indexOf('--effort'), argsSeen.indexOf('--effort') + 2), ['--effort', 'medium']);
  assert.equal(result.pageEstimate, 12);
  assert.match(result.markdown, /개인 문체 가이드/);
});

test('calibration surfaces an expired Claude login instead of treating it as a result', async () => {
  await assert.rejects(
    calibrateWritingStyle(
      { language: 'ko', files: [upload('essay.txt', '충분히 긴 원고라고 가정합니다.')] },
      { run: async () => JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired' }) },
    ),
    (error) => error?.code === 'OPUS_UNAVAILABLE' && /authenticate/i.test(error.message),
  );
});

test('writing-style store persists metadata and injects guarded document guidance', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root }).init();
  assert.equal((await store.status()).active, false);
  const status = await store.save({
    markdown: `# Style\n\n${'Prefer concrete verbs and short openings. '.repeat(12)}`,
    language: 'en',
    sourceCount: 3,
    pageEstimate: 14,
    summary: 'Direct and concrete.',
  });
  assert.equal(status.active, true);
  assert.equal(status.sourceCount, 3);
  const block = await store.promptBlock();
  assert.match(block, /drafting or rewriting a document/);
  assert.match(block, /Do not imitate mechanically/);
  assert.match(block, /Prefer concrete verbs/);
});
