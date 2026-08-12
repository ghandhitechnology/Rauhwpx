# Rauhwpx

HWP/HWPX editor with a local Claude/Codex agent sidebar. The engine lives in `rhwp/`.

## macOS install

Release builds are signed with a Developer ID certificate, same as Rautml.
Pushing a `v*` tag that matches `package.json` builds an arm64 DMG and ZIP on GitHub Actions and attaches them to a GitHub Release.

```bash
# package.json version is 0.1.1
git tag v0.1.1
git push origin v0.1.1
```

Signing uses the `macos-release` environment: `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`. Add `APPLE_APP_SPECIFIC_PASSWORD` later if you want notarization as well.

## Web development

```sh
cd rhwp/rhwp-agent && npm start
cd rhwp/rhwp-studio && npm run dev   # http://127.0.0.1:7700
```
