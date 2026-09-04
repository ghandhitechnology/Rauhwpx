#!/usr/bin/env bash
set -euo pipefail

rauhwpx_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
rauhwpx_runtime_root="${XDG_RUNTIME_DIR:-/tmp}/rauhwpx-cursor-$(id -u)"
rauhwpx_token_path="$rauhwpx_runtime_root/hub-token"

umask 077
mkdir -p -- "$rauhwpx_runtime_root"
chmod 700 "$rauhwpx_runtime_root"

node --input-type=module - "$rauhwpx_token_path" <<'NODE'
import { randomBytes } from 'node:crypto';
import { open, rename } from 'node:fs/promises';

const tokenPath = process.argv[2];
try {
  const existing = await open(tokenPath, 'r');
  const token = (await existing.readFile('utf8')).trim();
  await existing.close();
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const temporaryPath = `${tokenPath}.${process.pid}`;
const temporary = await open(temporaryPath, 'wx', 0o600);
await temporary.writeFile(randomBytes(32).toString('base64url'));
await temporary.close();
await rename(temporaryPath, tokenPath);
NODE

export RHWP_AGENT_PORT=5175
export RHWP_AGENT_TOKEN="$(tr -d '\r\n' < "$rauhwpx_token_path")"
exec npm --prefix "$rauhwpx_repo_root/rhwp/rhwp-agent" run start
