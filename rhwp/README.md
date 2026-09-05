# Rauhwpx engine and editor

This directory contains the Rust HWP/HWPX engine, the Studio web editor and the local agent hub. Rauhwpx is a fork of [Edward Kim's rhwp](https://github.com/edwardkim/rhwp); the crate and directory names retain that history.

The engine parses, lays out, renders and edits documents. Studio runs the engine through WebAssembly. The native CLI supports document inspection, conversion and export. Real-document regressions live in `samples/` and `tests/`.

The agent sidebar uses MCP tools to read and edit the open document. Editing runs locally; AI requests send prompts and the content the agent reads to the selected provider. The Node hub owns provider sessions, permissions, workflow state, downloads and tool routing. Browserbase is an optional external browser service.

## Development

Follow the clean-checkout setup in [CONTRIBUTING.md](../CONTRIBUTING.md). It installs root, Studio and agent dependencies and builds the required WASM engine. Development requires Node 22.18 or newer, Rust via rustup and wasm-pack 0.15.0.

From the repository root, after setup:

```sh
npm run build:wasm
npm run dev:studio
```

Studio starts an authenticated hub automatically. See [rhwp-agent/README.md](rhwp-agent/README.md) for provider configuration, standalone hub work and tool details.

## License

[MIT](LICENSE)
