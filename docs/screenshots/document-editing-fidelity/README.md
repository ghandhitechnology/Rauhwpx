# Document editing fidelity visual evidence

These comparisons use independent Studio and WASM builds from baseline `c69ad4a6` and this branch. Each pair runs the same representative document or editor interaction. The table and caret callouts report the actual runtime target dimensions and cursor path after the operation.

| Fix | Before and after |
| --- | --- |
| Letter spacing preserves glyph proportions | ![Letter spacing comparison](01-letter-spacing.webp) |
| Exact-face shaping preserves kerning and ligatures | ![Font shaping comparison](02-font-shaping.webp) |
| Nested table commands edit the selected table | ![Nested table targeting comparison](03-nested-table-targeting.webp) |
| Structural edits remap the full caret path | ![Caret remapping comparison](04-caret-remap.webp) |
| Equation properties target the selected equation | ![Exact equation targeting comparison](05-exact-equation-target.webp) |
| Equation text uses the saved face and measured widths | ![Equation font comparison](06-equation-face-metrics.webp) |
| Literal underscores and hyphens stay text | ![Literal line comparison](07-literal-lines.webp) |
| Advanced table borders remain visually distinct | ![Table border comparison](08-table-border-styles.webp) |
| Underline and strikeout styles survive the dialog | ![Decoration dialog comparison](09-decoration-dialog.webp) |
| Equation parse failures are visible and actionable | ![Equation diagnostics comparison](10-equation-diagnostics.webp) |
| Images, equations, tables, and ranges can be sent to agents | ![Agent object selection comparison](11-agent-object-selection.webp) |

These images are review evidence only. Visual comparisons remain outside CI.
