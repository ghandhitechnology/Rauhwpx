# PR #374 verification

The three handover fixes are integrated. The `hy-001` regression is repaired, all eight documents were rendered again in native Skia and Studio Canvas2D, and all 22 page counts match fresh Hancom-for-macOS PDF references. Every final native score is equal to or better than the original PR head.

Strict full parity remains unachieved. The exam retains small font shape and baseline differences, and the full native suite has five failures that also occur at the original PR head. The broader all-font rollout is deferred.

## Document results

Worst-page pixel mismatch at 200 dpi, tolerance 4. These percentages measure raster differences, not the percentage of document content that is incorrect. Each page and the nonzero comparison bands were visually reviewed.

| Document | Pages | #372 native | Original #374 native | Final native | Final Studio |
|---|---:|---:|---:|---:|---:|
| el-school-001 | 1 | 0.86% | 0.85% | 0.85% | 0.85% |
| hy-001 | 2 | 0.00% | 33.19% | 0.03% | 0.00% |
| tb-org-02 | 1 | 0.02% | 0.03% | 0.02% | 0.00% |
| eq-002 | 1 | 28.98% | 0.60% | 0.60% | 0.91% |
| exam-kor-1p | 1 | 3.38% | 3.73% | 1.19% | 1.13% |
| footnote-01 | 6 | 99.64% | 3.85% | 0.77% | 0.75% |
| hwpx-h-01 | 9 | 36.61% | 0.02% | 0.02% | 0.59% |
| landscape-001 | 1 | 0.30% | 0.00% | 0.00% | 0.00% |

Native uses installed Hancom TTFs and nine locally converted HFT faces from six families. Studio imports the content-referenced faces through `importLocalFontFiles`; all requested files were accepted. Import counts in table order are 9, 8, 5, 4, 8, 7, 9, and 5. The capture also checks that imported faces reach the runtime font chain and the WASM bridge with the current generation. The measured Studio backend is Canvas2D.

Seven documents have matching content and geometry with raster or small ink-edge residuals. The exam still has visible differences in heading/label glyphs and baselines. Its native paper height differs by two raster pixels because Hancom rounds the source 841.88 × 1190.52 pt page to 842 × 1191 pt in the PDF. No missing content or page-count regression was found.

## Changes

- Floating-table exclusion now accounts for inline items on the host line, removing the extra advance that moved `hy-001` page-2 logos about 40 pt downward.
- Footnote separator lengths use the same HWPUNIT/default interpretation in both layout paths. Localized family lookup and the native missing-glyph fallback restore the intended title and bullet faces.
- Nonbreaking spaces follow regular-space measurement. Dinaru substitution preserves source HFT advances; real imported or embedded faces retain their own metrics and style selection.
- Studio exposes current imported font bytes to WASM measurement and invalidates cached metrics when imports change. Native custom-face selection respects weight and italic style.
- Studio equation layout uses source TrueType ink bounds and advances, and Canvas2D paints the available HYhwpEQ radical glyphs. The equation page improved from 15.67% in the clean pre-fix Studio run to 0.91%.
- System font discovery is cached during native equation measurement while later custom-font imports remain discoverable.
- Two stale SVG goldens were refreshed after baseline reproduction and Hancom PDF checks. Only fallback family strings changed; text and geometry stayed identical.

## Tests

| Check | Result |
|---|---|
| `cargo test --profile release-test --features native-skia --no-fail-fast` | 5,124 passed, 5 failed, 66 ignored across 413 result groups |
| Studio unit suite, `node scripts/run-tests.mjs unit` | 2,332 passed, 0 failed, 1 skipped |
| `npx tsc --noEmit` | Passed |
| WASM target check and `wasm-pack build --target web` | Passed |
| `cargo fmt --check` and `git diff --check` | Passed |
| Converter `python -m unittest -v test_atlas_to_otf.py` | 5 passed |
| Converter Python syntax and `node --check capture_studio.mjs` | Passed |
| Eight-document native and Studio render checks | All 22 page counts match on each backend |
| Studio without imported fonts | All 22 pages reviewed; readable text/equations, no missing content or tofu observed |
| Studio late import and reimport | Generations 0 → 1 → 2 → 3; added coverage changes pixels, identical reimport stays pixel-stable |

The full native suite ran after native implementation commit `7178bbe7`. Subsequent equation changes in `120ae8fc` affect WASM/Canvas2D and TypeScript; native-skia method bodies are unchanged. The Studio suite and final captures include the final SFNT bounds guards.

All five native failures were independently reproduced at `b57d7eca3125084c3e0f561f1bfc20bccac0592c`:

| Target | Failing test | Observation |
|---|---|---|
| `issue_1116` | `sample16_hwp5_2022_page3_latin_font_matches_legacy_hancom_mapping` | Existing HCI Poppy fallback chain differs from the expected string. |
| `issue_1139_inline_picture_duplicate` | `issue_1139_endnote_equation_cursor_rects_do_not_rewind_to_line_start` | Existing equation cursor rectangles move backward. |
| `issue_1139_inline_picture_duplicate` | `issue_1256_2022_sep_page10_question12_keeps_between_notes_gap` | Existing between-note/TAC equation spacing assertion fails. |
| `issue_1549` | `issue_1549_multi_positive_float_host_title_renders_above_tables` | Existing title/table placement assertion fails. |
| `issue_6929_float_table_para_offset` | `visible_host_title_still_pushes_its_float_table_down` | Existing visible-host title placement assertion fails. |

The assertions were not relaxed. An additional Hancom export for the issue-1549 fixture places its title below the tables, but that fixture also exposes a broader one-versus-two-page layout discrepancy. It needs a separate fix, not an assertion-only change.

## Local font conversion checkpoint

[The reusable tools](../../../rhwp/tools/hancom_font_atlas/README.md) generate a synthetic Unicode atlas, recover Hancom's exported vector outlines, and build a reusable OpenType/CFF face with audited mappings, source advances, style metadata, and hashes. They reject unsupported mappings, ambiguous source banks, PDF text/image fallback, and unapproved cell crossings. The repository contains source tools only; generated fonts and source font files remain local.

Six families and nine faces were built with 2,445 mapped Hangul/ASCII characters each. Native checks covered 234 atlas pages with 0.00% mismatch. Independent Studio checks covered 104 full regular-atlas pages and eight style-pilot pages with 0.00% mismatch. A two-size outline check differed by at most 0.005 design units. These atlas results establish outline fidelity, not universal document layout parity.

An unrelated HWP document still scores 57.40% native and 57.48% Studio, mainly from document layout differences. A mixed-style synthetic document scores 20.15% native and 19.86% Studio, exposing effective styled advances and baseline differences. Hanja mappings, mixed-em Hanyang banks, and general styled-run spacing need further work. Vertical metrics remain explicitly inferred. The experimental probe scripts and broader research are preserved outside this PR.

## Evidence and reproduction

The local run bundle is `/tmp/rhwp-parity-374`. Final rounds are `converted-r3` and `studio-final-r4`. [verification-results.json](verification-results.json) records scores, page counts, font hashes, accepted imports, test results, and log hashes. The original handover and raw logs remain in that bundle.

| Sheet | Comparison |
|---|---|
| [01-hy-001-p2.png](01-hy-001-p2.png) | Original #374 / integrated fixes / Hancom, restored logo position |
| [02-exam-kor-1p-p1.png](02-exam-kor-1p-p1.png) | Original #374 / integrated fixes / Hancom, answer-choice spacing |
| [03-footnote-01-p1.png](03-footnote-01-p1.png) | Original #374 / integrated fixes / Hancom, separator length |
| [04-footnote-01-p5.png](04-footnote-01-p5.png) | Original #374 / integrated fixes / Hancom, localized title font |
| [05-exam-kor-1p-p1.png](05-exam-kor-1p-p1.png) | Original #374 / final converted-font native render / Hancom, Dinaru title |
| [06-studio-eq-002.png](06-studio-eq-002.png) | Required-font Studio render before the final equation fix / final Studio / Hancom |

## Risk and rollout

Font-dependent results require equivalent local faces; this PR does not distribute Hancom fonts. Layout/font changes can affect documents outside the eight-document set, as the heldout results demonstrate. No migration is required. The logical follow-up commits can be reverted individually. Fixer and baseline worktrees were removed; the PR worktree remains available for review.
