/**
 * OpenCode supports many providers and reads their credentials directly from
 * environment variables. Pass through only process-launch settings that the
 * managed child needs. The caller must supply the app-owned OpenCode key
 * separately so an ambient OPENCODE_API_KEY is not mistaken for one.
 */
const PASSTHROUGH_KEYS = Object.freeze([
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
]);

/** @param {NodeJS.ProcessEnv} sourceEnv @param {string|null|undefined} appOwnedApiKey */
export function openCodeRuntimeEnv(sourceEnv = {}, appOwnedApiKey = null) {
  const env = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = sourceEnv?.[key];
    if (typeof value === 'string') env[key] = value;
  }
  // Node commonly exposes the Windows search path as `Path`. Normalize it so
  // later PATH prepending cannot leave two case-insensitive variants behind.
  if (typeof env.PATH !== 'string' && typeof sourceEnv?.Path === 'string') {
    env.PATH = sourceEnv.Path;
  }
  if (typeof appOwnedApiKey === 'string' && appOwnedApiKey.trim()) {
    env.OPENCODE_API_KEY = appOwnedApiKey;
  }
  return env;
}
