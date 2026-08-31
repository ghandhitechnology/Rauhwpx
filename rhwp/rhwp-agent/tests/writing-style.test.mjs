import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCalibrationPrompt, calibrateWritingStyle, renderStyleMarkdown,
  sampleCorpusForPrompt, STYLE_AXES, validateAnalysisStructure, validateCalibrationInput,
} from '../style-calibrator.mjs';
import { analyzeText, deriveBands } from '../style-metrics.mjs';
import { WritingStyleStore, assertWritingStyleAppendCompatible } from '../writing-style.mjs';

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

function presencePayload() {
  return {
    portrait: '숫자에 기대 단정하고, 길어지면 스스로 자른다.',
    temperature: '건조하고 조금 성급하다.',
    unevenness: '문단 길이가 고르지 않고, 어떤 생각은 한 줄로 끝낸다.',
    stance: '판단을 미루지 않는다. 모르는 것은 모른다고 한다.',
    refusals: ['추상명사로 문장을 연다', '세 가지로 맞춰 나열한다'],
  };
}

function analysisOutput(overrides = {}) {
  return {
    enoughSample: true,
    pageEquivalent: 10,
    summary: '요약.',
    unsupportedFiles: [],
    presence: presencePayload(),
    axes: axisPayload(),
    adaptation: [],
    ...overrides,
  };
}

function axisPayload() {
  return STYLE_AXES.map((axis, index) => ({
    axis: axis.id,
    evidenceCount: index === 0 ? 12 : 2,
    observation: `${axis.ko} 관찰입니다.`,
    directives: [`${axis.ko}: 숫자를 먼저 쓰고 판단을 뒤에 붙인다.`],
    patterns: index === 0 ? ['a figure lands, then a short verdict'] : [],
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

test('calibration prompt asks for a person to inhabit, not a writing specification', () => {
  const checked = validateCalibrationInput({ language: 'en', files: [upload('sample.txt', 'A long sample')] });
  const prompt = buildCalibrationPrompt({ ...checked, metrics: null });
  assert.match(prompt, /person\*\* a drafting agent will inhabit/);
  assert.match(prompt, /not a style guide, not a checklist/);
  assert.match(prompt, /Brief an actor; do not issue a recipe/);
  assert.match(prompt, /never quote more than four consecutive words/);
  assert.match(prompt, /## Soul first/);
  assert.match(prompt, /`portrait`/);
  assert.match(prompt, /`refusals`/);
  assert.match(prompt, /profile the one that carries the voice/);
  assert.match(prompt, /Do not emit anti-AI rules/);
  assert.doesNotMatch(prompt, /Write directives in the imperative/);
  assert.match(prompt, /never as a fill-in-the-blank template/);
  for (const axis of STYLE_AXES) assert.ok(prompt.includes(axis.id), `${axis.id} 축이 프롬프트에 있어야 한다`);
});

test('measured numbers are handed to the model as settled context', () => {
  const checked = validateCalibrationInput({ language: 'ko', files: [upload('sample.txt', 'x')] });
  const metrics = analyzeText(longKoreanSample(), 'ko');
  const prompt = buildCalibrationPrompt({ ...checked, metrics });
  assert.match(prompt, /These numbers are a fingerprint, not a recipe/);
  assert.ok(prompt.includes('"sentenceLength"'));
});

test('style.md is rendered by code with portrait, covenant, fingerprint, and habit strength', () => {
  const metrics = analyzeText(longKoreanSample(), 'ko');
  const markdown = renderStyleMarkdown({
    language: 'ko',
    presence: presencePayload(),
    axes: [
      {
        axis: 'sentence_architecture',
        title: STYLE_AXES[0],
        observation: '짧은 단정과 긴 설명을 번갈아 쓴다.',
        directives: ['나쁜 소식은 문장이 숨을 곳이 없을 때까지 짧아진다.'],
        patterns: ['a figure lands, then a short verdict'],
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
  assert.match(markdown, /## 이 사람/);
  assert.match(markdown, /숫자에 기대 단정하고/);
  assert.match(markdown, /## 지키는 선/);
  assert.match(markdown, /사실·수치·날짜·고유명사/);
  assert.match(markdown, /## 지문 \(쓴 뒤에만 본다\)/);
  assert.match(markdown, /문장 길이 지문: 중앙값/);
  assert.match(markdown, /\*\*분명한 습관\*\*/);
  assert.match(markdown, /뚜렷한 습관이 보이지 않는다/);
  assert.match(markdown, /표본 신뢰도 high/);
  assert.doesNotMatch(markdown, /## 작성 지시/);
});

test('calibration measures the corpus itself and returns a structured profile', async () => {
  const argsByCall = [];
  const progress = [];
  const result = await calibrateWritingStyle(
    { language: 'ko', files: [upload('essay.txt', longKoreanSample())], agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    {
      onProgress: (event) => progress.push(event),
      run: async (args, prompt, cwd) => {
        argsByCall.push(args);
        assert.match(prompt, /Korean/);
        assert.ok((await fs.readdir(cwd)).includes('01-essay.txt'));
        return JSON.stringify({
          structured_output: analysisOutput({
            pageEquivalent: 0,
            summary: '간결한 문장과 구체적인 예시가 반복됩니다.',
            adaptation: [{ genre: '이메일', guidance: '인사말은 한 줄로 줄인다.' }],
          }),
        });
      },
    },
  );
  // 원고가 전부 평문이므로 추출 패스는 돌지 않는다.
  assert.equal(argsByCall.length, 1);
  const args = argsByCall[0];
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-5.6-sol']);
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  // 쪽수는 모델의 자기 신고(0)가 아니라 측정값에서 나온다.
  assert.ok(result.pageEstimate >= 10);
  assert.equal(result.profile.version, 3);
  assert.ok(result.profile.metrics.sentences > 100);
  assert.equal(result.profile.axes.length, STYLE_AXES.length);
  assert.equal(result.profile.axes[0].strength, 'strict');
  assert.equal(result.profile.axes[1].strength, 'advisory');
  assert.equal(result.profile.presence.portrait, presencePayload().portrait);
  assert.match(result.markdown, /## 이 사람/);
  assert.match(result.markdown, /## 문장에서 하는 일/);
  assert.ok(progress.some((event) => event.phase === 'measuring' && event.completed === 1));
  assert.ok(progress.some((event) => event.phase === 'analyzing' && event.activity === 'model-analysis'));
  assert.ok(progress.every((event) => !('reasoning' in event) && !('thinking' in event)));
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

test('binary samples are extracted locally before the single model analysis pass', async () => {
  const prompts = [];
  const result = await calibrateWritingStyle(
    { language: 'ko', files: [upload('report.pdf', 'binary-ish')] },
    {
      extractText: async () => ({ text: longKoreanSample() }),
      run: async (args, prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          structured_output: analysisOutput({ pageEquivalent: 0, summary: '요약.' }),
        });
      },
    },
  );
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /calibration-corpus\.txt/);
  assert.doesNotMatch(prompts[0], /mechanical transcription job/);
  assert.ok(result.profile.metrics.sentences > 100);
});

test('a failed extraction degrades to an advisory profile instead of failing', async () => {
  const result = await calibrateWritingStyle(
    { language: 'ko', files: [upload('report.hwp', 'binary-ish')] },
    {
      run: async (args) => {
        if (args[args.indexOf('--sandbox') + 1] === 'workspace-write') return JSON.stringify({ structured_output: { files: [{ source: '01-report.hwp', extracted: false, reason: 'unreadable' }] } });
        return JSON.stringify({
          structured_output: analysisOutput({ pageEquivalent: 14, summary: '요약.' }),
        });
      },
    },
  );
  assert.equal(result.profile.metrics, null);
  assert.equal(result.profile.bands, null);
  assert.equal(result.profile.confidence, 'low');
  assert.equal(result.pageEstimate, 14);
  assert.ok(result.profile.unsupportedFiles.includes('report.hwp'));
});

test('calibration surfaces an expired Codex login instead of treating it as a result', async () => {
  await assert.rejects(
    calibrateWritingStyle(
      { language: 'ko', files: [upload('essay.txt', longKoreanSample())] },
      { run: async () => JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired' }) },
    ),
    (error) => error?.code === 'CODEX_UNAVAILABLE' && /authenticate/i.test(error.message),
  );
});

test('Claude calibration uses the selected model and schema-constrained CLI output', async () => {
  let argv = null;
  const result = await calibrateWritingStyle(
    {
      language: 'ko', files: [upload('essay.txt', longKoreanSample())],
      agent: 'claude', model: 'sonnet', effort: 'high',
    },
    {
      run: async () => { throw new Error('Codex must not run'); },
      runClaude: async (args) => {
        argv = args;
        return JSON.stringify({
          structured_output: analysisOutput({ pageEquivalent: 10, summary: '요약.' }),
        });
      },
    },
  );
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
  assert.ok(argv.includes('--json-schema'));
  assert.equal(result.agent, 'claude');
  assert.equal(result.model, 'sonnet');
});

test('Pi calibration sends the explicitly selected configured model to OpenRouter', async () => {
  let requestedModel = null;
  const selected = 'anthropic/claude-sonnet-4.5';
  const result = await calibrateWritingStyle(
    {
      language: 'ko', files: [upload('essay.txt', longKoreanSample())],
      agent: 'pi', model: selected,
    },
    {
      useOpenRouter: true,
      piManager: {
        apiKey: () => 'secret',
        status: async () => ({ models: [{ id: selected }, { id: 'google/gemini-2.5-flash' }] }),
      },
      openRouter: {
        chat: async ({ model }) => {
          requestedModel = model;
          return JSON.stringify(analysisOutput({ pageEquivalent: 10, summary: '요약.' }));
        },
      },
    },
  );
  assert.equal(requestedModel, selected);
  assert.equal(result.agent, 'pi');
  assert.equal(result.model, selected);
});

test('Pi prompt sampling represents every source and the newest appended document within the cap', () => {
  const sources = Array.from({ length: 19 }, (_, index) => ({
    name: `old-${index + 1}.txt`,
    text: `OLD_${index + 1}\n${'가나다라마바사'.repeat(6_000)}`,
  }));
  sources.push({
    name: 'newly-appended.txt',
    text: `${'앞'.repeat(20_000)}NEW_APPEND_MARKER${'뒤'.repeat(20_000)}`,
  });
  const sample = sampleCorpusForPrompt(sources);
  assert.ok(sample.length <= 120_000);
  for (const source of sources) assert.match(sample, new RegExp(`--- ${source.name.replace('.', '\\.')} ---`));
  assert.match(sample, /OLD_1/);
  assert.match(sample, /NEW_APPEND_MARKER/);
});

test('analysis structure validation rejects a missing voice portrait', () => {
  assert.throws(
    () => validateAnalysisStructure(analysisOutput({
      presence: { portrait: '', temperature: '', unevenness: '', stance: '', refusals: [] },
    })),
    (error) => error?.code === 'INVALID_RESULT' && /incomplete/i.test(error.message),
  );
});

test('analysis structure validation rejects a partial seven-axis result', () => {
  assert.throws(
    () => validateAnalysisStructure({
      enoughSample: true, pageEquivalent: 10, summary: '요약', unsupportedFiles: [],
      presence: presencePayload(), axes: axisPayload().slice(0, 6), adaptation: [],
    }),
    (error) => error?.code === 'INVALID_RESULT' && /seven/i.test(error.message),
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
  assert.equal(status.additionalInstruction, '');
  assert.equal((await store.profile()).confidence, 'medium');
  const block = await store.promptBlock();
  assert.match(block, /person to inhabit, not a specification to satisfy/);
  assert.match(block, /fingerprint you glance at after a paragraph/);
  assert.match(block, /Generic polish is the failure mode/);
  assert.match(block, /Precedence/);
  assert.match(block, /Prefer concrete verbs/);

  const instructed = await store.setAdditionalInstruction('Keep the voice warm and avoid rhetorical questions.');
  assert.match(instructed.additionalInstruction, /voice warm/);
  const instructedBlock = await store.promptBlock();
  assert.match(instructedBlock, /personal_writing_instruction/);
  assert.match(instructedBlock, /avoid rhetorical questions/);

  const cleared = await store.setAdditionalInstruction('   ');
  assert.equal(cleared.additionalInstruction, '');
});

test('Windows startup recovers an additional instruction left at the replacement gap', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-instruction-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root, platform: 'win32' }).init();
  await store.save({
    markdown: `# Style\n\n${'Prefer concrete openings and explicit decisions. '.repeat(12)}`,
    language: 'en', sourceCount: 1, pageEstimate: 12, summary: '',
  });
  await store.setAdditionalInstruction('Preserve this instruction.');
  const instructionPath = path.join(root, 'additional-instruction.md');
  await fs.rename(instructionPath, `${instructionPath}.previous-write`);

  const recovered = await new WritingStyleStore({ root, platform: 'win32' }).init();
  assert.equal((await recovered.status()).additionalInstruction, 'Preserve this instruction.');
  await fs.copyFile(instructionPath, `${instructionPath}.previous-write`);
  await recovered.setAdditionalInstruction('');
  const restarted = await new WritingStyleStore({ root, platform: 'win32' }).init();
  assert.equal((await restarted.status()).additionalInstruction, '');
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

test('saved source documents support additive recalibration without re-uploading', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-sources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root }).init();
  const payload = {
    markdown: `# Style\n\n${'Prefer concrete openings and explicit decisions. '.repeat(12)}`,
    language: 'en', sourceCount: 1, pageEstimate: 12, summary: '', agent: 'claude', model: 'sonnet',
  };
  const first = upload('old.txt', 'saved original');
  await store.save(payload, { sources: [first] });
  const combined = await store.calibrationSources([
    upload('old-copy.txt', 'saved original'),
    upload('new.txt', 'new original'),
  ], { append: true });
  assert.deepEqual(combined.map((file) => file.name), ['old.txt', 'new.txt']);
  assert.ok(combined.every((file) => Buffer.isBuffer(file.bytes)));
  assert.ok(combined.every((file) => !Object.hasOwn(file, 'content')));
  const status = await store.save({ ...payload, sourceCount: 2 }, { sources: combined });
  assert.equal(status.savedSourceCount, 2);
  assert.deepEqual(status.sources.map((source) => source.name), ['old.txt', 'new.txt']);
  assert.equal(status.agent, 'claude');
  assert.equal(status.model, 'sonnet');
});

test('source metadata is bounded before it can make a saved profile unreadable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-source-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root }).init();
  const payload = {
    markdown: `# Style\n\n${'Prefer concrete openings and explicit decisions. '.repeat(12)}`,
    language: 'en', sourceCount: 1, pageEstimate: 12, summary: '',
  };

  await assert.rejects(
    store.calibrationSources([{ ...upload('source.txt', 'original'), type: 'x'.repeat(257) }]),
    { code: 'STYLE_SOURCES_LIMIT' },
  );
  const sources = await store.calibrationSources([upload('source.txt', 'original')]);
  sources[0].addedAt = 'x'.repeat(65);
  await assert.rejects(
    store.save(payload, { sources }),
    { code: 'STYLE_SOURCES_LIMIT' },
  );
  await assert.rejects(
    store.save(payload, {
      sources: [{ name: 'oversized.txt', type: 'text/plain', bytes: Buffer.alloc((20 * 1024 * 1024) + 1) }],
    }),
    { code: 'STYLE_SOURCES_LIMIT' },
  );
  assert.equal((await store.status()).active, false);
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.json')), false);
});

test('a corrupt saved-source manifest is surfaced instead of silently discarding the corpus', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-corrupt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root }).init();
  await fs.writeFile(path.join(root, 'sources.json'), '{broken', 'utf8');
  await assert.rejects(store.sourceDocuments(), (error) => error?.code === 'STYLE_SOURCES_CORRUPT');
});

test('writing-style persisted text and source catalogs are bounded before allocation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-bounds-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root }).init();
  await fs.writeFile(path.join(root, 'style.md'), 'x'.repeat(257 * 1024));
  await assert.rejects(store.status(), (error) => error?.code === 'BOUNDED_FILE_TOO_LARGE');

  await fs.rm(path.join(root, 'style.md'));
  const files = Array.from({ length: 21 }, (_, index) => {
    const id = (index + 1).toString(16).padStart(64, '0');
    return {
      id,
      sha256: id,
      storedName: `${String(index + 1).padStart(2, '0')}-${id}.txt`,
      name: `sample-${index + 1}.txt`,
      type: 'text/plain',
      size: 1,
      addedAt: '2026-08-31T00:00:00.000Z',
    };
  });
  await fs.writeFile(path.join(root, 'sources.json'), JSON.stringify({ version: 1, files }));
  await assert.rejects(store.sourceDocuments(), (error) => error?.code === 'STYLE_SOURCES_CORRUPT');
});

test('writing-style mutations serialize and a failed mutation does not poison the queue', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-mutations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root }).init();
  await store.save({
    markdown: `# Style\n\n${'Prefer concrete openings and explicit decisions. '.repeat(12)}`,
    language: 'en', sourceCount: 1, pageEstimate: 12, summary: '',
  });
  await Promise.all([
    store.setAdditionalInstruction('First queued instruction.'),
    store.setAdditionalInstruction('Second queued instruction.'),
  ]);
  assert.equal((await store.status()).additionalInstruction, 'Second queued instruction.');
  await assert.rejects(store.setAdditionalInstruction('x'.repeat(4_001)));
  await store.setAdditionalInstruction('Queue recovered.');
  assert.equal((await store.status()).additionalInstruction, 'Queue recovered.');
});

test('a missing saved-source blob is corruption instead of an omitted document', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-missing-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root }).init();
  const payload = {
    markdown: `# Style\n\n${'Prefer explicit decisions and concrete openings. '.repeat(12)}`,
    language: 'en', sourceCount: 1, pageEstimate: 12, summary: '',
  };
  await store.save(payload, { sources: [upload('source.txt', 'original text')] });
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'sources.json'), 'utf8'));
  await fs.rm(path.join(root, 'sources', manifest.files[0].storedName));
  await assert.rejects(store.status(), (error) => error?.code === 'STYLE_SOURCES_CORRUPT');
  await assert.rejects(store.sources(), (error) => error?.code === 'STYLE_SOURCES_CORRUPT');
});

test('startup rolls an interrupted multi-artifact transaction back to the previous profile', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-writing-style-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new WritingStyleStore({ root }).init();
  const oldMarkdown = `# Old style\n\n${'Keep the old stable profile. '.repeat(20)}`;
  await store.save({ language: 'en', markdown: oldMarkdown, sourceCount: 1, pageEstimate: 12, summary: 'old' });
  const oldMetadata = await fs.readFile(path.join(root, 'metadata.json'), 'utf8');
  const id = 'interrupted-test';
  const styleTemp = `style.md.tmp-${id}`;
  const metadataTemp = `metadata.json.tmp-${id}`;
  await fs.writeFile(path.join(root, styleTemp), `# New style\n\n${'partial write '.repeat(30)}`);
  await fs.writeFile(path.join(root, metadataTemp), JSON.stringify({ language: 'ko', summary: 'new' }));
  await fs.rename(path.join(root, 'style.md'), path.join(root, `style.md.old-${id}`));
  await fs.rename(path.join(root, styleTemp), path.join(root, 'style.md'));
  await fs.rename(path.join(root, 'metadata.json'), path.join(root, `metadata.json.old-${id}`));
  await fs.writeFile(path.join(root, 'commit-journal.json'), JSON.stringify({
    version: 1,
    id,
    artifacts: [
      { target: 'style.md', staged: styleTemp, hadOriginal: true },
      { target: 'metadata.json', staged: metadataTemp, hadOriginal: true },
    ],
  }));

  const recovered = await new WritingStyleStore({ root }).init();
  assert.equal(await fs.readFile(path.join(root, 'style.md'), 'utf8'), `${oldMarkdown.trim()}\n`);
  assert.equal(await fs.readFile(path.join(root, 'metadata.json'), 'utf8'), oldMetadata);
  assert.equal((await recovered.status()).summary, 'old');
  assert.equal((await fs.readdir(root)).some((name) => name.includes('.old-') || name.includes('.tmp-') || name === 'commit-journal.json'), false);
});

test('append compatibility protects the calibrated language and optional revision', () => {
  const status = { active: true, language: 'ko', updatedAt: '2026-08-15T00:00:00.000Z' };
  assert.doesNotThrow(() => assertWritingStyleAppendCompatible(status, {
    language: 'ko', baseRevision: status.updatedAt,
  }));
  assert.throws(
    () => assertWritingStyleAppendCompatible(status, { language: 'en' }),
    (error) => error?.code === 'CALIBRATION_LANGUAGE_MISMATCH',
  );
  assert.throws(
    () => assertWritingStyleAppendCompatible(status, { language: 'ko', baseRevision: 'stale' }),
    (error) => error?.code === 'STYLE_REVISION_CONFLICT',
  );
});
