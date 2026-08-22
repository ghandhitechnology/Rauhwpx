---
name: copy-layout
description: Turn an HWP or HWPX into a reusable template that preserves its layout, titles, labels, headers, instructions, and other structural guidance while removing filled-in or user-added content. Use when the user asks to copy, extract, preserve, or reuse a Hangul document's layout without completed entries.
---

Create a new `.hwp` or `.hwpx` that remains understandable and ready to fill in. Preserve the reusable document, not merely its empty geometry. Never modify, rename, move, or overwrite the source.

## Owning chat: delegate immediately

When this skill is selected in the main Studio chat, call `get_document_info` once and immediately pass its exact `documentId`, `digest`, `documentName`, `sourceFormat`, `dirty`, and `sourcePath` to `delegate_copy_layout`. The document ID and digest are authoritative; the name is display-only. Never search the filesystem, recent documents, or titles to guess the source, and never ask the user to save, attach, identify, or confirm the document.

Delegate the entire workflow. Do not inspect paragraphs, create decisions, run the helper, publish an artifact, or open a link in the owning chat. `delegate_copy_layout` starts a fresh independent provider session/process in the background and returns immediately, so the main chat stays responsive. It is represented by the normal session/fleet task protocol; it is not a provider-native subagent.

After `delegate_copy_layout` succeeds, do not call `wait_agent`, `list_agents`, poll tools, sleep, or use any other waiting mechanism. Collaboration tools cannot observe this independent process. Briefly tell the user that the background job is running, then end the current turn. The hub will automatically start a new turn in this same owning chat with the structured completion result when the worker settles; that injected turn is the only completion notification to act on.

There is no pre-execution confirmation. Do not ask about paragraph choices, media, privacy ambiguities, destination, format fallback, page-count differences, filename collision suffixes, previews, or publication while the worker runs.

## Dedicated worker: immutable source and bounded autonomy

When `update_copy_layout_job` and `complete_copy_layout_job` are available, you are the dedicated worker. Work without prompting the user or owning agent. Do not spawn or delegate. Call `complete_copy_layout_job` exactly once.

1. Report `binding-source`, read `scripts/copy_layout.py`, and call `get_document_info`. Require its `documentId` and `digest` to equal the trusted job binding. Always call `materialize_document_snapshot`, including when a clean native `sourcePath` exists, and perform every operation against that exact immutable snapshot.
2. Report `inspecting` and run `python3 scripts/copy_layout.py --inspect-text <snapshot>`. Inspect the complete paragraph inventory, fields, form controls, named structures, visual marks, and every media use—not a sample. The helper uses only Python 3's standard library; do not install `lxml` or switch interpreters.
3. Report `planning` and write a source-SHA-256-bound decision JSON with `default: "keep"`. Decide all keep/remove/replace/reset/clear actions before generation.
4. Report `generating` and run the helper with `--text-plan` to a fresh collision-free candidate path inside the job workspace. Use a new path for every retry. Never write beside the snapshot or source.
5. Report `previewing`. Read the complete helper report, including both `text_decisions.kept` and `text_decisions.removed`, `media_usage`, `removed_body_media`, `delivery`, and native conversion diagnostics. Render or preview representative first, middle, last, and risk-bearing pages for source and candidate with Rauhwpx tooling when available. Compare safety, readability, semantic retention/removal, page and section counts, media, geometry, native conversion, pagination, and render similarity.
6. Report `converging`. Revise the decision file or `--keep-media` evidence and rerun only when it predicts a safer or more faithful result. Stop at verified convergence or after three collision-free candidates with an explicit bounded-no-improvement result.
7. Report `publishing`. Publish exactly one successful final candidate with `publish_artifact`, then submit its exact `artifactId` and the structured quality, warnings, counts, and preview comparison through `complete_copy_layout_job`.

Example decision file:

```json
{
  "source_sha256": "<exact snapshot digest>",
  "default": "keep",
  "keep": ["Contents/section0.xml#p0003"],
  "remove": ["Contents/section0.xml#p0012"],
  "replace": { "Contents/section0.xml#p0020": "지출금액" },
  "reset_form_controls": ["Contents/section0.xml#control0004"],
  "clear_border_fill_marks": ["9", "11"]
}
```

The plan is cryptographically bound to the inspected source. Unknown or conflicting IDs are rejected. `keep` and `remove` override the preserve-by-default policy. `replace` may only reproduce fixed source wording while deleting entered content or resetting an obvious mark such as `☑` to `□`; never invent, translate, paraphrase, or improve retained wording.

## Semantic and media decisions

Preserve section/page geometry, paper and margins, columns, headers and footers, master-page graphics, styles, tabs and spacing, tables and cells, borders and fills, text boxes and shapes, object anchoring/wrapping/stacking/rotation/transparency, and zero-width layout anchors.

Keep reusable titles, headings, numbering, captions, column/row headers, category names, fixed options, labels, units, placeholders, signature and approval roles, instructions, warnings, notes, declarations, explanatory guidance, and fixed reference values. Repeated position, styles, table coordinates, bilingual pairs, numbering, nearby empty cells, and label/value relationships are stronger evidence than vocabulary. A field marker is not proof of user input. For mixed paragraphs, keep the exact fixed label and remove only the entered span. If context cannot distinguish guidance from entered content, keep it and report the precise ambiguity as a fidelity/privacy warning; never silently remove reusable guidance.

Remove names, organizations entered into blanks, contact details, selected answers, dates, amounts, identifiers, responses, results, feedback, signatures, stamps, populated charts, photos, scans, and attachments. Reset user-entered form-control state and visual marks such as checks, highlights, colored schedule bars, or data-bearing borders/fills. Keep logos, watermarks, seals, ornaments, and other fixed design media only when the evidence is strong; use `--keep-media <manifest-id>` on a fresh candidate when necessary. Preserve a removed payload's frame and geometry.

Do not rebuild from screenshots or use office-suite/third-party conversion. The helper edits HWPX packages directly and uses Rauhwpx's native HWP→HWPX→HWP pipeline with verified HWPX fallback. It strips scripts, history, rejected payloads, and unsafe previews, then creates the privacy-safe `Preview/PrvText.txt` and `Preview/PrvImage.png` entries required for publication.

## Completion gates

Hard safety/readability gates must all pass: package readability, approved reusable text, absence of rejected text/private payloads, valid structure, readable representative pages, and no source mutation. If any remains unresolved, publish nothing and complete the job as failed with `stoppedReason: hard-failure`.

Page count, pagination, geometry/render similarity, and native-format differences are fidelity checks. Correct them when useful, but after the bounded ceiling a safe and readable candidate may complete as `best_effort` with precise warnings and `stoppedReason: bounded-no-improvement`. Never classify a privacy or readability failure as best effort.

## Owning chat: one final action

The successful structured completion contains the exact immutable artifact, quality, warnings, counts, and representative preview data. Studio automatically opens that artifact in a new document window as a read-only template preview; do not output a `[템플릿 열기]` link or ask the user to open it.

Report the result concisely, then ask exactly one final question: whether to save/register this exact previewed artifact as a reusable template. If the user accepts, call `register_copy_layout_template` with the completed `jobId` (and a name only if they supplied one). If the user declines, do not call it. Declining leaves the preview open and does not register a template.
