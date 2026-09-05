# Persistent cloud conversations

Behavior and compatibility contract for persistent Cloud conversations.

## Outcome

A document and chat thread own one cloud conversation until the user explicitly
ends it. The Cloud runtime owns a draft separate from the local origin. Desktop
and PWA clients receive assistant and tool activity and enqueue another turn
from the existing Studio composer. The Cloud viewer accepts user editing input;
checkpoint archives provide recovery without changing the origin.

After setup, the existing conversation's **Cloud로 보내기** button transfers its
history, document snapshot, references, and composer text in one action. An empty
composer supplies a continuation request. An active local turn reaches a safe
boundary before transfer starts.

The implementation keeps these boundaries:

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
- Stable document/timeline boundaries are archived for recovery. Neither turn
  completion nor checkpoint mirroring automatically overwrites the origin.
- Only explicit user publication or `publish_cloud_document` requests writeback.
  The tool waits for a successful turn boundary. Publication checks the expected
  origin digest, preserves external edits, and keeps the conversation open.
  Desktop conflicts create a separate Cloud copy; PWA conflicts remain archived.
- Desktop retains the native origin document lease throughout Cloud work so
  explicit publication can validate the file identity and path. The separate
  Cloud authority lease blocks local editor mutations until authority returns.
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
  | 'staged' | 'queued' | 'running'
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
- Stable checkpoints are immutable. Reconnecting clients recover durable pending
  boundaries and verified checkpoint bytes. Recovery never implies publication;
  the origin changes only through an explicit publication or result action.

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
- stable checkpoint archives and explicit, digest-checked origin publication;
- a browser-safe signed transport plus File System Access/OPFS adapters.

The HTTP transport remains `protocolVersion: 1`. Persistent rooms require the
separate health field `conversationProtocolVersion: 2`; clients reject older
servers before uploading a new persistent handoff. Desktop and PWA question-mode
starts and switches also require `supportedWorkflows` to be an array containing
`question`. Ship the
matching control plane and worker runtime together; the service version string
or transport version alone is not a workflow capability check.

Existing v1 sessions retain their original lifecycle. New persistent rooms do
not fall back to a v1 writer when the server lacks room support.

## Implemented delivery

1. Persistent room foundation: additive migration, types, multiple durable
   turns, live event projection, explicit End, and compatibility tests.
2. Safe interaction: document-operation checkpoints, redirect latch, durable
   plan/question/effect waits, immutable follow-up attachments, and rollback.
3. Client continuity: stable checkpoint archives, presence/sleep/wake,
   cross-device copy takeover, PWA signed transport, IndexedDB storage,
   and explicit digest-checked origin publication.

The full-file preview fallback ships before any mutation-patch codec. CRDT/OT,
and client-side tool replay are outside this implementation. The interactive
remote viewer uses rendered frames; full document snapshots remain the recovery
format.

## Verification gates

- Atomic message/redirect races and command-response loss.
- Worker crash before and after provisional/stable boundary receipts.
- Plan/question/effect wait replay and stale-resolution rejection.
- Attachment-version immutability.
- Two-global/one-document runtime-lease admission and fake-clock sleep.
- Stable-turn archive without origin mutation; explicit user and agent publication;
  external-change keep-both; and non-origin takeover-as-copy.
- Desktop and PWA event-gap recovery to a verified stable checkpoint.
- Migration fixtures covering every existing v1 lifecycle state.
