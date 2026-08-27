#!/usr/bin/env bash
set -euo pipefail

CHANNEL=${RAUHWpx_CHANNEL:-stable}
TRANSPORT=${RAUHWpx_TRANSPORT:-tailscale}
TAILSCALE_HTTPS_PORT=${RAUHWpx_TAILSCALE_HTTPS_PORT:-443}
NODE_VERSION=${RAUHWpx_NODE_VERSION:-24.19.0}
COSIGN_VERSION=3.1.2
BASE_PATH=/rauhwpx-cloud

fail() {
  echo "Rauhwpx cloud install failed: $*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail "run this script through sudo"
[[ "$CHANNEL" == stable || "$CHANNEL" == prerelease ]] || fail "RAUHWpx_CHANNEL must be stable or prerelease"
[[ "$TRANSPORT" == tailscale || "$TRANSPORT" == public-https || "$TRANSPORT" == ssh-tunnel ]] \
  || fail "RAUHWpx_TRANSPORT must be tailscale, public-https, or ssh-tunnel"
if [[ "$TRANSPORT" == tailscale ]]; then
  [[ "$TAILSCALE_HTTPS_PORT" =~ ^[0-9]{1,5}$ ]] \
    || fail "RAUHWpx_TAILSCALE_HTTPS_PORT must be an integer from 1 to 65535"
  TAILSCALE_HTTPS_PORT=$((10#$TAILSCALE_HTTPS_PORT))
  (( TAILSCALE_HTTPS_PORT >= 1 && TAILSCALE_HTTPS_PORT <= 65535 )) \
    || fail "RAUHWpx_TAILSCALE_HTTPS_PORT must be an integer from 1 to 65535"
fi

source /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "Ubuntu and Debian are supported" ;;
esac

case "$(uname -m)" in
  x86_64) ASSET_ARCH=amd64; NODE_ARCH=x64; NODE_SHA=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647; COSIGN_SHA=f7622ed3cf22e55e1ae6377c080979ff77a22da9981c11df222a2e444991e7cf ;;
  aarch64|arm64) ASSET_ARCH=arm64; NODE_ARCH=arm64; NODE_SHA=01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc; COSIGN_SHA=90e7ae0b5dfd60f20816b52c012addf7fc055ebcc7bea4ce81c428ca8518c302 ;;
  *) fail "amd64 and arm64 are supported" ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl xz-utils podman crun uidmap slirp4netns fuse-overlayfs dbus-user-session

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

install_node() {
  local filename="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  local base="https://nodejs.org/dist/v${NODE_VERSION}"
  curl --fail --location --silent --show-error "$base/$filename" --output "$TMP/$filename"
  echo "$NODE_SHA  $TMP/$filename" | sha256sum --check
  rm -rf /opt/rauhwpx-node
  mkdir -p /opt/rauhwpx-node
  tar -xJf "$TMP/$filename" -C /opt/rauhwpx-node --strip-components=1
}

if [[ ! -x /opt/rauhwpx-node/bin/node ]] || [[ "$(/opt/rauhwpx-node/bin/node -p 'process.versions.node')" != "$NODE_VERSION" ]]; then
  install_node
fi

if [[ ! -x /usr/local/bin/cosign ]] || [[ "$(/usr/local/bin/cosign version 2>/dev/null | sed -n 's/.*GitVersion:[[:space:]]*v\{0,1\}//p' | head -1)" != "$COSIGN_VERSION" ]]; then
  curl --fail --location --silent --show-error \
    "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${ASSET_ARCH}" \
    --output "$TMP/cosign"
  echo "$COSIGN_SHA  $TMP/cosign" | sha256sum --check
  install -m 0755 "$TMP/cosign" /usr/local/bin/cosign
fi

if ! id rauhwpx-cloud >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/rauhwpx-cloud --shell /bin/bash rauhwpx-cloud
fi

ensure_subids() {
  local file=$1 option=$2
  if grep -q '^rauhwpx-cloud:' "$file"; then return; fi
  local start
  start=$(awk -F: 'BEGIN{m=100000} {e=$2+$3; if(e>m)m=e} END{print m}' "$file")
  usermod "$option" "$start-$((start + 65535))" rauhwpx-cloud
}
ensure_subids /etc/subuid --add-subuids
ensure_subids /etc/subgid --add-subgids
loginctl enable-linger rauhwpx-cloud >/dev/null 2>&1 || true
install -d -m 0700 -o rauhwpx-cloud -g rauhwpx-cloud /var/lib/rauhwpx-cloud /var/lib/rauhwpx-cloud/provider-auth
install -d -m 0700 -o rauhwpx-cloud -g rauhwpx-cloud /run/rauhwpx-cloud
install -d -m 0755 /opt/rauhwpx-cloud/releases
install -d -m 0755 -o rauhwpx-cloud -g rauhwpx-cloud /opt/rauhwpx-cloud/provider-cli

if [[ -n ${RAUHWpx_RELEASE_URL:-} ]]; then
  ARCHIVE_URL=$RAUHWpx_RELEASE_URL
else
  ASSET="rauhwpx-cloud-linux-${ASSET_ARCH}.tar.gz"
  RELEASES_JSON=$(curl --fail --location --silent --show-error \
    'https://api.github.com/repos/ghandhitechnology/Rauhwpx/releases?per_page=30')
  if [[ "$CHANNEL" == prerelease ]]; then
    ARCHIVE_URL=$(/opt/rauhwpx-node/bin/node -e '
      const releases=JSON.parse(process.argv[1]); const name=process.argv[2];
      const release=releases.find((item)=>item.prerelease && !item.draft && item.assets?.some((asset)=>asset.name===name));
      const url=release?.assets.find((asset)=>asset.name===name)?.browser_download_url;
      if (!url) process.exit(1); process.stdout.write(url);
    ' "$RELEASES_JSON" "$ASSET") || fail "no compatible prerelease cloud asset was found"
  else
    ARCHIVE_URL=$(/opt/rauhwpx-node/bin/node -e '
      const releases=JSON.parse(process.argv[1]); const name=process.argv[2];
      const release=releases.find((item)=>!item.prerelease && !item.draft && item.assets?.some((asset)=>asset.name===name));
      const url=release?.assets.find((asset)=>asset.name===name)?.browser_download_url;
      if (!url) process.exit(1); process.stdout.write(url);
    ' "$RELEASES_JSON" "$ASSET") || fail "no compatible stable cloud asset was found"
  fi
fi

ARCHIVE="$TMP/$(basename "$ARCHIVE_URL")"
curl --fail --location --silent --show-error "$ARCHIVE_URL" --output "$ARCHIVE"
curl --fail --location --silent --show-error "${RAUHWpx_RELEASE_SHA256_URL:-${ARCHIVE_URL}.sha256}" --output "$ARCHIVE.sha256"
(cd "$TMP" && sha256sum --check "$(basename "$ARCHIVE").sha256")
curl --fail --location --silent --show-error "${RAUHWpx_RELEASE_BUNDLE_URL:-${ARCHIVE_URL}.sigstore.json}" --output "$ARCHIVE.sigstore.json"
cosign verify-blob "$ARCHIVE" \
  --bundle "$ARCHIVE.sigstore.json" \
  --certificate-identity-regexp '^https://github\.com/ghandhitechnology/Rauhwpx/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' >/dev/null

mkdir "$TMP/unpacked"
tar -xzf "$ARCHIVE" -C "$TMP/unpacked" --strip-components=1
[[ -f "$TMP/unpacked/package.json" && -f "$TMP/unpacked/src/main.mjs" ]] || fail "release archive is incomplete"
VERSION=$(/opt/rauhwpx-node/bin/node -p "require('$TMP/unpacked/package.json').version")
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || fail "release version is invalid"
DESTINATION="/opt/rauhwpx-cloud/releases/$VERSION"
rm -rf "$DESTINATION"
install -d -m 0755 "$DESTINATION"
cp -a "$TMP/unpacked/." "$DESTINATION/"
chown -R root:root "$DESTINATION"
chmod -R a+rX "$DESTINATION"
chmod +x "$DESTINATION/install/"*.sh "$DESTINATION/install/rauhwpx-cloud"
[[ -x "$DESTINATION/bin/rauhwpx-cloud" ]] || fail "release CLI compatibility wrapper is missing"
ln -sfn "$DESTINATION" /opt/rauhwpx-cloud/current
install -d -m 0755 /usr/local/lib/rauhwpx-cloud
ln -sfn /opt/rauhwpx-cloud/current /usr/local/lib/rauhwpx-cloud/current

install -m 0644 "$DESTINATION/install/rauhwpx-cloud.service" /etc/systemd/system/rauhwpx-cloud.service
install -m 0644 "$DESTINATION/install/rauhwpx-cloud-update.service" /etc/systemd/system/rauhwpx-cloud-update.service
install -m 0644 "$DESTINATION/install/rauhwpx-cloud-update.timer" /etc/systemd/system/rauhwpx-cloud-update.timer
install -m 0755 "$DESTINATION/install/rauhwpx-cloud" /usr/local/bin/rauhwpx-cloud

touch /etc/rauhwpx-cloud.env
chmod 0600 /etc/rauhwpx-cloud.env
upsert_env() {
  local key=$1 value=$2 temporary
  temporary=$(mktemp)
  grep -v "^${key}=" /etc/rauhwpx-cloud.env >"$temporary" || true
  printf '%s=%q\n' "$key" "$value" >>"$temporary"
  install -m 0600 "$temporary" /etc/rauhwpx-cloud.env
  rm -f "$temporary"
}
upsert_env RAUHWpx_CHANNEL "$CHANNEL"
upsert_env RAUHWpx_DATA_DIR /var/lib/rauhwpx-cloud
upsert_env RAUHWpx_HOST 127.0.0.1
upsert_env RAUHWpx_PORT 7740
upsert_env RAUHWpx_BASE_PATH "$BASE_PATH"
if [[ "$TRANSPORT" == tailscale ]]; then
  upsert_env RAUHWpx_TAILSCALE_HTTPS_PORT "$TAILSCALE_HTTPS_PORT"
fi
upsert_env RAUHWpx_PROVIDER_CLI_DIR /opt/rauhwpx-cloud/provider-cli
upsert_env RAUHWpx_WORKER_IMAGE "ghcr.io/ghandhitechnology/rauhwpx-cloud-worker:${CHANNEL}"
upsert_env PATH "/opt/rauhwpx-cloud/provider-cli/current/node_modules/.bin:/var/lib/rauhwpx-cloud/provider-auth/cursor/.local/bin:/opt/rauhwpx-node/bin:/usr/local/bin:/usr/bin:/bin"

systemctl daemon-reload
/usr/local/bin/rauhwpx-cloud provider install claude
/usr/local/bin/rauhwpx-cloud provider install cursor

(
  cd /var/lib/rauhwpx-cloud
  /usr/sbin/runuser --user rauhwpx-cloud --preserve-environment -- \
    env HOME=/var/lib/rauhwpx-cloud XDG_RUNTIME_DIR=/run/rauhwpx-cloud \
    podman --cgroup-manager=cgroupfs build --tag "ghcr.io/ghandhitechnology/rauhwpx-cloud-worker:${CHANNEL}" \
    --file "$DESTINATION/install/Containerfile.worker" "$DESTINATION"
  /usr/sbin/runuser --user rauhwpx-cloud --preserve-environment -- \
    env HOME=/var/lib/rauhwpx-cloud XDG_RUNTIME_DIR=/run/rauhwpx-cloud \
    podman --cgroup-manager=cgroupfs run --rm \
    --uidmap 0:1:1000 --uidmap 1000:0:1 --uidmap 1001:1001:64535 \
    --gidmap 0:1:1000 --gidmap 1000:0:1 --gidmap 1001:1001:64535 \
    --security-opt=no-new-privileges --cap-drop=all --read-only --network=none --pids-limit=64 \
    --entrypoint /app/bin/rhwp "ghcr.io/ghandhitechnology/rauhwpx-cloud-worker:${CHANNEL}" --version >/dev/null
)

systemctl enable --now rauhwpx-cloud.service rauhwpx-cloud-update.timer
for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:7740/v1/health >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:7740/v1/health >/dev/null || fail "service health check failed"

TAILSCALE_RECEIPT_PORT=
if [[ "$TRANSPORT" == tailscale ]]; then
  command -v tailscale >/dev/null || fail "Tailscale must be installed and connected"
  TAILSCALE_JSON=$(tailscale status --json) || fail "Tailscale is not connected"
  DNS_NAME=$(/opt/rauhwpx-node/bin/node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.Self?.DNSName||"").replace(/\.$/,""))' "$TAILSCALE_JSON")
  [[ -n "$DNS_NAME" ]] || fail "Tailscale MagicDNS name was not found"
  if [[ ${RAUHWpx_ENABLE_TAILSCALE_SSH:-1} == 1 ]]; then tailscale set --ssh; fi
  tailscale serve --bg --yes --https="$TAILSCALE_HTTPS_PORT" --set-path="$BASE_PATH" http://127.0.0.1:7740
  TAILSCALE_PORT_SUFFIX=
  if [[ "$TAILSCALE_HTTPS_PORT" != 443 ]]; then TAILSCALE_PORT_SUFFIX=":${TAILSCALE_HTTPS_PORT}"; fi
  ENDPOINT="https://${DNS_NAME}${TAILSCALE_PORT_SUFFIX}${BASE_PATH}"
  TAILSCALE_RECEIPT_PORT=$TAILSCALE_HTTPS_PORT
elif [[ "$TRANSPORT" == public-https ]]; then
  PUBLIC_HOST=${RAUHWpx_PUBLIC_HOST:-}
  [[ "$PUBLIC_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])$ && "$PUBLIC_HOST" == *.* ]] \
    || fail "RAUHWpx_PUBLIC_HOST must be a DNS hostname without a scheme, port, or path"
  if [[ ${RAUHWpx_CONFIGURE_CADDY:-1} == 1 ]]; then
    apt-get install -y --no-install-recommends caddy
    install -d -m 0755 /etc/caddy/Caddyfile.d
    cat >/etc/caddy/Caddyfile.d/rauhwpx-cloud.caddy <<EOF
${PUBLIC_HOST} {
  handle_path ${BASE_PATH}/* {
    reverse_proxy 127.0.0.1:7740
  }

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
  }
}
EOF
    grep -Fqx 'import Caddyfile.d/*.caddy' /etc/caddy/Caddyfile \
      || printf '\nimport Caddyfile.d/*.caddy\n' >>/etc/caddy/Caddyfile
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
    systemctl enable --now caddy
    systemctl reload caddy
  fi
  ENDPOINT="https://${PUBLIC_HOST}${BASE_PATH}"
  for _ in $(seq 1 60); do
    if curl --fail --silent "${ENDPOINT}/v1/health" >/dev/null; then break; fi
    sleep 1
  done
  curl --fail --silent "${ENDPOINT}/v1/health" >/dev/null \
    || fail "public HTTPS endpoint is not reachable; check DNS, ports 80/443, and reverse proxy configuration"
else
  ENDPOINT="http://127.0.0.1:7740${BASE_PATH}"
fi

PAIRING_JSON=$(/usr/local/bin/rauhwpx-cloud pairing create "Origin device")
SERVER_KEY=$(/opt/rauhwpx-node/bin/node -e 'process.stdout.write(JSON.parse(process.argv[1]).serverPublicKey)' "$PAIRING_JSON")
PAIRING_CODE=$(/opt/rauhwpx-node/bin/node -e 'process.stdout.write(JSON.parse(process.argv[1]).code)' "$PAIRING_JSON")
RECEIPT=$(/opt/rauhwpx-node/bin/node -e '
  const receipt={endpoint:process.argv[1],serverPublicKey:process.argv[2],pairingCode:process.argv[3],transport:process.argv[5]};
  if (process.argv[4]) receipt.tailscaleHttpsPort=Number(process.argv[4]);
  process.stdout.write(JSON.stringify(receipt));
' "$ENDPOINT" "$SERVER_KEY" "$PAIRING_CODE" "$TAILSCALE_RECEIPT_PORT" "$TRANSPORT")
printf 'RAUHWpx_RECEIPT=%s\n' "$RECEIPT"
