# Hancom HFT vector atlases

These tools create Unicode OpenType/CFF faces from vector paths exported by
Hancom Office. The input is a synthetic HWPX grid plus a calibrated manifest:
the manifest supplies each character's Unicode mapping, PDF cell, baseline,
source HFT advance, family, style, and source hashes. The converter does not
guess mappings from the appearance of a glyph. Licensed HFT, HWPX, PDF, and OTF
files stay outside the repository.

Install the pinned Python dependencies and choose a local output directory:

```sh
cd rhwp/tools/hancom_font_atlas
python3 -m venv /tmp/hancom-font-venv
/tmp/hancom-font-venv/bin/pip install -r requirements.txt
HFT_DIR='/Applications/Hancom Office HWP.app/Contents/Resources/Hnc/Shared/Fonts'
ATLAS_DIR=/tmp/hancom-atlas
mkdir -p "$ATLAS_DIR"
```

The source HWPX is a content-free grid template. To create a 2,445-character
Hangul/ASCII atlas and record the installed HFT banks:

```sh
/tmp/hancom-font-venv/bin/python hft_inventory.py --hft-dir "$HFT_DIR" \
  --out "$ATLAS_DIR/hft-inventory.json"
/tmp/hancom-font-venv/bin/python generate_atlas.py '신명 디나루' \
  --coverage ks2350 --stem atlas-dinaru --out-dir "$ATLAS_DIR" \
  --hft-dir "$HFT_DIR" --source-hwpx ../../samples/hwpx/ref/ref_empty.hwpx
```

Export **that exact HWPX** to PDF using Hancom Office's File → Print → PDF
flow, then calibrate the manifest against the PDF clip rectangles and glyph
CTMs. On this Mac, the parity-loop helper automates the same export:

```sh
~/.codex/skills/hancom-parity-loop/scripts/hancom_export.sh \
  "$ATLAS_DIR/atlas-dinaru.hwpx" "$ATLAS_DIR/atlas-dinaru.pdf"
/tmp/hancom-font-venv/bin/python calibrate_manifest.py \
  "$ATLAS_DIR/atlas-dinaru.json"
/tmp/hancom-font-venv/bin/python audit_clips.py \
  "$ATLAS_DIR/atlas-dinaru.json" \
  --accept-top-protrusions-up-to-pt 1.0
```

The clip audit records each source path that extends above its cell in the
manifest and writes a report for review. The converter still rejects any
unrecorded crossing. The Dinaru Hangul/ASCII atlas has four such punctuation
paths; a fresh full atlas needs this audit before conversion.

The converter checks the source hashes, every Unicode mapping and HFT width,
PDF text/image fallback, cell crossing, blank proof, visible stroke metadata,
and serialized CFF geometry. `run` combines the steps and reuses a result only
when the manifest, PDF, HFT banks, tool, and OTF hashes still match:

```sh
/tmp/hancom-font-venv/bin/python atlas_to_otf.py run \
  "$ATLAS_DIR/atlas-dinaru.json" --hft-dir "$HFT_DIR" \
  --out "$ATLAS_DIR/atlas-dinaru.otf"
```

For review or independent checks, split it into explicit steps:

```sh
/tmp/hancom-font-venv/bin/python atlas_to_otf.py extract \
  "$ATLAS_DIR/atlas-dinaru.json" --hft-dir "$HFT_DIR" \
  --out "$ATLAS_DIR/atlas-dinaru.outlines.json"
/tmp/hancom-font-venv/bin/python atlas_to_otf.py build \
  "$ATLAS_DIR/atlas-dinaru.outlines.json" --out "$ATLAS_DIR/atlas-dinaru.otf"
/tmp/hancom-font-venv/bin/python atlas_to_otf.py verify \
  "$ATLAS_DIR/atlas-dinaru.outlines.json" "$ATLAS_DIR/atlas-dinaru.otf" \
  --out "$ATLAS_DIR/atlas-dinaru.verify.json"
```

Generate a second pilot at another font size, export/calibrate/extract it, and
run `compare-scales FIRST.outlines.json SECOND.outlines.json --out report.json`.
This checks that every normalized contour and source advance survives the PDF
transform at both sizes. A known TrueType control should be exported too: if
Hancom emits live PDF text instead of isolated vectors, extraction must fail.

Build the native renderer with `native-skia` and load the converted OTF through
the same import path used for document rendering:

```sh
(cd ../.. && cargo build --profile release-test --features native-skia --bin rhwp)
../../target/release-test/rhwp export-png "$ATLAS_DIR/atlas-dinaru.hwpx" \
  --font-path "$ATLAS_DIR/atlas-dinaru.otf" \
  --output "$ATLAS_DIR/native" --dpi 200
```

Render the same HWPX through Studio's real `importLocalFontFiles` path. After
building the WASM package and starting Studio, supply a document map and an
OTF map to the browser capture script:

```sh
(cd ../.. && wasm-pack build --target web)
npm --prefix ../../rhwp-studio ci
RHWP_AGENT_PORT=20001 npm --prefix ../../rhwp-studio run dev -- --host 127.0.0.1 --port 5173
```

In another terminal, use JSON files shaped as
`{"atlas-dinaru":{"source":"/tmp/hancom-atlas/atlas-dinaru.hwpx"}}` and
`{"atlas-dinaru":["/tmp/hancom-atlas/atlas-dinaru.otf"]}`:

```sh
node capture_studio.mjs --docs-json "$ATLAS_DIR/docs.json" \
  --fonts-json "$ATLAS_DIR/fonts.json" --out-dir "$ATLAS_DIR/studio" \
  --url http://127.0.0.1:5173/ --dpi 200
```

Compare every captured page against its Hancom PDF. The converted face's
OpenType name ID 10 contains the exact marker
`rhwp:source-format=HFT;metrics=source-hmtx-v1`; it identifies verified HFT
source widths for provenance audits. The renderers inspect the actual face
metrics. Hancom's *effective run advances* can differ
from those widths, especially for spaces and styled text. Measure those with
repeated-glyph probes before changing layout behavior. Unmapped Unicode remains
absent from `cmap` so normal font fallback can operate. The manifest records
vertical metrics as inferred until the proprietary HFT vertical fields are
decoded. Receipts retain coverage and source-hash evidence; they are not a
claim that every glyph in every HFT bank is mapped.

Run the durable converter checks with
`/tmp/hancom-font-venv/bin/python -m unittest -v test_atlas_to_otf.py`.
