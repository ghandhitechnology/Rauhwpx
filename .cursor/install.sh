#!/usr/bin/env bash
set -euo pipefail

rauhwpx_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$rauhwpx_repo_root"

node <<'NODE'
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 7)) {
  throw new Error(`Cloud development requires Node.js 24.7.0 or newer; found ${process.version}`);
}
NODE

rustc +1.93.1 --version
rustup target list --installed --toolchain 1.93.1 | grep -Fxq wasm32-unknown-unknown
test "$(wasm-pack --version)" = "wasm-pack 0.15.0"

npm ci --no-audit --no-fund
npm --prefix cloud ci --no-audit --no-fund
npm --prefix cloud/install/provider-runtime ci --no-audit --no-fund
npm --prefix rhwp/rau-credits ci --no-audit --no-fund
npm --prefix rhwp/rhwp-agent ci --no-audit --no-fund
npm --prefix rhwp/rhwp-studio ci --no-audit --no-fund
cargo +1.93.1 build --manifest-path rhwp/Cargo.toml --release --locked --bin rhwp
wasm-pack build rhwp --target web -- --locked
