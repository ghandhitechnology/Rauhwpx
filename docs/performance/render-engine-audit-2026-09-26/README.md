# Rendering engine audit — 2026-09-26

Branch: `feat/long-document-render-efficiency`

Audited commit: `cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779`

## Recommendation

Make the existing lowered `PageLayerTree` the shared unit of page preparation. Build it once for a page's current rendering state, then use it for plane summaries, image metadata, Canvas2D replay, and JSON export. This is the strongest measured opportunity in this audit. Fix invalid-page allocation and pending fallback-image reuse alongside it. Follow with negative-result normalization caching. Actual pagination early exit belongs in a later, separately validated change.

This draft PR contains only this report: findings, measured evidence, primary-source references, and proposed implementation steps. Engine changes and the local diagnostic source are excluded. All implementation steps below are proposals; the measurements describe the audited commit.

## Existing architecture to preserve

The pipeline already separates document composition and pagination, semantic `PageRenderTree`, paint lowering through `LayerBuilder`, and backend replay. It already has scoped invalidation, borrowed semantic-tree access, a 32-page render cache, up to four JSON variants per page, explicit output profiles, shaping-font support, weighted image caches, static/dynamic paint planes, and revision-guarded deferred pagination. These are foundations for the work below, rather than features that need to be introduced from scratch.

Relevant implementation: [paint preparation](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L632), [JSON caching](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L1581), [scoped invalidation](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L5410), and [borrowed tree access](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L5580).

## Findings

### 1. Validate page indices before growing the render cache

**Priority: P1. Reproduced against the current native library.**

`build_page_tree_cached` expands its `Vec` to `page_num + 1` before `build_page_tree` checks whether the page exists. This is reachable through `get_page_control_layout_native`, the exported render-tree query, and the legacy Canvas route. A rejected request can allocate and retain a large empty cache backing store.

The bounded probe first renders a real one-page document, then calls each API with an invalid index on a fresh document. Total allocator requests during the rejected call were:

| Invalid zero-based page | Control-layout query | Layer-tree query using the borrowed path |
| --- | ---: | ---: |
| 64 | 47,919 bytes | 5,799 bytes |
| 512 | 338,223 bytes | 5,799 bytes |
| 4,096 | 2,660,655 bytes | 5,799 bytes |

For index 4,096, the single largest allocation was 2,654,856 bytes. These are allocator-request measurements, not process RSS. Very large indices were not executed. The unbounded growth follows directly from the index-dependent resize.

**Patch:** use a non-growing cache lookup, build/validate on a miss, and insert only a successful tree. The borrowed helper already follows that ordering. Prefer borrowed access for control-layout queries too, since they only inspect nodes. Preserve the existing `PageOutOfRange` behavior. A lasting regression test should verify that rejected indices do not grow cache storage; asserting only that an error is eventually returned would miss this bug.

Evidence: [resize before validation](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L5553), [control-layout caller](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L2730), [exported render-tree caller](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/wasm_api.rs#L811).

### 2. Retain lowered paint operations across consumers

**Priority: first performance change. Repeated work confirmed in source and measured natively.**

Every `build_page_layer_tree_with_profile` call scans visible text to discover font slots, loads bounded embedded-font data, resolves faces, and runs a new `LayerBuilder`. Reusing the semantic tree avoids rebuilding layout, but does not avoid this lowering work. Every filtered WASM Canvas call invokes this method again.

The overlay-summary query also builds a full lowered tree before collecting its small result. Studio obtains that summary, renders flow and applicable overlays, and may fetch and parse the full layer JSON again to obtain flow-image operations. Static-layer reuse can skip some consumers; the number of builds depends on the page and repaint reason. This audit does not claim a fixed number of builds for every frame.

The existing JSON cache works: it is much cheaper than lowering in the probe. It does not serve direct Canvas lowering or the overlay-summary path.

| Fixture / displayed page | Full lowering | Overlay summary | Warm JSON cache | JSON bytes |
| --- | ---: | ---: | ---: | ---: |
| `issue1994_behindtext_table_20200830.hwp` / 2 | 1.344 ms | 1.339 ms | 0.023 ms | 1,048,320 |
| `basic-table-01.hwpx` / 1 | 0.052 ms | 0.054 ms | 0.0007 ms | 50,220 |
| `issue1949_giant_cell_nested_tables_perf.hwpx` / 58 | 0.288 ms | 0.291 ms | 0.0054 ms | 442,023 |

These are native debug-library medians, with three warmups and 21 samples per operation. They include destruction of returned values, exclude document loading, and are not browser frame times or an end-to-end speedup estimate. The giant-cell document produced 115 pages; only page 58 was timed.

**Patch design:** start with one immutable prepared-page record containing the existing operation tree and derived summary/image metadata. All consumers of the same rendering state share that record. On single-threaded WASM, an `Rc` snapshot can release the cache's `RefCell` borrow before invoking browser APIs. Avoid deep-cloning the complete tree to share it.

Use page-specific invalidation plus profile and output-option identity. Account for changes to resolved fonts, external image data, compatibility projection, page geometry, and header/footer preview context. Extend the existing invalidation paths; a document-wide edit generation alone would unnecessarily evict unaffected pages. Retention across frames should have a byte budget, including separately referenced image/font resources. Do not hold an interior-mutability borrow across re-entrant JavaScript.

Generate the overlay summary and compact flow-image list from the prepared record. This removes the repeated lowering and the full JSON parse used solely to find images. Keep the public JSON API for debugging and consumers that need it.

Evidence: [lowering and font discovery](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L632), [summary lowering](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L1866), [filtered WASM replay](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/wasm_api.rs#L157), [Studio paint sequence](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/rhwp-studio/src/view/page-renderer.ts#L130), [flow-image JSON parse](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/rhwp-studio/src/view/page-renderer.ts#L654).

### 3. Reuse pending fallback images; separate loading from drawing

**Priority: P2. Control-flow defect confirmed; delayed-image browser reproduction remains outstanding.**

After synchronous bitmap decoding fails, `draw_image` checks the HTML image cache. It returns only for an image that is complete and has a positive natural width. A cached image that is still loading falls through to conversion, Base64 encoding, creation of another `HtmlImageElement`, and replacement of the pending entry. This contradicts the adjacent comment promising reuse before loading completes. SVG/WMF and other browser-fallback formats are the relevant path; successfully decoded bitmap canvases return earlier.

**Patch:** distinguish pending, ready, and failed resource states. Retain a pending element, draw only a ready one, and make retry behavior for failure explicit. Integrate readiness with the existing rerender job and cancellation checks. Do not redo WMF conversion or data-URL construction for each pending draw.

`draw_image_cropped` also delegates its cache-miss path to the uncropped drawing method. If that method draws immediately, it uses the uncropped destination overload. Split resource acquisition from drawing so readiness cannot select the wrong crop operation. The possible incorrect frame is a source-backed conditional finding, not a reproduced screenshot.

Evidence: [pending-entry fallthrough](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/renderer/web_canvas.rs#L2927), [replacement](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/renderer/web_canvas.rs#L2963), [crop fallback](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/renderer/web_canvas.rs#L3033).

### 4. Memoize the result that no normalization is required

**Priority: P2. Repeated scanning confirmed in source; contribution to edit latency not isolated.**

`compute_render_normalized` reuses an entry only when it contains a projection with a matching source revision. A section that needs no projection stores `None`, which is indistinguishable from an unevaluated section. It therefore repeats floating-image-stack and table-cell scans on subsequent calls. Eligible compatibility branches can additionally clone paragraphs while determining that no projection is needed.

**Patch:** represent an evaluated result separately from its optional projection, for example a revision-tagged entry whose projection may be absent. Reuse both positive and negative results. Keep source-format, geometry, style/font, and section/path mutation dependencies correct. Global dirtying already advances section revisions; validate every relevant mutation path before relying on negative entries.

Do not replace a negative result with cloned unchanged paragraphs. That would fix the repeated scan by introducing avoidable retention. Keep the existing historical normalization predicates and metrics unchanged.

Evidence: [state representation](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/mod.rs#L140), [positive-only reuse](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L4627), [negative result](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L4680), [global revision invalidation](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L3391).

### 5. Reduce transient image memory before cache admission

**Priority: P2. Allocation order confirmed; no oversized-image failure was induced.**

`decode_image_to_canvas` decodes a `DynamicImage`, calls the borrowing conversion `to_rgba8`, constructs browser `ImageData`, and creates a canvas before the decoded-canvas cache accounts for its pixels. The cache's 16,777,216-pixel budget is a retention policy, not a bound on all these transient allocations. Its policy deliberately permits one oversized retained entry; that behavior should not be described as an accidental LRU bug.

The installed `image` 0.25.10 source was checked: `load_from_memory` uses `ImageReader`, whose default limits include a 512 MiB allocation limit. Additional application-specific admission and accounting for conversion copies are still needed.

**Small patch:** use the consuming `into_rgba8` conversion because the decoded image is not used again. This can reuse an existing RGBA8 buffer and preserves pixel values. **Separate policy work:** inspect dimensions and estimate transient bytes before decoding, pass explicit decoder limits, and account for WASM and browser buffers. Audit fallback paths so rejecting a native decode does not silently bypass the same policy through HTML decoding. Changing which large images are accepted requires its own compatibility decision; it is not automatically appearance-preserving.

Evidence: [decode/conversion order](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/renderer/web_canvas.rs#L273), [pixel budget](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/renderer/web_canvas.rs#L45), [existing encoded-image header support](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/renderer/image_header.rs#L31). Dependency evidence: `image-0.25.10/src/io/limits.rs:50` and `src/images/dynimage.rs:1676` in the installed Cargo registry.

The existing admission policies also differ: the Rust CanvasKit header helper uses an 8,192-pixel dimension ceiling, while the Studio TypeScript helper uses 16,384 pixels. Both use a `32 * 1024 * 1024` (33,554,432-pixel) budget. Studio additionally limits encoded data to `64 * 1024 * 1024` bytes. Inventory the callers and fallback behavior before reconciling these policies; reducing the accepted set could hide an image that currently renders. Evidence: [Rust admission constants](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/renderer/image_header.rs#L3) and [Studio admission constants](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/rhwp-studio/src/view/canvaskit/image-header.ts#L6).

### 6. Pagination convergence currently verifies potential reuse after doing the work

**Priority: later architectural experiment. Source-confirmed behavior; no speedup measured.**

The current pagination path completes typesetting and then checks convergence when paragraph-count offset is nonzero. It flattens old and new page items into temporary vectors, verifies the suffix, and logs how many pages could be reused. It does not stop typesetting early there. `copy_converged_pages` exists, but the search of `rhwp/src` found only its definition.

This explains why a convergence log must not be treated as evidence of work actually skipped. The diagnostic loop itself also adds allocation and scanning to qualifying edits. Gate optional verification/logging and compare iterators directly as a small cleanup, after deciding how the diagnostics should be enabled.

**Larger experiment:** checkpoint the typesetter's continuation state at page boundaries, then stop after both that state and the unchanged source dependencies converge. The state must cover columns, split tables, floats/wrapping, footnotes/endnotes, inherited headers/footers, and page numbering. Existing `matches_with_offset` compares selected item identities/ranges; it is not by itself a sufficient proof of geometric and continuation-state equality. Do not simply activate suffix copying on that predicate. Begin with a restricted document class and compare every result against full pagination.

Evidence: [post-typesetting diagnostic](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L4174), [convergence predicate](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/renderer/pagination.rs#L673), [copy helper](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/renderer/pagination.rs#L703).

### Smaller candidates to measure after sharing preparation

Font-slot discovery scans characters and uses `Vec::contains` for membership. An encounter-ordered vector plus a membership set or per-shape language bitmask can remove repeated linear membership checks while preserving resource order. Cache parsed font faces and shaped runs only with complete font identity, face-index, text, language/direction, and shaping-policy dependencies. Much of their repeated work may already disappear when lowering is shared, so measure before adding another cache.

The semantic/JSON cache is bounded by page and variant counts, not total retained bytes. Add telemetry for operation count, owned bytes, resource bytes, lowering calls, hits, and invalidation reasons before selecting a byte budget. A dense page and an almost-empty page should not be assumed to have equal memory cost. Preserve the existing scoped invalidation and editor responsiveness when choosing eviction policy.

Evidence: [font-slot membership](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L661), [per-run face parsing](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/paint/text_shape.rs#L134), [existing cache statistics](https://github.com/heemangstudio/Rauhwpx/blob/cdac4d6fb2bf8d0dfaf31e67247c8ea0b9eb9779/rhwp/src/document_core/queries/rendering.rs#L5499).

## Techniques to borrow from other engines

| Primary source | Verified technique | Application here |
| --- | --- | --- |
| MuPDF DisplayList [E1] | Records device calls once and replays them for rendering at different transforms and for other queries. | Share the already-lowered page across replay and metadata consumers. Keep the existing geometry and operation order. |
| PDF.js `PDFPageProxy` [E2] | Keeps an operator list in an intent-keyed state, requests it when absent, and delays cleanup until rendering and list delivery finish. | Make profile/options part of preparation identity and keep active snapshots alive through all plane consumers. |
| Typst's `comemo` [E3] | Tracks accessed dependencies so unrelated changes need not invalidate a memoized result. | Use explicit dependency revisions for positive and negative normalization results, followed by finer page/resource dependencies. A new dependency on `comemo` is not required for this first step. |
| Skia `SkPicture` [E4] | Replays recorded drawing commands and exposes approximate byte and operation counts. Its byte estimate excludes large referenced objects. | Budget prepared pages by operations and owned storage, with separate accounting for shared fonts/images. |
| MuPDF multithreaded example [E5] | Passes a completed display list to a rendering worker after document interpretation. | A later bounded worker experiment should consume immutable prepared data and preserve current font/backend behavior. Reuse the existing deferred-job revision discipline. |

These are architectural adaptations proposed for Rauhwpx. No upstream code or commits were copied.

### Primary-source references

Accessed 2026-09-26. These links describe the techniques; this audit makes no claim that every documentation page represents the same upstream release snapshot.

- [E1: MuPDF DisplayList](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/DisplayList.html).
- [E2: Mozilla PDF.js `api.js`](https://mozilla.github.io/pdf.js/api/draft/api.js.html): `PDFPageProxy.render`, `_intentStates`, and `#tryCleanup`.
- [E3: Typst `comemo` README](https://github.com/typst/comemo).
- [E4: Skia `SkPicture`](https://api.skia.org/classSkPicture.html): `playback`, `approximateBytesUsed`, and `approximateOpCount`.
- [E5: MuPDF multithreaded C example](https://mupdf.readthedocs.io/en/latest/cookbook/c/multi-threaded.html).

## Detailed implementation proposal

Deliver the following phases as separately reviewable implementation changes. The file areas below identify where to begin; the present PR changes none of them. Establish operation equality before expanding cache retention or changing scheduling.

### Phase 1: correct allocation and image lifecycle

**Page boundary:** update `build_page_tree_cached` in `rhwp/src/document_core/queries/rendering.rs` to inspect the existing slot with `get`, return a valid hit, and build on a miss before calling the insertion helper. Ensure invalidation also makes a formerly valid page inaccessible after pagination shrinks the document. Move read-only control-layout traversal to the borrowed accessor where its font-context behavior is equivalent. Preserve public error variants and valid-page geometry.

Exercise empty documents, the first and last valid pages, exactly `page_count`, and a formerly valid page after deletion. Check cache length/capacity and allocator requests for bounded invalid indices. Add `u32::MAX` and a nearby boundary only after the allocation ordering is fixed, running those cases in a subprocess with a controlled memory ceiling so a regression cannot exhaust the host. Cover the exported WASM queries and native helper. The acceptance condition is unchanged cache length/capacity for invalid requests, with no allocation proportional to the supplied index.

**Image resource acquisition:** give the bitmap and HTML fallback paths in `rhwp/src/renderer/web_canvas.rs` one acquisition operation that returns a resource state without drawing. Consult it before starting another decode or conversion for the same resource identity. Keep crop coordinates with the draw operation, since several placements can share one image.

| State | Acquisition behavior | Painting behavior |
| --- | --- | --- |
| Absent | Attempt the existing decode path once; create and retain one fallback element when needed. Install readiness/error callbacks before setting its source. | Apply the requested draw overload only if acquisition completes synchronously. |
| Pending | Return the same resource identity and preserve its readiness subscription. | Keep the existing pending-frame behavior; request a repaint on completion. |
| Ready | Return the decoded canvas or loaded element. | Use the original cropped or uncropped parameters, transform, clipping, and ordering. |
| Failed | Retain an explicit failure for that resource revision; retry only through a defined retry or invalidation path. | Preserve the existing failure/placeholder policy without repeated conversions per paint. |

Tie readiness callbacks to the existing document/page revision and cancellation rules. Coalesce notifications into the existing rerender path, discard stale completions after edits or document closure, and detach callbacks when a resource is disposed. Bound retained entries, including pending and failed ones. A resource eviction must release its subscriptions and must not leave an old callback painting a replaced document.

Use `into_rgba8` in `decode_image_to_canvas` as a separate small optimization. Require byte-for-byte decoded RGBA equality for the supported bitmap fixtures. Keep dimension-limit changes out of this phase until the Rust/TypeScript admission differences and total transient memory costs are understood.

**Acceptance:** repeated draws during delayed SVG/WMF loading create one fallback element per retained resource revision; both immediately ready and delayed cropped images use the correct source rectangle; stale load completions cannot repaint a new document. Exercise failure, retry, eviction, and disposal, as well as final pixels. These are proposed browser checks, not results already obtained by this audit.

### Phase 2: prepare once and share the operation tree

Start in `rhwp/src/document_core/mod.rs` and `queries/rendering.rs`, then route the hot consumers in `rhwp/src/wasm_api.rs` and `rhwp/rhwp-studio/src/view/page-renderer.ts` through the shared preparation path.

Introduce an internal immutable prepared-page record with the existing `PageLayerTree`, its overlay summary, a compact flow-image view, resource identities/revisions, and an owned-byte estimate. Compute metadata from the original traversal order and keep clipping/transform context intact. Build summaries lazily inside the record if eagerly deriving them materially increases single-consumer cost. Retain the public owned-tree and JSON API contracts; move hot consumers to an internal shared accessor rather than forcing callers to clone the complete tree.

Use an `Rc` snapshot for the existing single-threaded/WASM path. Native thread-sharing requirements should determine any native `Arc` variant. Release the cache borrow before invoking browser APIs. A later worker design will need explicit serialization or transferable ownership; an `Rc` is not itself a worker transport.

Define the cache identity from actual lowering inputs, using the effective `LayerOutputOptions` after profile filtering:

| Dependency | Proposed treatment |
| --- | --- |
| Document ownership, page identity, semantic content | Scope storage to one document. Use the existing page invalidation/revision mechanism and clear or remap affected page slots when pagination changes. Page number alone is insufficient. |
| `RenderProfile` and effective output options | Include profile, paragraph marks, control codes, transparent borders, clipping, and debug-overlay settings in variant identity. |
| Resolved fonts and embedded faces | Track font-resolution/resource revision, face identity, and policy dependencies. A changed fallback or newly available font invalidates dependent preparation and, when metrics change, layout. |
| Images and external resources | Track the identity/revision of data embedded in or referenced by lowered operations. A readiness-only change can request replay without rebuilding geometry when the operation data remains identical. |
| Compatibility normalization and page geometry | Include the validated normalization/layout state. Geometry-changing edits invalidate semantic layout before preparation. |
| Header/footer preview context | Treat preview and normal page contexts as distinct whenever they produce different semantic trees or operations. |
| Zoom, DPR, and backend | Keep a setting outside the preparation key only after proving it affects replay alone. Add it to the key if it changes lowering, snapping, font choice, or output operations. |

On a miss, capture dependency revisions, build outside a mutable cache borrow, then publish only if those revisions are still current. Failed builds must not be installed as valid pages. Coalesce deferred work using the existing revision-guarded jobs. Active consumers retain their immutable snapshot through all plane draws; eviction removes only the cache's ownership.

Route summary, flow/static/behind/front rendering, and JSON serialization to this same record. Add a compact image-metadata query for the Studio path that currently parses full layer JSON solely to collect images, preserving the existing JSON endpoint and schema for other consumers. Keep JSON variants associated with the same prepared identity so operation data and exported metadata cannot refer to different page revisions.

Initially keep the existing page/variant count ceilings and add measured byte accounting; do not start with unlimited retention. Count owned tree/metadata/JSON storage and referenced image/font storage separately, counting each shared resource once. Charge pinned snapshots until their consumers release them. A prepared page larger than the retained-byte budget can remain usable for the current repaint without being admitted for retention. Select a numeric budget from measured workloads rather than the JSON byte count alone.

Extend each existing invalidation entry point to invalidate the corresponding prepared variants and derived JSON together. Verify this matrix before enabling the cache by default:

| Trigger | Required invalidation/reuse behavior |
| --- | --- |
| Edit contained on one page without downstream geometry changes | Rebuild the affected page; preserve unrelated pages. |
| Insertion, deletion, or edit causing repagination | Invalidate affected geometry and page mappings, including removed tail pages; do not reuse a suffix until equivalence is established. |
| Style/font/source-format/normalization dependency changes | Invalidate dependent semantic and prepared state; use existing global invalidation when narrower dependencies are not proven. |
| Editor option/profile/preview change | Select or build the correct variant; never serve screen-only marks to print consumers. |
| Image bytes change versus readiness change | Invalidate operations that capture changed bytes; reuse identical operations for readiness-only replay. |
| Undo/redo, document replacement, or deferred-job completion | Restore or reject work according to current revisions; no stale snapshots may become the active page. |

**Acceptance:** one cold lowering per retained page/dependency/profile/options identity, with all consumers in that repaint sharing it; zero additional lowering for warm retained identities. Evicted entries may rebuild. Confirm exact operation and serialized-JSON equality against the old path, metadata consistency, and no deep tree clone on the hot sharing path. Measure actual lowering counts, p50/p95 repaint duration, allocation volume, and peak retained bytes in a release WASM/browser run before reporting speedup.

### Phase 3: cache evaluated normalization results

Change the normalization cache representation in `rhwp/src/document_core/mod.rs` and `compute_render_normalized` so an unevaluated slot differs from an evaluated entry with no projection. A revision-tagged entry should carry an optional projection; a negative entry must not retain a cloned unchanged section.

Inventory mutations affecting source paragraphs, source lineage/format, section geometry, styles, font metrics, and DPI. Reuse the current section revision where it already covers a dependency; add explicit invalidation for any uncovered dependency. Include changes that introduce a previously absent floating-image/table pattern and changes that remove an existing projection. Cache revision and projection provenance must describe the same source state.

**Acceptance:** an unchanged section that needs no projection skips the second scan. Relevant edits, undo/redo, and geometry/font/style changes force reevaluation. Positive and negative cached output must equal fresh normalization; pagination, historical compatibility predicates, and saved document content remain unchanged.

### Phase 4: establish safe pagination early exit

Treat `queries/rendering.rs` and `rhwp/src/renderer/pagination.rs` as the starting points for a separate experiment. First make the existing convergence diagnostic optional and avoid temporary flattened vectors when iterator comparison suffices. Preserve its observability when explicitly enabled.

Before wiring `copy_converged_pages`, define a complete page-boundary continuation record: source cursor and paragraph offset mapping, column/section state, geometry, pending split-table fragments, floats/wrap regions, footnote/endnote state, active headers/footers, and numbering. Include all resources and style dependencies that can change remaining output. Compare exact continuation state and unchanged suffix dependencies; a hash can accelerate lookup but must not be the sole correctness check.

Begin with text-only, single-column documents without carried objects or notes. Unsupported state falls back to full pagination. Enable each additional document class only after comparison with a full-pagination oracle across edits, insertion/deletion, and undo/redo. Record pages and paragraphs actually typeset so a convergence message cannot be mistaken for work skipped.

**Acceptance:** the optimized and full paths produce the same page count, geometry, source mapping, and paint operations after every covered mutation; accepted suffix reuse measurably avoids typesetting work. Keep this phase independently switchable until its supported cases pass the full visual corpus.

### Follow-on experiments and rollout

After shared preparation is measured, evaluate encounter-ordered font-slot deduplication and parsed-face/shaped-run caching using complete keys. A bounded worker can later consume immutable prepared data, following the completed-display-list handoff in MuPDF [E5]. Browser font access, resource ownership, cancellation, serialization cost, and identical raster output are explicit prerequisites. Replacing the raster backend, introducing WebGPU, changing font metrics, and tightening image admission are separate compatibility decisions.

Ship boundary/resource fixes independently, then introduce shared preparation behind an internal development switch with the existing path as an oracle and fallback. Enable retention after invalidation and byte accounting pass; follow with negative normalization caching. Keep incremental pagination experimental until each supported continuation state is verified. Each phase should be independently revertible without changing file formats or stored documents.

## Appearance-preservation acceptance criteria

For appearance preservation, capture current output with the same fonts, browser build, backend, scale/DPR, and input files. Compare semantic geometry and paint operations exactly, then pixels within that same raster environment. Cover HWP/HWPX, embedded and fallback fonts, split/nested tables, clipped and cropped images, behind/front ordering, headers/footers, toggled editor options, all four profiles, edits, undo/redo, and deferred pagination. Native SVG equality alone does not establish Canvas2D or CanvasKit pixel parity.

Keep the old lowering path available as a development oracle while introducing shared preparation. Record the first differing operation and its dependencies when comparison fails. This makes cache-key mistakes reviewable without changing pagination or font metrics to make screenshots match.

## Verification performed

`cargo build --locked --lib` succeeded against the audited source. The targeted baseline suites completed with **11 passed, 0 failed, and 2 ignored**:

| Suite | Passed | Ignored |
| --- | ---: | ---: |
| `issue_2214_page_local_repaint` | 1 | 2 |
| `issue_2222_layer_json_cache` | 1 | 0 |
| `render_p22_web_canvas_contract` | 4 | 0 |
| `table_cell_split_render_cache` | 2 | 0 |
| `issue_2308_render_normalized_guard` | 1 | 0 |
| `issue_6452_header_footer_selection_cache` | 2 | 0 |

The two ignored tests are already marked as known layout-oracle debt in the repository. They were not forced to run, so this audit does not claim to have reproduced or resolved their reported mismatch. Some passing suites are source-contract guards; they are not substitutes for browser rendering tests.

The local standalone diagnostic reproduced six bounded invalid-page cases, checked cached/uncached layer JSON equality for four profiles across three fixtures, and checked repeat SVG equality on those three pages. Its recorded measurements are included below. Diagnostic source and generated baselines are excluded from this documentation-only PR; no shipping regression test was added.

No fresh WASM/browser pixel comparison, image-readiness browser test, optimized-release benchmark, or full corpus fidelity run was performed. No engine patch is being presented as visually verified by this audit.

### Measurement protocol and exact timing record

The diagnostic linked a native debug library built with `cargo build --locked --lib` from the `rhwp` directory. Cargo and the diagnostic compiler used that directory's pinned Rust 1.93.1 toolchain. These measurements were captured during the audit; no implementation patch was applied between captures.

For each allocation case, construct a fresh `DocumentCore` from `rhwp/samples/hwpx/basic-table-01.hwpx`, warm valid page zero through `build_page_layer_tree`, and enable allocation counting only around the rejected query. Sum requested sizes from allocation, zeroed allocation, and reallocation; separately record the largest request. This counts requested bytes rather than net live bytes or RSS. Use only the bounded indices in finding 1 on the unfixed engine.

For timing, construct one document per fixture, warm its default layer-JSON and SVG paths, then measure `build_page_layer_tree`, `get_page_layer_tree_native`, `get_page_overlay_images_native`, and `get_page_control_layout_native`. Each operation receives three warmups and 21 timed calls. Consume each result with `black_box`, including its destruction inside the interval, and take the median. File loading is outside the interval.

| Fixture path relative to `rhwp/` | Zero-based page | Document pages | Lowering, microseconds | JSON cache, microseconds | Summary, microseconds | Control layout, microseconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `samples/basic/issue1994_behindtext_table_20200830.hwp` | 1 | 4 | 1,343.667 | 23.125 | 1,339.000 | 78.417 |
| `samples/hwpx/basic-table-01.hwpx` | 0 | 1 | 52.042 | 0.666 | 53.875 | 26.916 |
| `samples/issue1949_giant_cell_nested_tables_perf.hwpx` | 57 | 115 | 288.000 | 5.417 | 290.791 | 68.375 |

For each of these three pages, compare a fresh lowered tree's JSON with the profile-specific JSON query and its repeated cached result for `FastPreview`, `Screen`, `Print`, and `HighQuality`. Compare two SVG renders of the same page. All 12 profile/page comparisons and all three repeated SVG comparisons passed. This checks current-path consistency and repeatability; browser visual parity after a future patch remains an acceptance criterion.

The report contains the evidence and protocol needed to assess the findings. Recreating the timing/allocation harness requires a separate local diagnostic because that source is intentionally outside this PR.
