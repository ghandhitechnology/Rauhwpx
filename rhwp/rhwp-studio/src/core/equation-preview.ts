export type EquationDiagnosticSeverity = 'warning' | 'error';

export interface EquationDiagnostic {
  code: string;
  severity: EquationDiagnosticSeverity;
  message: string;
}

export interface EquationPreview {
  svg: string;
  widthPx?: number;
  heightPx?: number;
  baselinePx?: number;
  canonicalScript?: string;
  canonicalError?: string;
  warnings: string[];
  diagnostics: EquationDiagnostic[];
}

/** Parse both the current JSON response and the legacy bare-SVG response. */
export function parseEquationPreview(raw: string): EquationPreview {
  try {
    const parsed = JSON.parse(raw) as Partial<EquationPreview> | null;
    if (parsed && typeof parsed.svg === 'string') {
      const warnings = Array.isArray(parsed.warnings)
        ? parsed.warnings.filter((value): value is string => typeof value === 'string')
        : [];
      const diagnostics = Array.isArray(parsed.diagnostics)
        ? parsed.diagnostics.filter((value): value is EquationDiagnostic =>
          !!value && typeof value.code === 'string'
          && (value.severity === 'warning' || value.severity === 'error')
          && typeof value.message === 'string')
        : warnings.map((message): EquationDiagnostic => ({ code: 'parser-warning', severity: 'warning', message }));
      return {
        svg: parsed.svg,
        ...(typeof parsed.widthPx === 'number' ? { widthPx: parsed.widthPx } : {}),
        ...(typeof parsed.heightPx === 'number' ? { heightPx: parsed.heightPx } : {}),
        ...(typeof parsed.baselinePx === 'number' ? { baselinePx: parsed.baselinePx } : {}),
        ...(typeof parsed.canonicalScript === 'string' ? { canonicalScript: parsed.canonicalScript } : {}),
        ...(typeof parsed.canonicalError === 'string' ? { canonicalError: parsed.canonicalError } : {}),
        warnings,
        diagnostics,
      };
    }
  } catch { /* legacy wasm returns SVG directly */ }
  return { svg: raw, warnings: [], diagnostics: [] };
}

export function fatalEquationDiagnostics(preview: EquationPreview): EquationDiagnostic[] {
  return preview.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
}

/** Preserve imported EqEdit verbatim; canonicalize only new or changed LaTeX. */
export function equationScriptForStorage(
  script: string,
  originalScript: string,
  latexMode: boolean,
  preview: EquationPreview,
): string | undefined {
  const needsCanonicalExport = script !== originalScript && latexMode;
  return needsCanonicalExport ? preview.canonicalScript : script;
}
