# Line-width measurement benchmark

Reusing line-width measurements reduced the 78-page KPS edit workload from a median **2,184 ms to 1,398 ms**, a 1.56× speedup. Active frame rate rose from 11.91 to 18.93 FPS across three alternating baseline/optimized pairs of fresh headless Chrome runs. Large-document bursts still exceed the frame budget.

| Document | Baseline edit time | Optimized edit time | Baseline active FPS | Optimized active FPS | Baseline / optimized frame p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Business plan, 6 pages | 291.5 ms | 252.5 ms | 57.32 | 55.45 | 16.8 / 16.7 ms |
| KPS, 78 pages | 2,183.8 ms | 1,398.1 ms | 11.91 | 18.93 | 183.2 / 116.6 ms |

Values are medians of three runs. The short business-plan workload stayed at approximately one frame every 16.7 ms and produced no long tasks on either revision. On KPS, each run had twelve long tasks; median mean long-task duration fell from 169.4 to 101.9 ms.

## Workload and correctness

Each run inserts the same 48 strings into paragraph zero in twelve bursts of four edits, with an 8 ms timer between bursts. Edits use the real WASM bridge and production `document-changed` events. Both frontends are based on `fbe3991e`; the engine change is in `composer.rs`. The renderer is Canvas2D, running in fresh headless Chrome on Apple M4. No build, test, or competing benchmark process ran during the timing window.

Every pair passed all of these checks:

- Exact exported HWP bytes, compared by SHA-256.
- Exact SVG output for every page: six business-plan pages and 78 KPS pages.
- Exact first-page canvas PNG across engines and against a fresh render.
- Identical final page count, paragraph count, and verified inserted text.
- No browser crashes or uncaught page errors.

The SVG/export checks run after timing capture. [Raw measurements and parity records](results.json) include per-page hashes and all six runs.

## Matched builds

Both WASM binaries were rebuilt using the same dependency lockfile, Rust 1.93.1, LLVM 21.1.8, default features, release profile, and wasm-bindgen 0.2.125. The release profile uses LTO and one codegen unit. No custom RUSTFLAGS or wasm-opt pass was used.

```sh
CARGO_TARGET_DIR=/isolated/target \
  cargo +1.93.1 build --release --target wasm32-unknown-unknown --lib

wasm-bindgen --target web --out-dir pkg --out-name rhwp \
  /isolated/target/wasm32-unknown-unknown/release/rhwp.wasm
```

Baseline source: `fbe3991eea33702f8d81c5405e10916eb7b8e0f0`. Optimized measurements used the width-scan working tree subsequently committed as `7b1985d2`. Source and build hashes are recorded in the raw results.

- Baseline WASM: `087bafb902cf20eadd4882036ce238b4e3defc9432fade21d657393715bd2912`
- Optimized WASM: `d15757fc2c399f37c046ad6bd67bd1a43e92175ad3b9df249bb86bb959971d86`

These freshly built release binaries differ from the local WASM build used in the earlier preview report. The comparison here isolates the line-width change with a matched build pipeline.

The dedicated `typeset-line-width-bench.mjs` reuses the preview benchmark workload with export, per-page SVG, and first-page PNG hashing. Its trimmed single-line version passed a separate one-insert correctness check after the timing runs. The invocation for each checkout was:

```sh
BENCH_STUDIO_ROOT=/absolute/checkout/rhwp/rhwp-studio \
BENCH_BURSTS=12 BENCH_BURST_SIZE=4 \
BENCH_SAMPLES=biz_plan.hwp,kps-ai.hwp \
  node rhwp/rhwp-studio/e2e/typeset-line-width-bench.mjs --label=typeset-run
```

## Native checks

Separate native timing measured `insert_text_native` without browser rendering. Under matched `release-test` profiles with optimization level 3, LTO disabled, and 16 codegen units, median KPS time across three alternating 48-insert pairs fell from 1,249.5 to 786.8 ms. The median per-insert measurements were 25.479 and 15.609 ms. Native `business_overview.hwpx`, a different fixture from the browser business plan, remained approximately flat at 0.486 and 0.483 ms per insert. [Raw native pairs](native-release-pairs.txt) preserve the order and each measurement.

Native parity checks compared six exported HWP files and all 167 SVG pages from KPS, business overview, masked-text, stored-line overflow, multicolumn, and HWP3 fixtures. All matched exactly; see [parity summary](native-parity.json). The composer test group passed 92 tests with one ignored, including the threshold/guard oracle cases.
