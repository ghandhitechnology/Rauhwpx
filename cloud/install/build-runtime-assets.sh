#!/usr/bin/env bash
set -euo pipefail

CLOUD_ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPOSITORY_ROOT=$(cd "$CLOUD_ROOT/.." && pwd)
STUDIO_ROOT="$REPOSITORY_ROOT/rhwp/rhwp-studio"
AGENT_ROOT="$REPOSITORY_ROOT/rhwp/rhwp-agent"
NATIVE_RHWP="$REPOSITORY_ROOT/rhwp/target/release/rhwp"
OUTPUT="$CLOUD_ROOT/runtime-assets"
STAGING=$(mktemp -d "$CLOUD_ROOT/.runtime-assets.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT

[[ -f "$REPOSITORY_ROOT/rhwp/pkg/rhwp_bg.wasm" ]] || {
  echo "WASM engine is missing; run wasm-pack build --target web from rhwp" >&2
  exit 1
}
[[ -f "$STUDIO_ROOT/package-lock.json" && -f "$AGENT_ROOT/package-lock.json" ]] || {
  echo "Studio or agent dependency lock is missing" >&2
  exit 1
}
[[ -x "$NATIVE_RHWP" ]] || {
  echo "Native reference extractor is missing; run cargo build --release --locked --bin rhwp from rhwp" >&2
  exit 1
}

VITE_RHWP_CLOUD_RUNTIME=1 npm --prefix "$STUDIO_ROOT" run build
mkdir -p "$STAGING/studio" "$STAGING/rhwp-agent" "$STAGING/rau-credits" "$STAGING/bin"
cp -a "$STUDIO_ROOT/dist/." "$STAGING/studio/"
cp "$REPOSITORY_ROOT/rhwp/rau-credits/catalog.mjs" "$STAGING/rau-credits/catalog.mjs"
install -m 0755 "$NATIVE_RHWP" "$STAGING/bin/rhwp"
tar -C "$AGENT_ROOT" \
  --exclude='./node_modules' \
  --exclude='./tests' \
  --exclude='./.git' \
  -cf - . | tar -C "$STAGING/rhwp-agent" -xf -
node "$CLOUD_ROOT/install/normalize-runtime-assets.mjs" "$STAGING"

[[ -f "$STAGING/studio/index.html" ]] || {
  echo "Studio build did not produce index.html" >&2
  exit 1
}
find "$STAGING/studio" -type f -name '*.wasm' -print -quit | grep -q . || {
  echo "Studio build did not contain the document WASM engine" >&2
  exit 1
}
grep -Rq 'rauhwpxCloudRuntime' "$STAGING/studio/assets" || {
  echo "Studio build is missing the gated cloud runtime bridge" >&2
  exit 1
}
[[ -f "$STAGING/rhwp-agent/server.mjs" ]] || {
  echo "Agent runtime is missing server.mjs" >&2
  exit 1
}
"$STAGING/bin/rhwp" --version >/dev/null

rm -rf "$OUTPUT"
mv "$STAGING" "$OUTPUT"
trap - EXIT
