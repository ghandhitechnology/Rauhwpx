# Editing parity corpus

This directory pins the first official editing-parity corpus. `corpus.json` contains 50 ordered `EditingParityCase` records spanning 695 oracle pages. Every record names one source document, one oracle PDF, their SHA-256 digests, the PDF page count, provenance, and feature tags.

## Validate

Validation uses only the Python standard library. When Poppler's `pdfinfo` executable is present, it also verifies PDF page counts and producer metadata.

```sh
python3 rhwp/tools/editing_parity/validate.py
python3 rhwp/tools/editing_parity/validate.py --json
python3 -m unittest discover -s rhwp/tools/editing_parity/tests -v
```

The validator requires exactly 50 unique cases, unique source-file SHA-256 values, and fixed category quotas of 16 table, 16 picture, 10 layered, and 8 mixed cases. Sources must remain below `rhwp/samples/`. Oracles must remain below `rhwp/pdf/`.

## Verification workflow

Use these ten cases for focused pull-request verification:

```text
table-complex
table-giant-nested
table-text-anchor-wrap
picture-crop
picture-cell-stack
picture-treat-as-character
layered-coanchored-tables
layered-nested-vectors
mixed-textbook
mixed-exam-math
```

Run all 50 cases as the nightly document gate. Assign interaction recipes by feature tag instead of applying every edit to every document. Diagnostic oracles remain useful for regression analysis but must not become hard official-parity gates.

```sh
python3 rhwp/tools/editing_parity/batch_visual_compare.py \
  --all --pages all \
  --min-page-pixel-match 80 \
  --min-page-ink-match 5
```

## Immutable oracle rules

- Never update a pinned digest to make a test pass.
- Replace a source or oracle only as a reviewed corpus change.
- Record canonical Hancom application, build, operating system, fonts, and export settings when recapturing an oracle.
- Recompute `corpusSha256` only after reviewing the ordered case diff.
- A `hancom` oracle must report a Hancom PDF producer when producer metadata is available.
- A non-Hancom export must use `diagnostic` provenance. Four current Cairo PDFs are marked this way.

## Native visual comparison

The batch wrapper delegates to `scripts/visual_oracle_native.py`. It does not duplicate rendering or comparison logic.

```sh
cargo build --manifest-path rhwp/Cargo.toml --release --features native-skia --bin rhwp
python3 -m pip install PyMuPDF Pillow numpy

python3 rhwp/tools/editing_parity/batch_visual_compare.py \
  --case table-complex \
  --case picture-crop \
  --pages 1

# Fast first-page sweep across all 50 cases.
python3 rhwp/tools/editing_parity/batch_visual_compare.py --all --pages 1

# Full 50-document, all-page sweep without retaining hundreds of large PNGs.
python3 rhwp/tools/editing_parity/batch_visual_compare.py \
  --all --pages all --metrics-only \
  --min-page-pixel-match 80 --min-page-ink-match 5

# Rebuild summary.json and summary.md from an existing first-page sweep.
python3 rhwp/tools/editing_parity/batch_visual_compare.py \
  --all --pages 1 --summarize-only

# Optional explicit fidelity bounds. Execution completeness remains separate.
python3 rhwp/tools/editing_parity/batch_visual_compare.py \
  --all --pages 1 --summarize-only \
  --min-pixel-match 90 --min-ink-match 20

python3 rhwp/tools/editing_parity/batch_visual_compare.py \
  --case table-complex \
  --case-pages table-complex=1-4 \
  --dry-run
```

The direct existing command remains available:

```sh
cd rhwp
python3 scripts/visual_oracle_native.py \
  --hwp samples/pic-crop-01.hwp \
  --pdf pdf/pic-crop-01-2022.pdf \
  --pages 1 \
  --out output/editing-parity/picture-crop
```

The native comparator requires PyMuPDF, Pillow, NumPy, and a native-Skia `rhwp` binary. Those are optional and are not required to validate or test the corpus manifest.

Each completed batch writes `summary.json` and `summary.md` below the output root. The aggregate reports selected, completed, failed, and skipped counts; case-weighted pixel and ink averages by category and provenance; and the worst ten cases by ink match. Per-case rendering and metrics remain owned by `visual_oracle_native.py`.

`--min-pixel-match` and `--min-ink-match` remain optional case-mean bounds for backward compatibility. `--min-page-pixel-match` and `--min-page-ink-match` fail when any individual page falls below its bound, so a bad page cannot be averaged away. Summaries record each case's minimum metrics, pages containing those minima, and every page offending an enabled page bound. All bounds are percentages from 0 to 100.

The JSON and Markdown keep execution status and fidelity-threshold status separate. Passing chosen thresholds does not establish complete Hancom parity.

## Mutation-safety gate

`mutation_safety_gate.py` batches the existing real `rhwp edit-stress` command and continues after individual failures. The command currently accepts HWPX inputs only, so `--all-hwpx` is the normal corpus selection.

```sh
# Inspect the seven eligible commands.
python3 rhwp/tools/editing_parity/mutation_safety_gate.py \
  --all-hwpx --dry-run

# Run the mutation-safety battery and write JSON/Markdown summaries.
python3 rhwp/tools/editing_parity/mutation_safety_gate.py --all-hwpx

# Select individual eligible cases.
python3 rhwp/tools/editing_parity/mutation_safety_gate.py \
  --case table-row-split \
  --case picture-page-fill
```

Mutation safety checks local editing commands, render smoke tests, HWPX serialization and reparsing, and snapshot restoration. A selected case with zero mutation operations is skipped and makes execution incomplete. Table cases require a `table_*` or `cell_*` operation. Picture cases require a `pic_*` operation. Layered cases require a `pic_*`, `shape_*`, or `layer_*` operation. Mixed cases require both table/cell and visual-object operations. Reports record domain coverage.

`edit-stress` recursively inventories tables, pictures, shapes, group children, and page image brushes. It exercises property no-ops for top-level shapes and for pictures or shapes addressable inside table cells, textboxes, and picture captions. A `pic_page_image_fill_noop` reuses the existing page `borderFillId` and verifies that the complete image-fill query, BorderFill record, BinData reference, and image bytes remain identical. A `layer_z_order_roundtrip` uses the shared z-order command for pictures, shapes, floating tables, and floating equations, then restores an internal snapshot before later stress groups run. Unsupported controls remain counted without manufacturing coverage. Extra page-border fills, for example, remain an explicit picture-domain skip until they gain an addressable mutation command.

Mutation summaries also pin the selected `rhwp` executable's absolute path and SHA-256. This makes results from stale or mismatched binaries auditable.

This gate does not produce edited Hancom oracles, compare post-edit output with Hancom, or establish post-edit Hancom parity.
