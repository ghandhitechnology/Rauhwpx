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
npm start                            # hub in the background — terminal can close
cd rhwp/rhwp-studio && npm run dev   # http://127.0.0.1:7700
```

`npm start` waits until `http://127.0.0.1:5175/healthz` is ready, then returns. Logs go to `.run/rhwp-agent.log`. Use `npm stop` / `npm run status`. For a foreground hub that stays in the terminal: `npm run start:fg`.

Studio `npm run dev` will also start the hub if it is not already running.
