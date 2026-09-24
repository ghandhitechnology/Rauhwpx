import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  codexLineup,
  createCodexModelResolver,
  discoverCodexModels,
  latestCodexModel,
} from '../codex-model-routing.mjs';

test('legacy version IDs retain their lineup and numeric versions determine the latest model', () => {
  assert.equal(codexLineup('gpt-6-sol'), 'sol');
  assert.equal(codexLineup('gpt-6.1-sol'), 'sol');
  assert.equal(codexLineup('sol'), 'sol');
  assert.equal(codexLineup('gpt-6-unknown'), null);
  const models = [
    { model: 'gpt-6-sol' },
    { id: 'gpt-1-sol', model: 'gpt-6.10-sol' },
    { model: 'gpt-6.9-sol' },
    { model: 'gpt-7-sol', hidden: true },
    { model: 'gpt-99-luna' },
  ];
  assert.equal(latestCodexModel(models, 'sol'), 'gpt-6.10-sol');
  assert.equal(latestCodexModel(models, 'luna'), 'gpt-99-luna');
  assert.equal(latestCodexModel(models, 'terra'), null);
});

test('resolver caches discovery and falls back within the requested lineup only after discovery fails', async () => {
  let calls = 0;
  let time = 0;
  const resolve = createCodexModelResolver({
    now: () => time,
    discover: async () => {
      calls++;
      if (calls === 1) return [{ model: 'gpt-6.1-sol' }, { model: 'gpt-6-astra' }];
      throw new Error('CLI unavailable');
    },
  });
  assert.equal(await resolve('sol'), 'gpt-6.1-sol');
  assert.equal(await resolve('astra'), 'gpt-6-astra');
  assert.equal(calls, 1);
  await assert.rejects(resolve('terra'), { code: 'MODEL_UNAVAILABLE' });
  time = 5 * 60 * 1000;
  assert.equal(await resolve('terra'), 'gpt-5.6-terra');
  assert.equal(await resolve('sol'), 'gpt-6-sol');
  assert.equal(calls, 2);
});

class FakeProcess extends EventEmitter {
  constructor(respond) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.write = (text) => {
      for (const line of String(text).split('\n').filter(Boolean)) {
        const frame = JSON.parse(line);
        queueMicrotask(() => respond(frame, (result) => {
          this.stdout.emit('data', `${JSON.stringify({ id: frame.id, result })}\n`);
        }));
      }
    };
  }

  kill(signal) {
    this.signalCode = signal;
    queueMicrotask(() => { this.emit('exit', null, signal); this.emit('close', null, signal); });
  }
}

test('discovery follows model/list cursors and closes its CLI process', async () => {
  const requests = [];
  const child = new FakeProcess((frame, reply) => {
    requests.push(frame);
    if (frame.method === 'initialize') reply({});
    if (frame.method === 'model/list') reply(frame.params.cursor
      ? { data: [{ model: 'gpt-6.1-sol', hidden: false }], nextCursor: null }
      : { data: [{ model: 'gpt-6-sol', hidden: false }], nextCursor: 'page-2' });
  });
  const models = await discoverCodexModels({
    bin: 'codex', codexHome: '/tmp/codex-test', env: { PATH: '/bin' },
    spawnProcess: (command, args, options) => {
      assert.equal(command, 'codex');
      assert.equal(options.env.CODEX_HOME, '/tmp/codex-test');
      assert.ok(args.includes('app-server'));
      return child;
    },
  });
  assert.deepEqual(models.map((entry) => entry.model), ['gpt-6-sol', 'gpt-6.1-sol']);
  assert.equal(requests.filter((frame) => frame.method === 'model/list').length, 2);
  assert.equal(child.signalCode, 'SIGTERM');
});

test('discovery deadline terminates an unresponsive CLI', async () => {
  const child = new FakeProcess(() => {});
  await assert.rejects(discoverCodexModels({
    env: { PATH: '/bin' }, spawnProcess: () => child, timeoutMs: 10,
  }), /timed out/);
  assert.equal(child.signalCode, 'SIGTERM');
});
