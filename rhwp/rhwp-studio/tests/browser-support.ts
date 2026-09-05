import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function browserExecutable(): string {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = configured ? [configured] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']
      .flatMap((key) => process.env[key]
        ? [join(process.env[key]!, 'Google', 'Chrome', 'Application', 'chrome.exe')]
        : []),
  ];
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error('Browser tests require Chrome or Chromium. Set PUPPETEER_EXECUTABLE_PATH to its executable.');
  }
  return executable;
}

export function browserLaunchArgs(): string[] {
  return process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [];
}

export function requireWasmPackage(directory: string): void {
  if (!['rhwp.js', 'rhwp_bg.wasm'].every((name) => existsSync(join(directory, name)))) {
    throw new Error(`Browser merge tests require generated WASM in ${directory}. Run npm run build:wasm from the repository root first.`);
  }
}
