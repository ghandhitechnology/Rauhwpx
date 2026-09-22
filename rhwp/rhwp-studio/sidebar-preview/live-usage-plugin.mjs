import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

/** Opt-in local audit transport. Hub capabilities never enter browser code. */
export function liveUsagePlugin(hubUrl = process.env.RHWP_SIDEBAR_LIVE_HUB) {
  if (!hubUrl) return null;
  const hub = new URL(hubUrl);
  if (hub.protocol !== 'http:' || hub.hostname !== '127.0.0.1' || hub.username || hub.password) {
    throw new Error('Live sidebar usage requires a loopback HTTP hub.');
  }
  const require = createRequire(new URL('../../rhwp-agent/package.json', import.meta.url));
  const WebSocket = require('ws');
  const sessionId = `sidebar-audit-${randomUUID()}`;
  const token = process.env.RHWP_SIDEBAR_HUB_TOKEN || 'dev';
  let socket;
  let connecting;
  let launchId = '';
  const pending = new Map();
  const headers = () => ({ Authorization: `Bearer ${token}`, 'x-rhwp-launch-id': launchId });
  async function connect() {
    if (socket?.readyState === WebSocket.OPEN) return socket;
    if (connecting) return connecting;
    connecting = (async () => {
      const health = await fetch(new URL('/healthz', hub), { headers: headers(), signal: AbortSignal.timeout(10000) });
      if (!health.ok) throw new Error('Live agent hub is unavailable.');
      launchId = (await health.json()).launchId || '';
      const registration = await fetch(new URL(`/sessions/${sessionId}`, hub), {
        method: 'POST', headers: headers(), signal: AbortSignal.timeout(10000),
      });
      if (!registration.ok) throw new Error('Live agent hub registration failed.');
      const { capabilities } = await registration.json();
      const url = new URL('/studio', hub);
      url.protocol = 'ws:';
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('token', capabilities.studio);
      const connected = new WebSocket(url, { handshakeTimeout: 10000 });
      socket = connected;
      connected.on('message', (bytes) => {
        let message;
        try { message = JSON.parse(String(bytes)); } catch { return; }
        const waiter = pending.get(message.requestId);
        if (waiter) { pending.delete(message.requestId); waiter.resolve(message); }
      });
      connected.on('close', () => {
        for (const waiter of pending.values()) waiter.reject(new Error('Live agent hub disconnected.'));
        pending.clear();
      });
      connected.on('error', () => {});
      await new Promise((resolve, reject) => {
        connected.once('open', resolve);
        connected.once('error', () => reject(new Error('Live agent hub connection failed.')));
      });
      return connected;
    })().finally(() => { connecting = null; });
    return connecting;
  }
  async function request(frame) {
    const ws = await connect();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Live usage request timed out.')); }, 60000);
      pending.set(requestId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      ws.send(JSON.stringify({ v: 5, ...frame, requestId }));
    });
  }
  return {
    name: 'sidebar-live-usage',
    configureServer(server) {
      server.middlewares.use('/__sidebar-live-usage', (req, res) => {
        void (async () => {
          const origin = `http://${req.headers.host}`;
          if (req.method !== 'POST' || req.headers['x-sidebar-audit'] !== '1'
            || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')
            || (req.headers.origin && req.headers.origin !== origin)
            || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
            res.writeHead(403); res.end(); return;
          }
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 4096) throw new Error('Invalid usage request.');
          }
          const input = JSON.parse(body);
          let frame;
          if (input.type === 'usage-request') frame = { type: input.type, refresh: input.refresh === true };
          else if (input.type === 'codex-reset-consume') frame = {
            type: input.type, idempotencyKey: input.idempotencyKey, accountKey: input.accountKey,
          };
          else throw new Error('Unsupported live usage action.');
          const result = await request(frame);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(result));
        })().catch((error) => {
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ type: 'usage-error', message: error.message }));
        });
      });
      server.httpServer?.once('close', () => {
        socket?.close();
        void fetch(new URL(`/sessions/${sessionId}`, hub), { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(5000) }).catch(() => {});
      });
    },
  };
}
