import { createHash, sign } from 'node:crypto';

import { CloudError } from './protocol.mjs';

export const RESPONSE_PROOF_VERSION = 'RAUHWpx-response-v1';
export const SSE_PROOF_VERSION = 'RAUHWpx-sse-event-v1';
export const SSE_STREAM_PROTOCOL = 'rauhwpx-sse-v1';
export const SSE_STREAM_DIGEST = createHash('sha256').update(SSE_STREAM_PROTOCOL).digest('hex');

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseProofNonce(value, { required = true } = {}) {
  if (value === undefined && !required) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(value)) {
    throw new CloudError('PROOF_NONCE_REQUIRED', 'A fresh base64url response-proof nonce is required', 400);
  }
  let decoded;
  try { decoded = Buffer.from(value, 'base64url'); }
  catch { throw new CloudError('PROOF_NONCE_INVALID', 'Response-proof nonce is invalid', 400); }
  if (decoded.length < 16 || decoded.length > 64 || decoded.toString('base64url') !== value) {
    throw new CloudError('PROOF_NONCE_INVALID', 'Response-proof nonce must contain 16 to 64 random bytes', 400);
  }
  return value;
}

export function canonicalResponse({ nonce, method, pathAndQuery, status, digest }) {
  return `${RESPONSE_PROOF_VERSION}\n${nonce}\n${method.toUpperCase()}\n${pathAndQuery}\n${status}\n${digest}`;
}

export function canonicalSseEvent({ nonce, method, pathAndQuery, status, seq, type, digest }) {
  return `${SSE_PROOF_VERSION}\n${nonce}\n${method.toUpperCase()}\n${pathAndQuery}\n${status}\n${seq}\n${type}\n${digest}`;
}

export function createResponseProof(identity, request, nonce, pathAndQuery = request.url || '/') {
  if (!identity?.privateKey) throw new Error('Server identity is missing its Ed25519 private key');
  return {
    identity,
    nonce,
    method: String(request.method || 'GET').toUpperCase(),
    pathAndQuery,
  };
}

function signature(privateKey, canonical) {
  return sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64url');
}

export function responseProofHeaders(proof, status, digest) {
  if (!proof) return {};
  const canonical = canonicalResponse({ ...proof, status, digest });
  return {
    'X-Rauhwpx-Content-SHA256': digest,
    'X-Rauhwpx-Response-Signature': signature(proof.identity.privateKey, canonical),
  };
}

export function signedSseFrame(proof, event) {
  if (!proof) throw new Error('SSE event proof requires a response proof context');
  const data = JSON.stringify(event);
  const digest = sha256Hex(Buffer.from(data));
  const canonical = canonicalSseEvent({ ...proof, status: 200, seq: event.seq, type: event.type, digest });
  return [
    `id: ${event.seq}`,
    `event: ${event.type}`,
    `rauhwpx-sha256: ${digest}`,
    `rauhwpx-signature: ${signature(proof.identity.privateKey, canonical)}`,
    `data: ${data}`,
    '',
    '',
  ].join('\n');
}
