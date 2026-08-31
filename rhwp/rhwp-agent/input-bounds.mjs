function invalidRequest(message) {
  return Object.assign(new Error(message), { code: 'INVALID_REQUEST' });
}

// Credential-bearing Studio frames share the large document transport. Keep
// their individual text fields small before they reach HTTP headers, vaults,
// fallback files, or child-process stdin.
export const API_KEY_MAX_BYTES = 8 * 1024;
export const AUTH_CODE_MAX_BYTES = 8 * 1024;

/** True only for strings whose UTF-16 and UTF-8 representations fit the cap. */
export function textFitsByteLimit(value, maxBytes) {
  return typeof value === 'string'
    && value.length <= maxBytes
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

/** Copy selected untrusted text fields while enforcing per-field and aggregate limits. */
export function boundTextFields(input, limits, {
  maxTotalChars,
  maxTotalBytes,
  label = 'Request text',
} = {}) {
  const bounded = Object.create(null);
  let totalChars = 0;
  let totalBytes = 0;
  for (const [field, maxChars] of Object.entries(limits)) {
    const raw = input?.[field];
    const value = typeof raw === 'string' ? raw : '';
    const bytes = Buffer.byteLength(value, 'utf8');
    if (value.length > maxChars || bytes > maxChars * 4) {
      throw invalidRequest(`${field} exceeds its ${maxChars.toLocaleString('en-US')}-character limit.`);
    }
    totalChars += value.length;
    totalBytes += bytes;
    bounded[field] = value;
  }
  if ((Number.isSafeInteger(maxTotalChars) && totalChars > maxTotalChars)
    || (Number.isSafeInteger(maxTotalBytes) && totalBytes > maxTotalBytes)) {
    throw invalidRequest(`${label} exceeds the aggregate size limit.`);
  }
  return bounded;
}
