function reusableEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.type === 'api') {
    return typeof value.key === 'string' && value.key.trim().length > 0;
  }
  if (value.type === 'oauth') {
    return typeof value.access === 'string'
      && value.access.trim().length > 0
      && typeof value.refresh === 'string'
      && value.refresh.trim().length > 0
      && Number.isSafeInteger(value.expires)
      && value.expires >= 0;
  }
  // `wellknown` credentials can fetch and merge remote OpenCode config. A
  // managed Rauhwpx child reuses only inert API and OAuth credential records.
  return false;
}

/** Accept only a complete map of reusable OpenCode API or OAuth credentials. */
export function isReusableOpenCodeAuthContent(content) {
  try {
    const text = typeof content === 'string'
      ? content
      : new TextDecoder('utf-8', { fatal: true }).decode(content);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const entries = Object.entries(parsed);
    return entries.length > 0 && entries.every(([provider, value]) => (
      provider.trim().length > 0 && reusableEntry(value)
    ));
  } catch {
    return false;
  }
}
