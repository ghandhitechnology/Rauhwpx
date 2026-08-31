const RESPONSE_VERSION = 'RAUHWpx-response-v1';
const SSE_VERSION = 'RAUHWpx-sse-event-v1';

export type BrowserProofProfile = { serverPublicKey: string };
export type BrowserRequestContext = { nonce: string; method: string; pathAndQuery: string };
export type BrowserSseFrame = {
  id: string;
  event: string;
  digest: string;
  signature: string;
  data: string;
};

function protocolError(message: string, code: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(message), { code, retryable: false as const });
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function publicKey(serverPublicKey: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'spki',
    exactBuffer(fromBase64Url(serverPublicKey.replace(/^ed25519:/, ''))),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', exactBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function boundedResponseBytes(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  const declaredHeader = response.headers.get('content-length');
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > maximum) {
    throw protocolError('Cloud 응답 크기 제한을 초과했습니다.', 'CLOUD_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        throw protocolError('Cloud 응답 크기 제한을 초과했습니다.', 'CLOUD_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function verifyResponseProof(
  response: Response,
  selectedProfile: BrowserProofProfile,
  context: BrowserRequestContext,
  digest: string,
): Promise<void> {
  if (response.headers.get('x-rauhwpx-server-key') !== selectedProfile.serverPublicKey) {
    throw protocolError('Cloud 서버 신원이 페어링한 서버와 다릅니다.', 'SERVER_IDENTITY_MISMATCH');
  }
  if (response.headers.get('x-rauhwpx-content-sha256') !== digest) {
    throw protocolError('Cloud 응답 무결성 증명이 일치하지 않습니다.', 'SERVER_BODY_TAMPERED');
  }
  const canonical = `${RESPONSE_VERSION}\n${context.nonce}\n${context.method}\n${context.pathAndQuery}`
    + `\n${response.status}\n${digest}`;
  let valid = false;
  try {
    valid = await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      await publicKey(selectedProfile.serverPublicKey),
      exactBuffer(fromBase64Url(response.headers.get('x-rauhwpx-response-signature') ?? '')),
      exactBuffer(utf8(canonical)),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw protocolError('Cloud 응답 서명이 잘못됐습니다.', 'SERVER_PROOF_INVALID');
}

export function parseSse(buffer: string): { frames: BrowserSseFrame[]; rest: string } {
  const frames: BrowserSseFrame[] = [];
  let rest = buffer.replace(/\r\n/g, '\n');
  let boundary = rest.indexOf('\n\n');
  while (boundary !== -1) {
    const raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const fields = { id: '', event: 'message', digest: '', signature: '', data: [] as string[] };
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const key = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (key === 'id') fields.id = value;
      else if (key === 'event') fields.event = value;
      else if (key === 'rauhwpx-sha256') fields.digest = value;
      else if (key === 'rauhwpx-signature') fields.signature = value;
      else if (key === 'data') fields.data.push(value);
    }
    if (fields.data.length) frames.push({ ...fields, data: fields.data.join('\n') });
    boundary = rest.indexOf('\n\n');
  }
  return { frames, rest };
}

export async function verifySseFrame(
  frame: BrowserSseFrame,
  context: BrowserRequestContext,
  selectedProfile: BrowserProofProfile,
): Promise<number> {
  const sequence = Number(frame.id);
  const eventDigest = await sha256(utf8(frame.data));
  const canonical = `${SSE_VERSION}\n${context.nonce}\n${context.method}\n${context.pathAndQuery}`
    + `\n200\n${sequence}\n${frame.event}\n${eventDigest}`;
  let valid = false;
  try {
    valid = eventDigest === frame.digest && await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      await publicKey(selectedProfile.serverPublicKey),
      exactBuffer(fromBase64Url(frame.signature)),
      exactBuffer(utf8(canonical)),
    );
  } catch {
    valid = false;
  }
  if (!valid || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw protocolError('Cloud 스트림 서명이 잘못됐습니다.', 'SSE_PROOF_INVALID');
  }
  return sequence;
}
