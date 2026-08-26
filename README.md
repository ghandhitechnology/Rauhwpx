<p align="center">
  <img src="rhwp/assets/logo/logo-256.png" alt="Rauhwpx" width="112" />
</p>

<h1 align="center">Rauhwpx</h1>

<p align="center">
  An HWP/HWPX editor with an AI agent that edits the document you have open.<br />
  Rust → WebAssembly engine, desktop app and web editor, everything local.
</p>

<p align="center">
  Rauhwpx is a fork of Edward Kim's <a href="https://github.com/edwardkim/rhwp">edwardkim/rhwp</a>.
</p>

<p align="center">
  <img src="rhwp/assets/screenshots/studio-agent-sidebar.png" alt="Rauhwpx editing a Korean research report while the agent writes the title fields" width="100%" />
</p>

## What this is

Korean office work runs on HWP/HWPX, and no AI tool can actually open those files and work inside them. Rauhwpx is a real HWP editor — parsing, layout, rendering and editing all written in Rust and compiled to WASM — with a Claude, Codex or Pi CLI wired directly into the open document through MCP.

The agent reads structure, text ranges, tables, fields and rendered pages, then makes edits you can see and undo. Nothing leaves the machine: the document lives in the browser engine, and the agent hub is a localhost router with no document logic.

## Editor

- **Formats** — HWPX is the default save/export format for new work. HWP 5.0, HWPX and HML read/write, HWP3 read; opened `.hwp` files keep binary HWP on Save. Roundtrip fidelity is a core contract, backed by ~430 real documents in `rhwp/samples/`.
- **Layout and rendering** — full pagination, 어울림 wrap, tables with page splitting, footnotes/endnotes, equations, shapes, charts and embedded objects, drawn to Canvas2D/CanvasKit in the browser and Skia natively.
- **Editing** — character/paragraph/style dialogs, tables, list numbering, fields and forms, page setup, find/replace, document compare, revision history, undo throughout.
- **Export** — SVG, PNG, PDF, text, Markdown, table dumps, plus HWPX/HML conversion from the CLI.

## Agent sidebar

- **69 MCP tools** — semantic reads and writes for the common work, a batched write that applies up to 32 edits in one atomic call, path-independent live-document snapshots and downloadable generated artifacts, plus registry-generated engine batches that cover every classified mutation, so the agent is never blocked on a capability the editor has.
- **Live staged edits** — changes render in place as you watch, commit as one undo step when the turn succeeds, and restore the exact prior snapshot when it fails.
- **Two permission modes** — 안전 keeps edits behind review and files inside the project; 전체 lets the agent work uninterrupted.
- **Planning before implementation** — the agent can research with web, subagents and Browserbase while the document stays read-only, then presents a plan that only executes on your approval.
- **Revision contract** — every read returns a revision, every write requires it. Stale writes fail loudly instead of corrupting the document.

## Install

Download a build from [Releases](https://github.com/ghandhitechnology/Rauhwpx/releases): macOS arm64 DMG/ZIP (signed), Windows x64 installer (unsigned for now — SmartScreen warns until we get a certificate).

Testers can download the current pre-release from the [nightly tag](https://github.com/ghandhitechnology/Rauhwpx/releases/tag/nightly).

You supply your own agent CLI. Claude, Codex and Pi can each be installed and signed in from **Settings → Connection** inside the app.

## Development

```sh
cd rhwp && wasm-pack build --target web    # build the engine
cd rhwp-studio && npm install && npm run dev
```

Studio runs at http://127.0.0.1:7700 and owns its own authenticated hub on an ephemeral port, so parallel worktrees never collide. `npm run dev:desktop` from the repo root attaches the Electron shell to that dev server.

For standalone hub work, `npm start` from the root runs it on http://127.0.0.1:5175, logs to `.run/rhwp-agent.log` and returns once ready — `npm stop`, `npm run status`, `npm run start:fg`.

Rust: `cargo test`, `cargo clippy`, `cargo fmt`. Studio: `npm test`, `npm run build`, `npm run e2e:*`.

## 기여하기

[CONTRIBUTING.md](CONTRIBUTING.md)에서 로컬 설정, PR 전에 실행할 검사, [AGENTS.md](AGENTS.md)의 설명 형식을 확인하세요.

## Releasing

Push a `v*` tag matching `package.json` and GitHub Actions builds and attaches the installers.

```bash
git tag v0.1.11
git push origin v0.1.11
```

macOS signing uses the `macos-release` environment: `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`. Local Windows build: `npm run dist:win` on Windows.

### Nightly

GitHub Actions builds nightly desktop installers at 05:00 UTC. Run it manually from **Actions → Nightly desktop release**. A manual run publishes only from `main`.

Testers download the current build from the [nightly pre-release](https://github.com/ghandhitechnology/Rauhwpx/releases/tag/nightly). Each successful run replaces that pre-release and moves the `nightly` tag.

The workflow builds signed and notarized macOS arm64 DMG and ZIP installers. It also builds an unsigned Windows x64 NSIS installer, matching tagged releases. There is no Linux desktop nightly.

`.github/workflows/nightly.yml` remains the Linux engine and Studio verification workflow. It does not publish installers.

macOS uses the same `macos-release` environment as tagged releases. The required secrets are `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_SPECIFIC_PASSWORD`. If any secret is missing, the macOS job fails and GitHub does not publish a partial nightly. If `macos-release` requires a reviewer, the scheduled run waits for approval.

The nightly app version and artifact names use `<version>-nightly.<date>.<sha>`. `<date>` is the UTC `YYYYMMDD` date, and `<sha>` is the first seven commit SHA characters.

## Layout

| Path | What |
| --- | --- |
| `rhwp/src/` | Rust engine — parser, model, document_core, renderer, serializer, wasm_api |
| `rhwp/rhwp-studio/` | Web editor (TypeScript, no framework) and the agent sidebar |
| `rhwp/rhwp-agent/` | Local WS hub bridging the agent CLIs to the open tab |
| `desktop/` | Electron shell — multi-window, per-window agent sessions |
| `rhwp/rhwp-{chrome,firefox,safari,vscode}/` | Browser and VS Code viewer extensions |
| `rhwp/npm/editor/` | Embeddable editor package |

## License

[MIT](rhwp/LICENSE). Independent project — 한글, 한컴, HWP and HWPX are Hancom trademarks, and this is not affiliated with or endorsed by Hancom.
