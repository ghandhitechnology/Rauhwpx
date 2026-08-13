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
npm start                            # hub in the background — terminal can close
cd rhwp/rhwp-studio && npm run dev   # http://127.0.0.1:7700
```

`npm start` waits until `http://127.0.0.1:5175/healthz` is ready, then returns. Logs go to `.run/rhwp-agent.log`. Use `npm stop` / `npm run status`. For a foreground hub that stays in the terminal: `npm run start:fg`.

Studio `npm run dev` will also start the hub if it is not already running.
