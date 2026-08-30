# Persistent cloud conversations

Status: implemented on `feat/persistent-cloud-agent-chat`.

## Outcome

A document and chat thread own one cloud conversation until the user explicitly
ends it. The cloud runtime is the only document writer. Desktop and PWA clients
show the same read-only document mirror, receive assistant and tool activity as
it happens, and may enqueue another turn from the existing Studio composer.

The feature is complete only when all of these predicates hold:

- A completed provider turn leaves the conversation open and accepting input.
- A message accepted during a running turn executes exactly once in immutable
  queue order after that turn reaches a stable boundary.
- Stop-and-redirect cannot interrupt a document operation. Successful edits
  before the safe boundary survive in an exact operation checkpoint. A failed
  tool remains visibly failed in the live activity stream, and clients stay on
  the last stable bytes rather than displaying an uncommitted mutation.
- Plan approval, missing user decisions, external side effects, and destructive
  work outside the cloud draft are durable wait states. They do not end the
  conversation or become ordinary messages accidentally.
- Every terminal turn has one stable document/timeline boundary. The origin
  device archives one local version for it and replaces the origin only if the
  origin digest still matches the last synchronized digest. A conflict keeps
  both files.
- Paired devices may view and send. Only the origin device may replace the
  original path; another device can take over only as a verified copy.
- At most two runtimes are warm server-wide and at most one is warm for a
  document. The last client leaving starts a 30-minute grace period, after
  which the runtime sleeps at a stable boundary.
- Explicit End first verifies a local archive receipt, then purges remote
  conversation content. Inactive remote content expires after 30 days.
- Provider-specific streams normalize into the same room event contract.

## State model

One status value cannot safely represent conversation lifetime, scheduler
admission, a provider turn, and a user wait. These are independent axes.

```ts
type RoomStatus = 'active' | 'ending' | 'archived' | 'purged';

type AdmissionStatus =
  | 'staged' | 'queued' | 'running' | 'sleeping'
  | 'suspended' | 'completed' | 'cancelled' | 'failed' | 'purged';

type ExecutionPhase =
  | 'idle' | 'working' | 'waiting'
  | 'awaiting-plan-approval' | 'awaiting-question-answer'
  | 'awaiting-external-effect-approval'
  | 'redirecting' | 'sleeping';

type TurnStatus =
  | 'queued' | 'running' | 'waiting' | 'checkpointing'
  | 'completed' | 'stopped' | 'redirected' | 'failed';

type WaitKind =
  | 'plan-approval' | 'question'
  | 'external-side-effect' | 'destructive-external';
```

The existing `sessions` row remains the aggregate and compatibility surface.
Protocol-v2 fields provide room and execution state. Normalized `session_turns`,
`session_waits`, immutable attachment-version links, presence leases, and
runtime leases provide the new semantics without invalidating v1 sessions.

## Authoritative boundaries

- SQL commands and room events are idempotent and monotonically ordered.
- Document and timeline blobs are authoritative only after an atomic boundary
  receipt. Live events never replace checkpoint recovery.
- A full source-format snapshot is the first preview format. It is exact and
  provider-independent. Content-defined chunk manifests may optimize transfer
  after correctness is established, without changing the revision contract.
- A successful document tool is a safe operation boundary only after its
  snapshot receipt is durable. A redirect latch blocks the next write, waits
  for that receipt, interrupts the provider, and seals the partial turn.
- Stable turn checkpoints are immutable. Offline clients archive all missing
  stable turns and apply only the newest checkpoint to the origin.

## Event contract

The existing signed SSE stream remains the transport. Durable events include
message acceptance, turn transitions, waits, tool results, exact operation and
turn document revisions, runtime sleep/wake, origin sync results, archive, and
purge. Failed tool results are the visible rollback marker; no uncommitted
document bytes are published. Assistant text deltas and tool progress may be
compacted, but a stable timeline is always the reconciliation authority.

Large arguments, results, documents, and attachments are blob references; they
are never embedded in SSE payloads.

## Compatibility boundary

Reuse:

- content-addressed blob uploads and digest checks;
- idempotent commands and ordered SSE replay;
- worker authentication and provider credential isolation;
- atomic document/timeline boundary commits;
- safe pause/takeover gates and recovery from stable checkpoints;
- desktop response pinning and origin conflict detection.

Add:

- persistent room lifecycle and explicit End;
- normalized turn, wait, attachment, presence, and runtime-lease records;
- safe redirect and document-operation boundary receipts;
- live event reduction and read-only document mirroring;
- per-turn origin autosync/archive;
- a browser-safe signed transport plus File System Access/OPFS adapters.

Existing v1 sessions finish under v1 semantics. A v2 room never downgrades to a
v1 writer after emitting v2-only mutation semantics.

## Implemented delivery

1. Persistent room foundation: additive migration, types, multiple durable
   turns, live event projection, explicit End, and compatibility tests.
2. Safe interaction: document-operation checkpoints, redirect latch, durable
   plan/question/effect waits, immutable follow-up attachments, and rollback.
3. Client continuity: desktop mirror and per-turn autosync, presence/sleep/wake,
   cross-device copy takeover, PWA signed transport, IndexedDB turn archive,
   and digest-gated File System Access origin synchronization.

The full-file preview fallback ships before any mutation-patch codec. CRDT/OT,
client-side tool replay, and rendered-page screenshots are deliberately out of
scope because cloud is the single writer and the document engine is the source
of semantic truth.

## Verification gates

- Atomic message/redirect races and command-response loss.
- Worker crash before and after provisional/stable boundary receipts.
- Plan/question/effect wait replay and stale-resolution rejection.
- Attachment-version immutability.
- Two-global/one-document runtime-lease admission and fake-clock sleep.
- Stable-turn archive, origin replacement, external-change keep-both, and
  non-origin takeover-as-copy.
- Desktop and PWA event-gap recovery to a verified stable checkpoint.
- Migration fixtures covering every existing v1 lifecycle state.
