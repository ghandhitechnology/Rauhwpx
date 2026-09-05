# Rauhwpx cloud service

This package is the durable single-user control plane for cloud document agents. It requires Node.js 24.7 or newer, SQLite through `node:sqlite`, rootless Podman, and either Tailscale Serve or a user-managed HTTPS reverse proxy.

## Public API

All routes use protocol version 1. Every `/v1` response includes `X-Rauhwpx-Server-Key`. Except for the first-install health request, a desktop sends a fresh 16 to 64 byte base64url nonce in `X-Rauhwpx-Request-Nonce`. The server returns `X-Rauhwpx-Content-SHA256` and an Ed25519 `X-Rauhwpx-Response-Signature` bound to that nonce, the method, configured external base path plus normalized route and query, status, and body digest. This remains stable when Caddy or Tailscale strips its mount prefix before proxying. Clients verify both the signature and received bytes against the application key obtained over SSH. SSE handshakes use the fixed `rauhwpx-sse-v1` stream digest and every data frame has its own `rauhwpx-sha256` and `rauhwpx-signature` fields.

Access-controlled routes use opaque Bearer access tokens. Access tokens expire after 15 minutes. Refresh tokens rotate and expire after 30 days. The immediately previous rotation may be retried for 30 seconds, including after a service restart, until the successor is used. Other reuse revokes its family.

- `GET /v1/health` returns service version, transport `protocolVersion`, `conversationProtocolVersion`, `supportedWorkflows`, server ID, and pinned Ed25519 application key.
- `POST /v1/pairing/redeem` exchanges a one-time 10-minute code for a device and token pair.
- `POST /v1/pairing/bootstrap` issues a one-time code to the holder of `RAUHWpx_BOOTSTRAP_TOKEN`. It answers only while no device is paired and only when the token is configured. App-provided sandboxes use it instead of SSH.
- `POST /v1/token/refresh` rotates a refresh token.
- `GET /v1/profile` returns paired devices, provider readiness, setup actions, and service limits.
- `POST /v1/pairing` creates another one-time device code.
- `POST /v1/uploads/init` and `POST /v1/uploads/:id/chunks` implement resumable content-addressed uploads.
- `PUT /v1/providers/:provider/auth` imports the named provider's API key and allow-listed auth files from a paired device, then re-probes readiness.
- `POST /v1/sessions` stages a session from completed document, timeline, and reference blob IDs. The selected provider must already be available and authenticated.
- `POST /v1/sessions/:id/commands` accepts idempotent control commands. State controls require `payload.expectedVersion`.
- `GET /v1/sessions` and `GET /v1/sessions/:id` reconcile session state across paired devices.
- `GET /v1/sessions/:id/events?after=N` replays ordered SSE events and then follows live events.
- `GET /v1/sessions/:id/timeline` streams the latest portable timeline to any paired device.
- `GET /v1/sessions/:id/checkpoint` streams the latest stable document checkpoint to any paired device with digest, name, revision, turn, and boundary-kind headers.
- `GET /v1/sessions/:id/takeover` returns a pending takeover or the frozen checkpoint and timeline boundary receipt.
- `GET /v1/results/:id` streams result bytes to the origin device only.
- `POST /v1/results/:id/download-confirmed` records a verified origin download and purges sensitive server data. Retrying after purge is idempotent.

Sessions are staged until `session.activate` commits the handoff. Persistent rooms also support `session.end`, `turn.redirect`, `wait.resolve`, `conversation.workflow`, and immutable attachment versions on `message.queue`. A running takeover stays pending until the worker atomically commits matching checkpoint and timeline blobs and acknowledges the boundary. The durable `session.takeover_ready` event and takeover endpoint identify both blobs, their shared operation, revision, and turn. Every event contains the authoritative `stateVersion` in its envelope and payload.

## Conversation handoff and publication

After Cloud is configured and paired, **Cloud로 보내기** sends the current document snapshot, conversation history, references, and composer message to Cloud. An empty composer supplies a continuation request. A previously saved document may include unsaved draft edits; transfer does not save or clear that local draft. If a local turn is running, the handoff waits for its safe boundary. Follow-up messages use the same conversation; completing a turn does not require taking over or publishing the document.

The Cloud workspace edits a separate draft. Stable checkpoints and timelines are archived for recovery; they never automatically replace the origin file. The desktop retains the origin's native document lease while the Cloud authority lease keeps that document read-only in the local editor. The interactive Cloud workspace remains separate from the origin.

Publication is explicit: the user chooses **원본에 반영**, or the agent calls `publish_cloud_document`. The tool queues publication after a successful turn and stable checkpoint; it does not report that the local file has already been written. Publication checks the origin digest before replacement. An external save is preserved, with the Cloud version kept as a separate copy on desktop. Publishing leaves the Cloud conversation open for more turns.

The HTTP transport remains protocol 1; persistent conversations require `conversationProtocolVersion: 2`. Desktop and PWA clients reject an older server before starting a persistent handoff. Desktop and PWA clients also require `supportedWorkflows` to be an array containing `question` before starting or switching to question mode. Direct, plan, and question workflows require matching control-plane and worker implementations; a compatible transport version alone does not establish workflow support. See [persistent conversation behavior](PERSISTENT_CONVERSATIONS.md).

## Browser PWA access

The Studio PWA uses the same paired-device API over pinned HTTPS. Configure an
exact allowlist before connecting it:

```bash
RAUHWpx_BROWSER_ORIGINS=https://studio.example.com,https://office.example.com
```

Only exact HTTPS origins are accepted; wildcards, paths, credentials, and HTTP
origins fail service startup. The server grants only the Cloud methods and
headers needed by the browser client. The PWA verifies every response and SSE
frame with WebCrypto against the paired Ed25519 key and archives baseline and
stable-turn bytes in IndexedDB. Archiving does not write the origin. An explicit
publication may update a retained origin file handle only while write permission
is granted and its digest matches the expected origin digest. Otherwise the
origin remains untouched and the Cloud version stays archived.
A browser cannot install a VPS or import a desktop provider login; pair it to
an existing HTTPS/Tailscale server whose provider is already ready.

## Provider management

Provider credentials live on the VPS. A paired desktop imports the selected provider's local API key or auth files through `PUT /v1/providers/:provider/auth` before it stages a session. The control plane stores API keys in the vault and OAuth state under `/var/lib/rauhwpx-cloud/provider-auth`, then re-probes readiness. Interactive VPS login remains available.

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

## App-provided sandboxes

The desktop offers two server modes. Self-hosted installs this service on a user VPS over SSH. App-hosted asks a configured provider to create a sandbox, pairs without SSH, and tears the sandbox down on request. Railway is the first provider. `desktop/cloud-app-server.mjs` holds the registry contract of `configuration`, `spawn`, `status`, and `teardown`, so another provider is an added module rather than a new code path.

Sandbox hosts cannot run nested containers, so the sandbox image runs the control plane and its session workers in one container. Set `RAUHWpx_RUNNER=local` and the service starts each worker as a process under `RAUHWpx_WORKER_UID` with its own workspace and a copy of the provider credentials. `install/Containerfile.sandbox` and `install/sandbox-entrypoint.sh` build that image.

The local runner limits itself to one active worker because session processes share one uid and process namespace. On Linux, a dedicated `RAUHWpx_WORKER_UID` is also the cleanup boundary: the runner terminates the original process group, inventories that uid through `/proc`, and terminates remaining processes before removing the workspace or starting another session. `tini` runs as the sandbox init and reaps terminated descendants. A cleanup that cannot empty the live uid boundary fails closed and retains the workspace for recovery. When the worker uid is absent or matches the control-plane uid, `hardIsolationAvailable` is false and local development keeps process-group cleanup only. `RAUHWpx_DATA_DIR` stays mode 0700 so the worker uid cannot reach the database, blob store, or server identity key. Session workspaces live outside it under `RAUHWpx_WORKSPACE_ROOT`, which defaults to `/var/lib/rauhwpx-workspaces` and must not sit inside the data directory. The worker and display children receive allowlisted environments containing only runtime paths and session values, so the bootstrap token and seeded provider keys never reach the provider CLI.

```bash
podman build --tag ghcr.io/ghandhitechnology/rauhwpx-cloud:stable \
  --file cloud/install/Containerfile.sandbox cloud
podman push ghcr.io/ghandhitechnology/rauhwpx-cloud:stable
```

Run `bash cloud/install/build-runtime-assets.sh` first because the image copies the built Studio runtime, agent hub, and `rhwp` binary from `cloud/runtime-assets`.

App-hosted Raucloud normally reads its Railway configuration on the hosted credits broker. The direct Railway provider can also use local environment configuration. Tokens never belong in the repository or Studio renderer.

| Variable | Required | Meaning |
| --- | --- | --- |
| `RAUHWpx_RAILWAY_TOKEN` | yes | Railway API token that owns the sandbox project |
| `RAUHWpx_RAILWAY_PROJECT_ID` | yes | Project that receives sandbox services |
| `RAUHWpx_RAILWAY_ENVIRONMENT_ID` | yes | Environment inside that project |
| `RAUHWpx_RAILWAY_IMAGE` | no | Sandbox image, defaults to `ghcr.io/ghandhitechnology/rauhwpx-cloud:1.1.0-edge.14` |
| `RAUHWpx_RAILWAY_REGION` | no | Railway region for the sandbox instance |
| `RAUHWpx_RAILWAY_API_URL` | no | Alternate GraphQL endpoint for testing |

The broker requires all three connection values before it advertises allocation as available. Desktop sign-in and pairing do not supply Railway infrastructure credentials.

Each spawn generates a fresh 32-byte bootstrap token, sets it as a service variable, waits for the deployment and the health route, then redeems one pairing code through `POST /v1/pairing/bootstrap`. The desktop pins the server key returned by the health route and rejects a mismatch. A failed allocation attempts teardown and retains a durable cleanup request when deletion cannot be confirmed. An ambiguous create response is reconciled by the deterministic service name rather than replayed; read-only provider queries may retry transient failures. Teardown refuses while cloud work is live unless the caller forces it, deletes the service, and forgets the stored profile and tokens.

Provider credentials cannot be entered interactively in a sandbox. The entrypoint installs the CLI named by `RAUHWpx_SANDBOX_PROVIDER` and seeds any of `RAUHWpx_PROVIDER_KEY_CLAUDE`, `RAUHWpx_PROVIDER_KEY_CODEX`, `RAUHWpx_PROVIDER_KEY_GROK`, `RAUHWpx_PROVIDER_KEY_PI`, and `RAUHWpx_PROVIDER_KEY_CURSOR` through `provider login <name> --api-key-stdin`, so keys never appear in a process argument list.

## Worker boundary

The public listener rejects worker routes. Each sandbox receives a unique token and a mode-0600 Unix control socket. The worker downloads only its session blobs, verifies each digest, and runs in a read-only rootless container with private networking, bounded CPU, memory, pids, workspace tmpfs, and unrestricted outbound connections. Each stable turn commits the exported document and portable timeline through one SQLite transaction before pause, takeover, or completion can revoke the worker. The Studio runtime implements `document-runtime/run.mjs` according to `document-runtime/README.md`.

### Session virtual desktop

Every cloud worker session attempts one Xvfb display (`SessionDisplay`) owned by the worker uid, then fixes Studio to headed or headless mode for the harness lifetime. A ready display enables the demand-driven 12 fps live viewer after the document and chat runtime are ready. Authenticated viewers can send bounded `rauhwpx-input-v1` pointer, wheel, keyboard, paste, and composed-text events through the existing worker demand channel. One active viewer owns the transient control lease, and release or expiry resets pressed keys and buttons. Display loss fails the headed runtime rather than restarting Xvfb underneath Chromium. Computer-use capable providers see the same `DISPLAY`. `environment_screenshot` writes a PNG under the session work directory (inside `RHWP_IMAGE_ROOTS`) so `insert_image` can place it in the open HWP document. The screenshot directory is capped (20 files / 32 MB).
