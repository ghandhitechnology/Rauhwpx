---
name: copy-layout
description: Copy the visual layout and design of the current or specified HWPX document into a reusable, content-free HWPX template. Use when the user asks to copy, extract, preserve, or reuse a Hangul document's layout without its content.
---

Create a new `.hwpx` that matches the source's page design as closely as possible while exposing no source content.

## Resolve the source

Use the HWPX attached to the request, named by path, or matching the open document's title. If the live document has unsaved changes, ask the user to save it first so the layout copy reflects the visible version. If there is no unambiguous source file, find likely recent `.hwpx` files and ask the user to identify one; never guess between plausible documents.

## Output

- Create a `layout/` directory beside the source unless the user specifies another destination.
- Save as `<source stem> - Layout.hwpx`. Avoid overwriting an existing file; add ` (2)`, ` (3)`, and so on.
- Set the package title metadata to `<source stem> - Layout`.

## Preserve the design

Preserve all structural and visual properties that can affect the empty template: section and page count; paper size and orientation; margins, gutters, columns, page borders and backgrounds; headers and footers; master-page graphics; paragraph and character styles; tabs and spacing; tables and cell geometry; borders, fills, shading, colors, and line styles; text boxes and shape geometry; and object anchoring, wrapping, stacking, rotation, and transparency.

Remove user-authored content: visible text, field values, comments and annotations, tracked-change payloads, equations, charts, and content images or embedded objects. Keep decorative images only when they are clearly part of the page design. When intent is ambiguous, favor privacy and remove the payload while preserving a same-size empty frame.

Do not rebuild the document from screenshots or convert it through another format. Targeted HWPX package edits preserve small details more accurately.

## Create the copy

Read `scripts/copy_layout.py`, then run it from this skill's absolute root:

```bash
python3 scripts/copy_layout.py "/absolute/path/source.hwpx"
```

The helper preserves package structure, clears content-bearing XML, strips previews, scripts, history, and body payloads, keeps media referenced by master pages or layout definitions, assigns the title, and verifies package and geometry invariants. Read its JSON report, especially `media_usage` and `removed_body_media`.

If a removed body image is demonstrably decorative after inspecting the image and placement, rerun to a fresh output path with `--keep-media <manifest-id>` for each such asset. Never retain a chart, photo, scan, signature, or attachment merely to make the result look fuller.

Use `-o /absolute/path/result.hwpx` only when the user requests a destination. The helper refuses to overwrite the source or an explicitly named existing output.

## Verify before delivery

1. Confirm the output is valid ZIP/XML and opens as HWPX.
2. Confirm it contains no source text or obvious content payloads.
3. Confirm title, destination, page count, section setup, and layout-object geometry.
4. Render or preview representative pages when available and inspect small details.

Report the saved path, removed content, preserved design elements, and any uncertain content-versus-decoration decisions.
