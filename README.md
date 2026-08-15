# Rauhwpx

HWP/HWPX editor with a local Claude/Codex agent sidebar. The engine lives in `rhwp/`.

## Install

Pushing a `v*` tag that matches `package.json` builds installers on GitHub Actions and attaches them to a GitHub Release:

- macOS: arm64 DMG and ZIP, signed with a Developer ID certificate (same as Rautml)
- Windows: x64 NSIS installer (`Rauhwpx-<version>-x64.exe`), unsigned for now — SmartScreen shows a warning until we get a code-signing certificate

```bash
# package.json version is 0.1.1
git tag v0.1.1
git push origin v0.1.1
```

macOS signing uses the `macos-release` environment: `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`. Local Windows build: `npm run dist:win` (on Windows).

## Web development

```sh
cd rhwp/rhwp-studio && npm run dev   # http://127.0.0.1:7700
```

The Studio dev server owns an authenticated hub on an ephemeral port and stops it on exit. Separate worktrees therefore use separate hubs without port or process conflicts.

For standalone hub development, `npm start` uses `http://127.0.0.1:5175`, writes logs to `.run/rhwp-agent.log`, and returns after readiness. Use `npm stop` / `npm run status`; `npm run start:fg` keeps it in the foreground.
