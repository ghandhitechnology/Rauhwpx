import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { processTreeSpawnOptions } from './process-tree.mjs';

export const COPY_LAYOUT_RUN_TIMEOUT_MS = 120_000;
export const COPY_LAYOUT_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
export const COPY_LAYOUT_MAX_STDERR_BYTES = 64 * 1024;
export const COPY_LAYOUT_MAX_PLAN_BYTES = 1024 * 1024;
export const COPY_LAYOUT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const COPY_LAYOUT_MAX_PRIVATE_TEMP_ENTRIES = 4_096;
export const COPY_LAYOUT_MAX_PRIVATE_TEMP_BYTES = 512 * 1024 * 1024;
export const COPY_LAYOUT_RESULT_FRAME = 'RHWP_COPY_LAYOUT_RESULT ';

function runnerError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function boundedAppend(current, chunk, maximum, label) {
  const incoming = Buffer.from(chunk);
  if (current.length + incoming.length > maximum) {
    throw runnerError('COPY_LAYOUT_OUTPUT_LIMIT', `${label} exceeded its ${maximum}-byte limit`);
  }
  return Buffer.concat([current, incoming], current.length + incoming.length);
}

function framedResult(stdout, maximum) {
  const newline = stdout.indexOf(0x0a);
  if (newline < 0) {
    if (stdout.length > COPY_LAYOUT_RESULT_FRAME.length + 16) {
      throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper returned an invalid result frame');
    }
    return null;
  }
  const header = stdout.subarray(0, newline).toString('ascii');
  if (!header.startsWith(COPY_LAYOUT_RESULT_FRAME)) {
    throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper returned an invalid result frame');
  }
  const rawLength = header.slice(COPY_LAYOUT_RESULT_FRAME.length);
  if (!/^(?:0|[1-9]\d*)$/.test(rawLength)) {
    throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper returned an invalid result length');
  }
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 2 || length > maximum) {
    throw runnerError('COPY_LAYOUT_OUTPUT_LIMIT', 'Copy-layout helper result frame exceeded its limit');
  }
  const frameEnd = newline + 1 + length;
  if (stdout.length < frameEnd) return null;
  if (stdout.length !== frameEnd) {
    throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper wrote data outside its result frame');
  }
  let payload;
  try {
    payload = JSON.parse(stdout.subarray(newline + 1, frameEnd).toString('utf8'));
  } catch {
    throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper result frame was not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper result frame was not an object');
  }
  if (payload.ok !== true) {
    const diagnostic = typeof payload.error === 'string'
      ? payload.error.trim().slice(0, 2_000)
      : 'no diagnostic';
    throw runnerError('COPY_LAYOUT_HELPER_FAILED', `Copy-layout helper failed: ${diagnostic}`);
  }
  if (!payload.report || typeof payload.report !== 'object' || Array.isArray(payload.report)) {
    throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper result frame omitted its report');
  }
  return Buffer.from(JSON.stringify(payload.report), 'utf8');
}

function childEnvironment(source = process.env, privateTempRoot = null) {
  const env = {};
  for (const name of [
    'PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL',
  ]) {
    if (typeof source[name] === 'string') env[name] = source[name];
  }
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  if (privateTempRoot) {
    env.TEMP = privateTempRoot;
    env.TMP = privateTempRoot;
    env.TMPDIR = privateTempRoot;
  }
  return env;
}

function environmentValue(source, name) {
  const match = Object.keys(source ?? {}).find((key) => key.toUpperCase() === name);
  return match ? source[match] : undefined;
}

async function plainFile(candidate) {
  try {
    const stat = await fs.lstat(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Discover an interpreter without launching short-lived probe processes. */
export async function resolvePythonInvocation({
  pythonCommand = null,
  platform = process.platform,
  sourceEnv = process.env,
  executablePath = process.execPath,
  isPlainFile = plainFile,
} = {}) {
  if (typeof pythonCommand === 'string' && pythonCommand.trim()) {
    return { command: pythonCommand, argvPrefix: [] };
  }
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const candidates = [];
  const configured = environmentValue(sourceEnv, 'RHWP_BUNDLED_PYTHON');
  if (typeof configured === 'string' && platformPath.isAbsolute(configured)) {
    candidates.push({ command: platformPath.normalize(configured), argvPrefix: [] });
  }
  if (platform === 'win32' && typeof executablePath === 'string' && executablePath) {
    const executableDir = platformPath.dirname(executablePath);
    candidates.push(
      {
        command: platformPath.join(executableDir, 'resources', 'python', 'python.exe'),
        argvPrefix: [],
      },
      {
        command: platformPath.join(executableDir, 'python', 'python.exe'),
        argvPrefix: [],
      },
    );
  }
  const rawPath = environmentValue(sourceEnv, 'PATH');
  const pathEntries = String(rawPath ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const names = platform === 'win32'
    ? [
      { name: 'py.exe', argvPrefix: ['-3'] },
      { name: 'python3.exe', argvPrefix: [] },
      { name: 'python.exe', argvPrefix: [] },
    ]
    : [
      { name: 'python3', argvPrefix: [] },
      { name: 'python', argvPrefix: [] },
    ];
  for (const { name, argvPrefix } of names) {
    for (const directory of pathEntries) {
      const command = platformPath.join(directory, name);
      // Windows Store app-execution aliases can open an installer instead of
      // Python. They are not a usable interpreter proof for a background job.
      if (platform === 'win32'
        && /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(command)) continue;
      candidates.push({ command, argvPrefix });
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const identity = platform === 'win32'
      ? candidate.command.toLowerCase()
      : candidate.command;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (await isPlainFile(candidate.command)) return candidate;
  }
  throw runnerError(
    'COPY_LAYOUT_PYTHON_UNAVAILABLE',
    platform === 'win32'
      ? 'Copy layout requires bundled Python 3, py.exe -3, or python.exe on PATH'
      : 'Copy layout requires python3 or python on PATH',
  );
}

async function ensurePlainPrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw runnerError('COPY_LAYOUT_PATH_UNSAFE', 'Copy-layout private output root is not a plain directory');
  }
}

async function fileSha256(file) {
  const handle = await fs.open(file, 'r');
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export async function inspectPrivateTree(root, {
  maxEntries = COPY_LAYOUT_MAX_PRIVATE_TEMP_ENTRIES,
  maxBytes = COPY_LAYOUT_MAX_PRIVATE_TEMP_BYTES,
} = {}) {
  const pending = [path.resolve(root)];
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    let handle;
    try {
      handle = await fs.opendir(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    try {
      for await (const item of handle) {
        const candidate = path.join(directory, item.name);
        let stat;
        try {
          stat = await fs.lstat(candidate);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        entries += 1;
        if (entries > maxEntries) {
          throw runnerError(
            'COPY_LAYOUT_TEMP_LIMIT',
            `Copy-layout private temporary storage exceeds ${maxEntries} entries`,
          );
        }
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          throw runnerError(
            'COPY_LAYOUT_TEMP_UNSAFE',
            'Copy-layout private temporary storage contains a link or special file',
          );
        }
        if (stat.isDirectory()) {
          pending.push(candidate);
          continue;
        }
        if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
          throw runnerError('COPY_LAYOUT_TEMP_LIMIT', 'Copy-layout temporary file size is invalid');
        }
        bytes += stat.size;
        if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
          throw runnerError(
            'COPY_LAYOUT_TEMP_LIMIT',
            `Copy-layout private temporary storage exceeds ${maxBytes} bytes`,
          );
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return { entries, bytes };
}

async function runChild(command, argv, {
  cwd,
  env,
  spawnProcess,
  cleanupProcess,
  timeoutMs,
  maxStdoutBytes,
  maxStderrBytes,
  platform = process.platform,
  framed = false,
  watchedFiles = [],
  maxFileBytes = COPY_LAYOUT_MAX_OUTPUT_BYTES,
  watchedTrees = [],
  maxPrivateTempEntries = COPY_LAYOUT_MAX_PRIVATE_TEMP_ENTRIES,
  maxPrivateTempBytes = COPY_LAYOUT_MAX_PRIVATE_TEMP_BYTES,
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, argv, {
        ...processTreeSpawnOptions(platform),
        cwd,
        env,
        shell: false,
        // A framed Windows helper waits on stdin after reporting success. The
        // hub starts tree cleanup while that leader and its numeric pid still
        // belong to us; taskkill can then prove /T completion without a PID
        // reuse race. We never acknowledge the pipe because termination is
        // the release signal.
        stdio: [framed ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let forcedError = null;
    let settled = false;
    let finalizing = false;
    let cleanupPromise = null;
    const cleanup = () => {
      if (!cleanupPromise) cleanupPromise = Promise.resolve(cleanupProcess(child)).catch(() => false);
      return cleanupPromise;
    };
    const finalize = (error, value = null) => {
      if (finalizing || settled) return;
      finalizing = true;
      clearTimeout(timer);
      if (fileMonitor) clearInterval(fileMonitor);
      void cleanup().then((cleaned) => {
        settled = true;
        if (!cleaned) {
          const uncertain = error ?? runnerError(
            'COPY_LAYOUT_PROCESS_CLEANUP_UNCERTAIN',
            'Copy-layout helper process-tree cleanup could not be proven',
          );
          uncertain.processCleanupUncertain = true;
          reject(uncertain);
        } else if (error) reject(error);
        else resolve(value);
      });
    };
    const stop = (error) => {
      if (forcedError || settled || finalizing) return;
      forcedError = error;
      finalize(error);
    };
    const timer = setTimeout(() => stop(runnerError(
      'COPY_LAYOUT_TIMEOUT',
      `Copy-layout helper exceeded its ${timeoutMs / 1000}-second timeout`,
    )), timeoutMs);
    let fileMonitorBusy = false;
    const fileMonitor = watchedFiles.length > 0 || watchedTrees.length > 0 ? setInterval(() => {
      if (fileMonitorBusy || forcedError || settled || finalizing) return;
      fileMonitorBusy = true;
      void Promise.all([
        Promise.all(watchedFiles.map((file) => fs.lstat(file).catch((error) => (
          error?.code === 'ENOENT' ? null : Promise.reject(error)
        )))),
        Promise.all(watchedTrees.map((tree) => inspectPrivateTree(tree, {
          maxEntries: maxPrivateTempEntries,
          maxBytes: maxPrivateTempBytes,
        }))),
      ]).then(([stats]) => {
        if (stats.some((stat) => stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFileBytes))) {
          stop(runnerError('COPY_LAYOUT_OUTPUT_LIMIT', `Copy-layout output exceeds ${maxFileBytes} bytes`));
        }
      }).catch((error) => stop(error)).finally(() => { fileMonitorBusy = false; });
    }, 25) : null;
    fileMonitor?.unref?.();
    child.stdout?.on('data', (chunk) => {
      if (forcedError) return;
      try {
        stdout = boundedAppend(stdout, chunk, maxStdoutBytes, 'Copy-layout helper stdout');
        if (framed) {
          const result = framedResult(stdout, maxStdoutBytes);
          if (result) finalize(null, result);
        }
      } catch (error) {
        stop(error);
      }
    });
    child.stderr?.on('data', (chunk) => {
      if (forcedError) return;
      try {
        stderr = boundedAppend(stderr, chunk, maxStderrBytes, 'Copy-layout helper stderr');
      } catch (error) {
        stop(error);
      }
    });
    child.once('error', (error) => {
      finalize(error);
    });
    child.once('close', (code, signal) => {
      if (settled || finalizing) return;
      if (forcedError) {
        finalize(forcedError);
        return;
      }
      if (framed) {
        finalize(runnerError(
          'COPY_LAYOUT_PROCESS_CLEANUP_UNCERTAIN',
          'Copy-layout helper exited before its retained result handoff completed',
        ));
        return;
      }
      if (code !== 0) {
        finalize(runnerError(
          'COPY_LAYOUT_HELPER_FAILED',
          `Copy-layout helper exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}: ${stderr.toString('utf8').trim().slice(-2_000) || 'no diagnostic'}`,
        ));
        return;
      }
      finalize(null, stdout);
    });
  });
}

function parseReport(stdout) {
  try {
    const report = JSON.parse(stdout.toString('utf8'));
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('not an object');
    return report;
  } catch {
    throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper returned invalid JSON');
  }
}

/**
 * Run the bundled helper without exposing a command, script, source, or output
 * path to the provider. All provider data is passed as ordinary argv values to
 * a shell:false child; generated bytes stay in the hub-private tree.
 */
export async function runCopyLayoutHelper({
  action,
  iteration,
  textPlan,
  keepMedia = [],
}, {
  sourcePath,
  sourceFormat,
  helperPath,
  privateRoot,
  hwpBinary = null,
  pythonCommand = null,
  spawnProcess,
  cleanupProcess,
  sourceEnv = process.env,
  platform = process.platform,
  timeoutMs = COPY_LAYOUT_RUN_TIMEOUT_MS,
  maxStdoutBytes = COPY_LAYOUT_MAX_STDOUT_BYTES,
  maxStderrBytes = COPY_LAYOUT_MAX_STDERR_BYTES,
  maxPrivateTempEntries = COPY_LAYOUT_MAX_PRIVATE_TEMP_ENTRIES,
  maxPrivateTempBytes = COPY_LAYOUT_MAX_PRIVATE_TEMP_BYTES,
} = {}) {
  if (typeof spawnProcess !== 'function' || typeof cleanupProcess !== 'function') {
    throw new Error('runCopyLayoutHelper requires process lifecycle dependencies');
  }
  if (!sourcePath || !helperPath || !privateRoot) {
    throw runnerError('COPY_LAYOUT_NOT_READY', 'Copy-layout source and private runner roots must be bound first');
  }
  const format = String(sourceFormat ?? '').toLowerCase();
  if (format !== 'hwp' && format !== 'hwpx') {
    throw runnerError('COPY_LAYOUT_FORMAT_UNSUPPORTED', `Unsupported copy-layout source format: ${format || 'unknown'}`);
  }
  const sourceStat = await fs.lstat(sourcePath).catch(() => null);
  if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
    throw runnerError('COPY_LAYOUT_SOURCE_UNAVAILABLE', 'The bound immutable document snapshot is unavailable');
  }
  const canonicalHelper = await fs.realpath(helperPath);
  const helperStat = await fs.lstat(canonicalHelper);
  if (!helperStat.isFile() || helperStat.isSymbolicLink()) {
    throw runnerError('COPY_LAYOUT_PATH_UNSAFE', 'The bundled copy-layout helper is not a plain file');
  }
  await ensurePlainPrivateDirectory(privateRoot);
  const python = await resolvePythonInvocation({
    pythonCommand,
    platform,
    sourceEnv,
  });
  const runRoot = path.resolve(privateRoot);
  let runTempRoot = null;
  let retainPrivateTemp = false;
  const sourceDigest = await fileSha256(sourcePath);
  const argv = [...python.argvPrefix, '-S', canonicalHelper, sourcePath];
  const framed = platform === 'win32';
  if (framed) argv.push('--runner-framed');
  let outputPath = null;
  let fallbackOutputPath = null;
  let planPath = null;
  if (action === 'inspect') {
    argv.push('--inspect-text');
  } else if (action === 'generate') {
    if (!Number.isSafeInteger(iteration) || iteration < 1 || iteration > 3) {
      throw runnerError('COPY_LAYOUT_ITERATION_INVALID', 'Copy-layout generation iteration must be 1-3');
    }
    if (!textPlan || typeof textPlan !== 'object' || Array.isArray(textPlan)) {
      throw runnerError('COPY_LAYOUT_PLAN_INVALID', 'Copy-layout generation requires a structured text plan object');
    }
    if (textPlan.source_sha256 !== sourceDigest) {
      throw runnerError('COPY_LAYOUT_SOURCE_MISMATCH', 'Copy-layout text plan does not match the bound snapshot checksum');
    }
    let planBytes;
    try {
      planBytes = Buffer.from(`${JSON.stringify(textPlan)}\n`, 'utf8');
    } catch {
      throw runnerError('COPY_LAYOUT_PLAN_INVALID', 'Copy-layout text plan is not serializable');
    }
    if (planBytes.length > COPY_LAYOUT_MAX_PLAN_BYTES) {
      throw runnerError('COPY_LAYOUT_PLAN_TOO_LARGE', `Copy-layout text plan exceeds ${COPY_LAYOUT_MAX_PLAN_BYTES} bytes`);
    }
    planPath = path.join(runRoot, `.plan-${iteration}-${crypto.randomUUID()}.json`);
    outputPath = path.join(runRoot, `candidate-${iteration}.${format}`);
    fallbackOutputPath = format === 'hwp'
      ? path.join(runRoot, `candidate-${iteration}.hwpx`)
      : null;
    if (!isInside(runRoot, planPath) || !isInside(runRoot, outputPath)
      || (fallbackOutputPath && !isInside(runRoot, fallbackOutputPath))) {
      throw runnerError('COPY_LAYOUT_PATH_UNSAFE', 'Copy-layout private path escaped its bound root');
    }
    for (const candidate of [outputPath, fallbackOutputPath].filter(Boolean)) {
      try {
        await fs.lstat(candidate);
        throw runnerError('COPY_LAYOUT_OUTPUT_EXISTS', `Copy-layout candidate ${iteration} already exists`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await fs.writeFile(planPath, planBytes, { flag: 'wx', mode: 0o600 });
    argv.push('--text-plan', planPath, '--output', outputPath);
    for (const mediaId of keepMedia) argv.push('--keep-media', String(mediaId));
  } else {
    throw runnerError('COPY_LAYOUT_ACTION_INVALID', `Unknown copy-layout helper action: ${String(action)}`);
  }
  if (hwpBinary) argv.push('--rhwp-bin', hwpBinary);
  try {
    runTempRoot = await fs.mkdtemp(path.join(runRoot, '.tmp-'));
  } catch (error) {
    if (planPath) await fs.unlink(planPath).catch(() => {});
    throw error;
  }

  try {
    const stdout = await runChild(python.command, argv, {
      cwd: runRoot,
      env: childEnvironment(sourceEnv, runTempRoot),
      spawnProcess,
      cleanupProcess,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      platform,
      framed,
      watchedFiles: [outputPath, fallbackOutputPath].filter(Boolean),
      watchedTrees: [runTempRoot],
      maxPrivateTempEntries,
      maxPrivateTempBytes,
    });
    const report = parseReport(stdout);
    if (path.resolve(String(report.source ?? '')) !== path.resolve(sourcePath)) {
      throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper report does not match the bound source path');
    }
    if (action === 'inspect' && report.source_sha256 !== sourceDigest) {
      throw runnerError('COPY_LAYOUT_SOURCE_MISMATCH', 'Copy-layout inspection does not match the bound snapshot checksum');
    }
    if (outputPath) {
      const reportedOutput = path.resolve(String(report.output ?? ''));
      const allowedOutputs = [outputPath, fallbackOutputPath].filter(Boolean).map((item) => path.resolve(item));
      if (!allowedOutputs.includes(reportedOutput)) {
        throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper reported an output outside its fixed candidate paths');
      }
      outputPath = reportedOutput;
      if (report.delivery?.ready !== true
        || !['verified', 'best_effort'].includes(report.delivery?.quality)
        || !Array.isArray(report.delivery?.warnings)) {
        throw runnerError('COPY_LAYOUT_REPORT_INVALID', 'Copy-layout helper did not return a deliverable verification report');
      }
      const outputStat = await fs.lstat(outputPath).catch(() => null);
      if (!outputStat?.isFile() || outputStat.isSymbolicLink()) {
        throw runnerError('COPY_LAYOUT_OUTPUT_INVALID', 'Copy-layout helper did not create a plain output file');
      }
      if (outputStat.size < 1 || outputStat.size > COPY_LAYOUT_MAX_OUTPUT_BYTES) {
        throw runnerError('COPY_LAYOUT_OUTPUT_LIMIT', `Copy-layout output exceeds ${COPY_LAYOUT_MAX_OUTPUT_BYTES} bytes`);
      }
    }
    return {
      action,
      report,
      sourceSha256: sourceDigest,
      ...(outputPath ? {
        outputPath,
        iteration,
        sourceFormat: format,
        outputFormat: path.extname(outputPath).slice(1).toLowerCase(),
        size: (await fs.stat(outputPath)).size,
        checksum: `sha256:${await fileSha256(outputPath)}`,
      } : {}),
    };
  } catch (error) {
    retainPrivateTemp = error?.processCleanupUncertain === true;
    if (outputPath) await fs.unlink(outputPath).catch(() => {});
    if (fallbackOutputPath) await fs.unlink(fallbackOutputPath).catch(() => {});
    throw error;
  } finally {
    if (planPath) await fs.unlink(planPath).catch(() => {});
    if (!retainPrivateTemp && runTempRoot) {
      await fs.rm(runTempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}
