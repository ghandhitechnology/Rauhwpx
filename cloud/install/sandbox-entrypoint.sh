#!/usr/bin/env bash
# 앱이 제공하는 샌드박스의 시작 지점. 부트스트랩 토큰이 없으면 아무도 페어링할 수 없으므로
# 켜지지 않는다. 공급자 자격 증명은 배포 변수로만 받고 로그에 남기지 않는다.
set -euo pipefail

CLOUD_ROOT=/app
DATA_DIR=${RAUHWpx_DATA_DIR:-/var/lib/rauhwpx-cloud}
CONTROL_DIR=${RAUHWpx_WORKER_CONTROL_DIR:-/run/rauhwpx}
WORKSPACE_ROOT=${RAUHWpx_WORKSPACE_ROOT:-/var/lib/rauhwpx-workspaces}
PROVIDER_CLI_DIR=${RAUHWpx_PROVIDER_CLI_DIR:-/opt/rauhwpx-cloud/provider-cli}

if [[ -z ${RAUHWpx_BOOTSTRAP_TOKEN:-} ]]; then
  echo '{"event":"sandbox.start_failed","message":"RAUHWpx_BOOTSTRAP_TOKEN is required"}' >&2
  exit 1
fi

# Railway 같은 플랫폼은 PORT만 주입한다. 서비스가 실제로 듣는 포트와 어긋나면 도메인이 죽는다.
if [[ -n ${PORT:-} ]]; then export RAUHWpx_PORT="$PORT"; fi

mkdir -p "$DATA_DIR" "$CONTROL_DIR" "$WORKSPACE_ROOT" "$PROVIDER_CLI_DIR"
chmod 0700 "$DATA_DIR"
# 워커 uid는 데이터 디렉터리를 통과할 수 없다. 작업 디렉터리와 컨트롤 소켓만 지나갈 수 있어야 한다.
chmod 0711 "$CONTROL_DIR" "$WORKSPACE_ROOT"

seed_provider() {
  local provider=$1 variable=$2
  local key=${!variable:-}
  [[ -n $key ]] || return 0
  printf '%s' "$key" \
    | node "$CLOUD_ROOT/src/cli.mjs" provider login "$provider" --api-key-stdin >/dev/null
  echo "{\"event\":\"sandbox.provider_seeded\",\"provider\":\"$provider\"}"
}

if [[ ${RAUHWpx_SANDBOX_INSTALL_PROVIDER:-1} == 1 ]]; then
  node "$CLOUD_ROOT/src/cli.mjs" provider install "${RAUHWpx_SANDBOX_PROVIDER:-codex}" >/dev/null
fi
if [[ -n ${RAUHWpx_PROVIDER_SESSION:-} ]]; then
  node "$CLOUD_ROOT/src/seed-provider-session.mjs"
fi
seed_provider claude RAUHWpx_PROVIDER_KEY_CLAUDE
seed_provider codex RAUHWpx_PROVIDER_KEY_CODEX
seed_provider grok RAUHWpx_PROVIDER_KEY_GROK
seed_provider pi RAUHWpx_PROVIDER_KEY_PI
seed_provider cursor RAUHWpx_PROVIDER_KEY_CURSOR

exec node "$CLOUD_ROOT/src/main.mjs"
