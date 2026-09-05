# Editing parity corpus

See [Formatting parity implementation](IMPLEMENTATION.md) for the current image-editing work, reproducible fixtures, verification evidence and remaining official-reference checks.

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

## Independent edit comparison

Behavioral checks for formatting selections across pictures run separately from official PDF comparisons:

```sh
cargo test --manifest-path rhwp/Cargo.toml --no-default-features --test editing_parity_image_formatting
cargo test --manifest-path rhwp/Cargo.toml --no-default-features --test editing_parity_word_spacing
```

These check body/cell font changes, selected-range preservation, existing mixed styles, supplementary Unicode text, per-run undo/redo and three HWPX reopens. Visible-text equality catches characters lost by the live renderer even if the document still stores them. These are local editing invariants, not independently captured Hancom formatting references.

The word-spacing checks compare visible glyph positions when trailing spaces span different font sizes. They also verify natural spacing on short final lines and explicit line breaks, with and without an image, in body paragraphs and cells through three reopens. Deliberate justification remains intact.

The [independent Mac captures](../../tests/fixtures/editing_parity/mac-hancom-12.30.0-independent/README.md) cover body paragraph spacing, an empty table cell, mixed body text, mixed cell text and cell paragraph spacing, five of six diagnostic recipes. Hancom performed the same operations from the same pre-edit sources. This is separate from opening Rau-edited files in Hancom.

Run these commands from the repository root, choosing unused output paths. The first mode checks Rau's edit against Hancom's independent PDF. It requires byte-identical shared source and captured Rau output.

```sh
cd rhwp
cargo run --example editing_parity_fixtures --no-default-features -- \
  output/editing-parity/independent-parallel-new --hcr-declared
cd ..
uv run --with pymupdf python rhwp/tools/editing_parity/compare_independent_edits.py \
  rhwp/output/editing-parity/independent-parallel-new \
  --reference-directory rhwp/tests/fixtures/editing_parity/mac-hancom-12.30.0-independent \
  --output rhwp/output/editing-parity/independent-parallel-new/comparison.json
```

The second mode renders Hancom's independently saved HWPX in Rau and compares it with the same native PDF.

```sh
cd rhwp
cargo run --example editing_parity_fixtures --no-default-features -- \
  output/editing-parity/independent-import-new --hcr-declared \
  --reference-inputs=tests/fixtures/editing_parity/mac-hancom-12.30.0-independent
cd ..
uv run --with pymupdf python rhwp/tools/editing_parity/compare_independent_edits.py \
  rhwp/output/editing-parity/independent-import-new \
  --reference-directory rhwp/tests/fixtures/editing_parity/mac-hancom-12.30.0-independent \
  --mode hancom-import \
  --output rhwp/output/editing-parity/independent-import-new/comparison.json
```

Both modes validate immutable capture hashes, covered recipe properties and three actual reopened layouts. They gate page count, non-whitespace line breaks, text line starts/baselines and image bounds at 0.5 pt. All three cell cases check every cell against native PDF border geometry and preserve source text, cell margins, alignment and unedited paragraph properties. The cell-spacing recipe allows only A1's requested 6/3 pt paragraph spacing with 160 percent line spacing. The three text-bearing image cases verify the image's exact Unicode insertion offset and all 55 visible glyph origins. Unsupported SVG text shapes are rejected instead of estimating their advances. Whitespace positions and glyph outlines remain outside these checks. Reports list uncaptured recipes and never claim full formatting parity. A changed input requires a new reviewed capture, not a digest update to the existing reference.

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
