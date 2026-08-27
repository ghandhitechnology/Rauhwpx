import { createHash, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function loadOrCreateServerIdentity(dataDirectory) {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const privatePath = path.join(dataDirectory, 'server-ed25519-private.pem');
  const publicPath = path.join(dataDirectory, 'server-ed25519-public.pem');
  if (!existsSync(privatePath)) {
    const pair = generateKeyPairSync('ed25519');
    try {
      writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const privateKey = readFileSync(privatePath, 'utf8');
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (!existsSync(publicPath) || readFileSync(publicPath, 'utf8') !== publicKey) {
    writeFileSync(publicPath, publicKey, { mode: 0o644 });
  }
  const encodedKey = createPublicKey(publicKey).export({ type: 'spki', format: 'der' }).toString('base64url');
  const serverPublicKey = `ed25519:${encodedKey}`;
  const serverId = createHash('sha256').update(encodedKey).digest('hex').slice(0, 24);
  return { privateKey, publicKey, serverPublicKey, serverId };
}
