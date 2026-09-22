import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

export const DEFAULT_SCREEN_WIDTH = 1280;
export const DEFAULT_SCREEN_HEIGHT = 800;
export const SCREENSHOT_MAX_FILES = 20;
export const SCREENSHOT_MAX_BYTES = 32 * 1024 * 1024;

function screenshotError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function runCommand(command, args, { env = process.env, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(screenshotError('COMMAND_TIMEOUT', `${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(screenshotError('COMMAND_SPAWN_FAILED', `${command} failed to start`, error));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(screenshotError(
          'COMMAND_FAILED',
          `${command} exited ${signal ? `from ${signal}` : `with ${code}`}: ${stderr.trim() || stdout.trim() || '(no output)'}`,
        ));
      }
    });
  });
}

/**
 * Capture $DISPLAY into a PNG. Prefer xwd (shipped in the sandbox image);
 * fall back to ffmpeg x11grab when xwd is missing on a developer host.
 */
export async function captureDisplayPng({
  display = process.env.DISPLAY,
  authFile = process.env.XAUTHORITY,
  outputPath,
  width = Number(process.env.RAUHWpx_DISPLAY_WIDTH) || DEFAULT_SCREEN_WIDTH,
  height = Number(process.env.RAUHWpx_DISPLAY_HEIGHT) || DEFAULT_SCREEN_HEIGHT,
} = {}) {
  if (!display) {
    throw screenshotError('ENVIRONMENT_DISPLAY_UNAVAILABLE', 'No session DISPLAY is available for environment_screenshot');
  }
  if (!outputPath) throw screenshotError('SCREENSHOT_ARGS', 'outputPath is required');
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    DISPLAY: display,
    ...(authFile ? { XAUTHORITY: authFile } : {}),
  };
  const xwdPath = `${outputPath}.xwd`;
  try {
    await runCommand('xwd', ['-root', '-silent', '-display', display, '-out', xwdPath], {
      env,
      timeoutMs: 5_000,
    });
    await convertXwdToPng(xwdPath, outputPath);
    await fs.rm(xwdPath, { force: true }).catch(() => {});
    return outputPath;
  } catch (xwdError) {
    await fs.rm(xwdPath, { force: true }).catch(() => {});
    try {
      await runCommand('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'x11grab',
        '-video_size', `${width}x${height}`,
        '-i', display,
        '-frames:v', '1',
        '-update', '1',
        '-y', outputPath,
      ], { env, timeoutMs: 5_000 });
      return outputPath;
    } catch (ffmpegError) {
      throw screenshotError(
        'SCREENSHOT_FAILED',
        `Screen capture failed (xwd: ${xwdError.message}; ffmpeg: ${ffmpegError.message})`,
        ffmpegError,
      );
    }
  }
}

/** Minimal XWD ZPixmap TrueColor → PNG for Xvfb dumps (24/32 bpp). */
export async function convertXwdToPng(xwdPath, pngPath) {
  const buffer = await fs.readFile(xwdPath);
  if (buffer.length < 100) throw screenshotError('XWD_INVALID', 'XWD dump is too small');
  const headerSize = buffer.readUInt32BE(0);
  const pixmapDepth = buffer.readUInt32BE(12);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const byteOrder = buffer.readUInt32BE(28);
  const bitsPerPixel = buffer.readUInt32BE(44);
  const bytesPerLine = buffer.readUInt32BE(48);
  if (!width || !height || width > 8_192 || height > 8_192) {
    throw screenshotError('XWD_INVALID', `XWD geometry out of range: ${width}x${height}`);
  }
  if (![24, 32].includes(pixmapDepth) || ![24, 32].includes(bitsPerPixel)) {
    throw screenshotError('XWD_UNSUPPORTED', `Unsupported XWD depth/bpp ${pixmapDepth}/${bitsPerPixel}`);
  }
  const pixels = buffer.subarray(headerSize);
  const rowStride = bytesPerLine || Math.ceil((width * bitsPerPixel) / 32) * 4;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    const row = pixels.subarray(y * rowStride, y * rowStride + rowStride);
    for (let x = 0; x < width; x += 1) {
      const px = x * (bitsPerPixel / 8);
      let r;
      let g;
      let b;
      if (byteOrder === 0) {
        b = row[px];
        g = row[px + 1];
        r = row[px + 2];
      } else {
        r = row[px + (bitsPerPixel === 32 ? 1 : 0)];
        g = row[px + (bitsPerPixel === 32 ? 2 : 1)];
        b = row[px + (bitsPerPixel === 32 ? 3 : 2)];
      }
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }
  const compressed = deflateSync(raw);
  const png = Buffer.alloc(8 + 25 + 12 + compressed.length + 12);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  let cursor = 8;
  cursor = writePngChunk(png, cursor, 'IHDR', (() => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return ihdr;
  })());
  cursor = writePngChunk(png, cursor, 'IDAT', compressed);
  cursor = writePngChunk(png, cursor, 'IEND', Buffer.alloc(0));
  await fs.writeFile(pngPath, png.subarray(0, cursor), { mode: 0o600 });
}

function writePngChunk(target, offset, type, data) {
  target.writeUInt32BE(data.length, offset);
  target.write(type, offset + 4, 4, 'ascii');
  data.copy(target, offset + 8);
  const crcInput = Buffer.alloc(4 + data.length);
  crcInput.write(type, 0, 4, 'ascii');
  data.copy(crcInput, 4);
  target.writeUInt32BE(crc32(crcInput) >>> 0, offset + 8 + data.length);
  return offset + 12 + data.length;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Delete oldest PNGs when the screenshot dir exceeds file or byte caps. */
export async function capScreenshotDir(directory, {
  maxFiles = SCREENSHOT_MAX_FILES,
  maxBytes = SCREENSHOT_MAX_BYTES,
} = {}) {
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { deleted: [], kept: 0, bytes: 0 };
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!/\.png$/i.test(entry.name)) continue;
    const full = path.join(directory, entry.name);
    const stat = await fs.lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    files.push({ name: entry.name, full, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  const deleted = [];
  while (files.length && (files.length > maxFiles || bytes > maxBytes)) {
    const victim = files.shift();
    await fs.rm(victim.full, { force: true });
    deleted.push(victim.name);
    bytes -= victim.size;
  }
  return { deleted, kept: files.length, bytes };
}

/**
 * Write a timestamped screenshot under the session work dir and return paths
 * that stay inside RHWP_IMAGE_ROOTS for insert_image.
 */
export async function takeEnvironmentScreenshot({
  workDir,
  display = process.env.DISPLAY,
  authFile = process.env.XAUTHORITY,
  now = Date.now,
  capture = captureDisplayPng,
} = {}) {
  if (!display || process.env.RAUHWpx_SESSION_DISPLAY === 'error') {
    throw screenshotError(
      'ENVIRONMENT_DISPLAY_UNAVAILABLE',
      'No session display is ready for environment_screenshot',
    );
  }
  if (typeof workDir !== 'string' || !workDir.trim()) {
    throw screenshotError('SCREENSHOT_ARGS', 'workDir is required');
  }
  const screensDir = path.join(workDir, '.rhwp-agent', 'screens');
  await fs.mkdir(screensDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const imagePath = path.join(screensDir, `${stamp}.png`);
  const started = Date.now();
  await capture({ display, authFile, outputPath: imagePath });
  const elapsedMs = Date.now() - started;
  const cap = await capScreenshotDir(screensDir);
  const bytes = (await fs.stat(imagePath)).size;
  const image = await fs.readFile(imagePath);
  return {
    imagePath,
    bytes,
    elapsedMs,
    display,
    cap,
    image: {
      data: image.toString('base64'),
      mimeType: 'image/png',
    },
  };
}
