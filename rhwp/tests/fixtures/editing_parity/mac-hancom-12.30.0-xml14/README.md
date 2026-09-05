# Mac Hancom XML 1.4 image-editing captures

These six Rau-edited HWPX files were opened without editing or resaving in Mac Hancom 12.30.0 build 6446 and exported through `파일 > PDF로 저장하기...` on 2026-09-05. All six PDF pages were rendered with Poppler at 96 dpi and visually inspected. The original [capture set](../mac-hancom-12.30.0/README.md) is unchanged.

The inputs use the corrected package XML 1.4 declaration and Mac HCR font metrics. Their bytes match the `mac-2026-09-05-xml-version` and `mac-2026-09-05-legacy-import-new-recipes` generator runs. Those runs each verified identical live layout through three save/reopen cycles.

[capture.json](capture.json) records input/output hashes, recipes, application, OS, font and export details. Quartz PDF metadata alone does not prove Hancom provenance. These captures were observed in Hancom, with the document and save filename checked. Independently reproducing the edits in Hancom remains pending.

The [capture-time comparison](initial-comparison.json) has five passes and one failure at the unchanged 0.5 pt tolerance. All six have matching page counts and non-whitespace line breaks. The first cell paragraph with spacing is about 6 pt too high in Rau: image vertical error is 6.011 pt and text baseline errors range from 6.020 to 6.100 pt. The largest absolute image-coordinate error among passing cases is 0.203 pt; their text line-start/baseline errors are at most 0.100 pt.

After the first-cell spacing fix, both exact-input rendering and freshly executed recipes pass all six comparisons against these unchanged references. The previously failing image is within 0.011 pt vertically, its text baselines within 0.100 pt, and table borders within 0.5 pt. Current results live under `output/editing-parity/mac-2026-09-05-cell-spacing-layout` and `mac-2026-09-05-cell-spacing-edits`; the capture-time report is intentionally unchanged. See the [implementation record](../../../../tools/editing_parity/IMPLEMENTATION.md) for verification and remaining scope.

To compare the exact inputs, run from `rhwp` with a new output directory:

```sh
cargo run --example editing_parity_fixtures --no-default-features -- \
  output/editing-parity/NEW_XML14_RENDER --hcr-declared \
  --reference-inputs=tests/fixtures/editing_parity/mac-hancom-12.30.0-xml14
```

Then run from the repository root:

```sh
uv run --with pymupdf python rhwp/tools/editing_parity/compare_diagnostic_exports.py \
  rhwp/output/editing-parity/NEW_XML14_RENDER \
  --reference-directory rhwp/tests/fixtures/editing_parity/mac-hancom-12.30.0-xml14
```

The comparator rejects changed input bytes. It checks page counts, non-whitespace line breaks, line starts, baselines and single-image bounds, not every glyph, whitespace position, border or page feature. Passing these cases does not establish full formatting parity. Preserve these captures and their initial report; write later comparison reports into new output directories.
