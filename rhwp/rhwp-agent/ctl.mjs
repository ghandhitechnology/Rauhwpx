#!/usr/bin/env node
/**
 * 허브 프로세스 관리. 저장소 루트에서 `npm start` 하면 터미널을 붙잡지 않고
 * 백그라운드로 켜고, `npm stop` 으로 끈다.
 *
 *   node ctl.mjs start|stop|restart|status [--json]
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_HUB_PORT,
  hubHealthUrl,
  hubRunDir,
  hubRunPaths,
  isHubHealthy,
  readHubHealth,
  startDetachedHub,
  stopHubByPort,
} from '../../desktop/agent-hub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENT_DIR = HERE;
const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_SCRIPT = resolve(HERE, 'server.mjs');
export const EXPECTED_HUB_PROTOCOL = 5;

export const CTL_COMMANDS = ['start', 'stop', 'restart', 'status'];

export function parseCtlArgs(argv) {
  const args = argv.filter((arg) => arg !== '--');
  const json = args.includes('--json');
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const command = positional[0] ?? 'start';
  return { command, json };
}

export function ctlUsage() {
  return [
    '사용법: npm start | npm stop | npm run status | npm run start:fg',
    '',
    '  start     허브를 백그라운드에서 켭니다. 이미 켜져 있으면 그대로 둡니다.',
    '  stop      백그라운드 허브를 종료합니다.',
    '  restart   허브를 종료한 뒤 다시 켭니다.',
    '  status    실행 여부를 표시합니다.',
    '  start:fg  포그라운드(기존 node server.mjs). 터미널을 붙잡습니다.',
  ].join('\n');
}

function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

function describeHub(port, pid) {
  const where = `ws://127.0.0.1:${port}`;
  return pid ? `${where} (pid ${pid})` : where;
}

export async function runCtl(command, {
  port = Number(process.env.RHWP_AGENT_PORT ?? DEFAULT_HUB_PORT),
  repoRoot = process.env.RHWP_REPO_ROOT || DEFAULT_REPO_ROOT,
  runDir = process.env.RHWP_RUN_DIR || hubRunDir(repoRoot),
  scriptPath = DEFAULT_SCRIPT,
  agentDir = DEFAULT_AGENT_DIR,
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  home = env.HOME || env.USERPROFILE,
} = {}) {
  const paths = hubRunPaths(runDir);
  const token = env.RHWP_AGENT_TOKEN ?? env.RHWP_AGENT_DEV_TOKEN ?? 'dev';
  const print = (result, lines, code) => {
    if (json) writeLine(stdout, JSON.stringify({ command, ...result }));
    else for (const line of lines) writeLine(stdout, line);
    return { code, result };
  };

  if (!CTL_COMMANDS.includes(command)) {
    writeLine(stderr, ctlUsage());
    return { code: 2, result: { error: 'unknown-command', command } };
  }

  if (command === 'status') {
    const body = await readHubHealth(port, { token });
    const ready = body?.ok === true && Number(body.protocol) === EXPECTED_HUB_PROTOCOL;
    const pid = ready ? Number(body.pid) || null : null;
    return print(
      { ready, pid, url: hubHealthUrl(port), log: paths.log },
      ready
        ? [`허브가 실행 중입니다 — ${describeHub(port, pid)}`]
        : ['허브가 실행 중이지 않습니다. 저장소 루트에서 npm start 로 켜세요.'],
      ready ? 0 : 1,
    );
  }

  if (command === 'stop') {
    const result = await stopHubByPort(port, { pidPath: paths.pid, token });
    return print(
      result,
      result.pid
        ? [`허브를 종료했습니다 (pid ${result.pid}).`]
        : ['허브가 실행 중이지 않습니다.'],
      0,
    );
  }

  if (command === 'restart') {
    await stopHubByPort(port, { pidPath: paths.pid, token });
  }

  if (!existsSync(scriptPath)) {
    const result = { started: false, ready: false, error: 'missing-server' };
    return print(result, [`허브 스크립트를 찾지 못했습니다: ${scriptPath}`], 1);
  }

  const result = await startDetachedHub({
    port,
    scriptPath,
    agentDir,
    runDir,
    home,
    env,
    extraDirs: [resolve(repoRoot, 'node_modules', '.bin')],
    execPath: process.execPath,
    expectedProtocol: EXPECTED_HUB_PROTOCOL,
  });
  const pid = result.pid;
  if (result.alreadyRunning) {
    return print(result, [`허브가 이미 실행 중입니다 — ${describeHub(port, pid)}`], 0);
  }
  if (result.ready) {
    return print(
      result,
      [
        `허브를 백그라운드에서 켰습니다 — ${describeHub(port, pid)}`,
        `로그: ${result.log}`,
        '터미널을 닫아도 허브는 유지됩니다. 끄려면 npm stop.',
      ],
      0,
    );
  }
  return print(
    result,
    [
      '허브를 켜지 못했습니다. 로그를 확인하세요.',
      result.log ? `로그: ${result.log}` : '',
    ].filter(Boolean),
    1,
  );
}

function isDirectRun() {
  const self = fileURLToPath(import.meta.url);
  const invoked = process.argv[1] && resolve(process.argv[1]);
  return invoked === self;
}

if (isDirectRun()) {
  const { command, json } = parseCtlArgs(process.argv.slice(2));
  runCtl(command, { json }).then(({ code }) => {
    process.exit(code);
  }).catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
