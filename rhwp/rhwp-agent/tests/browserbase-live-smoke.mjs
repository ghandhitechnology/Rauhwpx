import { BrowserbaseSession } from '../browserbase-session.mjs';

const required = ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'GEMINI_API_KEY'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Live Browserbase smoke test requires ${missing.join(', ')}`);
}

const target = new URL(process.env.BROWSERBASE_SMOKE_URL || 'https://example.com/');
if (target.protocol !== 'https:') {
  throw new Error('BROWSERBASE_SMOKE_URL must use HTTPS');
}

for (let cycle = 1; cycle <= 3; cycle += 1) {
  const browser = new BrowserbaseSession();
  const chatId = `browserbase-live-smoke-${cycle}`;
  try {
    await browser.call(chatId, 'start');
    await browser.call(chatId, 'navigate', { url: target.href });
    await browser.call(chatId, 'observe', { instruction: 'Find the main link on this page.' });
    await browser.call(chatId, 'act', { action: 'Hover over the main link without clicking it.' });
    await browser.call(chatId, 'extract', { instruction: 'Extract the page title.' });
    await browser.call(chatId, 'extract');
    await browser.call(chatId, 'end');
    process.stdout.write(`Browserbase live cycle ${cycle}/3 passed.\n`);
  } finally {
    await browser.cleanup('live smoke finished');
  }
}
