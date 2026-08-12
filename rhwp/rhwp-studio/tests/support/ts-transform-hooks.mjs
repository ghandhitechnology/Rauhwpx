// TS 변환 로더 훅 — Node 26 에서 --experimental-transform-types 가 제거되어
// (기본 strip-only 는 cursor.ts:89 등의 parameter property 를 처리하지 못함),
// 자식 프로세스가 `--import <이 파일>` 로 등록하는 load 훅으로 대체한다.
// vite(rolldown) 이 내장한 oxc transformSync 로 단일 파일 변환만 수행해
// node_modules/.bin 실행 파일 없이 플랫폼 무관하게 동작한다.
// (devDependency typescript 는 7.x 네이티브 프리뷰라 JS transpile API 가 없다.)
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { transformSync } = createRequire(import.meta.url)('rolldown/experimental');

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !/\.ts$/.test(url)) return nextLoad(url, context);
    const fileName = fileURLToPath(url);
    const { code, errors } = transformSync(fileName, readFileSync(fileName, 'utf8'));
    if (errors.length > 0) {
      throw new Error(`TS 변환 실패 (${fileName}):\n${errors.map((e) => e.message ?? String(e)).join('\n')}`);
    }
    return { format: 'module', source: code, shortCircuit: true };
  },
});
