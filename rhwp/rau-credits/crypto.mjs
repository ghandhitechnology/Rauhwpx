import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyFromSecret(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest();
}

/** AES-256-GCM. Returns `iv:tag:ciphertext` in base64url parts. */
export function encryptSecret(sessionSecret, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(sessionSecret), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join(':');
}

export function decryptSecret(sessionSecret, payload) {
  const parts = String(payload ?? '').split(':');
  if (parts.length !== 3) throw new Error('invalid ciphertext');
  const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(sessionSecret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
