import path from 'node:path';
import { realpath } from 'node:fs/promises';

/**
 * insert_image imagePath 허용 범위 정책.
 *
 * RHWP_IMAGE_ROOTS(path.delimiter 구분)가 주어지면 그 실제 경로 하위만 읽을 수
 * 있다. 루트가 없으면(어댑터 미대응) 기존 동작을 유지한다 — 정책은 어댑터 env 가
 * 채워주는 구조다.
 */
export function imageRootsFromEnv(env = process.env) {
  return String(env.RHWP_IMAGE_ROOTS ?? '')
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
}

/**
 * @param {string} imagePath 검사 대상 경로
 * @param {string[]} allowedRoots 허용 루트 목록
 * @param {{ realpath?: typeof realpath }} [deps]
 * @returns {Promise<void>} 허용되면 resolve, 아니면 code 가 붙은 Error 로 reject
 */
export async function assertImagePathInsideRoots(imagePath, allowedRoots, deps = {}) {
  const resolveReal = deps.realpath ?? realpath;
  if (!allowedRoots || allowedRoots.length === 0) return;
  if (typeof imagePath !== 'string' || imagePath.length === 0) {
    throw policyError('INVALID_ARGS', 'imagePath is required');
  }
  let real;
  try {
    real = await resolveReal(imagePath);
  } catch (e) {
    throw policyError(e?.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'INVALID_ARGS', `cannot read image file: ${e?.message ?? e}`);
  }
  const roots = await Promise.all(allowedRoots.map((root) => resolveReal(root).catch(() => null)));
  const inside = roots.some((root) => root && (real === root || real.startsWith(root + path.sep)));
  if (!inside) {
    throw policyError('INVALID_ARGS', 'imagePath must be inside the session workspace or its downloads directory');
  }
}

function policyError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
