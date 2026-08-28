import {
  argon2Sync,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { transaction } from './database.mjs';
import { CloudError } from './protocol.mjs';

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const ROTATION_RETRY_GRACE_MS = 30 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;
const BOOTSTRAP_CONSUMED_KEY = 'auth.bootstrap.consumed';

function hashToken(value) {
  return createHash('sha256').update(value).digest();
}

function hashPairingCode(code, salt) {
  return argon2Sync('argon2id', {
    message: Buffer.from(code.normalize('NFKC').toUpperCase()),
    nonce: salt,
    parallelism: 1,
    tagLength: 32,
    memory: 64 * 1024,
    passes: 3,
  });
}

/** Deterministic, keyed seek value so redemption is one indexed lookup. */
function pairingCodeSeek(key, code) {
  return createHash('sha256').update('rauhwpx-pairing-seek\0').update(key).update(
    Buffer.from(code.normalize('NFKC').toUpperCase()),
  ).digest();
}

function sameBuffer(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function pairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const characters = [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
  return `${characters.slice(0, 4)}-${characters.slice(4, 8)}-${characters.slice(8)}`;
}

function publicDevice(row) {
  return { id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
}

export class AuthService {
  constructor(database, { now = Date.now, retrySecret = null, bootstrapToken = '' } = {}) {
    this.database = database;
    this.now = now;
    this.retryKey = createHash('sha256').update(retrySecret ?? this.#databaseRetrySecret()).digest();
    this.bootstrapToken = String(bootstrapToken ?? '');
  }

  #databaseRetrySecret() {
    const key = 'auth.refresh-retry-key';
    const existing = this.database.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    if (existing) return Buffer.from(existing.value, 'base64url');
    const generated = randomBytes(32);
    this.database.prepare('INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)')
      .run(key, generated.toString('base64url'));
    return Buffer.from(this.database.prepare('SELECT value FROM metadata WHERE key = ?').get(key).value, 'base64url');
  }

  #receiptAad(tokenHash, familyId, generation) {
    return Buffer.from(`${Buffer.from(tokenHash).toString('hex')}:${familyId}:${generation}`);
  }

  #sealRotationReceipt(tokenHash, familyId, generation, tokens) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.retryKey, nonce);
    cipher.setAAD(this.#receiptAad(tokenHash, familyId, generation));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
    return { nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  #openRotationReceipt(row) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.retryKey, row.nonce);
      decipher.setAAD(this.#receiptAad(row.previous_token_hash, row.family_id, row.successor_generation));
      decipher.setAuthTag(row.auth_tag);
      return JSON.parse(Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8'));
    } catch {
      throw new CloudError('REFRESH_RETRY_UNAVAILABLE', 'Refresh retry receipt could not be opened', 401);
    }
  }

  createPairingCode({ createdByDeviceId = null, intendedName = null } = {}) {
    const now = this.now();
    const code = pairingCode();
    const salt = randomBytes(16);
    this.database.prepare(`
      INSERT INTO pairing_codes(id, code_hash, code_seek, salt, created_by_device_id, intended_name, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), hashPairingCode(code, salt), pairingCodeSeek(this.retryKey, code), salt,
      createdByDeviceId, intendedName, now + PAIRING_TTL_MS, now,
    );
    return { code, expiresAt: now + PAIRING_TTL_MS };
  }

  /**
   * 앱이 제공하는 샌드박스는 SSH가 없으므로 배포 시 주입한 부트스트랩 토큰으로
   * 첫 페어링 코드를 받는다. 기기가 하나라도 페어링되면 이 경로는 영구히 닫힌다.
   * 기기를 전부 폐기해도 다시 열리지 않는다.
   */
  issueBootstrapPairing({ token, deviceName = null } = {}) {
    if (!this.bootstrapToken) {
      throw new CloudError('BOOTSTRAP_DISABLED', 'Bootstrap pairing is not enabled on this server', 404);
    }
    if (typeof token !== 'string' || !token
      || !sameBuffer(hashToken(token), hashToken(this.bootstrapToken))) {
      throw new CloudError('BOOTSTRAP_TOKEN_INVALID', 'Bootstrap token is invalid', 401);
    }
    return transaction(this.database, () => {
      const consumed = this.database.prepare('SELECT value FROM metadata WHERE key = ?').get(BOOTSTRAP_CONSUMED_KEY);
      const paired = this.database.prepare('SELECT COUNT(*) AS count FROM devices WHERE revoked_at IS NULL').get();
      if (consumed || paired.count > 0) {
        throw new CloudError('BOOTSTRAP_CLOSED', 'Bootstrap pairing closed after the first device paired', 409);
      }
      return this.createPairingCode({ intendedName: deviceName });
    });
  }

  redeemPairingCode({ code, deviceName }) {
    const now = this.now();
    const seek = pairingCodeSeek(this.retryKey, code);
    // The seek match avoids argon2 work on misses; legacy rows without a seek
    // value keep the original hash comparison until they expire.
    const candidates = this.database.prepare(`
      SELECT * FROM pairing_codes WHERE used_at IS NULL AND expires_at > ? AND (code_seek = ? OR code_seek IS NULL)
      ORDER BY created_at DESC LIMIT 20
    `).all(now, seek);
    const match = candidates.find((candidate) => (
      candidate.code_seek !== null
      || sameBuffer(candidate.code_hash, hashPairingCode(code, candidate.salt))
    ));
    if (!match) throw new CloudError('PAIRING_CODE_INVALID', 'Pairing code is invalid or expired', 401);
    return transaction(this.database, () => {
      const consumed = this.database.prepare(`
        UPDATE pairing_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?
      `).run(now, match.id, now);
      if (consumed.changes !== 1) throw new CloudError('PAIRING_CODE_USED', 'Pairing code was already used', 409);
      const deviceId = randomUUID();
      this.database.prepare(`
        INSERT INTO devices(id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)
      `).run(deviceId, deviceName, now, now);
      this.database.prepare('INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)')
        .run(BOOTSTRAP_CONSUMED_KEY, '1');
      return this.#issueTokenFamily(deviceId, now);
    });
  }

  #issueTokenFamily(deviceId, now) {
    const familyId = randomUUID();
    const refreshExpiresAt = now + REFRESH_TTL_MS;
    this.database.prepare(`
      INSERT INTO token_families(id, device_id, expires_at, created_at) VALUES (?, ?, ?, ?)
    `).run(familyId, deviceId, refreshExpiresAt, now);
    return this.#issueTokens({ deviceId, familyId, generation: 0, now, refreshExpiresAt });
  }

  #issueTokens({ deviceId, familyId, generation, now, refreshExpiresAt }) {
    const accessToken = `ra_at_${randomBytes(32).toString('base64url')}`;
    const refreshToken = `ra_rt_${familyId}.${generation}.${randomBytes(32).toString('base64url')}`;
    const accessExpiresAt = now + ACCESS_TTL_MS;
    this.database.prepare(`
      INSERT INTO refresh_tokens(family_id, generation, token_hash, created_at) VALUES (?, ?, ?, ?)
    `).run(familyId, generation, hashToken(refreshToken), now);
    this.database.prepare(`
      INSERT INTO access_tokens(token_hash, device_id, family_id, generation, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hashToken(accessToken), deviceId, familyId, generation, accessExpiresAt, now);
    const device = this.database.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    return {
      device: publicDevice(device),
      accessToken,
      accessExpiresAt,
      refreshToken,
      refreshExpiresAt,
    };
  }

  authenticate(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken.startsWith('ra_at_')) {
      throw new CloudError('UNAUTHORIZED', 'A valid bearer access token is required', 401);
    }
    const now = this.now();
    const row = this.database.prepare(`
      SELECT devices.*, access_tokens.expires_at AS token_expires_at, token_families.revoked_at AS family_revoked_at
             , token_families.expires_at AS family_expires_at,
             access_tokens.family_id AS token_family_id, access_tokens.generation AS token_generation
      FROM access_tokens
      JOIN devices ON devices.id = access_tokens.device_id
      JOIN token_families ON token_families.id = access_tokens.family_id
      WHERE access_tokens.token_hash = ?
    `).get(hashToken(accessToken));
    if (!row || row.token_expires_at <= now || row.family_expires_at <= now || row.revoked_at || row.family_revoked_at) {
      throw new CloudError('UNAUTHORIZED', 'Access token is expired or revoked', 401);
    }
    // synchronous = FULL makes every write an fsync, so keep the per-request
    // bookkeeping to statements that actually change a value.
    this.database.prepare(`
      UPDATE refresh_tokens SET activated_at = ?
      WHERE family_id = ? AND generation = ? AND activated_at IS NULL
    `).run(now, row.token_family_id, row.token_generation);
    if (!row.last_seen_at || now - row.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) {
      this.database.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    }
    return publicDevice({ ...row, last_seen_at: now });
  }

  refresh(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken.startsWith('ra_rt_')) {
      throw new CloudError('REFRESH_TOKEN_INVALID', 'Refresh token is invalid', 401);
    }
    const now = this.now();
    const tokenHash = hashToken(refreshToken);
    const outcome = transaction(this.database, () => {
      const row = this.database.prepare(`
        SELECT refresh_tokens.*, token_families.device_id, token_families.expires_at, token_families.revoked_at,
               devices.revoked_at AS device_revoked_at
        FROM refresh_tokens
        JOIN token_families ON token_families.id = refresh_tokens.family_id
        JOIN devices ON devices.id = token_families.device_id
        WHERE refresh_tokens.token_hash = ?
      `).get(tokenHash);
      if (!row || row.expires_at <= now || row.revoked_at || row.device_revoked_at) return { error: 'invalid' };
      if (row.used_at) {
        const receipt = this.database.prepare(`
          SELECT refresh_rotation_receipts.*, successor.used_at AS successor_used_at,
                 successor.activated_at AS successor_activated_at
          FROM refresh_rotation_receipts
          JOIN refresh_tokens AS successor
            ON successor.family_id = refresh_rotation_receipts.family_id
           AND successor.generation = refresh_rotation_receipts.successor_generation
          WHERE refresh_rotation_receipts.previous_token_hash = ?
        `).get(tokenHash);
        if (receipt && receipt.retry_until > now && !receipt.successor_used_at && !receipt.successor_activated_at) {
          return this.#openRotationReceipt(receipt);
        }
        this.database.prepare('UPDATE token_families SET revoked_at = ? WHERE id = ?').run(now, row.family_id);
        this.database.prepare('DELETE FROM access_tokens WHERE family_id = ?').run(row.family_id);
        return { error: 'reuse' };
      }
      this.database.prepare('UPDATE refresh_tokens SET used_at = ? WHERE family_id = ? AND generation = ?')
        .run(now, row.family_id, row.generation);
      this.database.prepare('DELETE FROM access_tokens WHERE family_id = ?').run(row.family_id);
      const tokens = this.#issueTokens({
        deviceId: row.device_id,
        familyId: row.family_id,
        generation: row.generation + 1,
        now,
        refreshExpiresAt: row.expires_at,
      });
      const receipt = this.#sealRotationReceipt(tokenHash, row.family_id, row.generation + 1, tokens);
      this.database.prepare(`
        INSERT INTO refresh_rotation_receipts(
          previous_token_hash, family_id, successor_generation, nonce, ciphertext, auth_tag, retry_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tokenHash, row.family_id, row.generation + 1, receipt.nonce, receipt.ciphertext, receipt.authTag,
        now + ROTATION_RETRY_GRACE_MS, now,
      );
      return tokens;
    });
    if (outcome.error === 'reuse') throw new CloudError('REFRESH_TOKEN_REUSED', 'Refresh token reuse revoked this device session', 401);
    if (outcome.error) throw new CloudError('REFRESH_TOKEN_INVALID', 'Refresh token is expired or revoked', 401);
    return outcome;
  }

  listDevices() {
    return this.database.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at').all().map(publicDevice);
  }

  revokeDevice(deviceId) {
    const now = this.now();
    return transaction(this.database, () => {
      this.database.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, deviceId);
      this.database.prepare('UPDATE token_families SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, deviceId);
      this.database.prepare('DELETE FROM access_tokens WHERE device_id = ?').run(deviceId);
    });
  }

  prune() {
    const now = this.now();
    this.database.prepare('DELETE FROM access_tokens WHERE expires_at <= ?').run(now);
    this.database.prepare('DELETE FROM pairing_codes WHERE expires_at <= ?').run(now);
    this.database.prepare('DELETE FROM refresh_rotation_receipts WHERE retry_until <= ?').run(now);
    this.database.prepare('DELETE FROM token_families WHERE expires_at <= ?').run(now);
  }
}
