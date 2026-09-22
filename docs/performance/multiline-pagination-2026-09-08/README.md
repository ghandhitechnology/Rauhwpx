# Guarded multiline insertion benchmark

The real `PendingEditManager.insertText` path inserted 32 Korean lines into `business_overview.hwp`. Across three alternating pairs of fresh headless Chrome runs, median insertion time fell from **78 ms to 30 ms**, a 2.6× speedup. All after runs had zero observed long tasks; each baseline run had one.

| Pair | Baseline insertion | Guarded insertion | Baseline long task | Guarded long tasks |
| --- | ---: | ---: | ---: | ---: |
| 1 | 93.5 ms | 44.4 ms | 84 ms | 0 |
| 2 | 70.2 ms | 23.7 ms | 58 ms | 0 |
| 3 | 78.0 ms | 30.0 ms | 67 ms | 0 |

Both sides used the same rebuilt WASM binary, SHA-256 `91d4ee14e63a0866173c6fdb2b0fe4667ec3efff30287e87da5108d92e45d2ed`. The frontend baseline is `ac0d607b`, which already includes the typewriter fixes. The after measurement used the guarded multiline changes on that base, subsequently committed as `2ec651e6`. [Raw results](results.json) preserve the measured HEAD and this working-tree provenance.

Every run produced exactly 61 paragraphs from an initial 30, and two pages from an initial one. Exact inserted text, paragraph boundaries, and first-page pixels against a fresh WASM render all passed. Exported HWP bytes had the same SHA-256 in all six runs: `8b51352b6a038ede31c4630ef762b6e4948705730e8285dc9c917fbb1ca5667a`. No browser crashes or uncaught page errors occurred.

The guard batches body text only when the engine confirms a single-column section. Final verification passed three Rust guard tests and five real-WASM parity tests, including exact exported HWP bytes and every SVG page for body, multicolumn, and cell fallback scenarios, plus approve/undo/redo. Cell insertion and multicolumn documents keep their existing path. This measurement covers the eligible business document; separate correctness tests cover fallback behavior. Authoritative layout refresh remains in the production path.

These final timings replace the earlier measurements using a different local WASM build. Local builds and tests were paused, and no other benchmark browser was running. The backend was Canvas2D. Each row measures one synchronous insertion; the raw FPS fields also include a 1.2-second settling period.

## Reproduce

Use the benchmark script from the preview scheduling branch, a fresh checkout of each frontend revision, and an identical copy of the rebuilt guarded WASM package in both checkouts.

```sh
BENCH_STUDIO_ROOT=/absolute/checkout/rhwp/rhwp-studio \
BENCH_SAMPLES=hwpx/hancom-hwp/business_overview.hwp \
BENCH_MODES=pending-multiline BENCH_BURSTS=1 BENCH_BURST_SIZE=1 \
  node rhwp/rhwp-studio/e2e/preview-frame-bench.mjs --label=multiline
```
