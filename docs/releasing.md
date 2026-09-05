# Desktop releases

Tagged releases and nightly builds publish signed and notarized macOS arm64 DMG/ZIP files and an unsigned Windows x64 NSIS installer. Windows users can see SmartScreen warnings. The workflows do not publish Linux installers.

## Tagged release

Set the product version in the root `package.json` and its lockfile, then push the matching `v<version>` tag. The workflow rejects a tag that differs from the package version.

```sh
git tag "v$(node -p "require('./package.json').version")"
git push origin "v$(node -p "require('./package.json').version")"
```

[release.yml](../.github/workflows/release.yml) verifies the tagged source, builds both platforms and publishes only after verification and packaging succeed. It attaches installers, update metadata and SHA-256 checksums to the GitHub release.

## Nightly

[Nightly verification](../.github/workflows/nightly.yml) starts daily at 03:00 Asia/Seoul, `0 18 * * *` UTC, and also supports manual dispatch. Verification, packaging and publishing share one workflow and commit SHA. Publishing waits for successful verification and both platform packages. A manual run publishes only from `main`.

Each successful publication replaces the [nightly pre-release](https://github.com/ghandhitechnology/Rauhwpx/releases/tag/nightly) and moves its tag. The app version and artifact names use `<version>-nightly.<date>.<sha>`, where the date is UTC `YYYYMMDD` and the SHA is the first seven commit characters. The publication time depends on verification and build duration.

## Signing and package checks

Both channels use [.github/actions/package-desktop](../.github/actions/package-desktop/action.yml) for platform setup, builds and verification. macOS jobs use the `macos-release` environment and require these secrets:

- `MACOS_CERTIFICATE`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`

Missing secrets fail the macOS job. If the environment requires a reviewer, GitHub waits for that approval. Publishing requires both platforms, so a failed macOS job cannot produce a partial nightly.

Keep packaged runtime checks, artifact architecture checks, Developer ID verification and notarization validation when changing this workflow. npm production dependency audits block high and critical advisories. Nightly also reports lower-severity findings for maintenance review.

## Local builds

Complete [development setup](../CONTRIBUTING.md) first. On the target platform, `npm run dist:mac` or `npm run dist:win` builds and packages the app. The macOS command needs the signing credentials configured for electron-builder.

For repeated packaging with an existing build:

```sh
npm run build:desktop
npm run package:mac
npm run verify:package
```

Use `package:win` on Windows. Packaging does not reinstall dependencies or rebuild the engine. Rebuild after source changes; rerun `npm run setup` after dependency changes.

## Product and package versions

Desktop, Studio's About dialog, and extension viewer About dialogs display the product version from the root `package.json`. The PWA and extension names use Rauhwpx. Engine crates, extension manifests and published npm packages keep their own versions and identifiers. Those values control package compatibility and store updates; changing the product version does not automatically bump them. Historical `rhwp` paths and upstream attribution remain intact.
