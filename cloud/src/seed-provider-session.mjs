import { join } from 'node:path';
import { decodeProviderSession, writeProviderSession } from './provider-session.mjs';

const session = decodeProviderSession(process.env.RAUHWpx_PROVIDER_SESSION);
if (!session) {
  console.error('{"event":"sandbox.provider_session_invalid"}');
  process.exit(1);
}
const dataDir = process.env.RAUHWpx_DATA_DIR || '/var/lib/rauhwpx-cloud';
writeProviderSession(join(dataDir, 'provider-auth', session.provider), session);
console.log(JSON.stringify({ event: 'sandbox.provider_session_seeded', provider: session.provider }));
