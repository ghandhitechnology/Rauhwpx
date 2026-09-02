import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const which = require('which');
const escape = require('cross-spawn/lib/util/escape');

/** cmd.exe 가 한 줄에서 받는 명령 길이 상한. CreateProcessW(~32767)보다 훨씬 낮다. */
export const WINDOWS_CMD_LINE_LIMIT = 8191;

const BATCH_EXT = /\.(?:cmd|bat)$/i;
/** npm/pnpm/yarn cmd-shim: node (or %_prog%) plus a quoted JS entry, forwarding %*. */
const NODE_SHIM_INVOCATION = /(?:^|[\s&])(?:node(?:\.exe)?|"[^"\r\n]*node(?:\.exe)?"|"%_prog%")[ \t]+"([^"\r\n]+\.(?:cjs|mjs|js))"[ \t]+%\*/gi;
const NODE_BIN = /^(?:node|node\.exe)$/i;

/**
 * cross-spawn 이 `.cmd` 를 `cmd.exe /c` 로 돌릴 때 실제로 붙는 명령 문자열 길이.
 * JSON/공백/따옴표는 `^` 이스케이프 때문에 원문보다 길어진다.
 *
 * @param {string} command
 * @param {readonly string[]} argv
 * @param {{ doubleEscapeMetaChars?: boolean }} [options]
 */
export function windowsCmdExeCommandLine(command, argv, { doubleEscapeMetaChars = false } = {}) {
  const body = [
    escape.command(String(command)),
    ...argv.map((arg) => escape.argument(String(arg), doubleEscapeMetaChars)),
  ].join(' ');
  return `cmd.exe /d /s /c "${body}"`;
}

export function windowsCmdExeCommandLineLength(command, argv, options) {
  return windowsCmdExeCommandLine(command, argv, options).length;
}

function isNodeBinary(command) {
  return NODE_BIN.test(path.basename(String(command ?? '')));
}

function expandCmdVars(raw, cmdFile) {
  const dir = path.dirname(path.resolve(cmdFile));
  const dirSlash = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  return String(raw)
    .replace(/%~dp0/gi, dirSlash)
    .replace(/%dp0%[/\\]?/gi, dirSlash)
    .replace(/\\/g, path.sep);
}

/**
 * npm/pnpm/yarn 이 쓰는 Windows `.cmd` 심에서 Node 엔트리 스크립트 경로를 꺼낸다.
 * node/`%_prog%` 가 `%*` 를 넘기는 호출만 인정하고, 그 스크립트가 실제로 있을 때만
 * 경로를 돌려준다. 그 외 배치 파일은 null — 호출자가 원래 `.cmd` 를 유지한다.
 *
 * @param {string} cmdPath
 * @param {string} contents
 * @param {{ existsSync?: typeof fsExistsSync }} [deps]
 * @returns {string | null}
 */
export function parseNpmCmdShimScript(cmdPath, contents, deps = {}) {
  const existsSync = deps.existsSync ?? fsExistsSync;
  for (const match of String(contents).matchAll(NODE_SHIM_INVOCATION)) {
    const resolved = path.resolve(expandCmdVars(match[1], cmdPath));
    if (resolved !== path.resolve(cmdPath) && existsSync(resolved)) return resolved;
  }
  return null;
}

function resolveWindowsCommand(command, deps = {}) {
  const existsSync = deps.existsSync ?? fsExistsSync;
  const whichSync = deps.whichSync ?? ((cmd, opt) => which.sync(cmd, { ...opt, nothrow: true }));
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    if (existsSync(command)) return command;
    if (!path.extname(command)) {
      for (const ext of ['.cmd', '.bat']) {
        const candidate = `${command}${ext}`;
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }
  return whichSync(command, { path: (deps.env ?? process.env).PATH }) ?? null;
}

/**
 * Windows 에서 npm `.cmd` 심을 node + JS 엔트리로 풀어 cmd.exe 8191 상한을 피한다.
 * 그 외 플랫폼/네이티브 바이너리는 그대로 둔다.
 *
 * @param {string} command
 * @param {{
 *   platform?: NodeJS.Platform,
 *   nodeCommand?: string,
 *   env?: NodeJS.ProcessEnv,
 *   existsSync?: typeof fsExistsSync,
 *   readFileSync?: typeof fsReadFileSync,
 *   whichSync?: Function,
 * }} [deps]
 * @returns {{ command: string, leadingArgs: string[], env: Record<string, string> }}
 */
export function resolveNpmCliLaunch(command, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const nodeCommand = deps.nodeCommand ?? process.execPath;
  const requested = String(command ?? '');
  if (platform !== 'win32') return { command: requested, leadingArgs: [], env: {} };

  const resolved = resolveWindowsCommand(requested, deps);
  if (!resolved || !BATCH_EXT.test(resolved)) {
    return { command: resolved ?? requested, leadingArgs: [], env: {} };
  }

  let contents = '';
  try {
    contents = String((deps.readFileSync ?? fsReadFileSync)(resolved, 'utf8'));
  } catch {
    return { command: resolved, leadingArgs: [], env: {} };
  }
  const script = parseNpmCmdShimScript(resolved, contents, deps);
  if (!script) return { command: resolved, leadingArgs: [], env: {} };

  return {
    command: nodeCommand,
    leadingArgs: [script],
    env: isNodeBinary(nodeCommand) ? {} : { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * @param {string} command
 * @param {readonly string[]} argv
 * @param {Parameters<typeof resolveNpmCliLaunch>[1]} [deps]
 */
export function applyNpmCliLaunch(command, argv, deps) {
  const launch = resolveNpmCliLaunch(command, deps);
  return {
    command: launch.command,
    argv: [...launch.leadingArgs, ...argv],
    env: launch.env,
  };
}
