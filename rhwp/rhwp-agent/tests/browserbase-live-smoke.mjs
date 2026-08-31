import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BrowserbaseSession } from '../browserbase-session.mjs';

/**
 * Cleanup must not replace a tool/navigation failure. Instead, keep that
 * primary error and mark it with the independent cleanup uncertainty.
 */
export async function cleanupBrowserbaseLiveCycle(
  browser,
  cycle,
  primaryError = null,
  report = (message) => process.stderr.write(message),
) {
  let cleanupError = null;
  try {
    const cleaned = await browser.cleanup('live smoke finished');
    if (cleaned === true) return true;
    cleanupError = new Error(`Browserbase cleanup was not confirmed in cycle ${cycle}`);
  } catch (error) {
    cleanupError = error instanceof Error
      ? error
      : new Error(`Browserbase cleanup failed in cycle ${cycle}: ${String(error)}`);
  }
  cleanupError.code ??= 'BROWSERBASE_CLEANUP_UNCERTAIN';
  cleanupError.processCleanupUncertain = true;

  if (primaryError !== null && primaryError !== undefined) {
    if ((typeof primaryError === 'object' && primaryError !== null) || typeof primaryError === 'function') {
      try {
        primaryError.cleanupError = cleanupError;
        primaryError.processCleanupUncertain = true;
      } catch {}
    }
    try {
      report(`[browserbase] ${cleanupError.message}; preserving the primary cycle error\n`);
    } catch {}
    return false;
  }
  throw cleanupError;
}

export async function runBrowserbaseLiveSmoke({
  env = process.env,
  createSession = () => new BrowserbaseSession(),
  write = (message) => process.stdout.write(message),
  report = (message) => process.stderr.write(message),
} = {}) {
  const required = ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'GEMINI_API_KEY'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Live Browserbase smoke test requires ${missing.join(', ')}`);
  }

  const target = new URL(env.BROWSERBASE_SMOKE_URL || 'https://example.com/');
  if (target.protocol !== 'https:') {
    throw new Error('BROWSERBASE_SMOKE_URL must use HTTPS');
  }

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const browser = createSession();
    const chatId = `browserbase-live-smoke-${cycle}`;
    let primaryError = null;
    try {
      await browser.call(chatId, 'start');
      await browser.call(chatId, 'navigate', { url: target.href });
      await browser.call(chatId, 'observe', { instruction: 'Find the main link on this page.' });
      await browser.call(chatId, 'act', { action: 'Hover over the main link without clicking it.' });
      await browser.call(chatId, 'extract', { instruction: 'Extract the page title.' });
      await browser.call(chatId, 'extract');
      await browser.call(chatId, 'end');
      write(`Browserbase live cycle ${cycle}/3 passed.\n`);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await cleanupBrowserbaseLiveCycle(browser, cycle, primaryError, report);
    }
  }
}

let isMain = false;
try {
  isMain = Boolean(process.argv[1])
    && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMain = false;
}
if (isMain) await runBrowserbaseLiveSmoke();
