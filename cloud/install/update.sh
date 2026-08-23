#!/usr/bin/env bash
set -euo pipefail

CHANNEL=${RAUHWpx_CHANNEL:-stable}
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ASSET_ARCH=amd64 ;;
  aarch64|arm64) ASSET_ARCH=arm64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

STATUS=$(/usr/local/bin/rauhwpx-cloud status)
RUNNING=$(/opt/rauhwpx-node/bin/node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.sessions.running||0))' "$STATUS")
if [[ "$RUNNING" != 0 ]]; then
  echo "Cloud update deferred while $RUNNING session(s) run"
  exit 0
fi

if [[ -n ${RAUHWpx_RELEASE_URL:-} ]]; then
  ARCHIVE_URL=$RAUHWpx_RELEASE_URL
else
  ASSET="rauhwpx-cloud-linux-${ASSET_ARCH}.tar.gz"
  if [[ "$CHANNEL" == prerelease ]]; then
    RELEASES_JSON=$(curl --fail --location --silent --show-error \
      'https://api.github.com/repos/ghandhitechnology/Rauhwpx/releases?per_page=30')
    ARCHIVE_URL=$(/opt/rauhwpx-node/bin/node -e '
      const releases=JSON.parse(process.argv[1]); const name=process.argv[2];
      const release=releases.find((item)=>item.prerelease && !item.draft && item.assets?.some((asset)=>asset.name===name));
      const url=release?.assets.find((asset)=>asset.name===name)?.browser_download_url;
      if (!url) process.exit(1); process.stdout.write(url);
    ' "$RELEASES_JSON" "$ASSET") || { echo "No compatible prerelease cloud asset was found" >&2; exit 1; }
  else
    ARCHIVE_URL="https://github.com/ghandhitechnology/Rauhwpx/releases/latest/download/${ASSET}"
  fi
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ARCHIVE="$TMP/$(basename "$ARCHIVE_URL")"
curl --fail --location --silent --show-error "$ARCHIVE_URL" --output "$ARCHIVE"
curl --fail --location --silent --show-error "${RAUHWpx_RELEASE_SHA256_URL:-${ARCHIVE_URL}.sha256}" --output "$ARCHIVE.sha256"
(cd "$TMP" && sha256sum --check "$(basename "$ARCHIVE").sha256")
curl --fail --location --silent --show-error "${RAUHWpx_RELEASE_BUNDLE_URL:-${ARCHIVE_URL}.sigstore.json}" --output "$ARCHIVE.sigstore.json"
cosign verify-blob "$ARCHIVE" \
  --bundle "$ARCHIVE.sigstore.json" \
  --certificate-identity-regexp '^https://github.com/ghandhitechnology/Rauhwpx/.github/workflows/release.yml@refs/(heads|tags)/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' >/dev/null

mkdir "$TMP/unpacked"
tar -xzf "$ARCHIVE" -C "$TMP/unpacked" --strip-components=1
VERSION=$(/opt/rauhwpx-node/bin/node -p "require('$TMP/unpacked/package.json').version")
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || { echo "Release version is invalid" >&2; exit 1; }
CURRENT_VERSION=$(/opt/rauhwpx-node/bin/node -p "require('/opt/rauhwpx-cloud/current/package.json').version")
UPGRADE=$(/opt/rauhwpx-node/bin/node -e '
  const parse=(value)=>{const match=value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/);return {core:match.slice(1,4).map(Number),pre:match[4]?match[4].split("."):[]}};
  const compare=(left,right)=>{for(let i=0;i<3;i++){if(left.core[i]!==right.core[i])return Math.sign(left.core[i]-right.core[i]);}
    if(!left.pre.length||!right.pre.length)return left.pre.length===right.pre.length?0:left.pre.length?-1:1;
    for(let i=0;i<Math.max(left.pre.length,right.pre.length);i++){if(left.pre[i]===undefined)return -1;if(right.pre[i]===undefined)return 1;
      const a=left.pre[i],b=right.pre[i],an=/^\d+$/.test(a),bn=/^\d+$/.test(b);if(a===b)continue;if(an&&bn)return Math.sign(Number(a)-Number(b));if(an!==bn)return an?-1:1;return a<b?-1:1;}return 0;};
  process.stdout.write(String(compare(parse(process.argv[1]),parse(process.argv[2]))>0?1:0));
' "$VERSION" "$CURRENT_VERSION")
if [[ "$UPGRADE" != 1 ]]; then
  echo "No newer Rauhwpx cloud release was found; current is $CURRENT_VERSION"
  exit 0
fi

CURRENT_PROTOCOL=$(/opt/rauhwpx-node/bin/node -e "import('/opt/rauhwpx-cloud/current/src/protocol.mjs').then(m=>process.stdout.write(String(m.PROTOCOL_VERSION)))")
NEW_PROTOCOL=$(/opt/rauhwpx-node/bin/node -e "import('$TMP/unpacked/src/protocol.mjs').then(m=>process.stdout.write(String(m.PROTOCOL_VERSION)))")
if [[ "$CURRENT_PROTOCOL" != "$NEW_PROTOCOL" ]]; then
  echo "Cloud update $VERSION requires desktop protocol migration and was deferred" >&2
  exit 0
fi

DESTINATION="/opt/rauhwpx-cloud/releases/$VERSION"
rm -rf "$DESTINATION"
install -d -m 0755 "$DESTINATION"
cp -a "$TMP/unpacked/." "$DESTINATION/"
chown -R root:root "$DESTINATION"
chmod -R a+rX "$DESTINATION"
chmod +x "$DESTINATION/bin/rauhwpx-cloud" "$DESTINATION/install/"*.sh "$DESTINATION/install/rauhwpx-cloud"
WORKER_IMAGE="ghcr.io/ghandhitechnology/rauhwpx-cloud-worker:release-$VERSION"
install -d -m 0700 -o rauhwpx-cloud -g rauhwpx-cloud /run/rauhwpx-cloud
(
  cd /var/lib/rauhwpx-cloud
  /usr/sbin/runuser --user rauhwpx-cloud --preserve-environment -- \
    env HOME=/var/lib/rauhwpx-cloud XDG_RUNTIME_DIR=/run/rauhwpx-cloud \
    podman --cgroup-manager=cgroupfs build --tag "$WORKER_IMAGE" --file "$DESTINATION/install/Containerfile.worker" "$DESTINATION"
  /usr/sbin/runuser --user rauhwpx-cloud --preserve-environment -- \
    env HOME=/var/lib/rauhwpx-cloud XDG_RUNTIME_DIR=/run/rauhwpx-cloud \
    podman --cgroup-manager=cgroupfs run --rm \
    --uidmap 0:1:1000 --uidmap 1000:0:1 --uidmap 1001:1001:64535 \
    --gidmap 0:1:1000 --gidmap 1000:0:1 --gidmap 1001:1001:64535 \
    --security-opt=no-new-privileges --cap-drop=all --read-only --network=none --pids-limit=64 \
    --entrypoint /app/bin/rhwp "$WORKER_IMAGE" --version >/dev/null
)
PREVIOUS=$(readlink -f /opt/rauhwpx-cloud/current)
cp /etc/rauhwpx-cloud.env "$TMP/environment.previous"
SWITCHED=0
rollback() {
  local status=${1:-$?}
  trap - ERR
  set +e
  if [[ "$SWITCHED" == 1 ]]; then
    ln -sfn "$PREVIOUS" /opt/rauhwpx-cloud/current
    install -m 0600 "$TMP/environment.previous" /etc/rauhwpx-cloud.env
    install -m 0644 "$PREVIOUS/install/rauhwpx-cloud.service" /etc/systemd/system/rauhwpx-cloud.service
    install -m 0644 "$PREVIOUS/install/rauhwpx-cloud-update.service" /etc/systemd/system/rauhwpx-cloud-update.service
    install -m 0644 "$PREVIOUS/install/rauhwpx-cloud-update.timer" /etc/systemd/system/rauhwpx-cloud-update.timer
    systemctl daemon-reload
    systemctl restart rauhwpx-cloud.service
  fi
  echo "Update to $VERSION failed and was rolled back" >&2
  exit "$status"
}
SWITCHED=1
trap rollback ERR
ln -sfn "$DESTINATION" /opt/rauhwpx-cloud/current
temporary=$(mktemp)
grep -Ev '^(RAUHWpx_WORKER_IMAGE|PATH)=' /etc/rauhwpx-cloud.env >"$temporary" || true
printf 'RAUHWpx_WORKER_IMAGE=%s\n' "$WORKER_IMAGE" >>"$temporary"
printf 'PATH=%s\n' '/opt/rauhwpx-cloud/provider-cli/current/node_modules/.bin:/var/lib/rauhwpx-cloud/provider-auth/cursor/.local/bin:/opt/rauhwpx-node/bin:/usr/local/bin:/usr/bin:/bin' >>"$temporary"
install -m 0600 "$temporary" /etc/rauhwpx-cloud.env
rm -f "$temporary"
/usr/local/bin/rauhwpx-cloud provider install claude
/usr/local/bin/rauhwpx-cloud provider install cursor
install -m 0644 "$DESTINATION/install/rauhwpx-cloud.service" /etc/systemd/system/rauhwpx-cloud.service
install -m 0644 "$DESTINATION/install/rauhwpx-cloud-update.service" /etc/systemd/system/rauhwpx-cloud-update.service
install -m 0644 "$DESTINATION/install/rauhwpx-cloud-update.timer" /etc/systemd/system/rauhwpx-cloud-update.timer
systemctl daemon-reload
systemctl restart rauhwpx-cloud.service
for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:7740/v1/health >/dev/null; then
    trap - ERR
    echo "Updated Rauhwpx cloud to $VERSION"
    exit 0
  fi
  sleep 1
done

rollback 1
