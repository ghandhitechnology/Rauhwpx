import test from 'node:test';
import assert from 'node:assert/strict';
import {
  equationScriptForStorage,
  fatalEquationDiagnostics,
  parseEquationPreview,
} from '../src/core/equation-preview.ts';

test('equation preview preserves legacy SVG and structured diagnostics', () => {
  assert.deepEqual(parseEquationPreview('<svg/>'), {
    svg: '<svg/>',
    warnings: [],
    diagnostics: [],
  });

  const preview = parseEquationPreview(JSON.stringify({
    svg: '<svg/>',
    canonicalScript: '{1} over {2}',
    warnings: ['unknown', 'unbalanced'],
    diagnostics: [
      { code: 'unknown-command', severity: 'warning', message: 'unknown' },
      { code: 'unbalanced-structure', severity: 'error', message: 'unbalanced' },
    ],
  }));
  assert.equal(preview.diagnostics.length, 2);
  assert.equal(preview.canonicalScript, '{1} over {2}');
  assert.deepEqual(fatalEquationDiagnostics(preview).map(diagnostic => diagnostic.code), [
    'unbalanced-structure',
  ]);
});

test('older JSON warnings remain visible but tolerated', () => {
  const preview = parseEquationPreview(JSON.stringify({ svg: '<svg/>', warnings: ['legacy'] }));
  assert.equal(preview.diagnostics[0]?.severity, 'warning');
  assert.deepEqual(fatalEquationDiagnostics(preview), []);
});

test('equation storage preserves imported EqEdit and canonicalizes changed LaTeX', () => {
  const preview = parseEquationPreview(JSON.stringify({
    svg: '<svg/>',
    canonicalScript: '{1} over {2}',
    warnings: [],
    diagnostics: [],
  }));

  assert.equal(equationScriptForStorage('1 OVER 2', '1 OVER 2', true, preview), '1 OVER 2');
  assert.equal(equationScriptForStorage('x + 1', 'x', false, preview), 'x + 1');
  assert.equal(equationScriptForStorage('\\frac{1}{2}', 'x', false, preview), '\\frac{1}{2}');
  assert.equal(equationScriptForStorage('\\frac{1}{2}', 'x', true, preview), '{1} over {2}');
  assert.equal(equationScriptForStorage('\\frac{1}{2}', 'x', true, { ...preview, canonicalScript: undefined }), undefined);
});
