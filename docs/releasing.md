# Desktop and cloud releases

Tagged releases publish signed and notarized macOS arm64 DMG/ZIP files, an unsigned Windows x64 NSIS installer, and Linux x64/arm64 AppImage and Debian packages. They also publish signed Linux amd64/arm64 cloud runtimes and cloud sandbox images. Nightly builds publish the macOS and Windows packages. Windows users can see SmartScreen warnings.

## Tagged release

Set the same release version in the root and `cloud/` package metadata before tagging:

- Update `package.json` and both version fields in `package-lock.json`.
- Update `cloud/package.json` and both version fields in `cloud/package-lock.json`.
- Set `RAILWAY_DEFAULT_IMAGE` in both `desktop/cloud-railway.mjs` and `rhwp/rau-credits/cloud-provisioner.mjs` to `ghcr.io/ghandhitechnology/rauhwpx-cloud:<version>`.

Run `node --test scripts/release-cloud-contracts.test.mjs tests/desktop-app-servers.test.mjs` and `npm run check:docs`, commit the changes, then push the matching `v<version>` tag. The workflow rejects mismatched tags, cloud metadata, or default image versions before building.

```sh
git tag "v$(node -p "require('./package.json').version")"
git push origin "v$(node -p "require('./package.json').version")"
```

[release.yml](../.github/workflows/release.yml) verifies the tagged source and publishes after all desktop and cloud builds succeed. The GitHub release contains installers, update metadata, SHA-256 checksums, signed cloud runtime archives and their bootstrap bundles. Each desktop package bundles both cloud runtime architectures for VPS setup.

Cloud builds push `<version>-amd64` and `<version>-arm64` image tags to GHCR. After tagged-source verification, the workflow combines those exact tags into the `<version>` and `stable` multi-architecture images. It also retains `stable-amd64` and `stable-arm64` aliases. Both manifests use versioned architecture tags so overlapping releases cannot mix their images. Desktop and hosted provisioning pin the versioned image; `RAUHWpx_RAILWAY_IMAGE` can override it.

## Nightly

[Nightly verification](../.github/workflows/nightly.yml) starts daily at 03:00 Asia/Seoul, `0 18 * * *` UTC, and also supports manual dispatch. Verification, packaging and publishing share one workflow and commit SHA. Publishing waits for successful verification and both platform packages. A manual run publishes only from `main`.

Each successful publication replaces the [nightly pre-release](https://github.com/ghandhitechnology/Rauhwpx/releases/tag/nightly) and moves its tag. The app version and artifact names use `<version>-nightly.<date>.<sha>`, where the date is UTC `YYYYMMDD` and the SHA is the first seven commit characters. The publication time depends on verification and build duration.

## Signing and package checks

Both channels use [.github/actions/package-desktop](../.github/actions/package-desktop/action.yml) for macOS and Windows setup, builds and verification. Tagged Linux releases build on native x64 and arm64 runners. macOS jobs use the `macos-release` environment and require these secrets:

- `MACOS_CERTIFICATE`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`

Missing secrets fail the macOS job. If the environment requires a reviewer, GitHub waits for that approval. Publishing requires both platforms, so a failed macOS job cannot produce a partial nightly.

Keep packaged runtime checks, artifact architecture checks, Developer ID verification and notarization validation when changing this workflow. npm production dependency audits block high and critical advisories. Nightly also reports lower-severity findings for maintenance review.

## Local builds

Complete [development setup](../CONTRIBUTING.md) first. On the target platform, `npm run dist:mac`, `npm run dist:win`, `npm run dist:linux:x64`, or `npm run dist:linux:arm64` builds and packages the app. The macOS command needs the signing credentials configured for electron-builder.

For repeated packaging with an existing build:

```sh
npm run build:desktop
npm run package:mac
npm run verify:package
```

Use `package:win` on Windows. Packaging does not reinstall dependencies or rebuild the engine. Rebuild after source changes; rerun `npm run setup` after dependency changes.

## Product and package versions

Desktop, Studio's About dialog, and extension viewer About dialogs display the product version from the root `package.json`. The cloud runtime package and default sandbox image must use that same release version. The PWA and extension names use Rauhwpx. Engine crates, extension manifests and published npm packages keep their own versions and identifiers. Those values control package compatibility and store updates; changing the product version does not automatically bump them. Historical `rhwp` paths and upstream attribution remain intact.
