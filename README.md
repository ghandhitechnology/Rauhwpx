<p align="center">
  <img src="rhwp/assets/logo/logo-256.png" alt="Rauhwpx" width="112" />
</p>

<h1 align="center">Rauhwpx</h1>

<p align="center">
  English · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  An HWP/HWPX editor with an AI agent that edits the document you have open.<br />
  Rust and WebAssembly document engine, desktop app and web editor.
</p>

<p align="center">
  Rauhwpx is a fork of Edward Kim's <a href="https://github.com/edwardkim/rhwp">edwardkim/rhwp</a>.
</p>

<p align="center">
  <img src="rhwp/assets/screenshots/studio-agent-sidebar.png" alt="Rauhwpx editing a Korean research report while the agent writes the title fields" width="100%" />
</p>

## What this is

Rauhwpx opens and edits Korean HWP/HWPX documents. The Rust engine handles parsing, layout, rendering and editing; the agent sidebar connects supported AI providers to the open document through MCP tools.

Document editing runs on your machine. AI requests send prompts and any document content read by the agent to your selected provider. Web research and the optional Browserbase integration also use external services. The local agent hub manages provider sessions, permissions, downloads and tool routing.

## Editor

- HWPX is the default format for new documents. HWP 5.0, HWPX and HML support reading and writing; HWP3 is read-only. Opened `.hwp` files keep binary HWP on Save. The documents in `rhwp/samples/` provide round-trip and rendering regression coverage; compatibility varies by document and feature.
- Layout and rendering include pagination, 어울림 wrap, tables with page splitting, footnotes/endnotes, equations, shapes, charts and embedded objects, drawn to Canvas2D/CanvasKit in the browser and Skia natively.
- Editing includes character/paragraph/style dialogs, tables, list numbering, fields and forms, page setup, find/replace, document compare, revision history, undo throughout.
- Save the document and its complete revision graph as one cross-platform `.rhwpx` archive. Older folder bundles remain available through the separate legacy import command.
- Export to SVG, PNG, PDF, text, Markdown, table dumps, plus HWPX/HML conversion from the CLI.

## Agent sidebar

- MCP tools read document structure and apply edits, including batches of up to 32 semantic edits, document snapshots and downloadable generated artifacts. The engine capability catalog lists the operations available to the agent.
- Staged edits appear in the document. Safe mode holds successful edits for review; Full access commits them as one undo step. Failed turns roll staged edits back.
- Safe mode limits file and shell access to the project. Full access permits broader access.
- In planning mode, the agent can research with web, subagents and Browserbase while the document stays read-only, then presents a plan that only executes on your approval.
- Document reads return a revision; writes require the expected revision. Stale writes fail loudly instead of corrupting the document.

## Install

Download a build from [Releases](https://github.com/ghandhitechnology/Rauhwpx/releases): macOS arm64 DMG/ZIP and Windows x64 installer. macOS builds are signed. Windows builds are currently unsigned and can trigger SmartScreen warnings.

Windows installs per user by default. The installer detects an older all-users installation and requests elevation to upgrade it instead of creating a second copy.

Saving over an existing desktop file uses a crash-safe compare-and-swap and
requires hard-link support on that volume. FAT/exFAT, some SMB shares, and some
cloud-synced volumes may reject the save without changing the original; use a
local APFS or NTFS volume, or Save As to a supported destination. On Windows,
preserving the original file's access rules also requires the built-in
System32 Windows PowerShell. If both publication and rollback fail, Rauhwpx
keeps an openable recovery copy and reports its exact path.

Testers can download the current pre-release from the [nightly tag](https://github.com/ghandhitechnology/Rauhwpx/releases/tag/nightly).

You supply your own agent CLI. Claude, Codex and Pi can each be installed and signed in from **Settings → Connection** inside the app.

## Development

Install Node 22.18 or newer, Rust via rustup, and wasm-pack 0.15.0. From the repository root:

```sh
npm run setup
npm run build:wasm
npm run dev:studio
```

Open http://127.0.0.1:7700. Studio starts its own authenticated agent hub on an ephemeral port. To attach Electron to that dev server, run `npm run dev:desktop` in another terminal.

See [CONTRIBUTING.md](CONTRIBUTING.md) for native builds, focused tests and prerequisites. Maintainers can find signing and publishing instructions in [docs/releasing.md](docs/releasing.md).

## Layout

| Path | What |
| --- | --- |
| `rhwp/src/` | Rust engine. parser, model, document_core, renderer, serializer, wasm_api |
| `rhwp/rhwp-studio/` | Web editor (TypeScript, no framework) and the agent sidebar |
| `rhwp/rhwp-agent/` | Local WS hub bridging the agent CLIs to the open tab |
| `desktop/` | Electron shell. multi-window, per-window agent sessions |
| `rhwp/rhwp-{chrome,firefox,safari,vscode}/` | Browser and VS Code viewer extensions |
| `rhwp/npm/editor/` | Embeddable editor package |

## License

[MIT](rhwp/LICENSE). Independent project. 한글, 한컴, HWP and HWPX are Hancom trademarks, and this is not affiliated with or endorsed by Hancom.
