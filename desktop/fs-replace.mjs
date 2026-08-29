import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

async function retryWindows(operation, platform) {
  const delays = [50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (platform !== 'win32' || !LOCK_CODES.has(error?.code) || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/**
 * Windows에서는 대상 파일이 바이러스 검사·색인 등에 잠깐 열려 있으면 rename 교체가
 * EPERM으로 실패한다. 대상을 백업 이름으로 치환한 뒤 교체하고, 실패하면 되돌린다.
 */
export async function replaceFile(tempPath, targetPath, platform = process.platform) {
  if (platform !== 'win32') return fs.rename(tempPath, targetPath);
  const previous = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.previous-write-${randomUUID()}`);
  let moved = false;
  try {
    await retryWindows(() => fs.rename(targetPath, previous), platform);
    moved = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await retryWindows(() => fs.rename(tempPath, targetPath), platform);
  } catch (error) {
    if (moved) await retryWindows(() => fs.rename(previous, targetPath), platform).catch(() => {});
    throw error;
  }
  if (moved) await retryWindows(() => fs.rm(previous, { force: true }), platform);
}
