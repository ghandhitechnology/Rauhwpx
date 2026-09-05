import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { writeFakeCliBin } from './fake-cli-bin.mjs';

const token = 'provider-settings-test';
const launchId = 'provider-settings-launch';

async function connect(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data))));
  await once(socket, 'open');
  return {
    socket, frames,
    send: (frame) => socket.send(JSON.stringify({ v: 5, ...frame })),
    async next(predicate) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const index = frames.findIndex(predicate);
        if (index >= 0) return frames.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Missing frame. Received: ${JSON.stringify(frames).slice(-4000)}`);
    },
  };
}

async function fixture(t, { holdStartupDelayMs = 0 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-provider-settings-'));
  const piRoot = path.join(root, 'pi');
  const packageDir = path.join(piRoot, 'prefix/node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  writeFileSync(path.join(piRoot, 'config.json'), JSON.stringify({
    version: 1, installedVersion: '0.0.0-test', defaultModelId: 'test/reasoning',
    models: [
      { id: 'test/reasoning', name: 'Reasoning', reasoning: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'test/plain', name: 'Plain', reasoning: false, efforts: [], defaultEffort: null },
    ].map((model) => ({ ...model, contextLength: 8192, supportsImages: false, pricing: { prompt: 0, completion: 0 } })),
  }));
  mkdirSync(path.join(piRoot, 'agent'), { recursive: true });
  writeFileSync(path.join(piRoot, 'agent/models.json'), JSON.stringify({ providers: { openrouter: { apiKey: 'fixture-key' } } }));
  writeFakeCliBin(path.join(piRoot, 'prefix/node_modules/.bin'), 'pi', `
    if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
    const args = process.argv;
    const prompt = args.at(-1);
    const userPrompt = prompt.split('<user_request>').at(-1).split('</user_request>')[0].trim();
    if (userPrompt === 'HOLD') {
      const emit = (text) => console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }));
      setTimeout(() => {
        emit('HOLD_READY');
        let tick = 0;
        setInterval(() => emit('HOLD_TICK:' + (++tick)), 25);
      }, ${holdStartupDelayMs});
    }
    else {
      const selected = { model: args[args.indexOf('--model') + 1], effort: args.includes('--thinking') ? args[args.indexOf('--thinking') + 1] : null, prompt };
      console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: JSON.stringify(selected) } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    }
  `);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, NODE_ENV: 'test', RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: token,
      RHWP_LAUNCH_ID: launchId, RHWP_WORK_DIR: root, RHWP_PI_DIR: piRoot,
      RHWP_TEMPLATES_DIR: path.join(root, 'templates'), RHWP_AGENT_INSTRUCTIONS_DIR: path.join(root, 'instructions') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    rmSync(root, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hub startup timed out: ${errors}`)), 20_000);
    lines.on('line', (line) => {
      if (!line.startsWith('RHWP_HUB_READY ')) return;
      clearTimeout(timer);
      lines.close();
      resolve(JSON.parse(line.slice('RHWP_HUB_READY '.length)));
    });
  });
  const sessionId = 'provider-settings';
  const capabilities = await registerHubSession({ port: ready.port, token, launchId, sessionId });
  const url = `ws://127.0.0.1:${ready.port}/studio?token=${capabilities.studio}&sessionId=${sessionId}&instance=settings-test`;
  const studio = await connect(url);
  t.after(() => studio.socket.close());
  let seq = 0;
  const start = async (selection = {}) => {
    const requestId = `select-${++seq}`;
    studio.send({ type: 'chat-start', requestId, agent: 'pi', model: 'test/reasoning', effort: 'medium',
      threadId: 'thread-settings', documentId: 'document-settings', documentName: 'settings.hwpx', ...selection });
    return studio.next((frame) => frame.requestId === requestId);
  };
  const turn = async (text) => {
    studio.send({ type: 'chat-user-message', text, threadId: 'thread-settings', documentId: 'document-settings' });
    const delta = await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'text-delta');
    await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
    return JSON.parse(delta.event.text);
  };
  return { studio, start, turn, url, port: ready.port, sessionId, diagnostics: () => errors.slice(-4000) };
}

test('live hub applies model/effort/provider changes after a turn and preserves the thread on reconnect', { timeout: 40_000 }, async (t) => {
  const { studio, start, turn, url } = await fixture(t);
  const first = await start();
  assert.equal(first.type, 'chat-started');
  assert.equal((await turn('Remember the word orchard.')).effort, 'medium');
  const history = [{ role: 'user', text: 'Remember the word orchard.' }, { role: 'assistant', text: 'orchard' }];
  const effort = await start({ effort: 'high', history });
  assert.equal(effort.effort, 'high');
  const reply = await turn('What word did I ask you to remember?');
  assert.equal(reply.effort, 'high');
  assert.match(reply.prompt, /reopened_chat_history/);
  assert.match(reply.prompt, /orchard/);
  const plain = await start({ model: 'test/plain', effort: '', history });
  assert.equal(plain.effort, null);
  const plainReply = await turn('Continue.');
  assert.equal(plainReply.model, 'openrouter/test/plain');
  assert.equal(plainReply.effort, null);
  const codex = await start({ agent: 'codex', model: 'gpt-5.6-luna', effort: 'low', history });
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.threadId, first.threadId);
  const back = await start({ history });
  assert.equal(back.agent, 'pi');
  assert.match((await turn('Continue again.')).prompt, /orchard/);
  // Burst starts are serialized at the hub, and replies carry their own identity.
  for (let i = 0; i < 3; i++) studio.send({ type: 'chat-start', requestId: `burst-${i}`, agent: 'pi', model: 'test/reasoning',
    effort: ['low', 'medium', 'high'][i], threadId: first.threadId, documentId: first.documentId, history });
  for (let i = 0; i < 3; i++) assert.equal((await studio.next((frame) => frame.requestId === `burst-${i}`)).effort, ['low', 'medium', 'high'][i]);
  studio.socket.close();
  await once(studio.socket, 'close');
  const reconnected = await connect(url);
  t.after(() => reconnected.socket.close());
  const welcome = await reconnected.next((frame) => frame.type === 'welcome');
  assert.equal(welcome.session.model, 'test/reasoning');
  assert.equal(welcome.session.effort, 'high');
  assert.equal(welcome.session.threadId, first.threadId);
});

test('busy and invalid provider changes leave the active turn intact', { timeout: 40_000 }, async (t) => {
  const { studio, start, diagnostics } = await fixture(t, { holdStartupDelayMs: 250 });
  await start();
  studio.send({ type: 'chat-user-message', text: 'HOLD', threadId: 'thread-settings', documentId: 'document-settings' });
  const active = await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-start');
  const busy = await start({ effort: 'high' });
  assert.equal(busy.code, 'AGENT_BUSY');
  assert.equal(busy.session.status, 'running');
  assert.equal(busy.session.effort, 'medium');
  const invalid = await start({ agent: 'invalid' });
  assert.equal(invalid.code, 'INVALID_REQUEST');
  assert.equal(invalid.session.status, 'running');
  const diagnostic = () => JSON.stringify({
    frames: studio.frames.filter((frame) => frame.type === 'agent-event').slice(-8).map((frame) => ({
      ...frame, event: { ...frame.event, ...(frame.event.text ? { text: frame.event.text.slice(-800) } : {}) },
    })), stderr: diagnostics(),
  });
  // turn-start precedes spawning the CLI. Prove both startup rejection and
  // rejection against an actually running process, not merely hub status.
  const ready = await studio.next((frame) => frame.type === 'agent-event'
    && (frame.event.type === 'turn-end' || frame.event.type === 'error' || frame.event.text === 'HOLD_READY'));
  assert.equal(ready.event.text, 'HOLD_READY', `HOLD fixture failed to start: ${JSON.stringify(ready)} ${diagnostic()}`);
  const runningBusy = await start({ effort: 'high' });
  assert.equal(runningBusy.code, 'AGENT_BUSY');
  assert.equal(runningBusy.session.turnId, active.event.turnId);
  const runningInvalid = await start({ agent: 'invalid' });
  assert.equal(runningInvalid.code, 'INVALID_REQUEST');
  assert.equal(runningInvalid.session.turnId, active.event.turnId);
  // Require a heartbeat produced after both rejections, not one buffered earlier.
  for (let index = studio.frames.length - 1; index >= 0; index--) {
    if (studio.frames[index].event?.text?.startsWith('HOLD_TICK:')) studio.frames.splice(index, 1);
  }
  const alive = await studio.next((frame) => frame.type === 'agent-event'
    && (frame.event.type === 'turn-end' || frame.event.type === 'error' || frame.event.text?.startsWith('HOLD_TICK:')));
  assert.match(alive.event.text ?? '', /^HOLD_TICK:/, `HOLD process stopped: ${JSON.stringify(alive)} ${diagnostic()}`);
  assert.deepEqual(studio.frames.filter((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end'), [],
    `Active provider ended after rejected settings: ${diagnostic()}`);
  studio.send({ type: 'chat-interrupt' });
  const stopped = await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  assert.equal(stopped.event.turnId, active.event.turnId);
  assert.equal(stopped.event.stopReason, 'interrupted');
  assert.equal((await start({ effort: 'high' })).effort, 'high');
});

test('changing settings retains a reviewable plan and its permission mode', { timeout: 40_000 }, async (t) => {
  const { studio, start, port, sessionId } = await fixture(t);
  const first = await start({ workflow: 'plan', permissionProfile: 'unrestricted' });
  studio.send({ type: 'chat-user-message', text: 'HOLD', threadId: first.threadId, documentId: first.documentId });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-start');
  const mcp = await connect(`ws://127.0.0.1:${port}/mcp?token=${token}&sessionId=${sessionId}&agent=pi`);
  t.after(() => mcp.socket.close());
  mcp.send({ type: 'tool-call', id: 1, tool: 'present_implementation_plan', workflow: 'plan', capabilityEpoch: first.capabilityEpoch,
    args: { goal: 'Retain context', title: 'Settings plan', summary: 'Continue the existing plan', assumptions: [], decisions: ['Keep the thread'],
      steps: [{ title: 'Continue', details: 'Use the selected provider' }], files: [], validation: ['Check context'], risks: [], exclusions: [] } });
  const presented = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 1);
  assert.equal(presented.ok, true);
  studio.send({ type: 'chat-interrupt' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  const changed = await start({ workflow: 'plan', permissionProfile: 'unrestricted', effort: 'high' });
  assert.equal(changed.type, 'chat-started');
  assert.equal(changed.phase, 'awaiting-approval');
  assert.equal(changed.latestPlan.title, 'Settings plan');
  assert.equal(changed.permissionProfile, 'unrestricted');
  assert.ok(changed.capabilityEpoch > first.capabilityEpoch);
});
