# Raucloud broker

The Rau credits service authenticates Raucloud requests and enforces account limits. Desktop Cloud code calls the reusable account-session interface; raw `rau_account_v1_…` credentials remain inside that interface and never reach Studio. The service stores Railway credentials, remote service IDs, worker tokens, quota records, and idempotency keys.

## Shared sign-in

Cloud and Rau provider sign-in both create the same account session. The hub uses `POST /v2/account-session/provider` with that session to connect the account's existing Rau key, then refreshes both status displays. Provider provisioning can be retried without repeating account sign-in. Signing out through account settings or disconnecting Rau clears both local credentials.

Deploy the credits service with this endpoint before releasing the linked desktop flow. Older service versions keep account sign-in working but cannot finish provider linking. Existing account sessions link automatically when restored; legacy provider-only keys require one account sign-in because an OpenRouter key does not authorize a Cloud account. No stored-key or database migration is required.

## Public API

- `POST /v2/account-session/provider` returns `{ apiKey, email }` to the authenticated hub, reusing the account's trial allocation. The hub stores the key in the encrypted desktop vault; it never sends it to Studio.
- `GET /v1/account` returns `{ account }`.
- `PATCH /v1/account/timezone` with `{ "timezone": "Asia/Seoul" }` initializes or schedules the account timezone.
- `GET /v1/cloud/status?deviceId=…&timezone=…&runId=…` returns `CloudStatusEnvelope`. Omit `deviceId` when Settings only needs account data. Supplying it binds the account session to that device. Supplying `runId` includes that run even after it fails.
- `POST /v1/cloud/runs` with `{ deviceId, timezone?, idempotencyKey }` durably reserves the run and returns an `allocating` `CloudRunEnvelope` immediately. Provisioning continues in the service process, and clients poll status by run ID.
- `POST /v1/cloud/runs/:id/takeover` rejects the request unless the completed checkpoint has an encrypted artifact owned by the broker. Merge checkpoint storage retains reviewable document copies; cross-worker runtime takeover remains unavailable.
- `POST /v1/cloud/runs/:id/stop` with `{ deviceId, reason?, finishCurrentTurn?, checkpoint? }` either stops the run now or blocks new input until the current turn ends.

All routes are authorized through an active account session. Pairing receipts are returned only to the device bound to the controlling session.

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
- Ready and warm workers expire after two unbilled idle hours. Accepted workspace activity renews that window. If deletion fails, the account remains in `tearing_down`. New allocation stays blocked until a reconciler confirms deletion.
- An allocating worker may take up to 30 minutes before the broker expires its reservation. This covers Railway deployment and worker-health deadlines without holding the public create request open.
- An account may change its timezone once every 30 days. The change takes effect at the current quota window's end, so changing timezone cannot trigger an early reset.
- The service retains encrypted merge checkpoints and conversation snapshots for up to 30 days. A replacement worker restores verified conversation rows and resources through the account-fenced restore protocol described below.
- Transient broker outages allow up to ten minutes of continued work, bounded by the last metered quota allowance. At the quota fuse, input stops and a worker has 60 seconds to save its final checkpoint before forced cleanup. That window cannot start another turn.

## Conversation continuity

`GET /v1/cloud/conversations?sessionId=...` uses an account token and returns `{ accountId, conversations }`. Each descriptor identifies `sessionId`, `documentId`, `threadId`, and `cloudStartId`, with a monotonic snapshot `revision`, completed `turn` count, source `state`, digest, size, and epoch-millisecond `createdAt`/`expiresAt`. A descriptor's revision counts snapshots, not document edits.

A paired worker advertises `capabilities.conversationRestore` and `capabilities.conversationResourceMaxBytes` in health. `POST /v1/sessions/restore` accepts `{ sourceSessionId }` and returns `{ session, restored: true, sourceEventSeq, restoredEventSeq }`. Repeating it returns the existing session and cursor receipt. After replacement, lower the watch cursor to `sourceEventSeq` to receive the authoritative restored tail, even if the old worker displayed later progress deltas. A missing or purged snapshot returns `CONVERSATION_SNAPSHOT_NOT_FOUND`. Seed the configured provider before restoring. Safe queued or idle work can continue after provider and lease checks; a presence-sleep room wakes through its existing presence protocol.

The worker archives accepted creation, activation and other commands, turn starts, waits, stable boundaries and completion before returning their HTTP receipts. Progress text is coalesced by a 15-second retry task backed by SQLite pending records. Desktop acceptance must use the successful activation receipt; a local queued status or progress event alone does not prove broker durability.

Snapshots preserve session, turn, message, wait, command and event identities. They exclude pairing tokens, provider credentials, server identity, worker credentials, process leases and absolute blob paths. An unfinished turn restores as `suspended` with `WORKER_REPLACED_UNCERTAIN`, including its pending wait. Explicit Resume restarts from the saved document and keeps the original turn identity. A completed turn boundary can finalize a lost completion response without repeating provider work.

Workers send both snapshot and immutable resource chunks to `POST /v1/internal/cloud/runs/:id/conversations`. Resources use `kind: conversation-resource`; the small state snapshot uses `kind: conversation`. Resource receipts are cached and reused. Worker-only listing and chunk routes under `/v1/internal/cloud/conversations` and `/v1/internal/cloud/conversation-resources` authorize the current assignment. Broker assignment updates and artifact commits serialize together, and older snapshot generations cannot replace newer ones. A purge publishes a tombstone and removes its retained runtime resources.

Each resource and state snapshot is limited to 128 MiB. Creation rejects an oversized document or reference before accepting it. Conversation resources, snapshots and completed merge documents share the existing 512 MiB / 1,024-receipt account allowance. The snapshot expires no later than its earliest referenced resource. Provider credentials must be supplied again on a new worker; an interrupted provider process is never replayed automatically.

Roll out the broker before the worker image, then clients that use capability negotiation. Existing worker databases add four continuity bookkeeping tables on startup; the broker reuses its encrypted artifact tables. No production deployment is performed by these tests. Verify a real provider task with the laptop disconnected, an idle worker replacement, and a pending approval before broad rollout.

## Railway and migration

Only this service uses `RAUHWpx_RAILWAY_TOKEN`, the Railway project and environment IDs, and the configured worker image. `RAUHWpx_LEGACY_MIGRATION_STARTED_AT` starts a 72-hour migration window. After that window, the hourly reconciler lists and removes legacy `rauhwpx-sandbox-*` services. It reads the service list again before marking deletion complete.

Production requires `DATABASE_URL`. PostgreSQL stores the service state in one `JSONB` row. Each update locks that row with `SELECT … FOR UPDATE`, so multiple service replicas cannot allocate two workers or spend the same quota at once. On first use, the store imports the existing `RAU_CREDITS_DB` JSON file, including users, sessions, access grants, and encrypted OpenRouter keys.

Local development and tests may use the atomic JSON file. Its update lock works only inside one process. Run one service replica when using this fallback.

Contract types live in `cloud-contract.d.ts`.

## Durable merge checkpoints

The broker persists completed turn snapshots in its own PostgreSQL database. Deleting
an account's temporary Railway worker, or closing the desktop, does not delete these
snapshots. `DATABASE_URL` creates `rau_cloud_merge_artifacts` and
`rau_cloud_merge_chunks` automatically. These tables are separate from the 8 MiB
credits state row. Keep this database attached to the broker when replacing workers.
Each chunk is encrypted with AES-256-GCM using a key derived from `SESSION_SECRET`;
authenticated encryption binds the bytes to their account, artifact id and chunk index.
Keep `SESSION_SECRET` stable across broker restarts. Changing it requires re-encrypting
existing artifacts before the old key is removed.

The worker uploads each completed turn before acknowledging durable delivery:

- `POST /v1/internal/cloud/runs/:runId/merge-requests` authenticates with the run's
  worker bearer token and current account assignment. Retired workers, stopped
  runs and runs awaiting teardown cannot upload. JSON contains `sessionId`, `documentId`, `threadId`,
  `cloudStartId`, `operationId`, integer `revision`, integer `turn`, `kind: "turn"`,
  `fileName`, lowercase hexadecimal `sha256`, byte `size`, `chunkIndex`, `chunkCount`,
  and `bytesBase64`. Chunk indices start at zero. Chunks contain exactly 512 KiB
  decoded bytes except the last chunk; `chunkCount = ceil(size / 524288)`.
- Every accepted chunk returns `{complete, mergeRequest}`. The receipt contains
  `id`, original `runId`, all snapshot metadata, `chunkCount`, `createdAt` and
  `expiresAt` in Unix milliseconds. Only `complete: true` acknowledges durable
  publication. All chunks must exist and the complete file's size and SHA-256 must
  match before publication. Intermediate chunks remain invisible to discovery.
- `GET /v1/cloud/merge-requests?sessionId=...` uses an account bearer token and
  returns `{accountId, mergeRequests: [...]}`. Omit `sessionId` to list all retained
  receipts for the account. It requires no live worker or run.
- `GET /v1/cloud/merge-requests/:id/chunks/:index` uses the same account bearer
  token and returns `{bytesBase64}`. Other accounts receive 404.

The broker commits recovery publication when the final chunk passes verification.
The frozen document remains available for manual merge even if the worker dies or
loses its local assignment before committing its runtime boundary. This receipt
does not acknowledge runtime turn completion or authorize an origin-file write.
A later worker confirmation is not required, so instance deletion cannot strand
an otherwise complete recovery copy.

Account, session and operation identify one immutable receipt. Repeated chunks
must have identical bytes and metadata; conflicting retries return HTTP 409
`CLOUD_MERGE_CONFLICT`. Retries may use a later authenticated run from the same
account, and retain the original receipt's run id. After warm worker reuse, retries
must address its newly assigned run URL; historical run URLs cannot authorize uploads. Desktop recovery verifies the
size and digest again before offering a snapshot for local review.

Snapshots are limited to 128 MiB each, 512 MiB of reserved plaintext bytes and
1,024 pending or completed receipts per account. Reservation counts the full
announced file size from the first chunk. Full accounts receive HTTP 429
`CLOUD_MERGE_CAPACITY`; snapshots are never silently replaced. Incomplete uploads
and complete receipts expire 30 days after the first accepted chunk. Expired
receipts disappear from reads immediately, and physical deletion runs at broker
startup, hourly, and when that account next uploads. PostgreSQL cascades deletion
to encrypted chunks. Encryption adds 28 bytes per chunk plus database overhead.

Without `DATABASE_URL`, local development stores encrypted chunks and atomic
metadata under `<credits-db-path>.merge-artifacts`. Use only one broker process
with that directory. An in-memory adapter supports isolated tests. Production
PostgreSQL account locks coordinate quota reservations and idempotent uploads
across broker replicas.

Run `npm test` for memory, file and HTTP recovery checks. Set
`RAU_TEST_POSTGRES_URL` to an isolated test database to additionally exercise real
PostgreSQL restart recovery and simultaneous uploads from separate broker pools.
