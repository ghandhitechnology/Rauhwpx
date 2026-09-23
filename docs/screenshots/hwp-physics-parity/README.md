# Physics worksheet rendering comparison

Each image is ordered **official / before / after**. The baseline is commit `0d7fd644`. The after images use Studio’s selected Canvas2D renderer with the source fonts imported through its font dialog.

## References and capture conditions

- `native-editor-comparison.png` uses an actual Hancom Office HWP for macOS window capture at 200% zoom. The document regions are cropped without resizing.
- `page-1-comparison.png` through `page-4-comparison.png` use Hancom's native PDF export at 96 DPI as the official panel. The detail comparisons use 192 DPI. Studio renders directly at the corresponding scale.
- The PDF reference panels use Poppler `pdftoppm`. Native window capture, PDF rasterization, Canvas2D, and CanvasKit can produce different antialiasing. The PDF panels provide a shared physical document scale.
- Both source and result contain four A4 pages. The comparison covers title/body weight, objective-cell alignment, results-table centering, equations, answer lines, diagrams/captions, headers/footers, and page breaks.

## Fonts

The after capture imports the installed Hancom TTF fonts and the legacy equation banks `HSUSR.HFT`, `HSUSRI.HFT`, `HSUSSP.HFT`, and `HSUSFL.HFT`. Import is session-only. No font binaries, source HWP, or reference PDF are included here.

The source faces include Gulim/GulimChe, HCR Dotum, HCR Batang, Malgun Gothic, HYkanB, and HYhwpEQ. The importer repairs malformed legacy cmap sentinels without changing outlines or advances. Supported HFT equation banks are converted to in-memory OpenType/CFF while retaining their cubic outlines and advances. HFT-specific hint instructions are omitted, so small-size rasterization can still differ.

## Geometry checks

The final results-table row boundaries agree with the PDF to about 0.1 CSS pixel. The footer text baseline is within 0.2 pixel. PDF stroke extents and print-coordinate quantization can account for subpixel differences at borders.

A contour comparison matched sampled HFT equation glyphs to Hancom's PDF paths within 0.000016 point. Modern HYhwpEQ samples match the PDF's embedded outlines. These checks establish source-shape fidelity for the sampled glyphs; they do not establish pixel identity across rasterizers.

## Remaining differences

Exact pixel identity is not achieved. In the lens formula, the first fraction retains an approximately 1 CSS pixel horizontal inset difference; the other numerator origins are within about 0.2 pixel. Sampled equation baselines differ by less than 0.5 pixel. The installed HYhwpEQ outlines and advances match the PDF's embedded font, and an independent fraction fixture does not support applying a universal offset.

Native window capture, PDF printing, and browser font rasterization also differ in antialiasing and thin-line coverage. Page 4 rules use black strokes of 0.5 CSS pixel in Studio and 0.48 pixel in the PDF; the PDF rasterizer snaps them darker at 96 DPI. HFT-specific hint instructions are not reproduced by the converter. CanvasKit was checked separately on all four pages at both scales; its existing `textRun:ratioTextEffect` limitation remains.

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
| Answer lines | [Detail](answer-lines-comparison.png) |
| Diagram and caption | [Detail](diagram-caption-comparison.png) |
| Header and footer | [Header](header-comparison.png), [footer](footer-comparison.png) |
