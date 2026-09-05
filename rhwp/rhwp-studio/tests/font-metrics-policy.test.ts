import test from 'node:test';
import assert from 'node:assert/strict';
import { fontMetricsPolicyForEnvironment } from '../src/core/font-metrics-policy.ts';

test('Mac HWPX selects declared HCR metrics while other environments retain the reference default', () => {
  assert.equal(fontMetricsPolicyForEnvironment('MacIntel', 'hwpx'), 'hcr-declared');
  assert.equal(fontMetricsPolicyForEnvironment('MacIntel', 'hwp'), 'hancom-windows');
  assert.equal(fontMetricsPolicyForEnvironment('Win32', 'hwpx'), 'hancom-windows');
  assert.equal(fontMetricsPolicyForEnvironment('Linux x86_64', 'hwpx'), 'hancom-windows');
  assert.equal(fontMetricsPolicyForEnvironment('', 'hwpx'), 'hancom-windows');
});
