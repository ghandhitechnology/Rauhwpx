import { randomUUID } from 'node:crypto';

function identityKeys(identity, canonicalPath) {
  if (typeof identity?.documentId !== 'string' || identity.documentId.length === 0) {
    throw new Error('Document ownership requires a documentId');
  }
  if (identity.sourceDigest !== null && (
    typeof identity.sourceDigest !== 'string' || identity.sourceDigest.length === 0
  )) {
    throw new Error('Document ownership sourceDigest is invalid');
  }
  const keys = [`document:${identity.documentId}`];
  if (identity.sourceDigest && !canonicalPath && identity.useSourceDigest !== false) {
    keys.push(`digest:${identity.sourceDigest}`);
  }
  if (canonicalPath) keys.push(`path:${canonicalPath}`);
  if (keys.length === 0) throw new Error('Document ownership requires an identity');
  return keys;
}

export class DocumentLeaseManager {
  #claimsByKey = new Map();
  #leasesBySession = new Map();
  #reservations = new Map();
  #createId;

  constructor({ createId = randomUUID } = {}) {
    this.#createId = createId;
  }

  ownerForPath(canonicalPath) {
    return this.#claimsByKey.get(`path:${canonicalPath}`)?.sessionId ?? null;
  }

  reserve(sessionId, identity, canonicalPath = null) {
    const keys = identityKeys(identity, canonicalPath);
    for (const key of keys) {
      const claim = this.#claimsByKey.get(key);
      if (claim && claim.sessionId !== sessionId) {
        return { ok: false, ownerSessionId: claim.sessionId };
      }
    }

    const reservationId = this.#createId();
    const reservation = {
      reservationId,
      sessionId,
      identity: Object.freeze({
        documentId: identity?.documentId ?? null,
        sourceDigest: identity?.sourceDigest ?? null,
        useSourceDigest: identity?.useSourceDigest !== false,
      }),
      canonicalPath,
      keys,
      claimedKeys: keys.filter((key) => !this.#claimsByKey.has(key)),
    };
    this.#reservations.set(reservationId, reservation);
    for (const key of reservation.claimedKeys) this.#claimsByKey.set(key, reservation);
    return { ok: true, reservationId };
  }

  commit(sessionId, reservationId) {
    const reservation = this.#reservationForSession(sessionId, reservationId);
    const previous = this.#leasesBySession.get(sessionId);
    if (previous) this.#releaseClaim(previous);

    this.#reservations.delete(reservationId);
    const lease = { ...reservation, reservationId: null, claimedKeys: reservation.keys };
    this.#leasesBySession.set(sessionId, lease);
    for (const key of lease.keys) this.#claimsByKey.set(key, lease);
    return lease;
  }

  cancel(sessionId, reservationId) {
    const reservation = this.#reservationForSession(sessionId, reservationId);
    this.#reservations.delete(reservationId);
    this.#releaseClaim(reservation);
    return true;
  }

  releaseSession(sessionId) {
    const lease = this.#leasesBySession.get(sessionId);
    if (lease) {
      this.#leasesBySession.delete(sessionId);
      this.#releaseClaim(lease);
    }
    for (const [reservationId, reservation] of this.#reservations) {
      if (reservation.sessionId !== sessionId) continue;
      this.#reservations.delete(reservationId);
      this.#releaseClaim(reservation);
    }
  }

  validateSaveTarget(sessionId, identity, canonicalPath) {
    const lease = this.#leasesBySession.get(sessionId);
    if (!lease) throw new Error('The window does not own an open document');
    const pending = [...this.#reservations.values()]
      .filter((reservation) => reservation.sessionId === sessionId);
    const candidates = [lease, ...pending];
    if (candidates.some((claim) => (
      identity?.documentId === claim.identity.documentId
      && identity?.sourceDigest === claim.identity.sourceDigest
      && canonicalPath
      && canonicalPath === claim.canonicalPath
    ))) return true;
    if (identity?.documentId !== lease.identity.documentId) {
      throw new Error('The save target does not belong to the active document');
    }
    if (identity?.sourceDigest !== lease.identity.sourceDigest) {
      throw new Error('The save request has a stale document identity');
    }
    throw new Error('The native save target is owned by another document');
  }

  leaseForSession(sessionId) {
    return this.#leasesBySession.get(sessionId) ?? null;
  }

  #reservationForSession(sessionId, reservationId) {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation || reservation.sessionId !== sessionId) {
      throw new Error('Document reservation does not belong to this window');
    }
    return reservation;
  }

  #releaseClaim(claim) {
    for (const key of claim.claimedKeys) {
      if (this.#claimsByKey.get(key) === claim) this.#claimsByKey.delete(key);
    }
  }
}
