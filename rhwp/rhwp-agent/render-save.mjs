/**
 * render_page savePath — 스튜디오가 돌려준 PNG 를 세션 작업 폴더에 쓴다.
 *
 * environment_screenshot 처럼 세션 workDir 아래에 파일을 만들고 절대 경로를 돌려준다.
 * 에이전트는 그 경로를 Python 등으로 참고 이미지와 비교할 수 있다.
 * workDir 은 프로바이더가 바꿀 수 있으므로 부모 폴더의 실제 경로를 다시 확인하고
 * 마지막 경로 성분은 심볼릭 링크를 따라가지 않고 연다.
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

function saveError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isInside(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * savePath(상대 경로)를 workDir 안의 절대 .png 경로로 바꾼다. 확장자가 없으면 .png 를 붙인다.
 * @param {string} workDir
 * @param {unknown} savePath
 */
export function resolveRenderSavePath(workDir, savePath) {
  if (typeof workDir !== 'string' || !workDir) {
    throw saveError('RENDER_SAVE_UNAVAILABLE', 'This session has no work directory for savePath');
  }
  if (typeof savePath !== 'string' || !savePath.trim()) {
    throw saveError('INVALID_ARGS', 'savePath must be a non-empty relative file name');
  }
  if (path.isAbsolute(savePath) || /^[a-zA-Z]:/.test(savePath)) {
    throw saveError('INVALID_ARGS', 'savePath must be relative to the session workspace');
  }
  const ext = path.extname(savePath).toLowerCase();
  if (ext && ext !== '.png') {
    throw saveError('INVALID_ARGS', 'savePath must end in .png');
  }
  const root = path.resolve(workDir);
  const target = path.resolve(root, ext ? savePath : `${savePath}.png`);
  if (!isInside(root, target)) {
    throw saveError('INVALID_ARGS', 'savePath must stay inside the session workspace');
  }
  return target;
}

/**
 * base64 PNG 를 target 에 쓴다 (덮어쓰기 허용).
 * @param {{ workDir: string, target: string, data: string }} options
 * @returns {Promise<{ imagePath: string, bytes: number }>}
 */
export async function writeRenderPng({ workDir, target, data }) {
  if (typeof data !== 'string' || !data) {
    throw saveError('RENDER_SAVE_FAILED', 'Studio returned no PNG data to save');
  }
  const root = await fs.realpath(path.resolve(workDir));
  const parent = path.dirname(target);
  const assertInside = (real) => {
    if (real !== root && !isInside(root, real)) {
      throw saveError('INVALID_ARGS', 'savePath must stay inside the session workspace');
    }
  };
  // 폴더를 만들기 전에 이미 있는 가장 가까운 조상부터 확인한다 (링크 밖에 폴더를 만들지 않도록).
  for (let dir = parent; ; dir = path.dirname(dir)) {
    let real;
    try {
      real = await fs.realpath(dir);
    } catch (error) {
      if (error?.code === 'ENOENT' && dir !== path.dirname(dir)) continue;
      throw error;
    }
    assertInside(real);
    break;
  }
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const realParent = await fs.realpath(parent);
  assertInside(realParent);
  const bytes = Buffer.from(data, 'base64');
  const finalPath = path.join(realParent, path.basename(target));
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(finalPath, flags, 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return { imagePath: finalPath, bytes: bytes.length };
}
