import path from 'node:path';

export const DEFAULT_PORT = 5180;
export const RAILWAY_DATA_DIR = '/data';

const REQUIRED_ON_RAILWAY = [
  'SESSION_SECRET',
  'WORKOS_API_KEY',
  'WORKOS_CLIENT_ID',
  'OPENROUTER_PROVISIONING_KEY',
];

export function isRailway(env = process.env) {
  return Boolean(env.RAILWAY_ENVIRONMENT);
}

/** WorkOS 콜백이 붙는 공개 origin. Railway 는 https + 공개 도메인을 쓴다. */
export function resolveCreditsOrigin(env = process.env, port = DEFAULT_PORT) {
  const explicit = typeof env.RAU_CREDITS_ORIGIN === 'string' ? env.RAU_CREDITS_ORIGIN.trim() : '';
  if (explicit) return explicit.replace(/\/$/, '');
  const railway = typeof env.RAILWAY_PUBLIC_DOMAIN === 'string' ? env.RAILWAY_PUBLIC_DOMAIN.trim() : '';
  if (railway) {
    const host = railway.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${host}`;
  }
  return `http://127.0.0.1:${port}`;
}

/** Railway 볼륨은 /data. 로컬은 현재 디렉터리. */
export function resolveCreditsDbPath(env = process.env) {
  if (typeof env.RAU_CREDITS_DB === 'string' && env.RAU_CREDITS_DB.trim()) {
    return env.RAU_CREDITS_DB.trim();
  }
  const dataDir = typeof env.RAU_CREDITS_DATA === 'string' && env.RAU_CREDITS_DATA.trim()
    ? env.RAU_CREDITS_DATA.trim()
    : (isRailway(env) ? RAILWAY_DATA_DIR : '.');
  return path.join(dataDir, 'rau-credits.json');
}

/** Distinct from credits JSON so unique-install growth cannot crowd out keys. */
export function resolveUniqueInstallsDbPath(env = process.env) {
  if (typeof env.RAU_UNIQUE_INSTALLS_DB === 'string' && env.RAU_UNIQUE_INSTALLS_DB.trim()) {
    return env.RAU_UNIQUE_INSTALLS_DB.trim();
  }
  const dataDir = typeof env.RAU_CREDITS_DATA === 'string' && env.RAU_CREDITS_DATA.trim()
    ? env.RAU_CREDITS_DATA.trim()
    : (isRailway(env) ? RAILWAY_DATA_DIR : '.');
  return path.join(dataDir, 'unique-installs.json');
}

export function resolveUniqueInstallPingKey(env = process.env) {
  const explicit = typeof env.RAU_UNIQUE_INSTALL_PING_KEY === 'string'
    ? env.RAU_UNIQUE_INSTALL_PING_KEY.trim()
    : '';
  return explicit;
}

export function assertCreditsEnv(env = process.env) {
  const names = isRailway(env) ? REQUIRED_ON_RAILWAY : ['SESSION_SECRET'];
  const missing = names.filter((name) => !String(env[name] ?? '').trim());
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`);
  }
}
