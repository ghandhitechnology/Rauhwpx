# Raucloud reliability fixes

Scope: app-hosted Raucloud in the desktop app. These changes follow the [original audit](raucloud-reliability-audit.md). They are implemented locally; no hosted deployment was performed.

## Changes

- Accepted editing input marks workspace activity. The local worker heartbeat coalesces activity into broker renewals, at most once per 15-second heartbeat. A warm worker gets another five minutes while editing continues. Idle cleanup and explicit revocation still apply.
- Studio exposes its document revision. The runtime checks dirty state every two seconds between turns and during user waits. It skips unchanged exports and serializes checkpoint writes. End, takeover, pause, sleep, and requested lease shutdown drain accepted input and save before relinquishing control. A cancelled sleep reopens the same document. Restoring an idle session starts Studio before waiting for another agent message.
- Desktop and browser clients batch up to 32 ordered inputs. Adjacent text, scroll, and pointer movement coalesce without crossing key or click transitions. Queues have size and age limits, and obsolete actions are discarded after a connection change. New servers confirm worker application. Lost acknowledgements do not reapply text; application failures reset held keys and buttons. The UI preserves unconfirmed text for copying and comparison.
- New clients receive JPEG bytes with their signed SSE metadata. This removes the frame GET round trip and the two-frame retention race on that path. Failed stale uploads give way to newer frames. Older servers and clients retain the original transport fallback.
- Local worker heartbeats no longer wait for broker requests. Broker outages enter a 90-second grace period before requesting a saved shutdown. Completion reports are persisted in SQLite before the local response and retried after an outage or process restart. The broker accepts a repeated completion receipt without charging again or extending idle time.
- Display reconnect continues while attached. Silent SSE reads expire after 45 seconds, and stream establishment has a deadline. The desktop watchdog continues after a failed reconnect. Failed health checks no longer automatically force-quit and replace the workspace. A retained frame stays marked stale until a fresh frame arrives.
- Live worker events use bounded batches independently of document export. Desktop checkpoint and timeline downloads run outside the event handler, coalesce pending work, retain the latest durable pending revision, and retry without restarting chat delivery. Profile changes still wait for admitted file operations.

## Verification

- `npm run test:cloud`: 397 passed, three environment-specific skips.
- `node --test rhwp/rhwp-studio/tests/cloud*.test.ts`: 105 passed.
- `node --test rhwp/rhwp-studio/tests/browser-cloud*.test.ts rhwp/rhwp-studio/tests/workspace.test.ts`: 49 passed.
- `node --test rhwp/rau-credits/tests/*.test.mjs`: 67 passed.
- `npm run build:wasm`, Studio production build, and `npm run check:cloud`: passed.
- `npm --prefix rhwp/rhwp-studio run e2e:cloud-workspace`: passed in headless Chromium with the desktop cloud mock.

The skips require Linux Xvfb or a normalization-sensitive filesystem. The browser test exercises workspace switching and local document ownership; it does not connect to a hosted worker.

The [regression probes](diagnostics/raucloud-reliability-probes.mjs) use real queue, broker, display-store, and runtime code with a fake network delay, provisioner, clock, and document engine:

| Probe | Original behavior | Updated behavior |
| --- | --- | --- |
| Twenty scroll events, simulated 100 ms request duration | 2,037 ms | About 111 ms, coalesced into one request |
| Editing every ten seconds after a turn | Teardown after five minutes | No teardown over thirty simulated minutes; idle teardown still works after editing stops |
| Manual edit after a turn, then End | Result omitted the manual edit | Result contains the manual edit |

Regression tests also cover pending input during handoff, lost application receipts, broker report recovery, signed inline-frame corruption, bounded input queues, silent streams, unchanged recovered documents, and newer revisions arriving during a blocked checkpoint download.

## Rollout and remaining limits

Deploy the broker activity endpoint first, then the cloud service and matching worker image, then the desktop build. The SQLite report table is created automatically. Capability negotiation keeps the old input and frame paths usable during a client upgrade; the new service and worker endpoints must ship together.

This remains a remote JPEG workspace capped at 12 fps. The changes remove avoidable request delays but cannot remove network transit or capture delay. Adaptive video transport and a local renderer with remote document synchronization are separate architectural work. No production input-to-visible latency distribution or hosted soak test has been measured here.

Before merging, run the updated desktop against an updated hosted worker through sleep/wake, broker outages, long document exports, and Korean IME editing. Measure input-to-visible p50/p95/p99 and verify the final document after a long session. The local checks establish the repaired behavior, not a production claim of native editing latency.
