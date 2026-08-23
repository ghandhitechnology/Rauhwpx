# Rauhwpx cloud service

This package is the durable single-user control plane for cloud document agents. It requires Node.js 24 or newer, SQLite through `node:sqlite`, rootless Podman, and either Tailscale Serve or a user-managed HTTPS reverse proxy.

## Public API

All routes use protocol version 1. Every `/v1` response includes `X-Rauhwpx-Server-Key`. Except for the first-install health request, a desktop sends a fresh 16 to 64 byte base64url nonce in `X-Rauhwpx-Request-Nonce`. The server returns `X-Rauhwpx-Content-SHA256` and an Ed25519 `X-Rauhwpx-Response-Signature` bound to that nonce, the method, configured external base path plus normalized route and query, status, and body digest. This remains stable when Caddy or Tailscale strips its mount prefix before proxying. Clients verify both the signature and received bytes against the application key obtained over SSH. SSE handshakes use the fixed `rauhwpx-sse-v1` stream digest and every data frame has its own `rauhwpx-sha256` and `rauhwpx-signature` fields.

Access-controlled routes use opaque Bearer access tokens. Access tokens expire after 15 minutes. Refresh tokens rotate and expire after 30 days. The immediately previous rotation may be retried for 30 seconds, including after a service restart, until the successor is used. Other reuse revokes its family.

- `GET /v1/health` returns service version, protocol version, server ID, and pinned Ed25519 application key.
- `POST /v1/pairing/redeem` exchanges a one-time 10-minute code for a device and token pair.
- `POST /v1/token/refresh` rotates a refresh token.
- `GET /v1/profile` returns paired devices, provider readiness, setup actions, and service limits.
- `POST /v1/pairing` creates another one-time device code.
- `POST /v1/uploads/init` and `POST /v1/uploads/:id/chunks` implement resumable content-addressed uploads.
- `POST /v1/sessions` stages a session from completed document, timeline, and reference blob IDs.
- `POST /v1/sessions/:id/commands` accepts idempotent control commands. State controls require `payload.expectedVersion`.
- `GET /v1/sessions` and `GET /v1/sessions/:id` reconcile session state across paired devices.
- `GET /v1/sessions/:id/events?after=N` replays ordered SSE events and then follows live events.
- `GET /v1/sessions/:id/timeline` streams the latest portable timeline to any paired device.
- `GET /v1/sessions/:id/checkpoint` streams the latest stable document checkpoint to any paired device with digest, name, revision, and turn headers.
- `GET /v1/sessions/:id/takeover` returns a pending takeover or the frozen checkpoint and timeline boundary receipt.
- `GET /v1/results/:id` streams result bytes to the origin device only.
- `POST /v1/results/:id/download-confirmed` records a verified origin download and purges sensitive server data. Retrying after purge is idempotent.

Sessions are staged until `session.activate` commits the handoff. Supported commands are `session.pause`, `session.resume`, `session.takeover`, `session.cancel`, and `message.queue`. A running takeover stays pending until the worker atomically commits matching checkpoint and timeline blobs and acknowledges the boundary. The durable `session.takeover_ready` event and takeover endpoint identify both blobs, their shared operation, revision, and turn. Every event contains the authoritative `stateVersion` in its envelope and payload.

## Provider management

Provider credentials are created independently on the VPS. Local desktop credentials are never accepted by the handoff API.

```bash
sudo rauhwpx-cloud provider install codex
sudo rauhwpx-cloud provider login codex
sudo rauhwpx-cloud provider status codex
sudo rauhwpx-cloud doctor
```

The same commands support `claude`, `codex`, `pi`, `grok`, and `cursor`. API-key login reads only standard input.

```bash
read -rsp 'OpenRouter API key: ' key
printf '%s' "$key" | sudo rauhwpx-cloud provider login pi --api-key-stdin
unset key
```

OAuth and device-code state stays under `/var/lib/rauhwpx-cloud/provider-auth`. API keys use an AES-256-GCM vault with a mode-0600 master key.

## Installation

`install/install.sh` supports Ubuntu 24.04 and 26.04 LTS, Debian 12 and 13, and amd64 or arm64. It verifies release SHA-256 and Sigstore identity, installs a hardened systemd service, builds the rootless worker image, adds only the `/rauhwpx-cloud` Tailscale Serve path, and emits the desktop provisioning receipt.

Set `RAUHWpx_CHANNEL=prerelease` for the persistent prerelease channel. Tailscale is the default transport. For public HTTPS, set `RAUHWpx_TRANSPORT=public-https` and `RAUHWpx_PUBLIC_HOST=cloud.example.com`. The installer configures Caddy and verifies the public endpoint. Set `RAUHWpx_CONFIGURE_CADDY=0` only when an existing HTTPS proxy already forwards `/rauhwpx-cloud` to `127.0.0.1:7740`.

## Worker boundary

The public listener rejects worker routes. Each sandbox receives a unique token and a mode-0600 Unix control socket. The worker downloads only its session blobs, verifies each digest, and runs in a read-only rootless container with private networking, bounded CPU, memory, pids, workspace tmpfs, and unrestricted outbound connections. Each stable turn commits the exported document and portable timeline through one SQLite transaction before pause, takeover, or completion can revoke the worker. The headless Studio runtime implements `document-runtime/run.mjs` according to `document-runtime/README.md`.
