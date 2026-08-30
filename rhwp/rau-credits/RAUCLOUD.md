# Raucloud broker

The Rau credits service authenticates Raucloud requests and enforces account limits. Clients use their existing opaque `rau_v1_…` account token. The service stores Railway credentials, remote service IDs, worker tokens, quota records, and idempotency keys.

## Public API

- `GET /v1/account` returns `{ account }`.
- `PATCH /v1/account/timezone` with `{ "timezone": "Asia/Seoul" }` initializes or schedules the account timezone.
- `GET /v1/cloud/status?deviceId=…&timezone=…` returns `CloudStatusEnvelope`. Omit `deviceId` when Settings only needs account data. Supplying it binds the access token to that device.
- `POST /v1/cloud/runs` with `{ deviceId, timezone?, idempotencyKey }` returns `CloudRunEnvelope`.
- `POST /v1/cloud/runs/:id/takeover` rejects the request unless the completed checkpoint has an encrypted artifact owned by the broker. This change does not add artifact storage, so cross-worker takeover is unavailable.
- `POST /v1/cloud/runs/:id/stop` with `{ deviceId, reason?, finishCurrentTurn?, checkpoint? }` either stops the run now or blocks new input until the current turn ends.

All routes use `Authorization: Bearer rau_v1_…`. Pairing receipts are returned only to the device bound to the controlling token.

## Worker API

Each cold worker receives a random token. The service stores its SHA-256 hash. A worker token can access only its assigned account and run.

- `GET /v1/internal/cloud/lease` discovers the current warm-reused run.
- `POST /v1/internal/cloud/runs/:id/allocation` starts billing when a turn begins. Provisioning, pairing, upload, queue time, and warm idle do not count.
- `POST /v1/internal/cloud/runs/:id/heartbeat` records elapsed time and returns `mustStop` when the 30-minute grace period ends.
- `POST /v1/internal/cloud/runs/:id/checkpoint`, `/complete`, and `/release` stop billing, then either retain the warm worker or tear it down.

Only the broker reconciler uses `CLOUD_WORKER_SECRET`. Do not add it to a user worker's environment.

## Limits and lifecycle

- One worker reservation per canonical verified-email account, across devices.
- 60 billed minutes per account-local quota window. A positive balance can start a turn.
- A turn that reaches zero may run for 30 more minutes to finish its current response. That extra time is deducted from the next quota window. Midnight does not extend the 30-minute deadline.
- Three confirmed cold starts per rolling 15 minutes and 12 per account-local window. Idempotent retries and warm reuse do not count.
- Ready and warm workers expire after five unbilled minutes. If deletion fails, the account remains in `tearing_down`. New allocation stays blocked until a reconciler confirms deletion.
- An account may change its timezone once every 30 days. The change takes effect at the current quota window's end, so changing timezone cannot trigger an early reset.
- The service stores checkpoint IDs, not checkpoint files. Cross-worker takeover and 30-day retention require encrypted artifact storage, restore verification before teardown, and expired-file deletion.

## Railway and migration

Only this service uses `RAUHWpx_RAILWAY_TOKEN`, the Railway project and environment IDs, and the configured worker image. `RAUHWpx_LEGACY_MIGRATION_STARTED_AT` starts a 72-hour migration window. After that window, the hourly reconciler lists and removes legacy `rauhwpx-sandbox-*` services. It reads the service list again before marking deletion complete.

Production requires `DATABASE_URL`. PostgreSQL stores the service state in one `JSONB` row. Each update locks that row with `SELECT … FOR UPDATE`, so multiple service replicas cannot allocate two workers or spend the same quota at once. On first use, the store imports the existing `RAU_CREDITS_DB` JSON file, including users, sessions, access grants, and encrypted OpenRouter keys.

Local development and tests may use the atomic JSON file. Its update lock works only inside one process. Run one service replica when using this fallback.

Contract types live in `cloud-contract.d.ts`.
