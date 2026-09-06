import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('installer is streamable, channel-aware, preserves Serve routes, and emits pairing receipt', async () => {
  const filename = path.join(root, 'install/install.sh');
  const source = await fs.readFile(filename, 'utf8');
  assert.ok(Buffer.byteLength(source) < 2 * 1024 * 1024);
  assert.match(source, /RAUHWpx_CHANNEL/);
  assert.match(source, /apt-get install[^\n]*\bpodman\b[^\n]*\bcrun\b/);
  assert.match(source, /releases\?per_page=30/);
  assert.doesNotMatch(source, /releases\/download\/cloud-prerelease/);
  assert.doesNotMatch(source, /releases\/latest\/download\/\$\{ASSET\}/);
  assert.match(source, /!item\.prerelease && !item\.draft && item\.assets\?\.some\(\(asset\)=>asset\.name===name\)/);
  assert.match(source, /no compatible stable cloud asset was found/);
  assert.match(source, /RAUHWpx_RECEIPT=/);
  assert.match(source, /pairingCode/);
  assert.match(source, /RAUHWpx_TAILSCALE_HTTPS_PORT/);
  assert.match(source, /TAILSCALE_HTTPS_PORT must be an integer from 1 to 65535/);
  assert.match(source, /tailscale serve --bg --yes --https="\$TAILSCALE_HTTPS_PORT" --set-path=/);
  assert.match(source, /TAILSCALE_PORT_SUFFIX/);
  assert.match(source, /tailscaleHttpsPort=Number/);
  assert.match(source, /RAUHWpx_TRANSPORT/);
  assert.match(source, /RAUHWpx_PUBLIC_HOST/);
  assert.match(source, /public-https/);
  assert.match(source, /caddy validate/);
  assert.doesNotMatch(source, /tailscale serve reset/);
  assert.match(source, /install -d -m 0755 -o rauhwpx-cloud -g rauhwpx-cloud \/opt\/rauhwpx-cloud\/provider-cli/);
  assert.match(source, /\/usr\/local\/lib\/rauhwpx-cloud\/current/);
  assert.match(source, /release CLI compatibility wrapper is missing/);
  assert.match(source, /chmod -R a\+rX "\$DESTINATION"/);
  assert.match(source, /XDG_RUNTIME_DIR=\/run\/rauhwpx-cloud/);
  assert.match(source, /cd \/var\/lib\/rauhwpx-cloud\s+\/usr\/sbin\/runuser --user rauhwpx-cloud/);
  assert.match(source, /podman --cgroup-manager=cgroupfs build --tag/);
  assert.match(source, /podman --cgroup-manager=cgroupfs run --rm[\s\S]*--uidmap 0:1:1000[\s\S]*--gidmap 1000:0:1[\s\S]*--entrypoint \/app\/bin\/rhwp/);
  assert.doesNotMatch(source, /(^|\s)(?:exec\s+)?runuser\s+--user/m);
  assert.match(source, /provider install claude/);
  assert.match(source, /provider install cursor/);
  assert.doesNotMatch(source, /for provider in claude codex pi grok cursor/);
  assert.ok(source.includes('github\\.com/ghandhitechnology/Rauhwpx/\\.github/workflows/release\\.yml@refs/tags/'));
  assert.doesNotMatch(source, /refs\/\(heads\|tags\)/);
  assert.match(source, /Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
  assert.match(source, /X-Content-Type-Options "nosniff"/);
  const syntax = spawnSync('/bin/bash', ['-n', filename], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const update = await fs.readFile(path.join(root, 'install/update.sh'), 'utf8');
  assert.match(update, /releases\?per_page=30/);
  assert.doesNotMatch(update, /releases\/latest\/download\/\$\{ASSET\}/);
  assert.match(update, /!item\.prerelease && !item\.draft && item\.assets\?\.some\(\(asset\)=>asset\.name===name\)/);
  assert.match(update, /no compatible stable cloud asset was found/);
  assert.match(update, /trap rollback ERR/);
  assert.match(update, /environment\.previous/);
  assert.match(update, /No newer Rauhwpx cloud release was found/);
  assert.match(update, /cd \/var\/lib\/rauhwpx-cloud\s+\/usr\/sbin\/runuser --user rauhwpx-cloud/);
  assert.match(update, /podman --cgroup-manager=cgroupfs build --tag/);
  assert.match(update, /podman --cgroup-manager=cgroupfs run --rm[\s\S]*--uidmap 0:1:1000[\s\S]*--gidmap 1000:0:1[\s\S]*--entrypoint \/app\/bin\/rhwp/);
  assert.match(update, /chmod -R a\+rX "\$DESTINATION"/);
  assert.doesNotMatch(update, /(^|\s)(?:exec\s+)?runuser\s+--user/m);
  assert.ok(update.includes('github\\.com/ghandhitechnology/Rauhwpx/\\.github/workflows/release\\.yml@refs/tags/'));
  assert.doesNotMatch(update, /refs\/\(heads\|tags\)/);
  const wrapper = await fs.readFile(path.join(root, 'install/rauhwpx-cloud'), 'utf8');
  assert.match(wrapper, /cd \/var\/lib\/rauhwpx-cloud\s+exec \/usr\/sbin\/runuser --user rauhwpx-cloud/);
  assert.doesNotMatch(wrapper, /(^|\s)(?:exec\s+)?runuser\s+--user/m);
  const providerPath = '/opt/rauhwpx-cloud/provider-cli/current/node_modules/.bin';
  assert.match(source, new RegExp(providerPath.replaceAll('/', '\\/')));
  assert.match(update, new RegExp(providerPath.replaceAll('/', '\\/')));
  const providerCli = await fs.readFile(path.join(root, 'src/provider-cli.mjs'), 'utf8');
  assert.match(providerCli, /currentLink = path\.join\(destination, 'current'\)/);
  assert.match(providerCli, /await rename\(nextLink, currentLink\)/);
  const updateSyntax = spawnSync('/bin/bash', ['-n', path.join(root, 'install/update.sh')], { encoding: 'utf8' });
  assert.equal(updateSyntax.status, 0, updateSyntax.stderr);
});

test('service and Podman assets keep the trust boundaries explicit', async () => {
  const service = await fs.readFile(path.join(root, 'install/rauhwpx-cloud.service'), 'utf8');
  const updateService = await fs.readFile(path.join(root, 'install/rauhwpx-cloud-update.service'), 'utf8');
  const runner = await fs.readFile(path.join(root, 'src/podman-runner.mjs'), 'utf8');
  assert.match(service, /User=rauhwpx-cloud/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /NoNewPrivileges=no/);
  assert.match(service, /ProtectKernelTunables=no/);
  assert.match(service, /ProtectKernelModules=yes/);
  assert.match(service, /ProtectControlGroups=yes/);
  assert.match(updateService, /Wants=network-online.target/);
  assert.match(updateService, /After=network-online.target rauhwpx-cloud.service/);
  assert.doesNotMatch(runner, /--network=host/);
  assert.match(runner, /--security-opt=no-new-privileges/);
  assert.match(runner, /--cap-drop=all/);
  assert.match(runner, /--read-only/);
  assert.match(runner, /\/workspace:rw,size=\$\{this\.config\.workspaceBytes\},mode=1777/);
  assert.match(runner, /\/tmp:rw,size=268435456,mode=1777/);
  assert.doesNotMatch(runner, /mode=1777,(?:uid|gid)=/);
  assert.match(runner, /createHash\('sha256'\)\.update\(session\.id\)/);
  assert.doesNotMatch(runner, /slice\(0, 48\)/);
  assert.match(runner, /'--env', 'RAUHWpx_WORKER_TOKEN'/);
  assert.doesNotMatch(runner, /RAUHWpx_WORKER_TOKEN=\$\{workerToken\}/);
  assert.match(runner, /env: \{ \.\.\.process\.env, RAUHWpx_WORKER_TOKEN: workerToken \}/);
  const worker = await fs.readFile(path.join(root, 'worker/main.mjs'), 'utf8');
  assert.match(worker, /process\.umask\(0o077\)/);
  assert.match(worker, /lease\?\.mustStop === true/);
  assert.match(runner, /path\.dirname\(endpoint\.socketPath\).*\/run\/rauhwpx:ro,Z/);
  assert.match(runner, /RAUHWpx_CONTROL_URL/);
});

test('macOS installer uses launchd, a dedicated Podman machine, and verified releases', async () => {
  const installer = await fs.readFile(path.join(root, 'install/install-macos.sh'), 'utf8');
  const wrapper = await fs.readFile(path.join(root, 'install/macos-service-wrapper'), 'utf8');
  const plist = await fs.readFile(path.join(root, 'install/com.hataewook.rauhwpx-cloud.plist'), 'utf8');
  const updater = await fs.readFile(path.join(root, 'install/macos-update-wrapper'), 'utf8');
  const cliWrapper = await fs.readFile(path.join(root, 'install/macos-cli-wrapper'), 'utf8');
  assert.match(installer, /macOS 14 or newer/);
  assert.match(installer, /Apple silicon/);
  assert.match(installer, /\/opt\/homebrew/);
  assert.match(installer, /MACHINE=rauhwpx-cloud/);
  assert.match(installer, /OTHER_RUNNING/);
  assert.match(installer, /--connection "\$\{MACHINE\}"/);
  assert.match(installer, /cosign.*verify-blob/s);
  assert.match(installer, /launchctl bootstrap system/);
  assert.match(installer, /trap rollback ERR/);
  assert.match(installer, /another Cloud install or update is already running/);
  assert.match(installer, /chown "\$\{SERVICE_USER\}:\$\{SERVICE_GROUP\}" "\$\{ENV_FILE\}"/);
  assert.match(installer, /transport:"ssh-tunnel"/);
  assert.match(wrapper, /podman.*machine start/s);
  assert.match(wrapper, /exec "\$\{NODE\}".*src\/main\.mjs/);
  assert.match(plist, /<key>RunAtLoad<\/key>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
  assert.match(updater, /localeCompare\(current/);
  assert.match(updater, /RAUHWpx_RELEASE_URL/);
  assert.match(cliWrapper, /RAUHWpx_PODMAN_CONNECTION/);
  assert.match(cliWrapper, /sudo -u "\$\{RAUHWpx_SERVICE_USER\}"/);
  for (const filename of ['install-macos.sh', 'macos-service-wrapper', 'macos-update-wrapper', 'macos-cli-wrapper']) {
    const syntax = spawnSync('/bin/bash', ['-n', path.join(root, 'install', filename)], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  if (existsSync('/usr/bin/plutil')) {
    const lint = spawnSync('/usr/bin/plutil', ['-lint', path.join(root, 'install/com.hataewook.rauhwpx-cloud.plist')], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stderr);
    const updateLint = spawnSync('/usr/bin/plutil', ['-lint', path.join(root, 'install/com.hataewook.rauhwpx-cloud-update.plist')], { encoding: 'utf8' });
    assert.equal(updateLint.status, 0, updateLint.stderr);
  }
});

test('all provider installers are allowlisted and version-pinned', async () => {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'install/providers.lock.json'), 'utf8'));
  const runtimePackage = JSON.parse(await fs.readFile(path.join(root, 'install/provider-runtime/package.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock).sort(), ['claude', 'codex', 'cursor', 'grok', 'pi']);
  for (const [provider, item] of Object.entries(lock)) {
    assert.ok(['npm', 'archive'].includes(item.kind), provider);
    if (item.kind === 'npm') assert.match(item.version, /^\d+\.\d+\.\d+$/, provider);
    if (item.kind === 'archive') {
      assert.match(item.version, /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]+$/, provider);
      assert.deepEqual(Object.keys(item.urls).sort(), ['arm64', 'x64']);
      for (const architecture of ['arm64', 'x64']) {
        assert.match(item.urls[architecture], /^https:\/\/downloads\.cursor\.com\/lab\//);
        assert.match(item.sha256[architecture], /^[a-f0-9]{64}$/);
      }
    }
  }
  const npmProviders = Object.values(lock).filter((item) => item.kind === 'npm');
  assert.deepEqual(
    Object.fromEntries(npmProviders.map((item) => [item.package, item.version])),
    runtimePackage.dependencies,
  );
  const providerCli = await fs.readFile(path.join(root, 'src/provider-cli.mjs'), 'utf8');
  assert.match(providerCli, /run\('npm', \[\s*'ci'/);
  assert.doesNotMatch(providerCli, /'ci'[^\]]*--ignore-scripts/s);
  assert.doesNotMatch(providerCli, /run\('npm', \[\s*'install'/);
});

test('worker image packages the real Studio, agent hub, Chromium, and locked runtimes', async () => {
  const containerfile = await fs.readFile(path.join(root, 'install/Containerfile.worker'), 'utf8');
  const release = await fs.readFile(path.join(root, 'install/package-release.sh'), 'utf8');
  const buildAssets = await fs.readFile(path.join(root, 'install/build-runtime-assets.sh'), 'utf8');
  assert.match(containerfile, /^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}/m);
  assert.match(containerfile, /chromium="\$CHROMIUM_VERSION"/);
  assert.match(containerfile, /\bxvfb\b/);
  assert.match(containerfile, /\bxauth\b/);
  assert.match(containerfile, /\bx11-utils\b/);
  assert.match(containerfile, /\bx11-apps\b/);
  assert.match(containerfile, /matchbox-window-manager/);
  assert.match(containerfile, /COPY install\/provider-runtime\/package\.json install\/provider-runtime\/package-lock\.json/);
  assert.match(containerfile, /npm ci --omit=dev/);
  assert.match(containerfile, /COPY runtime-assets\/studio \/app\/studio/);
  assert.match(containerfile, /COPY runtime-assets\/rhwp-agent \/app\/rhwp-agent/);
  assert.match(containerfile, /COPY runtime-assets\/bin\/rhwp \/app\/bin\/rhwp/);
  assert.match(containerfile, /RHWP_BIN=\/app\/bin\/rhwp/);
  assert.match(containerfile, /\/app\/bin\/rhwp --version/);
  assert.doesNotMatch(containerfile, /npm install --global|curl[^\n]*cursor/);
  assert.match(release, /"\$ROOT\/runtime-assets"/);
  assert.match(release, /"\$ROOT\/package-lock\.json"/);
  assert.match(release, /chmod -R a\+rX "\$STAGING\/rauhwpx-cloud-\$VERSION"/);
  assert.match(release, /Cloud release assets require a native Linux builder/);
  assert.match(release, /does not match native builder/);
  assert.match(release, /rauhwpx-cloud-bootstrap-linux-\$\{ASSET_ARCH\}\.tar\.gz/);
  assert.match(release, /"\$ROOT\/install\/install\.sh"/);
  assert.match(buildAssets, /VITE_RHWP_CLOUD_RUNTIME=1/);
  assert.match(buildAssets, /rauhwpxCloudRuntime/);
  assert.match(buildAssets, /target\/release\/rhwp/);
  assert.match(buildAssets, /normalize-runtime-assets\.mjs/);
  assert.match(release, /normalize-runtime-assets\.mjs/);
  const workflow = await fs.readFile(path.resolve(root, '../.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /Build native reference extractor[\s\S]*cargo build --release --locked --bin rhwp[\s\S]*Build dedicated headless Studio runtime/);
  const syntax = spawnSync('/bin/bash', ['-n', path.join(root, 'install/build-runtime-assets.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const releaseSyntax = spawnSync('/bin/bash', ['-n', path.join(root, 'install/package-release.sh')], { encoding: 'utf8' });
  assert.equal(releaseSyntax.status, 0, releaseSyntax.stderr);
});

test('worker runtime images pin ffmpeg, probe x11grab, and expose no display port', async () => {
  const ffmpegVersions = [];
  for (const filename of ['Containerfile.worker', 'Containerfile.sandbox']) {
    const containerfile = await fs.readFile(path.join(root, 'install', filename), 'utf8');
    assert.match(containerfile, /ARG FFMPEG_VERSION=\S+/, filename);
    ffmpegVersions.push(containerfile.match(/ARG FFMPEG_VERSION=(\S+)/)?.[1]);
    assert.match(containerfile, /ffmpeg="\$FFMPEG_VERSION"/, filename);
    assert.match(containerfile, /ffmpeg -hide_banner -devices 2>&1 \| grep -q 'x11grab'/, filename);
    assert.doesNotMatch(containerfile, /EXPOSE\s+(?:59\d\d|60\d\d|3389)\b/, filename);
  }
  assert.equal(new Set(ffmpegVersions).size, 1, 'worker runtime images must pin the same ffmpeg build');
  const publisher = await fs.readFile(path.join(root, 'document-runtime/session-frame-publisher.mjs'), 'utf8');
  assert.doesNotMatch(publisher, /\.\.\/src\//, 'dedicated worker image does not package control-plane src');
});
