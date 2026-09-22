export type FontMetricsPolicy = 'hancom-windows' | 'hcr-declared';

/** Mac HWPX references use HCR Batang itself, not the Windows Latin substitute.
 * Keep native HWP and other environments unchanged until separately verified.
 */
export function fontMetricsPolicyForEnvironment(platform: string, sourceFormat: string): FontMetricsPolicy {
  return sourceFormat === 'hwpx' && /^Mac/.test(platform) ? 'hcr-declared' : 'hancom-windows';
}
