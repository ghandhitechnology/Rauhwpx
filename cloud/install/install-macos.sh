#!/usr/bin/env bash
set -Eeuo pipefail

CHANNEL=${RAUHWpx_CHANNEL:-stable}
TRANSPORT=${RAUHWpx_TRANSPORT:-ssh-tunnel}
BASE_PATH=/rauhwpx-cloud
MACHINE=rauhwpx-cloud
INSTALL_ROOT='/Library/Application Support/Rauhwpx Cloud'
BREW=/opt/homebrew/bin/brew
INSTALL_LOCK=/var/run/rauhwpx-cloud-install.lock
ACTIVATED=0
PREVIOUS_TARGET=
ENV_BACKUP=
TMP=

rollback() {
  if [[ -n ${ENV_BACKUP} && -f ${ENV_BACKUP} ]]; then
    install -m 0600 "${ENV_BACKUP}" "${INSTALL_ROOT}/cloud.env" || true
    chown "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_ROOT}/cloud.env" || true
  fi
  if [[ ${ACTIVATED} == 1 && -n ${PREVIOUS_TARGET} && -d ${PREVIOUS_TARGET} ]]; then
    ln -sfn "${PREVIOUS_TARGET}" "${INSTALL_ROOT}/current"
    install -m 0755 "${PREVIOUS_TARGET}/install/macos-service-wrapper" "${INSTALL_ROOT}/service-wrapper"
    launchctl kickstart -k system/com.hataewook.rauhwpx-cloud >/dev/null 2>&1 || true
  elif [[ ${ACTIVATED} == 1 ]]; then
    launchctl bootout system/com.hataewook.rauhwpx-cloud >/dev/null 2>&1 || true
    rm -f "${INSTALL_ROOT}/current"
  fi
}

fail() {
  rollback
  echo "Rauhwpx cloud install failed: $*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail "run this script through sudo"
[[ $(uname -s) == Darwin ]] || fail "macOS is required"
[[ $(uname -m) == arm64 ]] || fail "Apple silicon is required"
[[ ${TRANSPORT} == ssh-tunnel ]] || fail "macOS requires the SSH tunnel transport"
[[ ${CHANNEL} == stable || ${CHANNEL} == prerelease ]] || fail "invalid release channel"
MACOS_MAJOR=$(sw_vers -productVersion | cut -d. -f1)
(( MACOS_MAJOR >= 14 )) || fail "macOS 14 or newer is required"
SERVICE_USER=${RAUHWpx_SERVICE_USER:-${SUDO_USER:-}}
[[ -n ${SERVICE_USER} && ${SERVICE_USER} != root ]] || fail "install through the SSH account with sudo"
SERVICE_HOME=$(dscl . -read "/Users/${SERVICE_USER}" NFSHomeDirectory | awk '{print $2}')
SERVICE_GROUP=$(id -gn "${SERVICE_USER}")
[[ -d ${SERVICE_HOME} ]] || fail "the SSH account home directory is unavailable"
[[ -x ${BREW} ]] || fail "Homebrew must be installed at /opt/homebrew"
mkdir "${INSTALL_LOCK}" 2>/dev/null || fail "another Cloud install or update is already running"

cleanup() {
  if [[ -n ${TMP} ]]; then rm -rf "${TMP}"; fi
  rmdir "${INSTALL_LOCK}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap rollback ERR

as_user() {
  sudo -u "${SERVICE_USER}" -H env HOME="${SERVICE_HOME}" PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}

if ! as_user "${BREW}" list --versions podman >/dev/null 2>&1; then
  as_user "${BREW}" install podman
fi
if ! as_user "${BREW}" list --versions node@24 >/dev/null 2>&1; then
  as_user "${BREW}" install node@24
fi
if ! as_user "${BREW}" list --versions cosign >/dev/null 2>&1; then
  as_user "${BREW}" install cosign
fi

PODMAN=/opt/homebrew/bin/podman
NODE="$(as_user "${BREW}" --prefix node@24)/bin/node"
COSIGN=/opt/homebrew/bin/cosign
PODMAN_MAJOR=$(${PODMAN} --version | sed -E 's/.*version ([0-9]+).*/\1/')
[[ ${PODMAN_MAJOR} == 6 ]] || fail "Podman 6.x is required"

MACHINES=$(as_user "${PODMAN}" machine list --format json)
OTHER_RUNNING=$("${NODE}" -e '
  const machines=JSON.parse(process.argv[1]);
  process.stdout.write(String(machines.some((item)=>item.Running && item.Name!==process.argv[2])?1:0));
' "${MACHINES}" "${MACHINE}")
[[ ${OTHER_RUNNING} == 0 ]] || fail "stop the other active Podman machine before continuing"
MACHINE_EXISTS=$("${NODE}" -e '
  const machines=JSON.parse(process.argv[1]);
  process.stdout.write(String(machines.some((item)=>item.Name===process.argv[2])?1:0));
' "${MACHINES}" "${MACHINE}")
if [[ ${MACHINE_EXISTS} == 0 ]]; then
  HOST_MEMORY=$(sysctl -n hw.memsize)
  VM_MEMORY=4096
  if (( HOST_MEMORY >= 16 * 1024 * 1024 * 1024 )); then VM_MEMORY=8192; fi
  as_user "${PODMAN}" machine init --provider applehv --cpus 4 --memory "${VM_MEMORY}" --disk-size 100 \
    --volume "${SERVICE_HOME}:${SERVICE_HOME}" "${MACHINE}"
fi
MACHINE_STATE=$(as_user "${PODMAN}" machine inspect "${MACHINE}" | "${NODE}" -e '
  let value="";process.stdin.on("data",(c)=>value+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(value)[0].State));
')
if [[ ${MACHINE_STATE} != running ]]; then as_user "${PODMAN}" machine start --update-connection=false "${MACHINE}"; fi
as_user "${PODMAN}" --connection "${MACHINE}" info >/dev/null

TMP=$(mktemp -d)
if [[ -n ${RAUHWpx_RELEASE_URL:-} ]]; then
  ARCHIVE_URL=${RAUHWpx_RELEASE_URL}
else
  ASSET=rauhwpx-cloud-linux-arm64.tar.gz
  RELEASES_JSON=$(curl --fail --location --silent --show-error \
    'https://api.github.com/repos/ghandhitechnology/Rauhwpx/releases?per_page=30')
  ARCHIVE_URL=$("${NODE}" -e '
    const releases=JSON.parse(process.argv[1]),name=process.argv[2],prerelease=process.argv[3]==="prerelease";
    const release=releases.find((item)=>item.prerelease===prerelease&&!item.draft&&item.assets?.some((asset)=>asset.name===name));
    const url=release?.assets.find((asset)=>asset.name===name)?.browser_download_url;
    if(!url)process.exit(1);process.stdout.write(url);
  ' "${RELEASES_JSON}" "${ASSET}" "${CHANNEL}") || fail "no compatible Cloud release was found"
fi
ARCHIVE="${TMP}/$(basename "${ARCHIVE_URL}")"
curl --fail --location --silent --show-error "${ARCHIVE_URL}" --output "${ARCHIVE}"
curl --fail --location --silent --show-error "${RAUHWpx_RELEASE_SHA256_URL:-${ARCHIVE_URL}.sha256}" --output "${ARCHIVE}.sha256"
(cd "${TMP}" && shasum -a 256 -c "$(basename "${ARCHIVE}").sha256")
curl --fail --location --silent --show-error "${RAUHWpx_RELEASE_BUNDLE_URL:-${ARCHIVE_URL}.sigstore.json}" --output "${ARCHIVE}.sigstore.json"
"${COSIGN}" verify-blob "${ARCHIVE}" \
  --bundle "${ARCHIVE}.sigstore.json" \
  --certificate-identity-regexp '^https://github.com/ghandhitechnology/Rauhwpx/.github/workflows/release.yml@refs/(heads|tags)/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' >/dev/null

mkdir "${TMP}/unpacked"
tar -xzf "${ARCHIVE}" -C "${TMP}/unpacked" --strip-components=1
VERSION=$("${NODE}" -p "require('${TMP}/unpacked/package.json').version")
[[ ${VERSION} =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || fail "release version is invalid"
DESTINATION="${INSTALL_ROOT}/releases/${VERSION}"
STAGED_RELEASE="${INSTALL_ROOT}/releases/.${VERSION}.$$.staging"
install -d -m 0755 "${INSTALL_ROOT}/releases" "${STAGED_RELEASE}"
ditto "${TMP}/unpacked" "${STAGED_RELEASE}"
chown -R root:wheel "${STAGED_RELEASE}"
chmod -R a+rX "${STAGED_RELEASE}"
if [[ -d ${DESTINATION} ]]; then
  rm -rf "${STAGED_RELEASE}"
else
  mv "${STAGED_RELEASE}" "${DESTINATION}"
fi
PREVIOUS_TARGET=$(readlink "${INSTALL_ROOT}/current" 2>/dev/null || true)
ln -sfn "${DESTINATION}" "${INSTALL_ROOT}/current"
ACTIVATED=1

DATA_ROOT="${SERVICE_HOME}/Library/Application Support/Rauhwpx Cloud"
install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${DATA_ROOT}" "${DATA_ROOT}/provider-auth" "${DATA_ROOT}/logs"
WORKER_IMAGE="localhost/rauhwpx-cloud-worker:${VERSION}"
as_user "${PODMAN}" --connection "${MACHINE}" build --tag "${WORKER_IMAGE}" \
  --file "${DESTINATION}/install/Containerfile.worker" "${DESTINATION}"
as_user "${PODMAN}" --connection "${MACHINE}" run --rm --read-only --network=none --pids-limit=64 \
  --entrypoint /app/bin/rhwp "${WORKER_IMAGE}" --version >/dev/null

ENV_FILE="${INSTALL_ROOT}/cloud.env"
if [[ -f ${ENV_FILE} ]]; then
  ENV_BACKUP="${TMP}/cloud.env.previous"
  cp "${ENV_FILE}" "${ENV_BACKUP}"
fi
umask 077
{
  printf 'RAUHWpx_CHANNEL=%q\n' "${CHANNEL}"
  printf 'RAUHWpx_SERVICE_USER=%q\n' "${SERVICE_USER}"
  printf 'RAUHWpx_DATA_DIR=%q\n' "${DATA_ROOT}"
  printf 'RAUHWpx_HOST=127.0.0.1\nRAUHWpx_PORT=7740\nRAUHWpx_BASE_PATH=%q\n' "${BASE_PATH}"
  printf 'RAUHWpx_PROVIDER_CLI_DIR=%q\n' "${DATA_ROOT}/provider-cli"
  printf 'RAUHWpx_WORKER_IMAGE=%q\n' "${WORKER_IMAGE}"
  printf 'RAUHWpx_PODMAN_CONNECTION=%q\n' "${MACHINE}"
  printf 'PATH=%q\n' "/opt/homebrew/bin:$(dirname "${NODE}"):/usr/local/bin:/usr/bin:/bin"
} >"${ENV_FILE}"
chmod 0600 "${ENV_FILE}"
chown "${SERVICE_USER}:${SERVICE_GROUP}" "${ENV_FILE}"

CLI_ENV=(env "RAUHWpx_DATA_DIR=${DATA_ROOT}" "RAUHWpx_PROVIDER_CLI_DIR=${DATA_ROOT}/provider-cli" \
  "RAUHWpx_WORKER_IMAGE=${WORKER_IMAGE}" "RAUHWpx_PODMAN_CONNECTION=${MACHINE}" \
  "PATH=/opt/homebrew/bin:$(dirname "${NODE}"):/usr/local/bin:/usr/bin:/bin")
sudo -u "${SERVICE_USER}" -H "${CLI_ENV[@]}" "${NODE}" "${DESTINATION}/src/cli.mjs" provider install claude >/dev/null
sudo -u "${SERVICE_USER}" -H "${CLI_ENV[@]}" "${NODE}" "${DESTINATION}/src/cli.mjs" provider install cursor >/dev/null

LAUNCHER="${INSTALL_ROOT}/service-wrapper"
install -m 0755 "${DESTINATION}/install/macos-service-wrapper" "${LAUNCHER}"
UPDATE_LAUNCHER="${INSTALL_ROOT}/update-wrapper"
install -m 0755 "${DESTINATION}/install/macos-update-wrapper" "${UPDATE_LAUNCHER}"
install -d -m 0755 /usr/local/bin
install -m 0755 "${DESTINATION}/install/macos-cli-wrapper" /usr/local/bin/rauhwpx-cloud
PLIST=/Library/LaunchDaemons/com.hataewook.rauhwpx-cloud.plist
sed -e "s|__SERVICE_USER__|${SERVICE_USER}|g" \
  -e "s|__SERVICE_HOME__|${SERVICE_HOME}|g" \
  -e "s|__LAUNCHER__|${LAUNCHER}|g" \
  "${DESTINATION}/install/com.hataewook.rauhwpx-cloud.plist" >"${PLIST}"
chown root:wheel "${PLIST}"
chmod 0644 "${PLIST}"
plutil -lint "${PLIST}" >/dev/null
launchctl bootout system/com.hataewook.rauhwpx-cloud >/dev/null 2>&1 || true
launchctl bootstrap system "${PLIST}"
launchctl enable system/com.hataewook.rauhwpx-cloud
launchctl kickstart -k system/com.hataewook.rauhwpx-cloud
UPDATE_PLIST=/Library/LaunchDaemons/com.hataewook.rauhwpx-cloud-update.plist
sed -e "s|__UPDATE_LAUNCHER__|${UPDATE_LAUNCHER}|g" \
  "${DESTINATION}/install/com.hataewook.rauhwpx-cloud-update.plist" >"${UPDATE_PLIST}"
chown root:wheel "${UPDATE_PLIST}"
chmod 0644 "${UPDATE_PLIST}"
plutil -lint "${UPDATE_PLIST}" >/dev/null
if ! launchctl print system/com.hataewook.rauhwpx-cloud-update >/dev/null 2>&1; then
  launchctl bootstrap system "${UPDATE_PLIST}"
  launchctl enable system/com.hataewook.rauhwpx-cloud-update
fi
for _ in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:7740/v1/health" >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent "http://127.0.0.1:7740/v1/health" >/dev/null || fail "launchd service health check failed"
ACTIVATED=0

PAIRING_JSON=$(sudo -u "${SERVICE_USER}" -H "${CLI_ENV[@]}" "${NODE}" "${DESTINATION}/src/cli.mjs" pairing create "Origin device")
SERVER_KEY=$("${NODE}" -e 'process.stdout.write(JSON.parse(process.argv[1]).serverPublicKey)' "${PAIRING_JSON}")
PAIRING_CODE=$("${NODE}" -e 'process.stdout.write(JSON.parse(process.argv[1]).code)' "${PAIRING_JSON}")
RECEIPT=$("${NODE}" -e '
  process.stdout.write(JSON.stringify({
    endpoint:"http://127.0.0.1:7740/rauhwpx-cloud",transport:"ssh-tunnel",
    serverPublicKey:process.argv[1],pairingCode:process.argv[2],serviceVersion:process.argv[3]
  }));
' "${SERVER_KEY}" "${PAIRING_CODE}" "${VERSION}")
printf 'RAUHWpx_RECEIPT=%s\n' "${RECEIPT}"
