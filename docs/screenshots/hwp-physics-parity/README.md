# Physics worksheet rendering comparison

Each image is ordered **official / before / after**. The baseline is commit `0d7fd644`. The after images use Studio’s selected Canvas2D renderer with the source fonts imported through its font dialog.

## References and capture conditions

- `native-editor-comparison.png` uses an actual Hancom Office HWP for macOS window capture at 200% zoom. The document regions are cropped without resizing.
- `page-1-comparison.png` through `page-4-comparison.png` use Hancom's native PDF export at 96 DPI as the official panel. The detail comparisons use 192 DPI. Studio renders directly at the corresponding scale.
- The PDF reference panels use Poppler `pdftoppm`. Native window capture, PDF rasterization, Canvas2D, and CanvasKit can produce different antialiasing. Canvas2D now uses `geometricPrecision`, avoiding Chromium's default macOS font smoothing while preserving source advances. The PDF panels provide a shared physical document scale.
- Both source and result contain four A4 pages. The comparison covers title/body weight, objective-cell alignment, results-table centering, equations, answer lines, diagrams/captions, headers/footers, and page breaks.

## Fonts

The after capture imports the installed Hancom TTF fonts and the legacy equation banks `HSUSR.HFT`, `HSUSRI.HFT`, `HSUSSP.HFT`, and `HSUSFL.HFT`. Import is session-only. No font binaries, source HWP, or reference PDF are included here.

The source faces include Gulim/GulimChe, HCR Dotum, HCR Batang, Malgun Gothic, HYkanB, and HYhwpEQ. The importer repairs malformed legacy cmap sentinels without changing outlines or advances. Supported HFT equation banks are converted to in-memory OpenType/CFF while retaining their cubic outlines and advances. HFT-specific hint instructions are omitted, so small-size rasterization can still differ.

## Geometry checks

The results-table row boundaries agree with the PDF to about 0.1 CSS pixel. Native editor captures at 100% and 200% confirm the row and column coordinates and one-device-pixel screen borders. Print and high-quality output retain vector stroke coverage. The footer text baseline is within 0.2 pixel.

A contour comparison matched sampled HFT equation glyphs to Hancom's PDF paths within 0.000016 point. Modern HYhwpEQ samples match the PDF's embedded outlines. These checks establish source-shape fidelity for the sampled glyphs; they do not establish pixel identity across rasterizers.

## Equation geometry and raster checks

The modern HY fraction box now preserves its minimum em width and independent bar inset. The three lens-formula numerator origins differ from the PDF by −0.265, +0.302, and −0.251 CSS pixel; sampled equation baselines differ by less than 0.5 pixel. All 14 equation layouts agree between Canvas2D and CanvasKit. The installed HYhwpEQ outlines and advances match the PDF's embedded font.

Exact pixel identity is not achieved: text antialiasing still differs between the native editor, Canvas2D, and CanvasKit. Native captures at 100%, 150%, and 200% were compared. In the registered 200% body-text sample, excess Canvas2D ink coverage fell from 17.4% to 0.5% after selecting geometric precision. This measurement covers that sample; it is not a claim of pixel identity for all text. HFT-specific hint instructions are not reproduced by the converter; a probe preserving its stem hints changed no pixels in either current rendering mode. CanvasKit now supports ordinary text width ratios and offset shadows, including fallback glyphs. All four pages at 1× and 2× completed without unsupported operations or hidden Canvas2D overlays.

## Reproduce

1. Build the WASM module and Studio, then open the attached physics HWP.
2. Choose **글꼴 파일 가져오기 (이번 세션)** and select the corresponding locally licensed TTF/OTF fonts and HFT equation banks.
3. Wait for font loading and layout refresh to finish. Compare all four pages at equal zoom.
4. Check the complete pages and detail comparisons below. The native comparison shows the editor-window appearance; the PDF comparisons show page geometry at a fixed scale.

## Comparisons

| Area | Evidence |
| --- | --- |
| Native editor, title, and objective cell | [Native comparison](native-editor-comparison.png) |
| Complete pages | [1](page-1-comparison.png), [2](page-2-comparison.png), [3](page-3-comparison.png), [4](page-4-comparison.png) |
| Title and objective cell | [Detail](title-and-goal-comparison.png) |
| Equations and body text | [Modern equations](equation-and-body-comparison.png), [legacy equations](legacy-equations-comparison.png) |
| Results table | [Detail](table-centering-comparison.png) |
| Answer lines | [PDF detail](answer-lines-comparison.png), [native editor detail](native-answer-lines-comparison.png) |
| Diagram and caption | [Detail](diagram-caption-comparison.png) |
| Header and footer | [Header](header-comparison.png), [footer](footer-comparison.png) |

## Live computer verification, 2026-09-24

Opened the original attached HWP in Hancom Office HWP and this PR worktree's Studio at `http://127.0.0.1:7701`. Imported 11 installed source font files through Studio's native file picker: Gulim, GulimChe, HCR Batang, HCR Dotum, Malgun Gothic, HYkanB, HYhwpEQ, and the four HFT banks listed above. The source document and fonts remain local.

Inspected all four pages in both applications. The window captures below use 51% page zoom; the fraction captures use 101% in both applications. They are unmodified window screenshots. Window dimensions and scroll positions differ, so use the fixed-scale comparison panels above for geometry measurements.

| Page | Hancom | Studio |
| --- | --- | --- |
| 1 | [Native window](hancom-live-page-1.png) | [Studio window](studio-live-page-1.png) |
| 2 | [Native window](hancom-live-page-2.png) | [Studio window](studio-live-page-2.png) |
| 3 | [Native window](hancom-live-page-3.png) | [Studio window](studio-live-page-3.png) |
| 4 | [Native window](hancom-live-page-4.png) | [Studio window](studio-live-page-4.png) |
| First lens fraction, 101% | [Native window](hancom-live-fraction.png) | [Studio window](studio-live-fraction.png) |

The follow-up fixes preserve modern HY fraction minimum width and bar inset, align thin screen rules to device pixels, select Canvas2D geometric text precision, and replay ordinary text width ratios and offset shadows in CanvasKit. Print profiles retain vector rule coverage. Rasterizer differences described above remain; these captures do not establish pixel identity.
