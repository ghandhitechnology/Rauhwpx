import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOpenRouter } from '../openrouter.mjs';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** /api/v1/models 응답 모양을 그대로 축소한 픽스처. */
const CATALOG_FIXTURE = {
  data: [
    {
      id: 'deepseek/deepseek-chat-v3.1',
      name: 'DeepSeek: Chat v3.1',
      context_length: 163840,
      pricing: { prompt: '0.0000002', completion: '0.0000008' },
      supported_parameters: ['tools', 'tool_choice', 'reasoning'],
      architecture: { input_modalities: ['text'], output_modalities: ['text'], modality: 'text->text' },
    },
    {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Anthropic: Claude Sonnet 4.5',
      context_length: 1000000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      supported_parameters: ['tools', 'include_reasoning'],
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'], modality: 'text+image->text' },
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      name: 'Anthropic: Claude Haiku 4.5',
      context_length: 200000,
      pricing: { prompt: '0.000001', completion: '0.000005' },
      supported_parameters: ['tools'],
      // architecture 가 없는 항목도 통과해야 한다.
    },
    {
      id: 'openai/gpt-4o-mini-tts',
      name: 'OpenAI: TTS',
      context_length: 8192,
      pricing: { prompt: '0.0000006', completion: '0' },
      supported_parameters: ['tools'],
      architecture: { input_modalities: ['text'], output_modalities: ['audio'], modality: 'text->audio' },
    },
    {
      id: 'meta-llama/llama-3-8b',
      name: 'Meta: Llama 3 8B',
      context_length: 8192,
      pricing: { prompt: '0.00000005', completion: '0.00000008' },
      supported_parameters: ['max_tokens'],
      architecture: { input_modalities: ['text'], output_modalities: ['text'], modality: 'text->text' },
    },
  ],
};

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-openrouter-'));
}

test('validateKey reports the account and treats 401 as invalid', async () => {
  const calls = [];
  const client = createOpenRouter({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), auth: init.headers.Authorization });
      if (init.headers.Authorization === 'Bearer sk-good') {
        return jsonResponse(200, {
          data: { label: 'rhwp key', limit: 20, usage: 3.5, is_free_tier: false },
        });
      }
      return jsonResponse(401, { error: { message: 'No auth credentials found' } });
    },
  });

  const good = await client.validateKey('  sk-good  ');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/key');
  assert.equal(calls[0].auth, 'Bearer sk-good');
  assert.deepEqual(good, { valid: true, label: 'rhwp key', limit: 20, usage: 3.5, isFreeTier: false });

  const bad = await client.validateKey('sk-bad');
  assert.equal(bad.valid, false);
  assert.equal(bad.label, null);

  const empty = await client.validateKey('');
  assert.equal(empty.valid, false);
  assert.equal(calls.length, 2, '빈 키는 호출조차 하지 않는다');
});

test('validateKey turns a network failure into OPENROUTER_UNREACHABLE', async () => {
  const client = createOpenRouter({
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(() => client.validateKey('sk-x'), (error) => {
    assert.equal(error.code, 'OPENROUTER_UNREACHABLE');
    return true;
  });
});

test('catalog keeps tool-capable text models and maps pricing and reasoning', async () => {
  const client = createOpenRouter({ fetchImpl: async () => jsonResponse(200, CATALOG_FIXTURE) });
  const models = await client.catalog();

  assert.deepEqual(models.map((model) => model.id), [
    'anthropic/claude-haiku-4.5',
    'anthropic/claude-sonnet-4.5',
    'deepseek/deepseek-chat-v3.1',
  ], '도구 미지원·오디오 출력은 빠지고 provider→name 순으로 정렬된다');

  const deepseek = models.at(-1);
  assert.equal(deepseek.provider, 'deepseek');
  assert.equal(deepseek.name, 'DeepSeek: Chat v3.1');
  assert.equal(deepseek.contextLength, 163840);
  assert.deepEqual(deepseek.pricing, { prompt: 0.0000002, completion: 0.0000008 });
  assert.equal(deepseek.reasoning, true);
  assert.equal(models[1].reasoning, true, 'include_reasoning 도 reasoning 으로 본다');
  assert.equal(models[0].reasoning, false);
});

test('catalog caches in memory and on disk, refresh bypasses both', async () => {
  const rootDir = await tmpRoot();
  let hits = 0;
  let clock = 1_000;
  const client = createOpenRouter({
    cacheDir: rootDir,
    now: () => clock,
    fetchImpl: async () => {
      hits += 1;
      return jsonResponse(200, CATALOG_FIXTURE);
    },
  });

  await client.catalog();
  await client.catalog();
  assert.equal(hits, 1);

  const cached = JSON.parse(await fs.readFile(path.join(rootDir, 'models-cache.json'), 'utf8'));
  assert.equal(cached.fetchedAt, 1_000);
  assert.equal(cached.models.length, 3);

  // 새 클라이언트는 메모리 캐시가 없지만 디스크 캐시를 재사용한다.
  const reopened = createOpenRouter({
    cacheDir: rootDir,
    now: () => clock,
    fetchImpl: async () => { hits += 1; return jsonResponse(200, CATALOG_FIXTURE); },
  });
  assert.equal((await reopened.catalog()).length, 3);
  assert.equal(hits, 1);

  await reopened.catalog(true);
  assert.equal(hits, 2, 'refresh 는 캐시를 건너뛴다');

  clock += 2 * 60 * 60 * 1000;
  await reopened.catalog();
  assert.equal(hits, 3, '1시간이 지나면 다시 받아온다');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('concurrent catalog calls share one request', async () => {
  let hits = 0;
  const client = createOpenRouter({
    fetchImpl: async () => {
      hits += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse(200, CATALOG_FIXTURE);
    },
  });
  const [a, b] = await Promise.all([client.catalog(), client.catalog()]);
  assert.equal(hits, 1);
  assert.equal(a, b);
});

test('credits compute the balance and cache for five minutes', async () => {
  let hits = 0;
  let clock = 5_000;
  const client = createOpenRouter({
    now: () => clock,
    fetchImpl: async (url) => {
      hits += 1;
      assert.equal(String(url), 'https://openrouter.ai/api/v1/credits');
      return jsonResponse(200, { data: { total_credits: 25, total_usage: 4.257891 } });
    },
  });

  const credits = await client.credits('sk-good');
  assert.equal(credits.totalCreditsUsd, 25);
  assert.equal(credits.totalUsageUsd, 4.257891);
  assert.equal(credits.balanceUsd, 20.742109);
  assert.equal(credits.checkedAt, 5_000);

  await client.credits('sk-good');
  assert.equal(hits, 1);
  await client.credits('sk-good', true);
  assert.equal(hits, 2);
  clock += 6 * 60 * 1000;
  await client.credits('sk-good');
  assert.equal(hits, 3);
});

test('credits reject a bad key with OPENROUTER_KEY_INVALID', async () => {
  const client = createOpenRouter({ fetchImpl: async () => jsonResponse(401, { error: {} }) });
  await assert.rejects(() => client.credits('sk-bad'), (error) => {
    assert.equal(error.code, 'OPENROUTER_KEY_INVALID');
    return true;
  });
});

test('chat posts a non-streaming completion and returns assistant text', async () => {
  let sent = null;
  const client = createOpenRouter({
    fetchImpl: async (url, init) => {
      sent = { url: String(url), method: init.method, body: JSON.parse(init.body) };
      return jsonResponse(200, { choices: [{ message: { content: '문서 정리 계획' } }] });
    },
  });

  const text = await client.chat({
    key: 'sk-good',
    model: 'deepseek/deepseek-chat-v3.1',
    messages: [{ role: 'user', content: '제목 지어줘' }],
    maxTokens: 64,
  });

  assert.equal(text, '문서 정리 계획');
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.body.stream, false);
  assert.equal(sent.body.max_tokens, 64);
  assert.equal(sent.body.model, 'deepseek/deepseek-chat-v3.1');
});

test('chat joins block content and surfaces HTTP errors', async () => {
  const blocks = createOpenRouter({
    fetchImpl: async () => jsonResponse(200, {
      choices: [{ message: { content: [{ type: 'text', text: '가' }, { type: 'text', text: '나' }] } }],
    }),
  });
  assert.equal(await blocks.chat({ key: 'k', model: 'm', messages: [] }), '가나');

  const failing = createOpenRouter({
    fetchImpl: async () => jsonResponse(429, { error: { message: 'rate limited' } }),
  });
  await assert.rejects(() => failing.chat({ key: 'k', model: 'm', messages: [] }), (error) => {
    assert.equal(error.code, 'OPENROUTER_HTTP');
    assert.match(error.message, /rate limited/);
    return true;
  });
});
