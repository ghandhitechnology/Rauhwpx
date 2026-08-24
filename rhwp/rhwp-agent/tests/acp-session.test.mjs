import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  acpMcpServer,
  acpPermissionResponse,
  createPersistentAcpSession,
  isRhwpAcpPermissionRequest,
} from '../agents/acp-session.mjs';

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
            send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'native-1' } });
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
  assert.equal(calls.filter((frame) => frame.method === 'session/prompt').length, 3);
  assert.equal(calls.filter((frame) => frame.method === 'session/cancel').length, 1);
  assert.equal(blockedSignalAborted, true);
  assert.deepEqual(extensionResponses, [{ answer: 'HELLO' }, { answer: 'HELLO' }, { aborted: true }]);
  assert.deepEqual(updates.map((update) => update.content.text), ['turn-1', 'turn-2']);
});
