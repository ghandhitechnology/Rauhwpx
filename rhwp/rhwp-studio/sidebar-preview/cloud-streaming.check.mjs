import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';

export async function checkCloudStreaming(page, origin) {
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${origin}/?cloud=1&cloud-turn=1&cloud-phase=working&reset=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.dataset.auditReady === 'true');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.evaluate(() => {
    window.cloudStreamingAnimations = [];
    document.querySelector('.ag-messages').addEventListener('animationstart', (event) => {
      if (event.animationName === 'ag-message-arrive') window.cloudStreamingAnimations.push(event.target);
    });
    const cloud = window.sidebarPreview.cloud;
    cloud.emitAgentEvent({ type: 'turn-start', agent: 'codex' });
    cloud.emitAgentEvent({ type: 'text-delta', agent: 'codex', text: 'A stable streaming answer' });
  });
  await page.waitForFunction(() => document.querySelector('.ag-messages')?.textContent.includes('A stable streaming answer'));
  await page.waitForFunction(() => window.cloudStreamingAnimations.includes([...document.querySelectorAll('.ag-msg-assistant')].at(-1)));
  const result = await page.evaluate(async () => {
    const bubble = [...document.querySelectorAll('.ag-msg-assistant')].at(-1);
    window.sidebarPreview.cloud.refreshTimeline();
    await new Promise(requestAnimationFrame);
    return { connected: bubble.isConnected, text: document.querySelector('.ag-messages').textContent };
  });
  assert.equal(result.connected, true, 'Timeline refresh removed the live bubble (visible flicker)');
  assert.ok(result.text.includes('A stable streaming answer'), 'Timeline refresh erased streamed text');
  const stability = await page.evaluate(async () => {
    const bubble = [...document.querySelectorAll('.ag-msg-assistant')].at(-1);
    const paragraph = bubble.querySelector('p');
    const textNode = paragraph.firstChild;
    const user = document.querySelector('.ag-msg-user');
    let text = 'A stable streaming answer';
    for (const chunk of [' with', ' several', ' small', ' chunks.']) {
      text += chunk;
      window.sidebarPreview.cloud.emitAgentEvent({ type: 'text-delta', agent: 'codex', text: chunk });
      window.sidebarPreview.cloud.refreshTimeline();
      await new Promise(requestAnimationFrame);
    }
    const stableDuringStream = bubble.isConnected && paragraph.isConnected && textNode.isConnected;
    window.sidebarPreview.cloud.finishReply(text, true);
    window.sidebarPreview.cloud.refreshTimeline();
    await new Promise(requestAnimationFrame);
    return {
      stableDuringStream,
      stableAfterCompletion: bubble.isConnected && user.isConnected,
      text: [...document.querySelectorAll('.ag-msg-assistant')].at(-1)?.textContent,
      expected: text,
      count: [...document.querySelectorAll('.ag-msg-assistant')]
        .filter((node) => node.textContent?.includes('A stable streaming answer')).length,
      animations: window.cloudStreamingAnimations.filter((node) => node === bubble).length,
    };
  });
  assert.equal(stability.stableDuringStream, true, 'Streaming replaced the Markdown paragraph or text node');
  assert.equal(stability.stableAfterCompletion, true, 'Completion snapshot rebuilt the transcript');
  assert.equal(stability.text, stability.expected);
  assert.equal(stability.count, 1);
  assert.equal(stability.animations, 1, 'Snapshot refresh restarted the arrival animation');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  console.log('PASS Cloud refresh, text chunks, and completion preserve streaming DOM and text');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await createServer({
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  try {
    await checkCloudStreaming(await browser.newPage(), `http://127.0.0.1:${server.httpServer.address().port}`);
  } finally {
    await browser.close();
    await server.close();
  }
}
