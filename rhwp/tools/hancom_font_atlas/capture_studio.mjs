#!/usr/bin/env node
/** Import local faces through Studio, then capture every page at the requested DPI. */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(here, '../../rhwp-studio');
const require = createRequire(path.join(studioRoot, 'package.json'));
const puppeteer = require('puppeteer-core');

function options(args) {
  const result = { docs: [], dpi: 200, url: 'http://127.0.0.1:5173/' };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--doc') {
      result.docs.push(args[++i]);
    } else if (['--docs-json', '--fonts-json', '--out-dir', '--url', '--chrome', '--dpi'].includes(key)) {
      result[key.slice(2).replaceAll('-', '')] = args[++i];
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (!result.docsjson || !result.fontsjson || !result.outdir) {
    throw new Error('Usage: capture_studio.mjs --docs-json FILE --fonts-json FILE --out-dir DIR [--url URL] [--dpi 200] [--doc ID]');
  }
  result.dpi = Number(result.dpi);
  if (!Number.isFinite(result.dpi) || result.dpi <= 0) throw new Error('DPI must be positive');
  return result;
}

const args = options(process.argv.slice(2));
const docs = JSON.parse(readFileSync(args.docsjson, 'utf8'));
const fonts = JSON.parse(readFileSync(args.fontsjson, 'utf8'));
const ids = args.docs.length ? args.docs : Object.keys(docs);
const chrome = args.chrome ?? process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
if (!chrome) throw new Error('Set --chrome or CHROME_PATH to a Chrome executable');

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const results = {};
try {
  for (const id of ids) {
    const doc = docs[id];
    const fontPaths = fonts[id]?.fonts ?? fonts[id];
    if (!doc?.source || !Array.isArray(fontPaths)) throw new Error(`Missing document or font manifest: ${id}`);
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    try {
      await page.goto(args.url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__wasm?.initialized && !!window.__eventBus);
      const imports = [];
      for (const fontPath of fontPaths) {
        const base64 = readFileSync(fontPath).toString('base64');
        const report = await page.evaluate(async ({ name, base64 }) => {
          const local = await import('/src/core/local-fonts.ts');
          const substitution = await import('/src/core/font-substitution.ts');
          const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
          const imported = await local.importLocalFontFiles([new File([bytes], name)]);
          return {
            imported: imported.imported.map(face => {
              const chain = substitution.fontFamilyChainForDisplay(face.family);
              const revision = globalThis.getImportedFontMetricsRevision?.();
              const bridgeHasFace = globalThis.hasImportedFontMetricsFace?.(face.family);
              if (!chain.includes(`"${face.runtimeFamily}"`)
                || revision !== local.getImportedFontGeneration()
                || bridgeHasFace !== true) {
                throw new Error(`Font module state diverged for ${face.family}; restart the Studio dev server`);
              }
              return { family: face.family, style: face.style, runtimeFamily: face.runtimeFamily };
            }),
            rejected: imported.rejected,
            generation: local.getImportedFontGeneration(),
          };
        }, { name: path.basename(fontPath), base64 });
        if (report.rejected.length || report.imported.length !== 1) {
          throw new Error(`Font import failed for ${fontPath}: ${JSON.stringify(report.rejected)}`);
        }
        imports.push({ path: fontPath, ...report });
      }
      const source = readFileSync(doc.source).toString('base64');
      const opened = await page.evaluate(async ({ id, source }) => {
        const requestId = `font-atlas-${id}`;
        const done = new Promise(resolve => {
          const off = window.__eventBus.on('open-document-bytes:done', event => {
            if (event.requestId === requestId) { off(); resolve(event); }
          });
        });
        const bytes = Uint8Array.from(atob(source), char => char.charCodeAt(0));
        window.__eventBus.emit('open-document-bytes', {
          bytes, fileName: `${id}.hwpx`, requestId, suppressDialogs: true, skipUnsavedGuard: true,
        });
        return await done;
      }, { id, source });
      if (!opened.ok) throw new Error(`${id}: ${opened.error}`);
      const pageCount = await page.evaluate(async () => {
        await document.fonts.ready;
        return window.__wasm.pageCount;
      });
      const output = path.join(args.outdir, id);
      mkdirSync(output, { recursive: true });
      const captures = [];
      for (let index = 0; index < pageCount; index += 1) {
        const shot = await page.evaluate(({ index, scale }) => {
          const canvas = document.createElement('canvas');
          window.__wasm.renderPageToCanvas(index, canvas, scale);
          return { width: canvas.width, height: canvas.height, png: canvas.toDataURL('image/png') };
        }, { index, scale: args.dpi / 96 });
        const file = path.join(output, `ours_${String(index + 1).padStart(3, '0')}.png`);
        writeFileSync(file, Buffer.from(shot.png.split(',')[1], 'base64'));
        captures.push({ file, width: shot.width, height: shot.height });
      }
      results[id] = { source: doc.source, imports, pageCount, captures };
      console.log(`${id}: ${pageCount} pages, ${imports.flatMap(item => item.imported).length}/${fontPaths.length} faces imported`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
mkdirSync(args.outdir, { recursive: true });
writeFileSync(path.join(args.outdir, 'capture-results.json'), JSON.stringify(results, null, 2));
