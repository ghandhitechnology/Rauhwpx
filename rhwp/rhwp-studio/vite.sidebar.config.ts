import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Deliberately independent of vite.config.ts: no agent hub, WASM, or PWA plugin.
export default defineConfig({
  root: resolve(import.meta.dirname, 'sidebar-preview'),
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      '/src': resolve(import.meta.dirname, 'src'),
      'virtual:pwa-register': resolve(
        import.meta.dirname,
        'src/sidebar-preview/pwa-placeholder.ts',
      ),
    },
  },
  publicDir: resolve(import.meta.dirname, 'public'),
  define: {
    __APP_VERSION__: JSON.stringify(
      JSON.parse(
        readFileSync(
          resolve(import.meta.dirname, '../../package.json'),
          'utf8',
        ),
      ).version,
    ),
  },
  server: {
    host: '127.0.0.1',
    port: 7715,
    strictPort: true,
    fs: { allow: [import.meta.dirname] },
  },
  build: { outDir: '../dist-sidebar', emptyOutDir: true },
});
