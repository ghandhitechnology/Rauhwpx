#!/usr/bin/env bash
set -euo pipefail

rauhwpx_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
rauhwpx_runtime_root="${XDG_RUNTIME_DIR:-/tmp}/rauhwpx-cursor-$(id -u)"
rauhwpx_token_path="$rauhwpx_runtime_root/hub-token"

for _ in {1..120}; do
  if [[ -s "$rauhwpx_token_path" ]]; then
    break
  fi
  sleep 0.25
done

if [[ ! -s "$rauhwpx_token_path" ]]; then
  echo "The agent hub did not create its authentication token within 30 seconds." >&2
  exit 1
fi

export RHWP_AGENT_TOKEN="$(tr -d '\r\n' < "$rauhwpx_token_path")"
export RHWP_CURSOR_HUB_TOKEN="$RHWP_AGENT_TOKEN"

node --input-type=module <<'NODE'
const deadline = Date.now() + 30_000;
let lastError = null;

while (Date.now() < deadline) {
  try {
    const response = await fetch('http://127.0.0.1:5175/healthz', {
      headers: { authorization: `Bearer ${process.env.RHWP_CURSOR_HUB_TOKEN}` },
      signal: AbortSignal.timeout(1_000),
    });
    const payload = await response.json();
    if (response.ok && payload?.ok === true && Number(payload.protocol) === 5) {
      process.exit(0);
    }
    lastError = new Error(`unexpected health response (${response.status})`);
  } catch (error) {
    lastError = error;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

throw new Error(`The agent hub was not healthy within 30 seconds: ${lastError ?? 'unknown error'}`);
NODE

unset RHWP_CURSOR_HUB_TOKEN
export RHWP_AGENT_PORT=5175
export VITE_RHWP_AGENT_URL=ws://127.0.0.1:5175
exec npm --prefix "$rauhwpx_repo_root/rhwp/rhwp-studio" run dev
