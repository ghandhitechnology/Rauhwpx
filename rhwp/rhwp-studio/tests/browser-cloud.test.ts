import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { createBrowserCloudApi } from '../src/cloud/browser-cloud.ts';

class MemoryStorage implements Storage {
  #values = new Map<string, string>();
  get length() { return this.#values.size; }
  clear() { this.#values.clear(); }
  getItem(key: string) { return this.#values.get(key) ?? null; }
  key(index: number) { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string) { this.#values.delete(key); }
  setItem(key: string, value: string) { this.#values.set(key, value); }
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('browser cloud pairs, verifies signed responses, and forwards a signed live agent event', async () => {
  const pair = generateKeyPairSync('ed25519');
  const encoded = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const serverPublicKey = `ed25519:${encoded}`;
  const endpoint = 'https://cloud.example.test/rauhwpx-cloud';
  const sessionId = 'pwa_signed_room';
  let streamCalls = 0;

  const signedResponse = (request: Request, body: unknown, status = 200) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
    const url = new URL(request.url);
    const contentDigest = digest(bytes);
    const canonical = `RAUHWpx-response-v1\n${nonce}\n${request.method}\n${url.pathname}${url.search}\n${status}\n${contentDigest}`;
    return new Response(bytes, {
      status,
      headers: {
        'content-type': 'application/json',
        'x-rauhwpx-server-key': serverPublicKey,
        'x-rauhwpx-content-sha256': contentDigest,
        'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), pair.privateKey).toString('base64url'),
      },
    });
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/v1/health')) {
      return new Response(JSON.stringify({
        ok: true, version: '1.1.0', protocolVersion: 1, serverPublicKey, serverId: 'browser-test',
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-rauhwpx-server-key': serverPublicKey } });
    }
    if (url.pathname.endsWith('/v1/pairing/redeem')) {
      return signedResponse(request, {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accessExpiresAt: Date.now() + 10 * 60_000,
        device: { id: 'pwa-device', name: 'PWA' },
      });
    }
    if (url.pathname.endsWith('/v1/sessions')) {
      return signedResponse(request, { sessions: [{
        id: sessionId,
        stateVersion: 4,
        status: 'running',
        persistent: true,
        roomStatus: 'active',
        executionPhase: 'working',
        originDeviceId: 'pwa-device',
        clientContext: { threadId: 'thread-pwa', documentId: 'document-pwa' },
        originDocument: { name: 'pwa.hwpx', sha256: 'a'.repeat(64), size: 12 },
        limits: { maxDurationSeconds: 28_800, maxTurns: 100 },
        turnsUsed: 1,
        startedAt: Date.now(),
        currentWait: null,
      }] });
    }
    if (url.pathname.endsWith(`/v1/sessions/${sessionId}/checkpoint`)) {
      const bytes = Buffer.from('SIGNED-OPERATION-CHECKPOINT');
      const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
      const contentDigest = digest(bytes);
      const canonical = `RAUHWpx-response-v1\n${nonce}\n${request.method}\n${url.pathname}${url.search}\n200\n${contentDigest}`;
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'x-rauhwpx-server-key': serverPublicKey,
          'x-rauhwpx-content-sha256': contentDigest,
          'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), pair.privateKey).toString('base64url'),
          'x-content-sha256': contentDigest,
          'x-boundary-operation': 'operation_1',
          'x-boundary-kind': 'operation',
          'x-checkpoint-revision': '2',
          'x-checkpoint-turn': '1',
          'x-document-name': encodeURIComponent('pwa.hwpx'),
        },
      });
    }
    if (url.pathname.endsWith(`/v1/sessions/${sessionId}/events`)) {
      streamCalls += 1;
      if (streamCalls > 1) throw new DOMException('stopped', 'AbortError');
      const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
      const event = {
        sessionId,
        seq: 1,
        type: 'agent.event',
        payload: { type: 'agent', event: { type: 'assistant-delta', text: '라이브' } },
      };
      const data = JSON.stringify(event);
      const eventDigest = digest(Buffer.from(data));
      const canonicalEvent = `RAUHWpx-sse-event-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n1\nagent.event\n${eventDigest}`;
      const frame = [
        'id: 1',
        'event: agent.event',
        `rauhwpx-sha256: ${eventDigest}`,
        `rauhwpx-signature: ${sign(null, Buffer.from(canonicalEvent), pair.privateKey).toString('base64url')}`,
        `data: ${data}`,
        '',
        '',
      ].join('\n');
      const protocolDigest = digest(Buffer.from('rauhwpx-sse-v1'));
      const canonicalResponse = `RAUHWpx-response-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n${protocolDigest}`;
      return new Response(frame, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-rauhwpx-server-key': serverPublicKey,
          'x-rauhwpx-stream-protocol': 'rauhwpx-sse-v1',
          'x-rauhwpx-content-sha256': protocolDigest,
          'x-rauhwpx-response-signature': sign(null, Buffer.from(canonicalResponse), pair.privateKey).toString('base64url'),
        },
      });
    }
    throw new Error(`Unexpected PWA request: ${request.method} ${url.pathname}`);
  };

  const api = createBrowserCloudApi({ fetchImpl, storage: new MemoryStorage() });
  assert.ok(api);
  let unsubscribe = () => {};
  const live = new Promise<Record<string, unknown>>((resolve) => {
    unsubscribe = api.onCloudEvent((raw) => {
      const event = raw as Record<string, unknown>;
      const envelope = event.event as Record<string, unknown> | undefined;
      if (envelope?.type === 'agent.event') resolve(event);
    });
  });
  const paired = await api.cloudPair({
    code: 'ABCD-EFGH-IJKL',
    profile: {
      name: 'Browser VPS',
      host: 'cloud.example.test',
      sshUser: 'ubuntu',
      sshPort: 22,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'https', endpoint },
    },
  });
  assert.equal((paired.profile as Record<string, unknown>).connection, 'ready');
  const scoped = await api.cloudGetState({ threadId: 'thread-pwa', documentId: 'document-pwa' });
  assert.equal((scoped.session as Record<string, unknown>).kind, 'running');
  const checkpoint = await api.cloudDownloadCheckpoint({ sessionId, operationId: 'operation_1' });
  assert.equal(checkpoint.kind, 'operation');
  assert.equal(checkpoint.operationId, 'operation_1');
  const event = await live;
  assert.equal(event.sessionId, sessionId);
  assert.equal(((event.event as Record<string, unknown>).payload as Record<string, unknown>).type, 'agent');
  unsubscribe();
  assert.equal(streamCalls, 1);
});
