---
name: copy-layout
description: Turn an HWP or HWPX into a reusable template that preserves its layout, titles, labels, headers, instructions, and other structural guidance while removing filled-in or user-added content. Use when the user asks to copy, extract, preserve, or reuse a Hangul document's layout without completed entries.
---

Create a new `.hwp` or `.hwpx` that remains understandable and ready to fill in. Preserve the reusable document, not merely its empty geometry.

## Resolve the source

When the user means the document open in Studio, call `get_document_info` first. Its `documentId` is the exact stable identity bound to this chat; `documentName` is display-only. Record the returned `documentId`, `digest`, `sourceFormat`, `dirty`, and `sourcePath`, and never search the filesystem, recent documents, or titles to guess the source—even when only one filename appears to match. All live document tools already target that exact `documentId`.

When `sourcePath` is non-null and `dirty` is false, use it directly: Studio resolved it from the sender-owned handle for this exact open document, so do not ask the user to attach or identify the file again. When `sourcePath` is null (including browser-only documents), or `dirty` is true and the visible revision must be captured, call `materialize_document_snapshot` and use its returned `path`. The snapshot is the exact current in-memory document in this chat's isolated workspace; it does not require another save and does not expose or overwrite the native source. Never tell the user to save merely because `sourcePath` is null. For an explicitly attached or path-named HWP/HWPX, use that file directly.

## Output

- Create a `layout/` directory beside the source unless the user specifies another destination.
- Preserve the source format by default: save as `<source stem> - Layout.hwp` or `<source stem> - Layout.hwpx`. Avoid overwriting an existing file; add ` (2)`, ` (3)`, and so on. If an HWP round trip fails a fidelity check, save and deliver the verified HWPX as a safe fallback, including when the user explicitly requested an HWP destination.
- Use `<source stem> - Layout` as the document title: set HWPX package metadata directly and use that exact filename title for HWP.
- Do not suppress a safe output solely because its page count, pagination, render diff, or native format differs from the source. Return the best safe copy and state the difference precisely.

## Decide what belongs to the template

Preserve all structural and visual properties that can affect the empty template: section and page count; paper size and orientation; margins, gutters, columns, page borders and backgrounds; headers and footers; master-page graphics; paragraph and character styles; tabs and spacing; tables and cell geometry; borders, fills, shading, colors, and line styles; text boxes and shape geometry; and object anchoring, wrapping, stacking, rotation, and transparency.

Keep reusable text, including:

- document titles and subtitles;
- section and subsection headings, numbering, and table descriptions or captions;
- table column headers, row headers, category names, and fixed option lists;
- field labels, units, date placeholders, signature labels, approval-role labels, and receipt labels;
- instructions, warnings, notes, boilerplate declarations, and explanatory guidance;
- fixed reference values that define how the blank form is organized.

Remove only content that appears filled in or added for a particular submission or use: names, organizations entered into blank fields, contact details, selected answers, dates, amounts, identifiers, free-form responses, results, feedback, signatures, stamps, populated charts, photos, scans, and attachments. A field marker is context, not proof that its text is user input; many official templates place labels inside fields. For mixed paragraphs, retain the fixed label and remove or reset only the entered span. Do not paraphrase source wording.

Judge text in document context rather than with a vocabulary whitelist. Repeated position, matching styles, table coordinates, nearby empty cells, bilingual pairs, numbering, and label/value relationships are stronger evidence than any single word. When a paragraph could reasonably be reusable guidance or user content and the surrounding document does not resolve it, keep it and record the ambiguity for review. This preserve-by-default rule is intentional.

Remove comments, annotations, tracked-change payloads, equations used as answers, charts, and content images or embedded objects. Keep decorative images and brand marks when they are part of the page design. Preserve a removed payload's frame and geometry.

Do not rebuild the document from screenshots or use office-suite or third-party format conversion. The helper edits HWPX packages directly; for HWP it uses Rauhwpx's native HWP→HWPX→HWP pipeline and verifies the round trip.

## Inspect, decide, then create

Read `scripts/copy_layout.py`. First inventory every visible paragraph:

```bash
python3 scripts/copy_layout.py --inspect-text "/absolute/path/source.hwp"
```

Review the complete inventory, not a small sample. It gives stable paragraph IDs, the exact source SHA-256, table-cell coordinates, header/footer and shape context, field-marker counts, editable fields, form controls, style identifiers, and suspicious visual marks. Create a JSON decision file in a temporary workspace:

```json
{
  "source_sha256": "<exact digest from inspection>",
  "default": "keep",
  "keep": ["Contents/section0.xml#p0003"],
  "remove": ["Contents/section0.xml#p0012"],
  "replace": {
    "Contents/section0.xml#p0020": "지출금액"
  },
  "reset_form_controls": ["Contents/section0.xml#control0004"],
  "clear_border_fill_marks": ["9", "11"]
}
```

`default` should normally be `keep`; use explicit removals for content that has evidence of being filled in. `keep` and `remove` override the default. `replace` is for a paragraph that mixes fixed scaffolding and entered content; its value must reproduce the fixed source text exactly except for deleting the entry or resetting an obvious form mark such as `☑` to `□`. Editable fields and form-control names are reusable structure and remain intact. Use `reset_form_controls` only for control IDs whose checked/selected/value state is user-entered; fixed official classifications can remain selected. `clear_border_fill_marks` accepts only suspicious border-fill IDs reported under `visual_marks`; use it when those marks encode filled schedules or similar user data. Never invent, rewrite, translate, or improve retained wording. The plan is cryptographically bound to the inspected source and unknown or conflicting IDs are rejected.

Apply the reviewed plan:

```bash
python3 scripts/copy_layout.py --text-plan "/absolute/path/decisions.json" "/absolute/path/source.hwp"
```

The old `--preserve-guidance` option exists only for compatibility and is not adequate for this task; do not use it for a guidance-preserving template.

The helper uses only the Python 3 standard library. Do not search for or install `lxml`, activate a repository-specific Python environment, or retry through an unrelated interpreter. A missing Python executable is an application packaging failure, not a reason to ask the user to save or identify the document again.

The helper preserves package structure, strips previews, scripts, history, and rejected body payloads, assigns the title, and verifies package and geometry invariants. Its report records both kept and removed paragraphs under `text_decisions`; review both lists. Page-count differences in either the intermediate or final output are fidelity diagnostics, not reasons to discard an otherwise safe template. For HWP input or output it locates the Rauhwpx `rhwp` binary from `--rhwp-bin`, `RHWP_BIN`, `PATH`, or this repository's build output. Read `delivery`, `text_decisions`, `media_usage`, `removed_body_media`, and `conversion.native_verification` or `conversion.fallback_reason`. When `delivery.ready` is `true`, return or publish the reported output; `delivery.quality: best_effort` requires a warning, not withholding the file.

Inspect body media and representative pages. If a removed body image is demonstrably a logo, seal, watermark, ornament, or other fixed design asset, rerun to a fresh output path with `--keep-media <manifest-id>` for each asset. Do not retain a populated chart, photo, scan, signature, or attachment merely to make the result look fuller. Also look for user-added information encoded as highlighting, checked boxes, colored schedule bars, cell fills, borders, or shapes; these are not safe merely because they are not text. If such marks cannot be cleanly reset without harming template styling, report the unresolved item instead of calling the result perfect.

Use `-o /absolute/path/result.hwp` or `.hwpx` only when the user requests a destination or format conversion. The helper refuses to overwrite the source or an explicitly named existing output.

When the source came from `materialize_document_snapshot`, the generated file is inside the isolated chat workspace. After verification, call `publish_artifact` with the output path and give the user its returned `downloadUrl` as a Markdown download link. Do not report only the temporary filesystem path for a snapshot-backed result.

## Verify and deliver

Treat verification in two tiers:

- Hard safety and semantic gates: the package must be readable, approved reusable text must match the reviewed plan, rejected text and private payloads must be absent, and the layout/template structure must remain valid. Do not deliver a candidate that fails these gates.
- Fidelity checks: native HWP conversion, final page count, pagination, and render similarity. Try reasonable corrections, then deliver a safe result as `best_effort` with concrete warnings if these still differ.

Review every entry in `text_decisions.kept` and `text_decisions.removed`; confirm headings, labels, captions, and guidance remain while filled values are absent. Preview representative pages when available. A one-page source becoming two pages is a fidelity warning, not a reason to return no file, and is not evidence that the wrong document is open. Do not ask the user to confirm or resave the current document unless a fresh identity check actually shows that `documentId` or `digest` changed.

Report the saved path, `verified` or `best_effort` quality, warnings, removed content, preserved design elements, and any uncertain content-versus-decoration decisions. When the source came from a snapshot, publish a safe `best_effort` artifact exactly as you would a verified artifact and include the warning beside its download link.
