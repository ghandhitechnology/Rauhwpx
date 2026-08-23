#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARCH=${1:-$(uname -m)}
case "$ARCH" in
  x86_64|amd64) ASSET_ARCH=amd64 ;;
  aarch64|arm64) ASSET_ARCH=arm64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
[[ $(uname -s) == Linux ]] || {
  echo "Cloud release assets require a native Linux builder" >&2
  exit 1
}
case "$(uname -m)" in
  x86_64) BUILDER_ASSET_ARCH=amd64 ;;
  aarch64|arm64) BUILDER_ASSET_ARCH=arm64 ;;
  *) echo "Unsupported builder architecture: $(uname -m)" >&2; exit 1 ;;
esac
[[ "$ASSET_ARCH" == "$BUILDER_ASSET_ARCH" ]] || {
  echo "Cloud release architecture $ASSET_ARCH does not match native builder $BUILDER_ASSET_ARCH" >&2
  exit 1
}
OUTPUT=${2:-"$ROOT/dist"}
NODE_BIN=/opt/rauhwpx-node/bin/node
if [[ ! -x "$NODE_BIN" ]]; then NODE_BIN=node; fi
VERSION=$($NODE_BIN -p "require('$ROOT/package.json').version")
DESKTOP_VERSION=$($NODE_BIN -p "require('$ROOT/../package.json').version")
[[ "$VERSION" == "$DESKTOP_VERSION" ]] || {
  echo "Cloud version $VERSION must match desktop release version $DESKTOP_VERSION" >&2
  exit 1
}
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
[[ -f "$ROOT/runtime-assets/studio/index.html" \
  && -f "$ROOT/runtime-assets/rhwp-agent/server.mjs" \
  && -f "$ROOT/package-lock.json" ]] || {
  echo "Cloud runtime assets are missing; run install/build-runtime-assets.sh first" >&2
  exit 1
}
mkdir -p "$STAGING/rauhwpx-cloud-$VERSION"
cp -a "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/bin" "$ROOT/src" "$ROOT/migrations" "$ROOT/install" "$ROOT/worker" "$ROOT/document-runtime" "$ROOT/runtime-assets" "$STAGING/rauhwpx-cloud-$VERSION/"
$NODE_BIN "$ROOT/install/normalize-runtime-assets.mjs" "$STAGING/rauhwpx-cloud-$VERSION/runtime-assets"
# Generated runtime assets can inherit a private build-directory mode. Release
# payloads contain no secrets and must remain traversable by the rootless
# rauhwpx-cloud user that builds the worker image after installation.
chmod -R a+rX "$STAGING/rauhwpx-cloud-$VERSION"
mkdir -p "$OUTPUT"
ASSET="$OUTPUT/rauhwpx-cloud-linux-${ASSET_ARCH}.tar.gz"
tar -czf "$ASSET" -C "$STAGING" "rauhwpx-cloud-$VERSION"
(cd "$OUTPUT" && sha256sum "$(basename "$ASSET")" >"$(basename "$ASSET").sha256")
cosign sign-blob --yes "$ASSET" --bundle "$ASSET.sigstore.json"
BOOTSTRAP="$OUTPUT/rauhwpx-cloud-bootstrap-linux-${ASSET_ARCH}.tar.gz"
mkdir -p "$STAGING/bootstrap"
cp "$ROOT/install/install.sh" \
  "$ASSET" "$ASSET.sha256" "$ASSET.sigstore.json" \
  "$STAGING/bootstrap/"
tar -czf "$BOOTSTRAP" -C "$STAGING/bootstrap" .
printf '%s\n' "$ASSET" "$BOOTSTRAP"
