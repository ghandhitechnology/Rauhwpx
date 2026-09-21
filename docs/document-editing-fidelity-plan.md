# Document editing fidelity plan

Status: implemented and locally verified, September 20, 2026. Source baseline: `c69ad4a6`. The implementation evidence and remaining product-level limits are recorded in the closure ledger below.

The first priority is preventing edits to the wrong object and keeping the caret usable after structural changes. Next come text-spacing corrections and missing line styles. Font resolution and shaping are a larger, staged effort because they affect wrapping, pagination, selection, and exports together.

## Scope and decisions

- Keep the existing Rust engine and Studio architecture. Reuse existing document-path, font-resource, and glyph-run types.
- Keep visual comparisons out of CI. Run selected comparisons locally when the affected behavior changes. The user's instruction supersedes the editing-parity README's suggestion of a nightly visual gate.
- Preserve existing HWP compatibility metrics until a focused comparison justifies changing them. Changing the default renderer is outside this plan.
- Preserve original document text, declared fonts, unrelated formatting, and unsupported values through saving. A rendering approximation must not silently rewrite document content.
- Extend selection-to-agent context to images, tables, equations, and mixed selections, retaining exact editable targets and useful previews.
- Each repair needs a behavioral reproduction before implementation. Source-pattern tests and screenshots of an unopened or unedited document are insufficient for editing defects.

## What the investigation established

| Finding | Evidence level | Remaining verification |
| --- | --- | --- |
| Positive spacing enlarges Latin glyph ink | Production Canvas2D helper reproduced in isolation; matching SVG code found | Actual document rendering before/after |
| Nested table commands lose the target path | Command dispatch traced; extracted production command probe | Real WASM mutation and UI sequence |
| Row deletion leaves a stale cursor path | Extracted command probe; history/cursor call chain traced | Typing and undo/redo against the real engine |
| Cell equation property APIs select the first equation | Read/write implementation and dialog callers traced | Selecting and editing a second equation in a fixture |
| Studio disables equation insertion in tables | Explicit command guard; existing engine cell-insertion test found | Wire and verify the complete user interaction |
| Font and equation measurements use approximations | Active measurement/rendering paths inspected | Font-pinned Hancom comparison for each changed case |
| Literal hyphens and certain borders receive substitutions | Measurement and rendering paths inspected | Determine which substitutions are required by existing reference documents |
| Underscore gaps | Plausible font/measurement mismatch, not reproduced in a user document | Obtain or construct the smallest matching document before choosing a repair |
| Selection-to-agent excludes non-body-text selections | Inline prompt uses a body-text-only guard and text-excerpt payload | Object capture, multimodal delivery, and exact-target agent actions |

During the initial audit, 19 existing font-policy, font-substitution, and renderer-session tests passed. The reference manifest validated 50 cases and 695 pages, including 46 Hancom and four diagnostic references. The implementation then added native and WASM builds, focused behavioral checks, full Studio and Rust suites, local native-Skia comparisons, and an official-editor HWPX opening check as recorded below.

## 1. Separate letter spacing from glyph stretching

**Problem.** Canvas2D fits Latin glyphs to an advance that includes tracking and justification. The isolated production-helper probe made 8px ink occupy 10px when the placement advance was 10px. SVG has the same risk through `textLength` with `lengthAdjust="spacingAndGlyphs"`.

Sources: [Canvas2D fitting](../rhwp/src/renderer/web_canvas.rs#L47), [SVG fitting](../rhwp/src/renderer/svg.rs#L3294), [glyph-relative tracking](../rhwp/src/renderer/layout/text_measurement.rs#L50).

**Planned changes.**

1. Expose the spacing-free calibrated glyph advance alongside the existing placement advance. Retain HWPUNIT quantization and language-specific width ratios.
2. Use the spacing-free value for Canvas2D glyph fitting and SVG `textLength`. Continue using the existing placement positions for wrapping, caret movement, selection, and justification.
3. Handle tracking and `extra_char_spacing` separately. Do not subtract raw `style.letter_spacing`: its applied contribution depends on the glyph's base width.
4. Check ordinary text and the outline/shadow rendering branch together. Preserve negative-tracking behavior and intentional font-substitution fitting.

**Acceptance.** In `AV iii WWW 123`, changing only tracking changes gaps without changing glyph proportions. Existing character positions, line breaks, and page count remain unchanged by this painting correction. Verify positive/zero/negative tracking, justification, non-100% width ratio, mixed Korean/English, superscripts, and text inside a cell. Screen and SVG agree.

Extend the existing Canvas2D/SVG fitting unit tests and [word-spacing](../rhwp/tests/editing_parity_word_spacing.rs), [no-op roundtrip](../rhwp/tests/spacing_noop_edit_roundtrip.rs), and [selection bounds](../rhwp/tests/selection_text_ink_bounds.rs) tests. Keep this patch independent of the larger shaping work.

## 2. Make font selection, measurement, and shaping agree

**Problem.** Uncalibrated Latin characters can fall back to `0.5em` measurements while painting uses a proportional substitute. Some registered font names also point to different physical font files, yet the status UI reports the requested name as available. Ordinary Latin text is painted character by character, and current layout deliberately leaves kerning neutral.

Sources: [fallback measurements](../rhwp/src/renderer/layout/text_measurement.rs#L1022), [cluster splitting](../rhwp/src/renderer/layout/text_measurement.rs#L2004), [font loading](../rhwp/rhwp-studio/src/core/font-loader.ts), [font status](../rhwp/rhwp-studio/src/core/document-font-status.ts#L119), [existing measurement policies](../rhwp/src/model/provenance.rs#L12).

**Stage A: resolve the actual face.** Record requested family, loaded face identity, style, substitute status, and metric policy together. Reuse [font face/blob types](../rhwp/src/paint/font.rs). Keep the document's declared name unchanged for serialization. For uncalibrated faces, obtain metrics from the same available face used to paint; keep existing calibrated `HancomWindows` and `HcrDeclared` behavior. Cache by face identity and style, and invalidate layout/rendering when font availability changes. Update existing font-status reporting without adding modal interruptions.

**Stage B: share shaped runs.** Reuse [FontResolver and ResolvedGlyphRun](../rhwp/src/paint/text_shape.rs), including source-cluster mappings. First prove Latin runs with `AV`, `To`, `office`, decomposed accents, and Korean/English boundaries. Feed the resulting geometry into layout, paint, caret/selection, and export; explicitly convert source offsets to the engine's Unicode-scalar contract. Preserve grapheme editing behavior even when a ligature contains multiple characters.

The default [Canvas2D layer replay currently ignores glyph-run and glyph-outline operations](../rhwp/src/renderer/web_canvas.rs#L745). Emitting shaped data alone cannot improve that renderer. Include replay in the proof: use the resolved face's glyph outlines and existing vector drawing primitives for supported shaped runs, with cached outlines and source-text mappings retained. Select one visible text representation per run to prevent duplicate painting. Keep the current text path for unsupported font/effect cases until their replay is implemented. Verify clip, transform, effects, SVG/PDF text extraction, and the absence of blank runs before changing which representation is selected.

Shaping produces font-specific glyph IDs, advances, and offsets; source clusters connect the output back to text for selection and editing. These requirements follow the [HarfBuzz shaping documentation](https://harfbuzz.github.io/shaping-and-shape-plans.html) and [cluster documentation](https://harfbuzz.github.io/clusters.html). They establish the adapter contract, not a decision to add HarfBuzz as a dependency. Select the implementation after a bounded native/WASM proof using the existing interface. Record startup cost, font-byte access, cache behavior, and bundle impact before adopting it.

**Acceptance.** A known proportional uncalibrated face measures `iiii` and `WWWW` differently. Declared names survive saving; substitutions and failed loads are accurately reported. Font-pinned runs produce consistent wrapping and caret/selection geometry across supported renderers and export. Offline reopening and delayed font loading do not leave stale layout. A font unavailable as bytes keeps an explicit deterministic fallback; a family name alone must not be treated as exact-face evidence.

Extend existing `font-substitution`, `font-metrics-policy`, `document-font-status`, `font-loader-offline-mode`, and `canvaskit-font-plan` tests. Compare old and new Hancom reference documents locally before changing calibrated metrics or kerning behavior. Measure a short document and the existing long-document editing workload; investigate any repeatable slowdown before broadening the rollout.

## 3. Address the selected table at every nesting depth

**Problem.** Cell selection retains `cellPath`, but row/column insertion/deletion and merge/split commands call flat APIs. An operation on an inner table can target the outer table.

Sources: [Studio table commands](../rhwp/rhwp-studio/src/command/commands/table.ts#L118), [merge command](../rhwp/rhwp-studio/src/command/commands/table.ts#L548), [nested selection](../rhwp/rhwp-studio/src/engine/cursor.ts#L1278), [existing mutable path resolver](../rhwp/src/document_core/commands/table_ops.rs#L1876).

**Planned changes.**

1. Reuse `resolve_table_mut_by_cell_path` for eight operations: insert/delete row and column, merge, split merged cell, split into N×M, and split a range. Keep flat public APIs as compatible depth-one entry points sharing the same mutation logic.
2. Add typed path methods through `wasm_api.rs`, the Studio bridge, and shared types. Update main dialogs, legacy command IDs, context queries, and last-cell Tab handling to use the same target resolver.
3. Preserve mutation finalization: dirty flags, stale resize-override clearing, raw-stream invalidation, recomposition, pagination, host-paragraph sizing, and page-split rules. Mark affected ancestors dirty. Nested host sizing must use the actual containing paragraph.
4. Keep existing event coordinates valid for outer-document invalidation; add optional path metadata only where an exact-target consumer needs it. Never pair an outer paragraph index with an inner control index as a flat address.
5. Check agent and HwpCtrl callers for compatibility. Update mirrored declarations and capability metadata only where their exposed contracts change. Start with existing full-section invalidation; defer performance optimization.

**Acceptance.** Merge an inner 1×2 table inside an outer 1×2 table: only the inner cells merge. Repeat insert/delete/split inside a textbox and at three nesting levels. Preserve content, formatting, equations, and nested controls. Invalid paths, non-table endpoints, invalid merged-cell overlaps, and deleting the final row/column fail without changing the document. The model currently requires at least one row and column.

Reuse the fixtures and contracts in `issue_7189_nested_table_resize_by_path`, `table_page_split_and_caption_contract`, `issue_1073_nested_table_split`, and `issue_2211_nested_table_row_growth`. Include a table crossing a page boundary with rowspans and repeated headers. Ancestor dimensions may legitimately change, but unrelated cell content and structure must remain intact.

## 4. Remap the caret and selection with structural table edits

**Problem.** Deletion updates flat `cellIndex` but retains the old path, which cursor geometry prefers. Insert and merge can also reorder cells while returning the previous cursor. There is no later repair in the snapshot/cursor path.

Sources: [deletion result](../rhwp/rhwp-studio/src/command/commands/table.ts#L225), [path-first cursor geometry](../rhwp/rhwp-studio/src/engine/cursor.ts#L1218), [snapshot result handling](../rhwp/rhwp-studio/src/engine/input-handler.ts#L3129), [model cell lookup](../rhwp/src/model/table.rs#L619).

**Planned changes.** Resolve the post-edit cell from logical row/column coordinates and the rebuilt model grid. Cells have no stable IDs; adding a persistent identity system is unnecessary for this repair. Return the remapped target with the mutation, or use a small path-aware model query. Do not derive identity from rendered bounding boxes, which may contain multiple page fragments.

| Operation | Caret rule |
| --- | --- |
| Insert row/column | Stay in the same original cell after its coordinates shift |
| Tab creates a row | Move to the first cell in the new row |
| Delete row/column | Stay in the surviving original cell, otherwise choose the nearest surviving cell at the deleted coordinate |
| Merge | Move to the surviving top-left cell at paragraph 0, character 0 |
| Split | Move to the top-left resulting cell containing the original content |

Update the full path, flat compatibility fields, selection state, and geometry cache together. Preserve paragraph/character offsets when their containing cell and paragraph survive without reordering; otherwise clamp them or use the explicit operation rule above. Merge deliberately resets to the surviving cell's start because paragraphs from other cells are appended and their old indices no longer identify the same text. Construct new path arrays rather than mutating arrays stored in undo history. Keep one snapshot per user operation, including multi-row insertion, and roll back both content and cursor on failure.

**Acceptance.** Delete the last row of a 2×2 table with a path-addressed caret in its last cell. Both flat and path cell indices become `1`; typing goes into the surviving cell. Test insert-before, delete-column, merge with a bottom-right anchor, split, undo, redo, and mutation failure. Include merging with the caret in the second paragraph of a non-primary cell: it lands at the specified surviving-cell start; undo restores the original paragraph and offset. Before/after history paths remain independent. The caret stays on the correct visible fragment of a split table.

Replace the source-pattern assertions in [table-delete-cursor-1483.test.ts](../rhwp/rhwp-studio/tests/table-delete-cursor-1483.test.ts) with behavioral coverage once the new tests cover its intent. Extend `table-keyboard-navigation` and `command-history-snapshot`. Ship this together with the structural path work where they share mutation results.

## 5. Give equations exact targets and enable cell insertion

**Problem.** Cell equation property lookup and mutation use the first equation in a cell paragraph. Mixed-text and equation-only cell renderers also disagree about whether `control_index` means the outer table or inner equation. Studio disables insertion in tables even though the engine already has `insert_equation_in_cell_native`. Body insertion creates an empty equation before opening the dialog; Cancel/Escape only hides it, and confirmation creates a second history entry.

Sources: [first-equation lookup](../rhwp/src/document_core/commands/object_ops/equation.rs#L47), [first-equation mutation](../rhwp/src/document_core/commands/object_ops/equation.rs#L105), [Studio insertion guard](../rhwp/rhwp-studio/src/command/commands/insert.ts#L189), [existing cell-insertion coverage](../rhwp/tests/pr_agent_cell_equation.rs).

**Planned changes.**

1. Add the equation's own inner control index to `EquationNode` and render-query JSON. Normalize all constructors in paragraph, table, and partial-table layout: a cell equation's outer index identifies its table; its separate inner index identifies the equation. Body equations retain their existing address.
2. Carry that identity and the containing path through `ControlLayoutItem`, `ObjectRef`, object-address equality, hit-testing, both equation dialogs, property APIs, and deletion. Preserve the existing exact inner index in note references. Add exact-target property methods or a compatible optional index; migrate every known interactive/agent object caller to the exact form. Newly emitted references must not fall back to a first-equation scan.
3. Split the dialog into create and edit modes. Create mode holds an insertion intent and previews without document mutation. Confirmation validates the current nonblank script and inserts the completed equation in one snapshot. Cancel/Escape discards the intent. Edit mode retains one property-change snapshot. Revalidate the captured insertion address if the document revision changed while the dialog was open.
4. Wire the existing cell-insertion capability into Studio for ordinary cells. Use the returned inner `controlIdx` to select the new equation. Deliver that supported case first, then extend exact addressing/insertion to deeper paths through the same paragraph resolver; keep unsupported contexts disabled until their acceptance checks pass.
5. Preserve control offsets, inline marker counts, ancestor invalidation, reflow, and serializer invalidation. Keep one undo step for creating a completed equation.

**Acceptance.** Put two different equations in one cell paragraph. Editing or deleting the second changes only the second. Mixed-text and equation-only cells report consistent outer/inner identities even when those indices differ. Repeat in a nested table when the path extension lands. Insert between surrounding text, cancel, confirm, undo, redo, save, and reopen. Cancel/Escape preserves document digest and undo depth; one undo removes a confirmed creation. Confirm surrounding text, equation index, and cursor remain correct. Existing agent cell-equation calls still work. Test body equations and supported note/textbox contexts to prevent context-routing regressions.

Extend `pr_agent_cell_equation`, `issue_1061_equation_serialize`, `equation-editor-undo`, and `equation-props-undo` with exact-target and cancellation assertions. A full UI reproduction must verify that selection supplies the same exact address used by the engine.

## 6. Use the intended equation face and measured glyph widths

**Problem.** Equation layout assigns fixed ratios to character categories. The SVG/default Canvas2D equation path uses its own font chain; CanvasKit uses its default typeface and fits it to estimated widths. Preserving `fontName` in the file does not make the displayed equation use that face.

Sources: [equation width estimates](../rhwp/src/renderer/equation/layout.rs#L1217), [SVG font chain](../rhwp/src/renderer/equation/svg_render.rs#L10), [Canvas2D equation rendering](../rhwp/src/renderer/equation/canvas_render.rs), [equation properties](../rhwp/src/document_core/commands/object_ops/equation.rs#L129).

**Planned changes.** Add the saved equation font to `EquationNode`, every constructor, layer serialization in `paint/json.rs`, and Studio's `LayerEquationOp`. Carry its resolved face through preview and each renderer, including the default `web_canvas.rs` to `equation/canvas_render.rs` call. Resolve prepared typefaces once per equation for CanvasKit; quote CSS font-family values safely for browser text drawing. Use actual advances for text/identifier runs through the font work in issue 2, while retaining the equation parser and structural box layout. Font propagation alone does not close this issue if positions still use synthetic widths. Keep calibrated symbol/operator placement until reference samples justify changes. Recompute intrinsic size and baseline through shared equation layout, preserving explicit object-size and anchoring semantics.

**Acceptance.** Compare `iii`, `WWW`, digits, functions, fractions, radicals, large operators, scripts, and matrices using fixed available fonts. Dialog preview and document agree on geometry and face selection. Changing font/size or equation content keeps the inline baseline and surrounding line height correct. Missing fonts use a consistent substitute across preview, screen, and export. Save/reopen preserves the declared equation font and object settings.

Use `mixed-exam-math` and a minimal equation fixture for local comparisons. Do not alter stored baseline rules solely because a property appears unused: existing equation baseline tests protect fixes for tall operators and fractions. Establish the reference behavior before changing those rules.

## 7. Separate literal characters, form blanks, and text decoration

**Problem.** Three consecutive literal hyphens are treated as a leader in width measurement, justification, and painting. Splitting text into style runs can change that interpretation. Underscores remain individual glyphs; actual underlines use separate drawing code with fixed offsets and stroke sizes. The reported underscore breakage still needs a minimal reproduction.

Sources: [hyphen detection](../rhwp/src/renderer/layout/text_measurement.rs#L1943), [leader justification](../rhwp/src/renderer/layout/paragraph_layout.rs#L1549), [Canvas2D replacement](../rhwp/src/renderer/web_canvas.rs#L2331), [SVG replacement](../rhwp/src/renderer/svg.rs#L2787), [underline geometry](../rhwp/src/renderer/web_canvas.rs#L3398).

**Planned changes.**

1. Build a local fixture with literal `_____`, literal `---`, tab leaders, and actual underlining. Include a font change, bold/color boundary, trailing spaces, wrapping, and body/cell placement. Capture Hancom output under a recorded font setup.
2. Determine whether each failure comes from font advances, decoration segmentation, clipping, or the compatibility substitution. Fix the measured cause; do not globally connect underscore glyphs or replace text with drawing objects.
3. Compute one leader/decoration interpretation before backend painting and use it consistently in measurement and rendering. Prefer real tab-leader metadata. Retain only reference-supported legacy hyphen behavior under the existing compatibility policy.
4. Share decoration geometry across Canvas2D, SVG, and applicable layer/native paths. Respect explicit style boundaries, line breaks, and HWP decoration semantics. Measure size-dependent offsets/thickness before replacing fixed values.

**Acceptance.** Literal text remains identical in copy/export/save. Harmless run segmentation does not turn text into a different kind of line. True leaders and underline spans match the reference at multiple font sizes and zoom levels, including line endings and split cells. Existing form blanks retain their layout. Close the underscore issue only after its reproduced symptom passes; the hyphen fix alone is insufficient.

## 8. Preserve distinct table border styles

**Problem.** Wave and DoubleWave reach a solid-line fallback; LongDash collapses to Dash and Circle to Dot. Double/triple borders already have dedicated rendering and should retain it.

Sources: [border construction](../rhwp/src/renderer/layout/border_rendering.rs#L480), [lossy mapping](../rhwp/src/renderer/layout/border_rendering.rs#L959), [limited dash representation](../rhwp/src/renderer/mod.rs#L390).

**Planned changes.** Represent the missing border geometry through existing line/path render nodes. Generate oriented wave paths for horizontal and vertical edges. Preserve long-dash patterns and circular dot caps through the shared paint representation; extend it only where existing nodes cannot express them. Keep shared-edge conflict resolution, border-width conversion, corners, clipping, and page-split ownership unchanged. Update render bounds if wave amplitude extends the visible border.

**Acceptance.** A border-style sheet shows distinct solid, dash, long dash, dot, circle, wave, double wave, and existing multiple-line styles. Compare cell interiors/shared edges, merged cells, nested wrappers, vertical edges, and page splits. Screen/SVG/PDF preserve the same style, and saved style enums remain unchanged. Reuse [nested-border tests](../rhwp/tests/issue_nested_table_border.rs) and add focused geometry assertions plus local cropped comparisons.

## 9. Preserve loaded underline and strikeout styles in the dialog

**Problem.** The character dialog only lists values 0–10, although rendering supports wave values 11–12. A missing selection can produce `NaN` during change collection. JSON turns that into `null`, which the Rust integer helper ignores, but the presence of a change can still enable underline/strikeout flags. Exact saved-file impact requires a behavioral reproduction.

Sources: [dialog options](../rhwp/rhwp-studio/src/ui/char-shape-dialog.ts#L503), [change collection](../rhwp/rhwp-studio/src/ui/char-shape-dialog.ts#L974), [integer parsing](../rhwp/src/document_core/helpers.rs#L709), [placeholder semantics](../rhwp/src/parser/doc_info.rs#L508).

**Planned changes.** Add the supported wave options 11–12. Preserve unknown loaded values as unchanged values, and only emit finite valid changes after an intentional selection. Keep decoration enablement independent of an unrepresentable shape. Values 13–15 can be placeholders, including a no-strike sentinel; preserve them without inventing new visible line styles.

**Acceptance.** Open and confirm the dialog on styles 11, 12, and a placeholder without editing: the model, enabled flags, and serialized attributes remain unchanged. Changing an unrelated font/color setting also preserves them. Selecting a supported style intentionally changes only the requested properties. Verify HWP and HWPX behavior using [strikeout parity coverage](../rhwp/tests/hwp5_strikeout_shape_parity.rs) and a real dialog behavior test.

## 10. Surface equation parse problems and verify export syntax

**Problem.** The engine preview returns parser warnings, but the dialog reads only the SVG. Confirmation checks script length and can save a tolerant parse without presenting its problems. Separately, LaTeX mode inserts templates whose raw script is saved; official-editor compatibility of those extensions has not been established by this audit.

Sources: [preview warning contract](../rhwp/src/document_core/commands/object_ops/equation.rs#L236), [dialog preview](../rhwp/rhwp-studio/src/ui/equation-editor-dialog.ts#L701), [confirmation](../rhwp/rhwp-studio/src/ui/equation-editor-dialog.ts#L725), [parser](../rhwp/src/renderer/equation/parser.rs).

**Planned changes.** Put preview-result parsing in a shared typed bridge contract used by the dialog and agent tooling. Preserve the existing string `warnings` field and raw-SVG compatibility handling; add structured diagnostic codes/severity as an additive field if needed. Show concise inline feedback beside the equation input. Associate each result with the current script revision so a delayed preview cannot validate newer text. Validate the current draft again on confirmation. Distinguish fatal/incomplete structure from tolerated unknown commands; preserve unchanged imported scripts and avoid rejecting every parser warning. Apply the same validation rules in the agent equation gate. Allow saving tolerated syntax through an explicit, understandable action where appropriate.

For export syntax, first capture small HWP-script and LaTeX-mode fractions, matrices, and scripts, save as HWP/HWPX, and open them in the official editor. Record application version and the actual accepted syntax. If supported extensions fail, add AST-to-canonical-EqEdit conversion at the edit/commit boundary for affected new/changed expressions. Preserve unchanged imported script and reject or explain unsupported conversion without flattening it silently. If the official editor accepts the scripts, record that result and avoid adding unnecessary conversion code.

**Acceptance.** Unknown commands, mismatched braces, empty groups, and depth-limit warnings have the intended severity and visible feedback. Correcting the draft clears stale errors. Cancel changes nothing. Valid HWP scripts and supported LaTeX templates survive save/reopen in both apps with equivalent structure. The exact official-editor syntax question remains open until the local experiment runs.

## 11. Send images, tables, equations, and mixed selections to agents

**Problem.** The inline agent chip calls `currentBodySelection`, rejects cell selections, and extracts only body text. Its payload contains a label, excerpt, and text context block. Studio already exposes selected object references, selected tables, and cell ranges, but this feature does not consume them. An image or equation can therefore be selected in the editor without becoming usable context for the agent.

Sources: [inline selection guard and capture](../rhwp/rhwp-studio/src/agent/inline-prompt.ts#L237), [current context contract](../rhwp/rhwp-studio/src/agent/inline-prompt-context.ts), [sidebar submission](../rhwp/rhwp-studio/src/ui/agent-sidebar/index.ts#L8429), [object selection access](../rhwp/rhwp-studio/src/engine/input-handler.ts#L4847), [table and cell selection access](../rhwp/rhwp-studio/src/engine/input-handler.ts#L5460), [agent selection query](../rhwp/rhwp-studio/src/agent/tool-executor.ts#L910).

**User experience.** Selecting an image, table, cell range, equation, or supported collection exposes the existing agent action near the visible selection. The prompt shows compact identifiable previews, such as an image thumbnail, table dimensions and selected rows, or the rendered equation. The user can ask about or edit that exact selection without manually describing its location. Opening or dismissing the prompt neither edits the document nor sends a message.

| Selected element | Context delivered to the agent |
| --- | --- |
| Text | Existing text/range context, extended to addressable cell text with an explicit offset convention |
| Image | Exact object reference, image resource or provider-readable attachment, intrinsic size, displayed crop/rotation, and relevant caption/alt text; a thumbnail alone is insufficient |
| Whole table | Exact table path, dimensions, merged-cell structure, bounded cell content, and relevant formatting |
| Cells within a table | Explicit selected row/column bounds and merged-cell membership, preserving the distinction from selecting the whole table |
| Equation | Exact equation reference, original script, font/size, and rendered preview, including equations inside cells |
| Multiple objects or mixed text/objects | An ordered list of typed items, preserving scope and excluding duplicate captures of the same element |

**Planned changes.**

1. Replace the body-only capture branch with a shared typed selection snapshot. Read existing text, object, table, and cell-range selection APIs; let their active selection mode determine the target instead of treating an empty text range as no selection. Reuse full table paths and exact equation identities from issues 3–5. Include document/session identity, captured revision, item type, exact address, and preview metadata. Preserve the plain-text payload's compatibility.
2. Capture semantic content through existing engine queries and document resources. Extract image bytes or an accurate rendered appearance through the existing attachment/resource flow. Keep table structure and equation script available alongside previews so the agent can perform edits rather than infer structure from a screenshot. Explicitly distinguish scalar text offsets, logical offsets, and control indices.
3. Replace cursor-only chip anchoring with the active selection's visible object bounds or cell-range fragment. Preserve selection while the prompt gains focus; support zoom, scrolling, split tables, keyboard invocation, and Escape. Show selected item types/counts and allow removing individual captured items. Mixed capture should reuse existing selection capabilities rather than require a new drawing/selection system.
4. Extend `InlinePromptSubmission` and the sidebar send path to carry typed context plus prepared attachments. Reuse `stageDraftFiles` in the [reference library](../rhwp/rhwp-studio/src/ui/agent-sidebar/reference-library.ts#L486) and `sendUserMessage` with staged reference IDs in the [bridge](../rhwp/rhwp-studio/src/agent/bridge.ts#L2835). The existing [reference tools](../rhwp/rhwp-agent/reference-tools.mjs) expose `read_reference_image`, allowing the agent to retrieve actual MCP image content; retain this route rather than inventing inline-base64 prompt transport. Prepare resources asynchronously with a cancellable pending state; preserve the draft and selection after preparation/send failure, and prevent duplicate sends. Record the same selected items in the user's chat message for later inspection. Removing a captured item also discards its staged resource.
5. Give agent tools a consistent way to resolve the captured targets, extending the existing selection/object contracts where needed. Current `get_selection` treats nested cell paths as diagnostic only; do not promote those paths to writable targets until the corresponding exact-path operations exist. A later cursor move must not change the captured request. Revalidate document identity and revision before an edit, using the existing expected-revision contract; if indices shifted, resolve an unambiguous target or request reselection instead of editing the new occupant of an old index.
6. Keep payloads bounded using existing text/image/reference limits. Send a summary plus scoped resource references for large tables or multiple images, with an explicit truncation marker and a way to read the remainder. Keep selected document content separate from the user's instruction. A provider without image input still receives structural metadata and available descriptions, with its image limitation visible rather than silently dropping the attachment.
7. Preserve current execution routing, planning/read-only restrictions, staged edits, and undo behavior. Adding a selected object is context for the prompt, not permission to change unrelated objects. Do not expand cloud/provider support as an incidental part of this work; ensure each currently supported route preserves the new context end to end.

**Delivery.** First add the shared context contract and ordinary image/table/equation capture, retaining existing text behavior. Add cell ranges, nested elements, and mixed selections through the same contract as their exact targeting becomes available. This depends on issues 3–5 for reliable nested edits and equation identity, but not on the font/shaping work. Structures or shapes already exposed by object selection may use the same representation once their capture and targeting checks pass; the required initial coverage is images, tables, equations, and mixed selections.

**Acceptance.**

- Select an image and ask the agent to describe it: the transport contains accessible image content, not only a filename or generic object label. Select a cropped/rotated image and preserve what the user sees plus its original object address.
- Select a whole table, then a cell range: the two requests carry different explicit scopes. A request to change selected cells leaves other cells unchanged, including merged and nested cases.
- Select the second equation in a cell paragraph and request a change: the exact script/reference is sent and only that equation changes. Its preview accompanies the request where the provider supports image input.
- Send a mixed selection containing text, an image, a table, and an equation without losing or duplicating elements. Focusing the prompt and moving the caret afterward does not silently replace the captured selection.
- Modify/delete a captured object, switch documents, or undo before sending/executing: stale references cannot target another object. Cancelling selection capture leaves both document digest and undo depth unchanged.
- Exercise missing resources, oversized selections, attachment failure, disconnect/retry, and providers with/without image support. Drafts survive recoverable failure, messages are not duplicated, and unsupported image input is visible.
- Keep existing plain-text selection behavior working. Agent edits still use the current review/undo flow, and reopening the chat preserves identifiable selection context.

Extend [agent-inline-prompt tests](../rhwp/rhwp-studio/tests/agent-inline-prompt.test.ts), [inline-prompt E2E](../rhwp/rhwp-studio/e2e/inline-prompt.test.mjs), and [agent image/equation tests](../rhwp/rhwp-studio/tests/agent-image-equation.test.ts), together with existing `agent-reference-ui`, `reference-message-gate`, `reference-image`, and `reference-tools` tests as affected. Add focused contract tests for captured item payloads, transport attachments, exact references, and stale revisions, plus local real-WASM interaction checks. Update typed sidebar preview fixtures for the new context cards and attachment states; when shipping sidebar behavior, run the existing sidebar tests/build as required. Visual comparisons remain local.

## Delivery order and dependencies

| Batch | Issues | Completion boundary |
| --- | --- | --- |
| A | 3 + 4 | Nested structural edits, caret, selection, and undo/redo are correct together |
| B | 5 | Exact equation targeting, cell insertion, and cancellation are reliable |
| C | 1 | Tracking no longer stretches glyphs in Canvas2D or SVG |
| D | 8 + 9 | Missing border styles render distinctly; formatting dialogs preserve loaded styles |
| E | 2 stage A, then stage B; 6 follows shared font support | Resolved fonts first, then shaped text, then equation text metrics, in separate reviewable changes |
| F | 7 + 10 | Reproduced form-line failures and equation feedback/export cases pass their local reference checks |
| G | 11; exact nested actions depend on 3–5 | Image, table, equation, cell-range, and mixed selections reach the agent with content and correct targets |

Independent small fixes can proceed concurrently. Do not make targeting repairs or selection-to-agent support wait for the font work; batch G can start alongside A/B and complete its nested-edit cases afterward. Split batches further when a review would combine unrelated behavior. Each implementation change should link its issue here and record its actual reproduction, tests, and remaining limitations.

## Verification and closure

Use small deterministic tests for address selection, cursor remapping, spacing arithmetic, and preservation. Use the real WASM engine for the corresponding edit/undo/save sequence. Extend the existing test suites; avoid tests that merely assert source text or implementation shape. Rebuild WASM when native APIs or Rust rendering code change.

Run visual checks locally on affected pages. Begin with `table-complex`, `table-giant-nested`, and `mixed-exam-math` as relevant, then add the minimal English/line fixtures. Record font files/identities, metric policy, renderer, zoom/DPR, source hash, and build revision. Existing PDFs validate opening/layout; edited output needs the same edit performed in Hancom and a separately captured reference. Do not compare changed content against an unedited PDF or update a pinned oracle to make a repair pass.

Useful existing commands, to run during implementation rather than as part of this planning change:

```sh
# Fast corpus integrity check.
python3 rhwp/tools/editing_parity/validate.py

# Example local visual comparison after preparing the native renderer.
python3 rhwp/tools/editing_parity/batch_visual_compare.py \
  --case table-complex --pages 1

# Existing focused Rust checks, selected according to the actual patch.
cd rhwp
cargo test --locked --test pr_agent_cell_equation
cargo test --locked --test editing_parity_word_spacing
cargo test --locked --test hwp5_strikeout_shape_parity
```

The commands start at the repository root, then switch to `rhwp/` for Rust fixture tests. The comparator's native-Skia and Python prerequisites are documented in the [existing guide](../rhwp/tools/editing_parity/README.md). Its native results supplement the default Canvas2D Studio checks; they do not replace them. Browser editor checks require the full Studio/WASM setup, not the sidebar-only preview.

An issue is fixed only when its original reproduction fails before the change and passes afterward, its acceptance conditions above pass, and the relevant undo/redo/save/reopen sequence preserves unrelated content. Mark a visual issue verified only after reviewing the affected local comparison. Visual comparison remains a local verification step; no CI workflow runs it.

## Implementation closure ledger

| Issue | Implemented result | Verification evidence |
| --- | --- | --- |
| 1. Letter spacing | Painting now separates calibrated glyph ink width from placement spacing in Canvas2D and SVG. | Positive, zero, and negative spacing tests; selection bounds and roundtrip spacing suites. |
| 2. Font selection and shaping | Document-scoped exact-face resolution and Rustybuzz shaping now feed layout, pagination, caret, selection, hit testing, links, exports, and equation text. WebCanvas keeps eligible kerning and ligature text in one fitted native run; positioned cases use the established fallback. TTC aliases share one resolved face index. | Deterministic embedded fixture covers `AV`, `To`, `office`, decomposed accents, and Korean/English boundaries; native and WASM checks pass. |
| 3. Nested table targeting | Insert/delete row and column, merge, split, split-into, and range split resolve the complete cell path at every nesting depth. | Nested table mutation integrations and exact logical-cell lookup tests. |
| 4. Structural caret remap | Structural mutations remap flat fields and full paths together; last-cell Tab inserts a row and lands in its first cell. | Behavioral cursor remap, merged terminal-cell, nested mutation, and undo snapshot coverage. Obsolete source-only deletion coverage was removed. |
| 5. Exact equations | Equation references retain outer table identity plus exact inner control index. Create mode is transactional, supports flat and nested cells, and creates one undo entry. | Multi-equation exact-target tests, nested insert/edit/delete, cancel, undo/redo, save/reopen, and real-WASM cell-equation suites. |
| 6. Equation face metrics | Saved equation families flow through preview and renderers, and text runs use the shared resolved face metrics. | Equation layout/render tests and native/WASM builds. |
| 7. Literal lines and decorations | Literal hyphens and underscores remain text; line substitution is metadata-driven, and decoration geometry is shared. | Literal line, spacing, underline, and renderer geometry tests. |
| 8. Table borders | Long dash, circle, wave, and double-wave styles retain distinct shared path geometry across orientations. | Focused geometry plus nested and split-table border coverage. |
| 9. Dialog preservation | Wave values 11–12 are selectable; unknown loaded values remain unchanged and non-finite changes are not emitted. | Dialog behavior tests and HWP strikeout roundtrips. |
| 10. Equation diagnostics/export | Preview diagnostics are typed and revision-safe. Unchanged EqEdit stays byte-preserved; changed expressions are canonicalized only in explicit LaTeX mode. Unsupported styles fail visibly. | Canonical serializer tests, 23,202-script corpus scan, HWPX roundtrip with zero IR differences, and Hancom Office HWP 12.30 opening the canonical `{1} over {2}` result without an error dialog. |
| 11. Selection to agents | Text, cell text, images, tables, cell ranges, equations, and mixed selections carry bounded typed context and exact addresses. Image/equation previews use cancellable staged resources; capture/send failures preserve the draft and selection. Stored chats restore the typed selection. | Unit, sidebar, and browser E2E coverage for attachments, scope, stale revisions, failure/retry, cell logical offsets, and persistence. |

Local native-Skia review used page 1 of `table-complex`, `table-giant-nested`, and `mixed-exam-math` at 96 DPI. Pixel matches were 92.96%, 89.79%, and 97.21%; the side-by-side review images showed complete content and expected baseline font/layout differences. The 50-case manifest still covers 695 pages. Generated comparison artifacts remain local and untracked.

Per-fix baseline and implementation screenshots are collected in [document editing fidelity visual evidence](screenshots/document-editing-fidelity/README.md). They were captured from separate Studio and WASM builds; the table and caret callouts are derived from the live engine state.

The official-editor check also exposed a separate converter defect: a full `exam_math.hwp` to HWPX export passes the internal IR/page verifier but Hancom 12.30 rejects the package. The focused `math-001.hwpx` equation roundtrip and the canonical fraction experiment both open correctly. Full HWP-to-HWPX package compatibility is tracked separately from these editor fidelity changes and is not used as evidence for issue 10.
