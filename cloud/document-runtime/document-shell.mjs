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
