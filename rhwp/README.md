# Rauhwpx engine and editor

This directory contains the Rust HWP/HWPX engine, the Studio web editor and the local agent hub. The product landing page is the [repository README](../README.md). Rauhwpx is a fork of [Edward Kim's rhwp](https://github.com/edwardkim/rhwp); the crate and directory names retain that history.

The engine parses, lays out, renders and edits documents. Studio runs the engine through WebAssembly. The native CLI supports document inspection, conversion and export. Real-document regressions live in `samples/` and `tests/`.

## Development

Follow the clean-checkout setup in [CONTRIBUTING.md](../CONTRIBUTING.md). It installs root, Studio and agent dependencies and builds the required WASM engine. Development requires Node 22.18 or newer, Rust via rustup and wasm-pack 0.15.0.

From the repository root, after setup:

```sh
npm run build:wasm
npm run dev:studio
```

Studio starts an authenticated hub automatically. See [rhwp-agent/README.md](rhwp-agent/README.md) for provider configuration, standalone hub work and tool details.

## Engine CLI

From this directory:

```sh
cargo run --bin rhwp -- info path/to/file.hwpx
```

`info`, `export-svg`, `export-png`, `export-pdf`, `export-text`, `export-markdown`, `export-tables`, `export-hwpx`, `export-hml`, `dump`, `search`, `convert`, and `edit` are the usual commands. PNG and PDF export are native only. Enable Skia with the `native-skia` feature.

## Tests

```sh
cargo test
cargo clippy
cargo fmt
```

Integration tests live in `tests/` and load fixtures from `samples/`.

## License

[MIT](LICENSE)
