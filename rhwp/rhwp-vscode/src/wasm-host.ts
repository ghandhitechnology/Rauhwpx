/**
 * Extension Host에서 WASM을 Node.js 환경으로 로드하는 헬퍼
 *
 * - Canvas API가 없는 Node.js 환경에서 measureTextWidth stub 등록
 * - WASM 파일은 dist/media/rhwp_bg.wasm 경로에서 읽음
 */
import * as fs from "fs";
import * as path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { initSync, HwpDocument } = require("@rhwp-wasm/rhwp.js");

export { HwpDocument };

let wasmInitialized = false;

/**
 * WASM을 extension host(Node.js)에서 초기화한다.
 * 중복 호출 안전 (1회만 실제 초기화).
 */
export function initWasmHost(extensionPath: string): void {
  if (wasmInitialized) return;

  // measureTextWidth stub — Node.js에는 Canvas API가 없으므로 근사값 반환
  if (!(globalThis as any).measureTextWidth) {
    (globalThis as any).measureTextWidth = (_font: string, text: string): number =>
      text.length * 8;
  }

  const wasmPath = path.join(extensionPath, "dist", "media", "rhwp_bg.wasm");
  const wasmBuf = fs.readFileSync(wasmPath);
  initSync({ module: wasmBuf });
  wasmInitialized = true;
}
