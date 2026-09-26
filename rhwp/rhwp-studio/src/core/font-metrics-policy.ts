export type FontMetricsPolicy = 'hancom-windows' | 'hcr-declared';

/** Hancom for macOS is the reference platform: every environment measures
 * faces with their declared advances. 'hancom-windows' stays available for
 * the Windows substitution rules.
 */
export const DEFAULT_FONT_METRICS_POLICY: FontMetricsPolicy = 'hcr-declared';
