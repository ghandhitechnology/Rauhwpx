# Raucloud reliability fixes

Scope: app-hosted Raucloud in the desktop app. These changes follow the [original audit](raucloud-reliability-audit.md). The audit includes a disposable hosted worker test; it does not establish that the updated production broker or final worker image has been deployed.

## Changes

- Previously saved documents can transfer their current unsaved draft without writing the local origin or clearing dirty state. The saved origin digest is tracked separately from the uploaded snapshot. Unknown baselines and external changes preserve a Cloud copy instead of authorizing overwrite. Failed transfers return the local draft to editable state.
- Existing conversation history can be handed off with **Cloud로 보내기**, including the current document snapshot, references, and composer message. An active local turn reaches a safe boundary first. Follow-up turns keep the Cloud conversation open.
- Stable checkpoints archive the Cloud draft without writing the origin. Only explicit **원본에 반영** or an agent `publish_cloud_document` request publishes it. Desktop retains its native origin lease, checks the expected digest, and preserves external edits in a conflict. Publication does not end the Cloud conversation.
- Cloud clients check persistent-room support before transfer. Desktop and PWA question mode also require the server's advertised `question` workflow capability. The control plane and worker must be upgraded together.
- Follow-up message records update atomically, accepted SSE receipts recover lost send responses, and generated message IDs remain distinct during concurrent sends. Input queued after reconnection survives an older stream's failure.
- Broker requests cover response-body deadlines and bounded JSON reads. Safe provider reads retry transient errors; ambiguous creates reconcile by name. Cancelled or expired allocations retain cleanup work. Active turns are metered before the quota window advances at midnight.
- Accepted editing input marks workspace activity. The local worker heartbeat coalesces activity into broker renewals, at most once per 15-second heartbeat. A warm worker gets another five minutes while editing continues. Idle cleanup and explicit revocation still apply.
- Studio exposes its document revision. The runtime checks dirty state every two seconds between turns and during user waits. It skips unchanged exports and serializes checkpoint writes. End, takeover, pause, sleep, and requested lease shutdown drain accepted input and save before relinquishing control. A cancelled sleep reopens the same document. Restoring an idle session starts Studio before waiting for another agent message.
- Desktop and browser clients batch up to 32 ordered inputs. Adjacent text, scroll, and pointer movement coalesce without crossing key or click transitions. Queues have size and age limits, and obsolete actions are discarded after a connection change. New servers confirm worker application. Lost acknowledgements do not reapply text; application failures reset held keys and buttons. The UI preserves unconfirmed text for copying and comparison.
- Headed Chromium uses the physical Xvfb viewport at scale 1 without automation chrome offsets. Text input uses Puppeteer’s supported `sendCharacter` API. The sandbox image must pass a real Linux screenshot-coordinate and Korean-input test before publication.
- Pointer click counts survive transport, including double-click selection. Capability negotiation removes the new field for older workers that reject unknown fields. Local IME mode controls stay local while committed text is sent to the worker.
- Authenticated worker browsers show the full-width editor without another chat/setup panel. The cloud-served shell suppresses translation popups; ordinary Studio/PWA HTML remains unchanged.
- New clients receive JPEG bytes with their signed SSE metadata. This removes the frame GET round trip and the two-frame retention race on that path. Failed stale uploads give way to newer frames. Older servers and clients retain the original transport fallback.
- Local worker heartbeats no longer wait for broker requests. Broker outages enter a 90-second grace period before requesting a saved shutdown. Completion reports are persisted in SQLite before the local response and retried after an outage or process restart. The broker accepts a repeated completion receipt without charging again or extending idle time.
- Display reconnect continues while attached. Silent SSE reads expire after 45 seconds, and stream establishment has a deadline. The desktop watchdog continues after a failed reconnect. Failed health checks no longer automatically force-quit and replace the workspace. A retained frame stays marked stale until a fresh frame arrives.
- Live worker events use bounded batches independently of document export. Desktop checkpoint and timeline downloads run outside the event handler, coalesce pending work, retain the latest durable pending revision, and retry without restarting chat delivery. Profile changes still wait for admitted file operations.

## Verification

A disposable `1.1.0-edge.13` Railway worker completed six real Codex turns through
`CloudCoordinator`. The first two edited the Cloud draft, and the downloaded
checkpoints were exported with native `rhwp` to verify both text markers. The
origin file stayed unchanged before publication.

The same live run verified:

- Manual publication wrote the exact checkpoint digest and left the room running.
- A later Cloud edit left the origin at its previously published digest.
- `publish_cloud_document` wrote the exact Cloud digest without closing the room.
- A simulated external local save remained byte-for-byte intact; publication
  produced a separate conflict copy matching the Cloud checkpoint.

The local audit also passed the hosted credits suite, repository CI tooling, and
desktop cloud regressions. Their tests cover provider response loss and timeouts,
allocation cancellation, midnight accounting, concurrent messages, reconnecting
input, and external saves during publication preparation. Browser workspace tests
with the desktop Cloud mock cover workspace switching and origin ownership; they
are separate from the real hosted run above.

The input fixes were also applied to the disposable worker for immediate Linux verification. The real Xvfb test passed with no skips, including screenshot-coordinate alignment, pointer targeting, and Korean input. A Korean paragraph entered into the actual HWP document survived checkpoint export and a full pause/resume cycle with the same digest; native `rhwp` confirmed the text and the local origin stayed unchanged.

After installing the rebuilt worker Studio, a seventh real Codex turn edited the document successfully and retained the Korean paragraph. [Before](evidence/pr188-cloud-before.jpg) and [after](evidence/pr188-cloud-after.jpg) screenshots show the worker-only editor layout change. The Linux proof also passes double-click delivery through the production input dispatcher.

An eighth turn verified automatic sleep/wake: reconnecting the desktop conversation woke the sleeping worker, completed the follow-up, and preserved both the cloud checkpoint and local origin byte-for-byte.

These source-level hosted checks preceded the immutable `edge.15` image verification. The [PR verification record](https://github.com/ghandhitechnology/Rauhwpx/pull/188) records final image and CI results. These results do not claim deployment of the updated production broker.

## Follow-up audit

The viewer fitting and in-conversation provider settings changes were integrated before the next audit. Further regressions exposed and fixed these boundary cases:

- Pointer movement now stays ordered with keys and text. Lost pointer capture releases the remote drag once; stale connection responses cannot update a newer viewer. Chromium IME commits are delivered once and remain bound to the conversation where composition began.
- The worker checks its event cursor and active tools atomically before interruption. Late requests from the interrupted turn are rejected. Pause checkpoints an unfinished turn without consuming it, so Resume continues the original goal and queued messages. Early planning interruption and End at the turn limit retain a valid result path.
- Signed queue receipts preserve a send after a lost HTTP response in both desktop and browser clients. Publication uses the guarded native file writer to preserve saves or deletions made at the final replacement boundary.
- Confirmed provider settings persist with the existing conversation, including when they match the optimistic UI selection. Failed changes restore the selection and keep the unsent draft.
- Orphan cleanup rechecks durable allocation ownership immediately before deletion, protecting allocations created during the inventory scan.

The matching worker image is `1.1.0-edge.16`. The PR verification record identifies its source, immutable digest, hosted control checks, and final repository CI results. The browser interaction proof is included in CI and covers screen fitting, pointer targeting, dragging, typing, and Chromium composition events.

The [regression probes](diagnostics/raucloud-reliability-probes.mjs) use real queue, broker, display-store, and runtime code with a fake network delay, provisioner, clock, and document engine:

| Probe | Original behavior | Updated behavior |
| --- | --- | --- |
| Twenty scroll events, simulated 100 ms request duration | 2,037 ms | About 111 ms, coalesced into one request |
| Editing every ten seconds after a turn | Teardown after five minutes | No teardown over thirty simulated minutes; idle teardown still works after editing stops |
| Manual edit after a turn, then End | Result omitted the manual edit | Result contains the manual edit |

Regression tests also cover pending input during handoff, lost application receipts, broker report recovery, signed inline-frame corruption, bounded input queues, silent streams, unchanged recovered documents, and newer revisions arriving during a blocked checkpoint download.

## Rollout and remaining limits

Deploy the broker activity endpoint and metering/recovery fixes, then the cloud service and matching worker image, then the desktop build. The SQLite report table is created automatically and conversation migrations run on service startup. Capability negotiation retains older input/frame transports, but persistent conversations require room protocol 2 and question mode requires its advertised workflow. The new control-plane and worker endpoints must ship together.

This remains a remote JPEG workspace capped at 12 fps. The changes remove avoidable request delays but cannot remove network transit or capture delay. Adaptive video transport and a local renderer with remote document synchronization are separate architectural work. No production input-to-visible latency distribution or hosted soak test has been measured here.

Remaining live checks include broker outages and long document exports. Korean committed text was tested through the production input protocol; an OS-level IME composition session was not measured. A long-session document check and input-to-visible p50/p95/p99 measurements are still needed; the hosted runs do not establish production latency or soak reliability.
