import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const currentDir = import.meta.dirname;

// rhwp-studio를 Chrome 확장용으로 빌드
// 산출물: rhwp-chrome/dist/ → viewer.html + JS/CSS + WASM + 폰트

// Display the Rauhwpx product version; the extension manifest keeps its own package version.
const appPackage = JSON.parse(
  readFileSync(resolve(currentDir, '..', '..', 'package.json'), 'utf-8'),
);

export default defineConfig({
  root: resolve(currentDir, '..', 'rhwp-studio'),
  publicDir: false, // public/ 폴더 제외 (samples, images 등 불필요)
  define: {
    __APP_VERSION__: JSON.stringify(appPackage.version),
  },
  resolve: {
    alias: {
      '@': resolve(currentDir, '..', 'rhwp-studio', 'src'),
      '@wasm': resolve(currentDir, '..', 'pkg'),
      'virtual:pwa-register': resolve(currentDir, '..', 'rhwp-shared', 'pwa-register-stub.js'),
    },
  },
  build: {
    outDir: resolve(currentDir, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        viewer: resolve(currentDir, '..', 'rhwp-studio', 'index.html'),
      },
    },
    // WASM inline 방지 — 별도 파일로 유지
    assetsInlineLimit: 0,
  },
  // 개발 서버 (확장 디버깅용)
  server: {
    host: '0.0.0.0',
    port: 7701,
    fs: {
      allow: ['..'],
    },
  },
});
