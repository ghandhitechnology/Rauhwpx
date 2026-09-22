// Keep the shared editor's initialization nodes, but give the worker its own
// presentation before the first paint. Built engine/font assets remain untouched.
export function documentShell(html) {
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<meta name="google" content="notranslate">`)
    .replace(/<\/head>/i, `<style id="cloud-document-shell">
html, body { width: 100%; height: 100%; margin: 0 !important; overflow: hidden !important; }
body > :not(#studio-root):not(script):not(style):not([aria-label="문서 편집 입력"]),
#studio-root > :not(#editor-area):not(#workspace-stack),
#workspace-stack > :not(#editor-area),
#editor-area > :not(#scroll-container):not([aria-label="문서 편집 입력"]),
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
    // The editor's invisible keyboard/IME input lives beside the scroll area.
    // display:none leaves the page looking correct while clicks cannot focus it.
    const input = document.querySelector('textarea[aria-label="문서 편집 입력"], [contenteditable="true"][aria-label="문서 편집 입력"]');
    const previousFocus = document.activeElement;
    input?.focus({ preventScroll: true });
    const inputReady = Boolean(input && document.activeElement === input);
    if (previousFocus instanceof HTMLElement && previousFocus !== input) previousFocus.focus({ preventScroll: true });
    if (inputReady && document.activeElement === input && previousFocus !== input) input.blur();
    const scroll = document.querySelector('#scroll-container');
    const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      installed: Boolean(document.querySelector('#cloud-document-shell')),
      fillsWindow: Boolean(viewport && viewport.x === 0 && viewport.y === 0
        && viewport.width === innerWidth && viewport.height === innerHeight),
      inputReady,
      receivesPointer: Boolean(hit && scroll?.contains(hit)),
      chrome: [...document.querySelectorAll(
        '#studio-header, #status-bar, #h-ruler, #v-ruler, #ruler-corner, .ag-root, #document-empty-state',
      )].filter(visible).map((element) => element.id || element.className),
    };
  });
  if (!layout.installed || !layout.fillsWindow || !layout.inputReady || !layout.receivesPointer || layout.chrome.length > 0) {
    throw Object.assign(new Error(`Cloud document-only layout is missing or obscured: ${JSON.stringify(layout)}`), {
      code: 'STUDIO_DOCUMENT_LAYOUT_INVALID',
    });
  }
  return layout;
}
