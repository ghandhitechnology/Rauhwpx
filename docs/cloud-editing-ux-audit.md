# Cloud editing experience audit

Audited desktop and browser cloud connections, agent streaming, remote document viewing, recovery controls, and switching between local and cloud conversations. Changes preserve the current sidebar and document controls.

## Verified problems and repairs

| Area | Reproduction | Repair |
| --- | --- | --- |
| Connection startup | An idle SSE endpoint waited for its 15-second heartbeat to send headers, racing the client's connection deadline. | Both chat and display endpoints flush their signed headers immediately. |
| Connection recovery | A recovered browser stream kept showing reconnecting until that stream ended. Clean EOF could retry immediately without backoff. | Readiness updates when the verified stream opens. Unexpected closure enters cancellable backoff; completed sessions finish normally. |
| Authentication failures | Revoked credentials and invalid proofs triggered repeated reconnect attempts. | Permanent failures stop retrying and preserve their failure state through the client, coordinator, and UI. |
| Agent responsiveness | Status, checkpoint, and timeline downloads delayed later agent text on the browser SSE reader. | Background synchronization coalesces pending updates, retries transient failures, and cancels with its session/profile. A permanently missing artifact does not block subsequent work. |
| Transcript refresh | Downloading a new browser timeline did not notify subscribers, so it stayed invisible until another update. | Completed downloads publish their refreshed snapshot immediately. |
| Streaming transcript | Operation checkpoints omit the active turn. Applying one mid-response erased text already shown; a delayed checkpoint could also overwrite a finished reply. | Live turns retain their text and activity until completed history includes them. Session changes reset this guard. |
| Static document recovery | Reconnecting requested only newer frames. An unchanged document produced none, leaving the viewer stalled and input unavailable. | Each display connection can replay its latest verified frame once. Duplicate frames remain suppressed within that connection. |
| Stale display work | Old stream callbacks or unfinished image decoding could restore live controls after a disconnect. | Stream callbacks and image decoding are cancelled or rejected when the connection changes. |
| Buffered display traffic | Several valid frame events in one network read exceeded a limit intended for one event. | Limits apply separately to complete events and the unfinished remainder. Oversized individual events remain rejected. |
| Offline composing | Losing the cloud connection disabled drafting as well as sending. | Drafting remains available during an outage; Send stays disabled until recovery. |
| Local/cloud switching | Starting a local chat discarded the cloud draft. Opening another chat could carry the previous chat's text into it. | Text and staged files stay with their conversation during the current app session. Background cloud recovery notices stay out of the local composer. |
| Selection errors | A synchronous selection failure left its execution lock held. | Selection and refresh share the cleanup path, so the lock is released on either failure. |

## Measurements

These measurements use local services or explicit network fixtures.

| Check | Result |
| --- | --- |
| Idle chat and display SSE headers, real local HTTP | About 1 ms after the fix; the original failed a 500 ms deadline and depended on the 15-second heartbeat. |
| Twenty scroll inputs with a simulated 100 ms request | 112 ms total, one request in flight. |
| Opening recovery controls while status refresh is blocked | About 20 ms in the sidebar fixture. |
| Restoring a disconnected viewer in the sidebar fixture | About 357 ms. |
| Remote input smoke test | 100 target clicks, four viewport sizes, DPR 1/2, dragging, double-clicking, typing, and Korean composition events passed with simulated 80/250 ms request latency. |

## Verification

- `npm run test:cloud`: 509 passed, four skipped. Skips require Linux/Xvfb, built Studio assets, or a normalization-sensitive filesystem.
- Cloud-specific Studio unit tests passed. Coverage includes browser signatures, profile changes, session selection, viewer state, authority transitions, checkpoints, message submission, and transcript imports checked against the runtime's actual timeline recorder.
- The final coordinator, recovery, and transcript regression run passed 85 checks. It verifies that revoked credentials leave Send disabled, background retries stop, and explicit reconnection succeeds after repair.
- `npm run test:sidebar` passed. It exercises the production sidebar with local fixtures, including outage drafts and local/cloud draft isolation. The existing wide-subagent-layout check now uses a viewport large enough to reach its intended breakpoint.
- `npm run build:sidebar` passed.
- `npm --prefix rhwp/rhwp-studio run e2e:cloud-display` passed with two fresh headless browser profiles.
- `node docs/diagnostics/raucloud-reliability-probes.mjs` passed. Its idle-expiry probe now reads the broker's configured idle duration instead of assuming five minutes.
- `npm run check:cloud` and `git diff --check` passed.

[Narrow dark-mode recovery with an editable draft and retained document frame](evidence/cloud-audit-offline-draft.png).

## Shipping

Release the cloud service for immediate SSE headers, and the desktop/browser app for the client and UI fixes. No storage migration or protocol version change is required.

## Remaining live verification

No hosted service was deployed or contacted during this audit. Production input-to-visible p50/p95/p99 latency, a long hosted session through network changes, and native OS IME behavior still need measurement. The browser IME checks dispatch Chromium composition events. The remote viewer remains a JPEG stream with a 12 fps ceiling.

Conversation draft retention added here lasts for the current app session. Durable cross-restart storage still covers the existing first-message draft flow.

The full Studio type check requires the missing generated `@wasm/rhwp.js` declarations; the standalone sidebar build is independent of those assets.
