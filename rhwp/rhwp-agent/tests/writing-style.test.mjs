import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCalibrationPrompt, buildExtractionPrompt, calibrateWritingStyle, renderStyleMarkdown,
  STYLE_AXES, validateCalibrationInput,
} from '../style-calibrator.mjs';
import { analyzeText, deriveBands } from '../style-metrics.mjs';
import { WritingStyleStore } from '../writing-style.mjs';

function upload(name, text) {
  return { name, type: 'text/plain', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') };
}

/** 10쪽(18,000자) 기준을 넘기는 한국어 원고를 만든다. */
function longKoreanSample() {
  const block = [
    '예산은 3,200만 원이 남았다. 3분기까지 이 속도로 쓰면 11월에 바닥난다.',
    '담당자는 2026년 2월에 바뀌었습니다. 인수인계 문서가 없어 같은 질문이 반복됩니다. 회의 대신 문서 한 장으로 정리했습니다.',
    '보고서는 짧게 쓴다. 표 하나와 문단 세 개면 대체로 충분하다. 길어지면 결재선에서 멈춘다.',
  ].join('\n\n');
  return `${block}\n\n`.repeat(160);
}

function axisPayload() {
  return STYLE_AXES.map((axis, index) => ({
    axis: axis.id,
    evidenceCount: index === 0 ? 12 : 2,
    observation: `${axis.ko} 관찰입니다.`,
    directives: [`${axis.ko}: 숫자를 먼저 쓰고 판단을 뒤에 붙인다.`],
    patterns: index === 0 ? ['<수치> 기준으로 <판단>. <조건>이면 <대안>.'] : [],
  }));
}

test('calibration input rejects unsupported files and accepts authored text', () => {
  const checked = validateCalibrationInput({ language: 'ko', files: [upload('essay.md', '내가 직접 쓴 글입니다.')] });
  assert.equal(checked.language, 'ko');
  assert.equal(checked.files[0].name, 'essay.md');
  assert.equal(checked.files[0].native, true);
  assert.throws(
    () => validateCalibrationInput({ language: 'ko', files: [upload('archive.zip', 'no')] }),
    (error) => error?.code === 'UNSUPPORTED_FILE',
  );
});

test('calibration prompt asks for writing directives, not a style critique', () => {
  const checked = validateCalibrationInput({ language: 'en', files: [upload('sample.txt', 'A long sample')] });
  const prompt = buildCalibrationPrompt({ ...checked, metrics: null });
  assert.match(prompt, /writing\*\* specification/);
  assert.match(prompt, /not a checklist for grading/);
  assert.match(prompt, /before\*\* the sentence exists/);
  assert.match(prompt, /never quote more than four consecutive words/);
  for (const axis of STYLE_AXES) assert.ok(prompt.includes(axis.id), `${axis.id} 축이 프롬프트에 있어야 한다`);
});

test('measured numbers are handed to the model as settled context', () => {
  const checked = validateCalibrationInput({ language: 'ko', files: [upload('sample.txt', 'x')] });
  const metrics = analyzeText(longKoreanSample(), 'ko');
  const prompt = buildCalibrationPrompt({ ...checked, metrics });
  assert.match(prompt, /These numbers are settled; do not restate, recompute, or contradict them/);
  assert.ok(prompt.includes('"sentenceLength"'));
});

test('extraction prompt asks for verbatim transcription only', () => {
  const checked = validateCalibrationInput({ language: 'ko', files: [upload('report.pdf', 'x')] });
  const prompt = buildExtractionPrompt(checked.files);
  assert.match(prompt, /Do not summarize, translate, reorder, correct, or reformat/);
  assert.match(prompt, /extracted\//);
});

test('style.md is rendered by code with covenant, baselines, and rule strength', () => {
  const metrics = analyzeText(longKoreanSample(), 'ko');
  const markdown = renderStyleMarkdown({
    language: 'ko',
    axes: [
      {
        axis: 'sentence_architecture',
        title: STYLE_AXES[0],
        observation: '짧은 단정과 긴 설명을 번갈아 쓴다.',
        directives: ['수치를 문장 앞에 놓는다.'],
        patterns: ['<수치> 기준으로 <판단>.'],
        evidenceCount: 12,
        strength: 'strict',
      },
      {
        axis: 'figuration',
        title: STYLE_AXES[5],
        observation: '',
        directives: [],
        patterns: [],
        evidenceCount: 0,
        strength: 'advisory',
      },
    ],
    adaptation: [{ genre: '보고서', guidance: '격식은 장르를 따른다.' }],
    bands: deriveBands(metrics, 'high'),
    metrics,
    confidence: 'high',
    stability: 0.9,
    summary: '짧은 단정형 문장이 반복됩니다.',
  });
  assert.match(markdown, /## 지키는 선/);
  assert.match(markdown, /사실·수치·날짜·고유명사/);
  assert.match(markdown, /## 기준선 \(원고에서 측정\)/);
  assert.match(markdown, /문장 길이: 중앙값/);
  assert.match(markdown, /\*\*기본 규칙\*\*/);
  assert.match(markdown, /뚜렷한 습관이 보이지 않는다/);
  assert.match(markdown, /표본 신뢰도 high/);
});

test('calibration measures the corpus itself and returns a structured profile', async () => {
  const argsByCall = [];
  const result = await calibrateWritingStyle(
    { language: 'ko', files: [upload('essay.txt', longKoreanSample())] },
    {
      run: async (args, prompt, cwd) => {
        argsByCall.push(args);
        assert.match(prompt, /Korean/);
        assert.equal((await fs.readdir(cwd)).length, 1);
        return JSON.stringify({
          structured_output: {
            enoughSample: true,
            pageEquivalent: 0,
            summary: '간결한 문장과 구체적인 예시가 반복됩니다.',
            unsupportedFiles: [],
            axes: axisPayload(),
            adaptation: [{ genre: '이메일', guidance: '인사말은 한 줄로 줄인다.' }],
          },
        });
      },
    },
  );
  // 원고가 전부 평문이므로 추출 패스는 돌지 않는다.
  assert.equal(argsByCall.length, 1);
  const args = argsByCall[0];
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'opus']);
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'medium']);
  // 쪽수는 모델의 자기 신고(0)가 아니라 측정값에서 나온다.
  assert.ok(result.pageEstimate >= 10);
  assert.equal(result.profile.version, 2);
  assert.ok(result.profile.metrics.sentences > 100);
  assert.equal(result.profile.axes.length, STYLE_AXES.length);
  assert.equal(result.profile.axes[0].strength, 'strict');
  assert.equal(result.profile.axes[1].strength, 'advisory');
  assert.match(result.markdown, /## 작성 지시/);
});

test('a measured corpus below ten pages is rejected without trusting the model', async () => {
  await assert.rejects(
    calibrateWritingStyle(
      { language: 'ko', files: [upload('essay.txt', '짧은 원고입니다. 두 문장뿐입니다.')] },
      {
        run: async () => JSON.stringify({
          structured_output: {
            enoughSample: true, pageEquivalent: 40, summary: '충분합니다.',
            unsupportedFiles: [], axes: axisPayload(), adaptation: [],
          },
        }),
      },
    ),
    (error) => error?.code === 'INSUFFICIENT_SAMPLE' && /at least 10 are required/i.test(error.message),
  );
});

test('binary samples go through an extraction pass before measurement', async () => {
  const prompts = [];
  const result = await calibrateWritingStyle(
    { language: 'ko', files: [upload('report.pdf', 'binary-ish')] },
    {
      run: async (args, prompt, cwd) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          await fs.mkdir(path.join(cwd, 'extracted'), { recursive: true });
          const [name] = (await fs.readdir(cwd)).filter((entry) => entry.endsWith('.pdf'));
          await fs.writeFile(path.join(cwd, 'extracted', `${name}.txt`), longKoreanSample(), 'utf8');
          return JSON.stringify({ structured_output: { files: [{ source: name, extracted: true }] } });
        }
        return JSON.stringify({
          structured_output: {
            enoughSample: true, pageEquivalent: 0, summary: '요약.',
            unsupportedFiles: [], axes: axisPayload(), adaptation: [],
          },
        });
      },
    },
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /mechanical transcription job/);
  assert.ok(result.profile.metrics.sentences > 100);
});

test('a failed extraction degrades to an advisory profile instead of failing', async () => {
  const result = await calibrateWritingStyle(
    { language: 'ko', files: [upload('report.hwp', 'binary-ish')] },
    {
      run: async (args) => {
        if (args.includes('Read,Write')) return JSON.stringify({ structured_output: { files: [{ source: '01-report.hwp', extracted: false, reason: 'unreadable' }] } });
        return JSON.stringify({
          structured_output: {
            enoughSample: true, pageEquivalent: 14, summary: '요약.',
            unsupportedFiles: [], axes: axisPayload(), adaptation: [],
          },
        });
      },
    },
  );
  assert.equal(result.profile.metrics, null);
  assert.equal(result.profile.bands, null);
  assert.equal(result.profile.confidence, 'low');
  assert.equal(result.pageEstimate, 14);
  assert.ok(result.profile.unsupportedFiles.includes('01-report.hwp'));
});

test('calibration surfaces an expired Claude login instead of treating it as a result', async () => {
  await assert.rejects(
    calibrateWritingStyle(
      { language: 'ko', files: [upload('essay.txt', longKoreanSample())] },
      { run: async () => JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired' }) },
    ),
    (error) => error?.code === 'OPUS_UNAVAILABLE' && /authenticate/i.test(error.message),
  );
});

test('writing-style store persists the structured profile and injects generative guidance', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root }).init();
  assert.equal((await store.status()).active, false);
  assert.equal(await store.profile(), null);
  const status = await store.save({
    markdown: `# Style\n\n${'Prefer concrete verbs and short openings. '.repeat(12)}`,
    language: 'en',
    sourceCount: 3,
    pageEstimate: 14,
    summary: 'Direct and concrete.',
    profile: { version: 2, confidence: 'medium', bands: { unit: 'words' } },
  });
  assert.equal(status.active, true);
  assert.equal(status.sourceCount, 3);
  assert.equal((await store.profile()).confidence, 'medium');
  const block = await store.promptBlock();
  assert.match(block, /specification for producing text, not a checklist for grading it/);
  assert.match(block, /baselines are targets you write toward/);
  assert.match(block, /Precedence/);
  assert.match(block, /Prefer concrete verbs/);
});

test('re-calibrating without measurements clears the stale quantitative layer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root }).init();
  const payload = { markdown: `# Style\n\n${'Short openings. '.repeat(20)}`, language: 'ko', sourceCount: 1, pageEstimate: 12, summary: '' };
  await store.save({ ...payload, profile: { version: 2, bands: { unit: '자' } } });
  assert.ok(await store.profile());
  await store.save(payload);
  assert.equal(await store.profile(), null);
});
