import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { RAILWAY_DEFAULT_IMAGE } from '../desktop/cloud-railway.mjs';
import { RAILWAY_DEFAULT_IMAGE as HOSTED_RAILWAY_DEFAULT_IMAGE } from '../rhwp/rau-credits/cloud-provisioner.mjs';

const release = yaml.load(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));

test('desktop, cloud runtime metadata and default sandbox image use one release version', () => {
  const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const version = read('../package.json').version;
  const cloud = read('../cloud/package.json');
  const lock = read('../cloud/package-lock.json');
  assert.equal(cloud.version, version);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.equal(RAILWAY_DEFAULT_IMAGE, `ghcr.io/ghandhitechnology/rauhwpx-cloud:${version}`);
  assert.equal(HOSTED_RAILWAY_DEFAULT_IMAGE, RAILWAY_DEFAULT_IMAGE);
});

test('every desktop release bundles both cloud runtimes before packaging', () => {
  for (const platform of ['macos', 'windows', 'linux']) {
    const job = release.jobs[platform];
    assert.ok(job.needs.includes('cloud'), `${platform} requires completed cloud artifacts`);
    const downloadIndex = job.steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@'));
    const buildIndex = job.steps.findIndex((step) => step.uses === './.github/actions/package-desktop'
      || step.run?.includes('npm run dist:linux:'));
    assert.ok(downloadIndex >= 0 && buildIndex > downloadIndex, `${platform} downloads runtimes before packaging`);
    assert.deepEqual(job.steps[downloadIndex].with, {
      pattern: 'cloud-dist-*', path: 'cloud/release', 'merge-multiple': true,
    });
  }
  for (const platform of ['macos', 'windows']) {
    const job = release.jobs[platform];
    assert.equal(job.steps.filter((step) => step.uses === './.github/actions/package-desktop').length, 1);
    assert.equal(job.steps.some((step) => /npm run (?:build:desktop|dist:)/.test(step.run ?? '')), false);
  }
});

test('cloud release preserves architecture artifacts, signing and sandbox smoke checks', () => {
  const cloud = release.jobs.cloud;
  assert.deepEqual(cloud.strategy.matrix.include.map((entry) => entry.asset_arch).sort(), ['amd64', 'arm64']);
  const upload = cloud.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name, 'cloud-dist-${{ matrix.asset_arch }}');
  for (const asset of [
    'rauhwpx-cloud-linux-${{ matrix.asset_arch }}.tar.gz',
    'rauhwpx-cloud-linux-${{ matrix.asset_arch }}.tar.gz.sha256',
    'rauhwpx-cloud-linux-${{ matrix.asset_arch }}.tar.gz.sigstore.json',
    'rauhwpx-cloud-bootstrap-linux-${{ matrix.asset_arch }}.tar.gz',
  ]) assert.ok(upload.with.path.includes(asset), asset);
  const commands = cloud.steps.map((step) => step.run ?? '').join('\n');
  assert.match(commands, /cosign verify-blob/);
  assert.match(commands, /Containerfile\.worker/);
  assert.match(commands, /Containerfile\.sandbox/);
  assert.match(commands, /document-runtime\/smoke\.mjs/);
});

test('stable cloud manifest and GitHub Release wait for tagged-source verification', () => {
  assert.ok(release.jobs['cloud-image'].needs.includes('verification'));
  assert.ok(release.jobs['cloud-image'].needs.includes('cloud'));
  for (const dependency of ['verification', 'macos', 'windows', 'linux', 'cloud', 'cloud-image']) {
    assert.ok(release.jobs.publish.needs.includes(dependency), dependency);
  }
  const publication = release.jobs.publish.steps.map((step) => step.run ?? '').join('\n');
  for (const pattern of ['release/*.tar.gz', 'release/*.AppImage', 'release/*.deb', 'release/*.tar.gz.sigstore.json']) {
    assert.ok(publication.includes(pattern), pattern);
  }
});

test('versioned and stable sandbox manifests consume only this release architecture tags', () => {
  const architecture = release.jobs.cloud.steps.find((step) => step.run?.includes('podman push')).run;
  const manifest = release.jobs['cloud-image'].steps.find((step) => step.run?.includes('podman manifest')).run;
  for (const script of [architecture, manifest]) {
    assert.ok(script.includes('release_version="${GITHUB_REF_NAME#v}"'), 'derive the image version from the release tag');
  }
  assert.ok(architecture.includes('podman tag rauhwpx-cloud-sandbox-release "$image:$release_version-$ASSET_ARCH"'));
  assert.ok(architecture.includes('podman push "$image:$release_version-$ASSET_ARCH"'));
  assert.equal(architecture.indexOf('podman push "$image:$release_version-$ASSET_ARCH"')
    < architecture.indexOf('podman push "$image:stable-$ASSET_ARCH"'), true);
  const inputs = [...manifest.matchAll(/podman manifest add "[^"]+" "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(inputs.sort(), [
    'docker://$image:$release_version-amd64',
    'docker://$image:$release_version-arm64',
  ]);
  assert.ok(manifest.includes('podman manifest push --all "$image:$release_version" "docker://$image:$release_version"'));
  assert.ok(manifest.includes('podman manifest push --all "$image:$release_version" "docker://$image:stable"'));
});
