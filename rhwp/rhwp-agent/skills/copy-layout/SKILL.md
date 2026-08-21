---
name: copy-layout
description: Copy the visual layout and design of the current or specified HWP or HWPX document into a reusable, content-free template. Use when the user asks to copy, extract, preserve, or reuse a Hangul document's layout without its content.
---

Create a new `.hwp` or `.hwpx` that matches the source's page design as closely as possible while exposing no source content.

## Resolve the source

Use the HWP/HWPX attached to the request, named by path, or matching the open document's title. If the live document has unsaved changes, ask the user to save it first so the layout copy reflects the visible version. If there is no unambiguous source file, find likely recent `.hwp` and `.hwpx` files and ask the user to identify one; never guess between plausible documents.

## Output

- Create a `layout/` directory beside the source unless the user specifies another destination.
- Preserve the source format by default: save as `<source stem> - Layout.hwp` or `<source stem> - Layout.hwpx`. Avoid overwriting an existing file; add ` (2)`, ` (3)`, and so on. If an HWP round trip fails the precision gates, save the verified HWPX as a safe fallback and report the reason rather than delivering degraded HWP.
- Use `<source stem> - Layout` as the document title: set HWPX package metadata directly and use that exact filename title for HWP.

## Preserve the design

Preserve all structural and visual properties that can affect the empty template: section and page count; paper size and orientation; margins, gutters, columns, page borders and backgrounds; headers and footers; master-page graphics; paragraph and character styles; tabs and spacing; tables and cell geometry; borders, fills, shading, colors, and line styles; text boxes and shape geometry; and object anchoring, wrapping, stacking, rotation, and transparency.

Remove user-authored content: visible text, field values, comments and annotations, tracked-change payloads, equations, charts, and content images or embedded objects. Keep decorative images only when they are clearly part of the page design. When intent is ambiguous, favor privacy and remove the payload while preserving a same-size empty frame.

Do not rebuild the document from screenshots or use office-suite or third-party format conversion. The helper edits HWPX packages directly; for HWP it uses Rauhwpx's native HWP→HWPX→HWP pipeline and verifies the round trip.

## Create the copy

Read `scripts/copy_layout.py`, then run it from this skill's absolute root:

```bash
python3 scripts/copy_layout.py "/absolute/path/source.hwp"
```

The helper preserves package structure, strips previews, scripts, history, and body payloads, keeps media referenced by master pages or layout definitions, assigns the title, and verifies package and geometry invariants. It first empties HWP body text completely; if that contracts pagination, it retries with width-aware blank spacing that retains flow without retaining source words. For HWP input or output it locates the Rauhwpx `rhwp` binary from `--rhwp-bin`, `RHWP_BIN`, `PATH`, or this repository's build output. Read its JSON report, especially `text_strategy`, `media_usage`, `removed_body_media`, and `conversion.native_verification` or `conversion.fallback_reason`.

If a removed body image is demonstrably decorative after inspecting the image and placement, rerun to a fresh output path with `--keep-media <manifest-id>` for each such asset. Never retain a chart, photo, scan, signature, or attachment merely to make the result look fuller.

Use `-o /absolute/path/result.hwp` or `.hwpx` only when the user requests a destination or format conversion. The helper refuses to overwrite the source or an explicitly named existing output.

## Verify before delivery

1. Confirm the output opens in its reported HWP/HWPX format; for HWP, confirm the native round-trip and render-diff verification passed. Treat an HWPX precision fallback as intentional, not as native HWP success.
2. Confirm it contains no source text or obvious content payloads.
3. Confirm title, destination, page count, section setup, and layout-object geometry.
4. Render or preview representative pages when available and inspect small details.

Report the saved path, removed content, preserved design elements, and any uncertain content-versus-decoration decisions.
