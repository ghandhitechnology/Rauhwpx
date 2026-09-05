import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('bridge matches rapid settings replies, reconnects, failures and queued follow-ups', { timeout: 30_000 }, async () => {
  const server = await createServer({
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, open: false }, logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const page = await browser.newPage();
    const address = server.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}`);
    const results = await page.evaluate(async () => {
      // Load the production bridge in a browser so its CSS/DOM imports are real.
      const { AgentBridgeImpl } = await import('/src/agent/bridge.ts');
      const bridge = Object.create(AgentBridgeImpl.prototype);
      const frames: any[] = [];
      const events: any[] = [];
      Object.assign(bridge, {
        state: 'connected', requestSeq: 0, pendingChatStart: null, chatStartSent: false,
        activeAgent: null, selectedAgent: 'codex', selectedModel: null, selectedEffort: null,
        permissionProfile: 'safe', serviceTier: 'standard', workflow: 'direct', phase: 'direct',
        threadId: 'test-thread', documentId: 'test-document', documentName: 'test.hwpx',
        chatHistory: [], queuedMessages: [], workflowSwitchPending: false,
        pendingUserQuestion: null, pendingTurnOpen: false,
        sendJson: (frame: any) => { frames.push(structuredClone(frame)); return true; },
        emit: (event: any) => events.push(event),
        // Document rendering and plan transitions are independent of settings delivery.
        finishWorkflowSwitch() {}, syncWorkflowState() {}, clearPendingQuestionCancellation() {},
        notifyPlanningDocumentSaved() {}, syncEditingLease() {}, abortActiveToolRequests() {},
        workflowState: () => ({ workflow: 'direct', phase: 'direct', capabilityEpoch: 1, latestPlan: null }),
      });
      const acknowledge = (frame: any, extra = {}) => bridge.handleMessage({
        ...frame, type: 'chat-started', sessionId: 'provider-session', ...extra,
      });
      bridge.startChat('codex', 'gpt-5.6-sol', 'medium');
      acknowledge(frames.at(-1));
      bridge.startChat('claude', 'sonnet', 'high');
      const old = frames.at(-1);
      bridge.startChat('codex', 'gpt-6-astra', 'max');
      const latest = frames.at(-1);
      const sentBefore = frames.length;
      let followupSettled = false;
      const followup = bridge.sendUserMessage('Use the latest settings').then(() => { followupSettled = true; });
      bridge.handleMessage({ type: 'chat-error', requestId: old.requestId, code: 'AGENT_SPAWN_FAILED', message: 'old failure' });
      acknowledge(old);
      bridge.handleMessage({ type: 'welcome', session: { ...old, status: 'idle' } });
      const beforeLatestAck = {
        model: bridge.selectedModel, effort: bridge.selectedEffort,
        pending: bridge.pendingChatStart.requestId, sent: frames.length - sentBefore, followupSettled,
      };
      acknowledge(latest);
      await followup;
      acknowledge(latest); // duplicate acknowledgement must not replay the message
      const messages = frames.filter((frame) => frame.type === 'chat-user-message');
      bridge.startChat('cursor', 'auto', '');
      const cursor = frames.at(-1);
      acknowledge(cursor, { effort: null });
      const clearedEffort = bridge.selectedEffort;
      bridge.startChat('claude', 'sonnet', 'high');
      const rejected = frames.at(-1);
      const failedFollowup = bridge.sendUserMessage('Must not run under the old provider');
      bridge.handleMessage({ type: 'chat-error', requestId: rejected.requestId, code: 'AUTH_REQUIRED', message: 'Connect Claude',
        session: { agent: 'cursor', model: 'auto', effort: null, threadId: 'test-thread', documentId: 'test-document' } });
      await failedFollowup;
      const rollback = { agent: bridge.activeAgent, effort: bridge.selectedEffort, pending: bridge.pendingChatStart };
      bridge.startChat('codex', 'gpt-5.6-luna', 'low');
      const failed = frames.at(-1);
      bridge.handleMessage({ type: 'chat-error', requestId: failed.requestId, session: null, code: 'AGENT_SPAWN_FAILED', message: 'Spawn failed' });
      const retryMessage = bridge.sendUserMessage('Retry once');
      const retry = frames.at(-1);
      acknowledge(retry);
      await retryMessage;
      return {
        beforeLatestAck, latestRequestId: latest.requestId, messages, clearedEffort, rollback,
        retryAgent: bridge.activeAgent, retryCount: frames.filter((frame) => frame.type === 'chat-user-message' && frame.text === 'Retry once').length,
        rejectedMessages: frames.filter((frame) => frame.type === 'chat-user-message' && frame.text.startsWith('Must not')).length,
        hubErrors: events.filter((event) => event.type === 'hub-error').map((event) => event.message),
      };
    });
    assert.deepEqual(results.beforeLatestAck, {
      model: 'gpt-6-astra', effort: 'max', pending: results.latestRequestId, sent: 0, followupSettled: false,
    });
    assert.equal(results.messages.length, 1);
    assert.equal(results.messages[0].text, 'Use the latest settings');
    assert.equal(results.clearedEffort, null);
    assert.deepEqual(results.rollback, { agent: 'cursor', effort: null, pending: null });
    assert.equal(results.retryAgent, 'codex');
    assert.equal(results.retryCount, 1);
    assert.equal(results.rejectedMessages, 0);
    assert.deepEqual(results.hubErrors, ['Connect Claude', 'Spawn failed']);
  } finally {
    await browser.close();
    await server.close();
  }
});
