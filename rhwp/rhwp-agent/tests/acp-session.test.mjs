import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  acpMcpServer,
  acpPermissionResponse,
  createBoundedNdjsonTransform,
  createPersistentAcpSession,
  isRhwpAcpPermissionRequest,
  selectAcpMode,
} from '../agents/acp-session.mjs';

test('ACP NDJSON framing rejects one oversized provider frame across chunks', async () => {
  const accepted = createBoundedNdjsonTransform(5);
  let output = '';
  accepted.on('data', (chunk) => { output += String(chunk); });
  const ended = once(accepted, 'end');
  accepted.end('12345\n12\n');
  await ended;
  assert.equal(output, '12345\n12\n');

  const rejected = createBoundedNdjsonTransform(5);
  rejected.write('123');
  const failed = once(rejected, 'error');
  rejected.write('456');
  const [error] = await failed;
  assert.match(error.message, /exceeded 5 bytes/);
});

test('ACP helpers preserve MCP env names and only select advertised permission IDs', () => {
  assert.deepEqual(acpMcpServer('rhwp', {
    command: '/usr/bin/node', args: ['/mcp.mjs'], env: { TOKEN: 'secret', EPOCH: 4 },
  }), {
    name: 'rhwp', command: '/usr/bin/node', args: ['/mcp.mjs'],
    env: [{ name: 'TOKEN', value: 'secret' }, { name: 'EPOCH', value: '4' }],
  });
  const options = [
    { optionId: 'no', kind: 'reject_once' },
    { optionId: 'yes', kind: 'allow_once' },
  ];
  assert.deepEqual(acpPermissionResponse(options, true), {
    outcome: { outcome: 'selected', optionId: 'yes' },
  });
  assert.deepEqual(acpPermissionResponse(options, false), {
    outcome: { outcome: 'selected', optionId: 'no' },
  });
  assert.deepEqual(acpPermissionResponse([], true), { outcome: { outcome: 'cancelled' } });
  assert.equal(isRhwpAcpPermissionRequest({ toolCall: { name: 'mcp__rhwp__get_structure' } }), true);
  assert.equal(isRhwpAcpPermissionRequest({ toolCall: { name: 'rhwp:insert_text' } }), true);
  assert.equal(isRhwpAcpPermissionRequest({ toolCall: { name: 'shell' } }), false);
  assert.equal(isRhwpAcpPermissionRequest({ toolCall: { title: 'mcp__rhwp__get_structure' } }), false);
});

test('required ACP modes fail closed when absent or unmatched', () => {
  assert.throws(
    () => selectAcpMode(undefined, ['plan', 'architect'], { required: true, clientName: 'Cursor' }),
    /Cursor ACP does not advertise required mode \(plan, architect\)/,
  );
  assert.throws(
    () => selectAcpMode({ availableModes: [{ id: 'agent', name: 'Agent' }] }, ['plan'], {
      required: true, clientName: 'Grok',
    }),
    /Grok ACP does not advertise required mode \(plan\)/,
  );
  assert.throws(
    () => selectAcpMode({ availableModes: [{ name: 'Plan' }] }, ['plan'], {
      required: true, clientName: 'Cursor',
    }),
    /Cursor ACP does not advertise required mode \(plan\)/,
  );
  assert.equal(selectAcpMode(undefined, ['agent']), null, 'best-effort default mode stays compatible');
  assert.equal(
    selectAcpMode({ availableModes: [{ id: 'architect', name: 'Plan' }] }, ['plan'])?.id,
    'architect',
  );
});

class FakeAcpProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode = null;
  signalCode = null;
}

test('persistent ACP initializes once, serves extension requests, streams updates and cancels', async () => {
  const calls = [];
  const updates = [];
  const extensionResponses = [];
  let spawns = 0;
  let promptRequestId = null;
  let promptCount = 0;
  let blockedSignalAborted = false;
  let proc;

  function send(message) {
    proc.stdout.write(`${JSON.stringify(message)}\n`);
  }

  const transport = createPersistentAcpSession({
    clientName: 'rhwp-test',
    command: '/fake/acp',
    args: ['stdio'],
    cwd: '/tmp/project',
    env: { PATH: '/usr/bin' },
    authMethodId: 'cached_token',
    setModelMethod: 'session/set_model',
    isolatePrompts: false,
    promptCompletionMethods: ['_x.ai/session/prompt_complete'],
    requestHandlers: [{
      method: 'vendor/ask',
      handler: async (ctx) => {
        if (ctx.params.question !== 'block') return { answer: String(ctx.params.question).toUpperCase() };
        return new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            blockedSignalAborted = true;
            resolve({ aborted: true });
          }, { once: true });
        });
      },
    }],
    onSessionUpdate: (update) => updates.push(update),
  }, {
    spawnProcess() {
      spawns += 1;
      proc = new FakeAcpProcess();
      let buffer = '';
      proc.stdin.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          calls.push(frame);
          if (frame.method === 'initialize') {
            send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } });
          } else if (frame.method === 'authenticate') {
            send({ jsonrpc: '2.0', id: frame.id, result: {} });
          } else if (frame.method === 'session/new') {
            send({
              jsonrpc: '2.0', id: frame.id,
              result: {
                sessionId: 'native-1',
                modes: {
                  currentModeId: 'agent',
                  availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }],
                },
              },
            });
          } else if (frame.method === 'session/set_mode') {
            send({ jsonrpc: '2.0', id: frame.id, result: {} });
          } else if (frame.method === 'session/set_model') {
            send({ jsonrpc: '2.0', id: frame.id, result: {} });
          } else if (frame.method === 'session/prompt') {
            promptRequestId = frame.id;
            promptCount += 1;
            const text = frame.params.prompt[0].text;
            send({
              jsonrpc: '2.0', id: `ask-${promptCount}`, method: 'vendor/ask',
              params: { question: text === 'block' ? 'block' : 'hello' },
            });
          } else if (frame.method === 'session/cancel') {
            send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'cancelled' } });
          } else if (frame.id === `ask-${promptCount}` && frame.result) {
            extensionResponses.push(frame.result);
            if (promptCount === 3) continue;
            send({
              jsonrpc: '2.0', method: 'session/update',
              params: {
                sessionId: 'native-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `turn-${promptCount}` } },
              },
            });
            if (promptCount === 1) {
              send({
                jsonrpc: '2.0', method: '_x.ai/session/prompt_complete',
                params: {
                  sessionId: 'native-1',
                  promptId: 'rhwp-test-prompt-1',
                  stopReason: 'end_turn',
                },
              });
            } else {
              send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });
            }
          }
        }
      });
      return proc;
    },
    terminateProcess: async (child) => {
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    },
  });

  assert.equal((await transport.start()).sessionId, 'native-1');
  await transport.configure({ model: 'grok-4.6' });
  await transport.configure({ modeAliases: ['plan', 'architect'], requireModeMatch: true });
  await assert.rejects(
    transport.configure({ modeAliases: ['review'], requireModeMatch: true }),
    /rhwp-test ACP does not advertise required mode \(review\)/,
  );
  assert.equal((await transport.prompt('first')).stopReason, 'end_turn');
  assert.deepEqual(await transport.prompt('second'), { stopReason: 'end_turn' });
  const blocked = transport.prompt('block');
  await new Promise((resolve) => setImmediate(resolve));
  await transport.cancel();
  assert.equal((await blocked).stopReason, 'cancelled');
  await transport.dispose();

  assert.equal(spawns, 1);
  assert.equal(calls.filter((frame) => frame.method === 'initialize').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/new').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/set_model').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/set_mode').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/prompt').length, 3);
  assert.equal(calls.filter((frame) => frame.method === 'session/cancel').length, 1);
  assert.equal(blockedSignalAborted, true);
  assert.deepEqual(extensionResponses, [{ answer: 'HELLO' }, { answer: 'HELLO' }, { aborted: true }]);
  assert.deepEqual(updates.map((update) => update.content.text), ['turn-1', 'turn-2']);
});

test('persistent ACP selects providers that advertise mode through configOptions', async () => {
  const calls = [];
  let proc;
  const options = [
    {
      id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'build',
      options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }],
    },
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'openai/default',
      options: [
        { value: 'openai/default', name: 'OpenAI/Default' },
        { value: 'anthropic/claude-sonnet', name: 'Anthropic/Claude Sonnet' },
      ],
    },
    {
      id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low',
      options: [{ value: 'low', name: 'Low' }],
    },
  ];
  const send = (id, result) => proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  const transport = createPersistentAcpSession({
    clientName: 'rhwp-opencode-test',
    command: '/fake/opencode',
    args: ['acp', '--pure'],
    cwd: '/tmp/project',
    isolatePrompts: false,
  }, {
    spawnProcess() {
      proc = new FakeAcpProcess();
      let buffer = '';
      proc.stdin.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          calls.push(frame);
          if (frame.method === 'initialize') {
            send(frame.id, { protocolVersion: 1, agentCapabilities: {} });
          } else if (frame.method === 'session/new') {
            send(frame.id, { sessionId: 'opencode-session', configOptions: structuredClone(options) });
          } else if (frame.method === 'session/set_config_option') {
            const selected = options.find((option) => option.id === frame.params.configId);
            selected.currentValue = frame.params.value;
            if (frame.params.configId === 'model') {
              options.find((option) => option.id === 'effort').options = [
                { value: 'low', name: 'Low' }, { value: 'high', name: 'High' },
              ];
            }
            send(frame.id, { configOptions: structuredClone(options) });
          }
        }
      });
      return proc;
    },
    terminateProcess: async (child) => {
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      return true;
    },
  });

  await transport.configure({
    modeAliases: ['plan'], requireModeMatch: true,
    model: 'anthropic/claude-sonnet', requireModelMatch: true, effort: 'high',
  });
  await transport.configure({ modeAliases: ['plan'], requireModeMatch: true });
  await assert.rejects(
    transport.configure({ modeAliases: ['review'], requireModeMatch: true }),
    /rhwp-opencode-test ACP does not advertise required mode \(review\)/,
  );
  await assert.rejects(
    transport.configure({ model: 'unlisted/misreported', requireModelMatch: true }),
    /rhwp-opencode-test ACP does not advertise required model \(unlisted\/misreported\)/,
  );
  await transport.dispose();

  const selections = calls
    .filter((frame) => frame.method === 'session/set_config_option')
    .map((frame) => [frame.params.configId, frame.params.value]);
  assert.deepEqual(selections, [
    ['mode', 'plan'],
    ['model', 'anthropic/claude-sonnet'],
    ['effort', 'high'],
  ]);
  assert.equal(calls.some((frame) => frame.method === 'session/set_mode'), false);
});

test('isolated ACP prompts wait for tree proof and resume the session in a fresh process', async () => {
  const calls = [];
  let spawns = 0;
  let envCalls = 0;
  let releaseFirstCleanup;
  let markFirstCleanupStarted;
  const firstCleanupStarted = new Promise((resolve) => { markFirstCleanupStarted = resolve; });

  const closeChild = (child) => {
    child.exitCode = 0;
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  };
  const transport = createPersistentAcpSession({
    clientName: 'rhwp-prompt-isolation-test',
    command: '/fake/acp',
    args: ['stdio'],
    cwd: '/tmp/project',
    env: () => ({ PATH: '/usr/bin', ACP_ENV_GENERATION: String(++envCalls) }),
  }, {
    spawnProcess(_command, _args, options) {
      const generation = ++spawns;
      assert.equal(options.env.ACP_ENV_GENERATION, String(generation));
      const child = new FakeAcpProcess();
      child.generation = generation;
      let buffer = '';
      const send = (id, result) => child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id, result,
      })}\n`);
      child.stdin.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          calls.push({ generation, ...frame });
          if (frame.method === 'initialize') {
            send(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
          } else if (frame.method === 'session/new' || frame.method === 'session/load') {
            send(frame.id, { sessionId: 'isolated-session' });
          } else if (frame.method === 'session/prompt') {
            send(frame.id, { stopReason: 'end_turn' });
          }
        }
      });
      return child;
    },
    terminateProcess(child) {
      if (child.generation !== 1) {
        closeChild(child);
        return true;
      }
      markFirstCleanupStarted();
      return new Promise((resolve) => {
        releaseFirstCleanup = () => {
          closeChild(child);
          resolve(true);
        };
      });
    },
  });

  let firstSettled = false;
  const first = transport.prompt('first').finally(() => { firstSettled = true; });
  await firstCleanupStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false, 'prompt completion must wait for process-tree proof');
  releaseFirstCleanup();
  assert.equal((await first).stopReason, 'end_turn');
  assert.equal(transport.isStarted(), false, 'the completed prompt releases its ACP generation');

  assert.equal((await transport.prompt('second')).stopReason, 'end_turn');
  assert.equal(spawns, 2);
  assert.equal(envCalls, 2, 'the launch environment is rebuilt for every isolated child');
  assert.deepEqual(
    calls.filter((frame) => frame.method === 'session/new' || frame.method === 'session/load')
      .map((frame) => [frame.generation, frame.method, frame.params.sessionId ?? null]),
    [[1, 'session/new', null], [2, 'session/load', 'isolated-session']],
  );
  assert.deepEqual(
    calls.filter((frame) => frame.method === 'session/prompt').map((frame) => frame.generation),
    [1, 2],
  );
  assert.equal(await transport.dispose(), true);
});

test('an unproven isolated-prompt cleanup quarantines the ACP session', async () => {
  let spawns = 0;
  const transport = createPersistentAcpSession({
    clientName: 'rhwp-prompt-quarantine-test',
    command: '/fake/acp',
    args: ['stdio'],
    cwd: '/tmp/project',
    env: { PATH: '/usr/bin' },
  }, {
    spawnProcess() {
      spawns += 1;
      const child = new FakeAcpProcess();
      let buffer = '';
      const send = (id, result) => child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id, result,
      })}\n`);
      child.stdin.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.method === 'initialize') {
            send(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
          } else if (frame.method === 'session/new') {
            send(frame.id, { sessionId: 'quarantined-session' });
          } else if (frame.method === 'session/prompt') {
            send(frame.id, { stopReason: 'end_turn' });
          }
        }
      });
      return child;
    },
    terminateProcess(child) {
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      return null;
    },
  });

  await assert.rejects(
    transport.prompt('unsafe'),
    /process-tree cleanup could not be confirmed after the prompt/,
  );
  assert.equal(transport.isCleanupUncertain(), true);
  await assert.rejects(transport.start(), /cleanup remains unconfirmed/);
  assert.equal(spawns, 1, 'quarantine must prevent a fresh ACP process');
  assert.equal(await transport.dispose(), false);
});

test('a natural provider exit during a prompt cannot publish its terminal response', async () => {
  let proc;
  const transport = createPersistentAcpSession({
    clientName: 'rhwp-natural-prompt-exit-test',
    command: '/fake/acp',
    args: ['stdio'],
    cwd: '/tmp/project',
    env: { PATH: '/usr/bin' },
  }, {
    spawnProcess() {
      proc = new FakeAcpProcess();
      let buffer = '';
      const send = (id, result) => proc.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id, result,
      })}\n`);
      proc.stdin.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.method === 'initialize') {
            send(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
          } else if (frame.method === 'session/new') {
            send(frame.id, { sessionId: 'natural-prompt-exit' });
          } else if (frame.method === 'session/prompt') {
            send(frame.id, { stopReason: 'end_turn' });
            proc.exitCode = 0;
            proc.stdout.end();
            proc.emit('exit', 0, null);
            proc.emit('close', 0, null);
          }
        }
      });
      return proc;
    },
    terminateProcess: async () => null,
  });

  await assert.rejects(
    transport.prompt('must not complete'),
    /process-tree cleanup could not be confirmed after the prompt/,
  );
  assert.equal(transport.isCleanupUncertain(), true);
  assert.equal(await transport.dispose(), false);
});

test('a stale ACP generation cannot invoke request handlers during the next prompt', async () => {
  const children = [];
  let handlerCalls = 0;
  let secondPromptRequest = null;
  let markSecondPromptStarted;
  const secondPromptStarted = new Promise((resolve) => { markSecondPromptStarted = resolve; });
  const transport = createPersistentAcpSession({
    clientName: 'rhwp-generation-handler-test',
    command: '/fake/acp',
    args: ['stdio'],
    cwd: '/tmp/project',
    env: { PATH: '/usr/bin' },
    requestHandlers: [{
      method: 'vendor/ask',
      handler: async () => {
        handlerCalls += 1;
        return { answer: 'should-not-run' };
      },
    }],
  }, {
    spawnProcess() {
      const generation = children.length + 1;
      const child = new FakeAcpProcess();
      children.push(child);
      let buffer = '';
      const send = (id, result) => child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id, result,
      })}\n`);
      child.stdin.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.method === 'initialize') {
            send(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
          } else if (frame.method === 'session/new' || frame.method === 'session/load') {
            send(frame.id, { sessionId: 'generation-handler-session' });
          } else if (frame.method === 'session/prompt' && generation === 1) {
            send(frame.id, { stopReason: 'end_turn' });
          } else if (frame.method === 'session/prompt') {
            secondPromptRequest = frame.id;
            markSecondPromptStarted();
          }
        }
      });
      return child;
    },
    terminateProcess(child) {
      child.exitCode = 0;
      // Keep the fake readable object writable after proof so the test can
      // inject a frame that was queued by the retired generation.
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      return true;
    },
  });

  await transport.prompt('generation A');
  const second = transport.prompt('generation B');
  await secondPromptStarted;
  children[0].stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 'late-a', method: 'vendor/ask', params: { question: 'stale' },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handlerCalls, 0, 'the retired ClientApp cannot borrow generation B prompt authority');

  children[1].stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: secondPromptRequest, result: { stopReason: 'end_turn' },
  })}\n`);
  assert.equal((await second).stopReason, 'end_turn');
  assert.equal(await transport.dispose(), true);
});

test('ACP sends set_model again for the same model after a connection restart', async () => {
  const calls = [];
  let spawns = 0;
  const transport = createPersistentAcpSession({
    clientName: 'rhwp-model-generation-test',
    command: '/fake/acp',
    args: ['stdio'],
    cwd: '/tmp/project',
    env: { PATH: '/usr/bin' },
    setModelMethod: 'session/set_model',
  }, {
    spawnProcess() {
      const generation = ++spawns;
      const child = new FakeAcpProcess();
      let buffer = '';
      const send = (id, result) => child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id, result,
      })}\n`);
      child.stdin.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          calls.push({ generation, ...frame });
          if (frame.method === 'initialize') {
            send(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
          } else if (frame.method === 'session/new' || frame.method === 'session/load') {
            send(frame.id, { sessionId: 'model-generation-session' });
          } else if (frame.method === 'session/set_model') {
            send(frame.id, {});
          }
        }
      });
      return child;
    },
    terminateProcess: async (child) => {
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      return true;
    },
  });

  await transport.configure({ model: 'same-model' });
  await transport.configure({ model: 'same-model' });
  await transport.restart();
  await transport.configure({ model: 'same-model' });
  await transport.configure({ model: 'same-model' });

  const selections = calls.filter((frame) => frame.method === 'session/set_model');
  assert.equal(spawns, 2);
  assert.deepEqual(selections.map((frame) => frame.generation), [1, 2]);
  assert.deepEqual(selections.map((frame) => frame.params.modelId), ['same-model', 'same-model']);
  await transport.dispose();
});

test('a drained self-exit stays fail-closed when tree proof is unavailable', async () => {
  let proc = null;
  let spawns = 0;
  let loads = 0;
  const transport = createPersistentAcpSession({
    clientName: 'rhwp-restart-test',
    command: '/fake/acp',
    args: ['stdio'],
    cwd: '/tmp/project',
    env: { PATH: '/usr/bin' },
  }, {
    spawnProcess() {
      spawns += 1;
      proc = new FakeAcpProcess();
      let buffer = '';
      proc.stdin.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          const send = (result) => proc.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0', id: frame.id, result,
          })}\n`);
          if (frame.method === 'initialize') {
            send({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
          } else if (frame.method === 'session/new') {
            send({ sessionId: 'native-restart-1' });
          } else if (frame.method === 'session/load') {
            loads += 1;
            send({ sessionId: 'native-restart-1' });
          }
        }
      });
      return proc;
    },
    terminateProcess: async (child) => {
      if (child.exitCode != null || child.signalCode != null) return null;
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
      return true;
    },
  });

  assert.equal((await transport.start()).sessionId, 'native-restart-1');
  proc.exitCode = 0;
  proc.emit('exit', 0, null);
  proc.emit('close', 0, null);
  await assert.rejects(transport.restart(), /cleanup could not be confirmed/);
  await assert.rejects(transport.start(), /cleanup remains unconfirmed/);

  assert.equal(transport.isStarted(), false, 'the naturally closed connection is invalidated');
  assert.equal(spawns, 1);
  assert.equal(loads, 0);
  assert.equal(
    await transport.dispose(),
    false,
    'an earlier unavailable tree proof remains sticky for final disposal',
  );
});

test('ACP rejects a process that already exited before startup state is assigned', async () => {
  let spawns = 0;
  const transport = createPersistentAcpSession({
    clientName: 'rhwp-fast-exit-test',
    command: '/fake/acp',
    args: ['stdio'],
    cwd: '/tmp/project',
    env: { PATH: '/usr/bin' },
  }, {
    spawnProcess() {
      spawns += 1;
      const child = new FakeAcpProcess();
      child.exitCode = 0;
      return child;
    },
    terminateProcess: async () => null,
  });

  await assert.rejects(transport.start(), /exited \(code 0\)/);
  assert.equal(transport.isStarted(), false);
  assert.equal(spawns, 1);
  assert.equal(await transport.dispose(), false);
});
