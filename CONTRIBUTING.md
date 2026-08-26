# Contributing

Rauhwpx is an HWP/HWPX editor: a Rust engine compiled to WebAssembly, the `rhwp-studio` web editor, a local `rhwp-agent` hub for Claude/Codex/Pi, and an Electron desktop shell. It is a fork of [edwardkim/rhwp](https://github.com/edwardkim/rhwp).

Most of the code lives under `rhwp/`. The usual contributions are engine fidelity, editor behavior, the agent bridge, desktop packaging, or docs. Roundtrip fidelity is a core contract. Integration tests load real documents from `rhwp/samples/` (about 430 HWP/HWPX files).

## Local setup

You need:

- Rust via rustup. `rhwp/rust-toolchain.toml` pins 1.93.1 plus clippy, rustfmt, and `wasm32-unknown-unknown`.
- [wasm-pack](https://rustwasm.github.io/wasm-pack/) 0.15.0. CI installs it with `cargo install wasm-pack --version 0.15.0 --locked`.
- Node 20 or newer. `rhwp-agent` documents Node ≥ 20. GitHub Actions uses Node 22.

Studio loads the engine from `rhwp/pkg/` through Vite's `@wasm` alias, so build WASM before starting the editor.

```sh
cd rhwp && wasm-pack build --target web
cd rhwp-studio && npm install && npm run dev
```

Studio listens on http://127.0.0.1:7700. In this mode it starts its own authenticated hub on an ephemeral port, so parallel worktrees do not collide.

For a standalone hub on http://127.0.0.1:5175, from the repo root:

```sh
npm start          # detaches when /healthz is ready; logs to .run/rhwp-agent.log
npm run status
npm stop
npm run start:fg   # foreground
```

Once studio is up, `npm run dev:desktop` from the repo root attaches the Electron shell to that server.

Agent configuration and troubleshooting: [rhwp/rhwp-agent/README.md](rhwp/rhwp-agent/README.md).

## Tests, lint, and build

Run the checks that match what you changed. Full `cargo test` and every `e2e:*` script are large.

### Rust engine (`rhwp/`)

```sh
cargo test
cargo clippy
cargo fmt
```

One integration file or function:

```sh
cargo test --test issue_1234_some_name
cargo test --test issue_1234_some_name test_fn_name
```

Those tests live in `rhwp/tests/` and are mostly named `issue_NNNN_*` or `pr_NNNN_*`. Nightly CI runs `cargo test --locked --workspace`.

`Cargo.toml` allows many structural Clippy lints on purpose, pending a phased refactor. Do not clean those allows in an unrelated PR, and do not tighten the lint table without a dedicated tooling issue.

`rhwp/rustfmt.toml` uses `max_width = 100` and Unix newlines. Formatting policy changes belong in their own tooling issue.

WASM build (writes `rhwp/pkg/`):

```sh
wasm-pack build --target web
```

PDF and PNG export are native-only. The `native-skia` feature enables the Skia backend.

### Studio (`rhwp/rhwp-studio/`)

```sh
npm test          # Node test runner; also runs ../npm/editor/tests
npm run build     # generate:agent-edit-capabilities, then tsc, then Vite
```

There is no separate typecheck script. `npm run build` runs `tsc`.

E2E scripts are `npm run e2e:<name>` (puppeteer-core, often `--mode=headless`). Run the one that covers your change. `npm run e2e:manifest-check` checks the e2e manifest.

### Agent hub (`rhwp/rhwp-agent/`)

```sh
npm test
npm run typecheck
```

`typecheck` uses Studio's `tsc`. Install studio dependencies first.

### What CI actually runs

Every pull request, and every push to `main` or `feat/**`, runs [Desktop session checks](.github/workflows/desktop-sessions.yml): WASM build, `node --check` on the desktop and hub entry files, then `rhwp-agent` and `rhwp-studio` unit tests.

[Nightly verification](.github/workflows/nightly.yml) adds `cargo test --locked --workspace` and `npm run build` in studio.

Clippy, rustfmt, and the e2e suite are not in the PR workflow. Run them locally when you touch those areas.

## Pull requests

Open PRs against `main`. There is no issue or PR template in this repo.

Existing branches use `feat/` and `fix/` prefixes. Pushes to `feat/**` also run the desktop-session workflow. That is observed practice, not a written naming policy.

[AGENTS.md](AGENTS.md) is the PR description format used here: title, summary, problem, solution, diff overview, testing, risk and rollout, and visual evidence when the UI changed. Do not claim tests that were not run.

## Code style and agent notes

- Match the file you edit. Comments, commit messages, and CLI output in the engine are often Korean.
- Studio is TypeScript with no UI framework. [DESIGN.md](DESIGN.md) is the visual system. Change `--n-*` tokens instead of one-off CSS colors.
- Product language is Korean-first where studio already is. See [PRODUCT.md](PRODUCT.md).
- [CLAUDE.md](CLAUDE.md) has the command list and architecture map used by coding agents.

## License

[MIT](rhwp/LICENSE). 한글, 한컴, HWP, and HWPX are Hancom trademarks. This project is not affiliated with Hancom.
