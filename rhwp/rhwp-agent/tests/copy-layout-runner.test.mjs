import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COPY_LAYOUT_RESULT_FRAME,
  inspectPrivateTree,
  resolvePythonInvocation,
  runCopyLayoutHelper,
} from '../copy-layout-runner.mjs';
import { terminateProcessTree } from '../process-tree.mjs';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
}

function resultFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([
    Buffer.from(`${COPY_LAYOUT_RESULT_FRAME}${body.length}\n`, 'ascii'),
    body,
  ]);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-copy-runner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'snapshot.hwpx');
  const helperPath = path.join(root, 'bundled-copy-layout.py');
  const privateRoot = path.join(root, 'hub-private');
  await Promise.all([
    fs.writeFile(sourcePath, 'snapshot'),
    fs.writeFile(helperPath, '# bundled helper'),
  ]);
  return { root, sourcePath, helperPath, privateRoot };
}

test('structured runner fixes shell:false executable, helper, source, and private output paths', async (t) => {
  const paths = await fixture(t);
  const sourceDigest = crypto.createHash('sha256').update('snapshot').digest('hex');
  const spawns = [];
  const spawnProcess = (command, argv, options) => {
    const child = new FakeChild();
    spawns.push({ command, argv, options, child });
    queueMicrotask(async () => {
      const outputIndex = argv.indexOf('--output');
      if (outputIndex >= 0) await fs.writeFile(argv[outputIndex + 1], 'candidate');
      child.stdout.end(JSON.stringify({
        source: paths.sourcePath,
        source_sha256: sourceDigest,
        ...(outputIndex >= 0 ? {
          output: argv[outputIndex + 1],
          delivery: { ready: true, quality: 'verified', warnings: [] },
        } : {}),
      }));
      child.emit('close', 0, null);
    });
    return child;
  };
  const dependencies = {
    ...paths,
    sourceFormat: 'hwpx',
    platform: 'linux',
    pythonCommand: 'trusted-python',
    spawnProcess,
    cleanupProcess: async () => true,
    sourceEnv: { PATH: '/trusted/bin', SECRET_TOKEN: 'must-not-leak' },
  };

  const inspected = await runCopyLayoutHelper({ action: 'inspect' }, dependencies);
  assert.equal(inspected.report.source_sha256, sourceDigest);
  assert.equal(spawns[0].command, 'trusted-python');
  assert.deepEqual(spawns[0].argv, [
    '-S', await fs.realpath(paths.helperPath), paths.sourcePath, '--inspect-text',
  ]);
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.env.SECRET_TOKEN, undefined);

  const generated = await runCopyLayoutHelper({
    action: 'generate',
    iteration: 1,
    textPlan: { source_sha256: sourceDigest, default: 'keep', note: '; touch /tmp/pwned' },
    keepMedia: ['id; touch /tmp/pwned'],
  }, dependencies);
  const generation = spawns[1];
  assert.equal(generation.options.shell, false);
  assert.equal(generation.argv[0], '-S');
  assert.equal(generation.argv[1], await fs.realpath(paths.helperPath));
  assert.equal(generation.argv[2], paths.sourcePath);
  assert.ok(generation.argv.includes('id; touch /tmp/pwned'), 'untrusted text remains one argv value');
  assert.ok(path.resolve(generated.outputPath).startsWith(path.resolve(paths.privateRoot) + path.sep));
  assert.equal(await fs.readFile(generated.outputPath, 'utf8'), 'candidate');
  assert.equal(await fs.stat(path.join(paths.root, 'pwned')).catch(() => null), null);
  assert.deepEqual(
    (await fs.readdir(paths.privateRoot)).filter((name) => name.startsWith('.plan-')),
    [],
  );
});

test('structured runner bounds time and requires proven process-tree cleanup', async (t) => {
  const paths = await fixture(t);
  const hangingSpawn = () => new FakeChild();
  await assert.rejects(
    runCopyLayoutHelper({ action: 'inspect' }, {
      ...paths,
      sourceFormat: 'hwpx',
      pythonCommand: 'trusted-python',
      spawnProcess: hangingSpawn,
      cleanupProcess: async () => true,
      timeoutMs: 5,
    }),
    (error) => error.code === 'COPY_LAYOUT_TIMEOUT',
  );
  await assert.rejects(
    runCopyLayoutHelper({ action: 'inspect' }, {
      ...paths,
      sourceFormat: 'hwpx',
      pythonCommand: 'trusted-python',
      spawnProcess: hangingSpawn,
      cleanupProcess: async () => false,
      timeoutMs: 5,
    }),
    (error) => error.processCleanupUncertain === true,
  );
});

test('private temporary inventory bounds entries, aggregate bytes, and links', async (t) => {
  const paths = await fixture(t);
  const inventoryRoot = path.join(paths.root, 'inventory');
  await fs.mkdir(inventoryRoot);
  await Promise.all([
    fs.writeFile(path.join(inventoryRoot, 'one'), '12'),
    fs.writeFile(path.join(inventoryRoot, 'two'), '34'),
  ]);
  assert.deepEqual(await inspectPrivateTree(inventoryRoot), { entries: 2, bytes: 4 });
  await assert.rejects(
    inspectPrivateTree(inventoryRoot, { maxEntries: 1, maxBytes: 100 }),
    (error) => error.code === 'COPY_LAYOUT_TEMP_LIMIT',
  );
  await assert.rejects(
    inspectPrivateTree(inventoryRoot, { maxEntries: 10, maxBytes: 3 }),
    (error) => error.code === 'COPY_LAYOUT_TEMP_LIMIT',
  );
  await fs.symlink(paths.sourcePath, path.join(inventoryRoot, 'linked'));
  await assert.rejects(
    inspectPrivateTree(inventoryRoot),
    (error) => error.code === 'COPY_LAYOUT_TEMP_UNSAFE',
  );
});

test('structured runner stops a helper that exceeds its private temporary quota', async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    runCopyLayoutHelper({ action: 'inspect' }, {
      ...paths,
      sourceFormat: 'hwpx',
      pythonCommand: 'trusted-python',
      spawnProcess(command, argv, options) {
        const child = new FakeChild();
        writeFileSync(path.join(options.env.TMPDIR, 'oversized'), '12');
        return child;
      },
      cleanupProcess: async () => true,
      timeoutMs: 1_000,
      maxPrivateTempBytes: 1,
    }),
    (error) => error.code === 'COPY_LAYOUT_TEMP_LIMIT',
  );
});

test('Windows result handoff starts taskkill while the retained Python leader is live', async (t) => {
  const paths = await fixture(t);
  const sourceDigest = crypto.createHash('sha256').update('snapshot').digest('hex');
  const taskkillCalls = [];
  let helperSpawn = null;
  const result = await runCopyLayoutHelper({ action: 'inspect' }, {
    ...paths,
    sourceFormat: 'hwpx',
    platform: 'win32',
    pythonCommand: 'trusted-python.exe',
    spawnProcess(command, argv, options) {
      const child = Object.assign(new FakeChild(), {
        pid: 4_242,
        exitCode: null,
        signalCode: null,
      });
      helperSpawn = { command, argv, options, child };
      queueMicrotask(() => child.stdout.write(resultFrame({
        ok: true,
        report: { source: paths.sourcePath, source_sha256: sourceDigest },
      })));
      return child;
    },
    cleanupProcess(child) {
      assert.equal(child.exitCode, null, 'cleanup must begin before the retained leader exits');
      return terminateProcessTree(child, {
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows' },
        spawnProcess(command, argv) {
          taskkillCalls.push([command, argv]);
          const killer = new EventEmitter();
          queueMicrotask(() => {
            killer.emit('exit', 0, null);
            child.exitCode = 0;
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
          });
          return killer;
        },
      });
    },
  });

  assert.equal(result.report.source_sha256, sourceDigest);
  assert.equal(helperSpawn.command, 'trusted-python.exe');
  assert.ok(helperSpawn.argv.includes('--runner-framed'));
  assert.equal(helperSpawn.options.detached, false);
  assert.deepEqual(helperSpawn.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(taskkillCalls, [[
    'C:\\Windows\\System32\\taskkill.exe',
    ['/PID', '4242', '/T', '/F'],
  ]]);
});

test('the real framed Python helper remains live until the hub starts cleanup', async (t) => {
  const paths = await fixture(t);
  const sourceDigest = crypto.createHash('sha256').update('snapshot').digest('hex');
  await fs.writeFile(paths.helperPath, [
    'import hashlib, json, pathlib, sys',
    'source = pathlib.Path(sys.argv[1])',
    'payload = {"ok": True, "report": {"source": str(source), "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}}',
    'body = json.dumps(payload, separators=(",", ":")).encode("utf-8")',
    'sys.stdout.buffer.write(b"RHWP_COPY_LAYOUT_RESULT " + str(len(body)).encode("ascii") + b"\\n" + body)',
    'sys.stdout.buffer.flush()',
    'sys.stdin.buffer.read(1)',
  ].join('\n'));
  let cleanupSawLiveLeader = false;
  const result = await runCopyLayoutHelper({ action: 'inspect' }, {
    ...paths,
    sourceFormat: 'hwpx',
    platform: 'win32',
    pythonCommand: process.platform === 'win32' ? 'python' : 'python3',
    spawnProcess: spawn,
    cleanupProcess(child) {
      cleanupSawLiveLeader = child.exitCode == null && child.signalCode == null;
      return new Promise((resolve) => {
        child.once('close', () => resolve(true));
        child.kill('SIGTERM');
      });
    },
  });

  assert.equal(cleanupSawLiveLeader, true);
  assert.equal(result.report.source_sha256, sourceDigest);
});

test('Windows helper exit before the frame fails closed without taskkilling an expired pid', async (t) => {
  const paths = await fixture(t);
  let taskkillCalled = false;
  await assert.rejects(
    runCopyLayoutHelper({ action: 'inspect' }, {
      ...paths,
      sourceFormat: 'hwpx',
      platform: 'win32',
      pythonCommand: 'trusted-python.exe',
      spawnProcess() {
        const child = Object.assign(new FakeChild(), {
          pid: 4_243,
          exitCode: null,
          signalCode: null,
        });
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit('close', 0, null);
        });
        return child;
      },
      cleanupProcess(child) {
        return terminateProcessTree(child, {
          platform: 'win32',
          spawnProcess() {
            taskkillCalled = true;
            return new EventEmitter();
          },
        });
      },
    }),
    (error) => (
      error.code === 'COPY_LAYOUT_PROCESS_CLEANUP_UNCERTAIN'
      && error.processCleanupUncertain === true
    ),
  );
  assert.equal(taskkillCalled, false);
});

test('Windows Python discovery prefers a configured or packaged interpreter', async () => {
  const configured = 'D:\\Rau\\python\\python.exe';
  const checked = [];
  const result = await resolvePythonInvocation({
    platform: 'win32',
    executablePath: 'C:\\Program Files\\Rauhwpx\\Rauhwpx.exe',
    sourceEnv: {
      RHWP_BUNDLED_PYTHON: configured,
      PATH: 'C:\\Windows;C:\\Python',
    },
    isPlainFile(candidate) {
      checked.push(candidate);
      return candidate === configured;
    },
  });

  assert.deepEqual(result, { command: configured, argvPrefix: [] });
  assert.deepEqual(checked, [configured]);
});

test('Windows Python discovery probes py -3, python3, then python without spawning aliases', async () => {
  const existing = new Set(['C:\\Tools\\py.exe', 'C:\\Tools\\python3.exe', 'C:\\Tools\\python.exe']);
  const py = await resolvePythonInvocation({
    platform: 'win32',
    executablePath: '',
    sourceEnv: {
      PATH: 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools',
    },
    isPlainFile: (candidate) => existing.has(candidate),
  });
  assert.deepEqual(py, { command: 'C:\\Tools\\py.exe', argvPrefix: ['-3'] });

  existing.delete('C:\\Tools\\py.exe');
  const python3 = await resolvePythonInvocation({
    platform: 'win32',
    executablePath: '',
    sourceEnv: { PATH: 'C:\\Tools' },
    isPlainFile: (candidate) => existing.has(candidate),
  });
  assert.deepEqual(python3, { command: 'C:\\Tools\\python3.exe', argvPrefix: [] });

  existing.delete('C:\\Tools\\python3.exe');
  const python = await resolvePythonInvocation({
    platform: 'win32',
    executablePath: '',
    sourceEnv: { PATH: 'C:\\Tools' },
    isPlainFile: (candidate) => existing.has(candidate),
  });
  assert.deepEqual(python, { command: 'C:\\Tools\\python.exe', argvPrefix: [] });
});
