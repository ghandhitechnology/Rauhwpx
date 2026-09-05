import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CloudError, PROVIDERS } from './protocol.mjs';

function loadKey(dataDirectory) {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDirectory, 'provider-vault.key');
  if (!existsSync(filename)) writeFileSync(filename, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = readFileSync(filename);
  if (key.length !== 32) throw new CloudError('VAULT_KEY_INVALID', 'Provider vault key must contain 32 bytes', 500);
  return { key, filename };
}

function validate(provider, name) {
  if (!PROVIDERS.includes(provider)) throw new CloudError('INVALID_PROVIDER', 'Provider is not supported');
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) throw new CloudError('INVALID_CREDENTIAL', 'Credential name is invalid');
}

export class SecretVault {
  constructor(database, { dataDirectory, now = Date.now } = {}) {
    this.database = database;
    const loaded = loadKey(dataDirectory);
    this.key = loaded.key;
    this.keyPath = loaded.filename;
    this.now = now;
  }

  set(provider, name, value) {
    validate(provider, name);
    if (typeof value !== 'string' || value.length < 1 || value.length > 64 * 1024) {
      throw new CloudError('INVALID_CREDENTIAL', 'Credential value is invalid');
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${provider}\0${name}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    this.database.prepare(`
      INSERT INTO provider_credentials(provider, credential_name, nonce, ciphertext, auth_tag, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, credential_name) DO UPDATE SET
        nonce = excluded.nonce, ciphertext = excluded.ciphertext, auth_tag = excluded.auth_tag, updated_at = excluded.updated_at
    `).run(provider, name, nonce, ciphertext, authTag, this.now());
  }

  get(provider, name) {
    validate(provider, name);
    const row = this.database.prepare(`
      SELECT * FROM provider_credentials WHERE provider = ? AND credential_name = ?
    `).get(provider, name);
    if (!row) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.nonce);
      decipher.setAAD(Buffer.from(`${provider}\0${name}`));
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new CloudError('VAULT_DECRYPT_FAILED', 'Provider credential could not be decrypted', 500);
    }
  }

  delete(provider, name) {
    validate(provider, name);
    return this.database.prepare(`DELETE FROM provider_credentials WHERE provider = ? AND credential_name = ?`).run(provider, name).changes === 1;
  }

  list() {
    return this.database.prepare(`
      SELECT provider, credential_name, updated_at FROM provider_credentials ORDER BY provider, credential_name
    `).all().map((row) => ({ provider: row.provider, name: row.credential_name, updatedAt: row.updated_at }));
  }
}
