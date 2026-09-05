// Keep the shared editor's initialization nodes, but give the worker its own
// presentation before the first paint. Built engine/font assets remain untouched.
export function documentShell(html) {
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<meta name="google" content="notranslate">`)
    .replace(/<\/head>/i, `<style id="cloud-document-shell">
html, body { width: 100%; height: 100%; margin: 0 !important; overflow: hidden !important; }
body > :not(#studio-root):not(script):not(style),
#studio-root > :not(#editor-area):not(#workspace-stack),
#workspace-stack > :not(#editor-area),
#editor-area > :not(#scroll-container),
#document-empty-state { display: none !important; }
#studio-root, #workspace-stack { width: 100% !important; height: 100% !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; }
#editor-area { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; margin: 0 !important; display: block !important; transition: none !important; }
#scroll-container { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; box-shadow: none !important; scrollbar-width: none; }
#scroll-container::-webkit-scrollbar { display: none; }
</style></head>`);
}

// Run in Chromium before the worker advertises its display as ready. A missing
// shell must fail startup instead of silently streaming the entire application.
export async function verifyDocumentShell(page) {
  const layout = await page.evaluate(() => {
    const visible = (element) => element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden';
    const viewport = document.querySelector('#scroll-container')?.getBoundingClientRect();
    return {
      installed: Boolean(document.querySelector('#cloud-document-shell')),
      fillsWindow: Boolean(viewport && viewport.x === 0 && viewport.y === 0
        && viewport.width === innerWidth && viewport.height === innerHeight),
      chrome: [...document.querySelectorAll(
        '#studio-header, #status-bar, #h-ruler, #v-ruler, #ruler-corner, .ag-root, #document-empty-state',
      )].filter(visible).map((element) => element.id || element.className),
    };
  });
  if (!layout.installed || !layout.fillsWindow || layout.chrome.length > 0) {
    throw Object.assign(new Error(`Cloud document-only layout is missing or obscured: ${JSON.stringify(layout)}`), {
      code: 'STUDIO_DOCUMENT_LAYOUT_INVALID',
    });
  }
  return layout;
}
