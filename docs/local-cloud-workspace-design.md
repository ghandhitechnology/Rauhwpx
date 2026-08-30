# Seamless local and cloud workspace

## Problem

Studio has one long-lived editor, one local agent bridge, and one mounted conversation. Cloud handoff already provides a durable room, signed live events, stable document checkpoints, and one cloud writer. Cloud checkpoints currently replace the primary editor document, and the worker's Xvfb display has no Studio viewer. A local and cloud switch must preserve opaque editor state, keep chat connected, and leave write ownership under the existing cloud lease.

## Usage

`main.ts` creates one controller around two mounted roots. The selected mode changes the visible content and composer route in one transition.

```ts
const workspace = createWorkspaceController({
  localRoot: document.getElementById('editor-area')!,
  cloudRoot: createCloudWorkspace(),
  cloud: cloudClient.display,
});

initAgentSidebar({
  bridge: agentBridge,
  cloudController: cloudClient.control,
  workspace,
});

workspace.select('cloud');
```

Composer submission reads one derived target.

```ts
const target = workspace.composerTarget();

if (target.kind === 'local-ready') {
  sendLocalMessage(text);
} else if (target.kind === 'cloud-ready') {
  await cloudUi.queueMessage(text, messageId, attachments);
} else {
  showComposerUnavailable(target.message);
}
```

## Shape

### Workspace state

```ts
type WorkspaceMode = 'local' | 'cloud';

type ComposerTarget =
  | { kind: 'local-ready' }
  | { kind: 'local-blocked'; reason: 'cloud-lease'; message: string }
  | { kind: 'cloud-ready'; sessionId: string; expectedVersion: number }
  | {
      kind: 'cloud-blocked';
      reason: 'no-session' | 'not-accepting-messages';
      message: string;
    };

type CloudDisplayState =
  | { kind: 'unavailable'; reason: CloudDisplayUnavailableReason; message: string }
  | { kind: 'connecting'; sessionId: string }
  | { kind: 'live'; sessionId: string; frame: CloudDisplayFrame }
  | { kind: 'stalled'; sessionId: string; lastFrame: CloudDisplayFrame | null }
  | { kind: 'ended'; sessionId: string; lastFrame: CloudDisplayFrame | null };
```

`WorkspaceMode` is the only stored execution-target choice. The controller derives both root visibility and `ComposerTarget` from it. `CloudDocumentLease` stays independent and remains the only document write authority.

The local and cloud roots are siblings in one stack. The inactive root stays mounted with `inert`, `aria-hidden`, hidden visibility, and disabled pointer events. Studio does not recreate `WasmBridge`, `CanvasView`, `AgentBridge`, `CloudController`, the transcript, or the composer.

### Display transport

The display uses a transient signed frame rail.

```ts
type CloudDisplayCapability =
  | {
      kind: 'available';
      protocol: 'rauhwpx-frame-v1';
      sessionId: string;
      streamId: string;
      width: number;
      height: number;
      maxFrameBytes: 524_288;
      maxFps: 2;
    }
  | {
      kind: 'unavailable';
      sessionId: string | null;
      reason: CloudDisplayUnavailableReason;
      message: string;
      retryable: boolean;
    };

interface CloudDisplayFrame {
  streamId: string;
  sequence: number;
  capturedAt: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg';
  byteLength: number;
  sha256: string;
  bytes: Uint8Array;
}
```

The worker runs one demand-driven `ffmpeg x11grab` publisher beside `SessionDisplay`. The worker sends JPEG frames through its existing session-token control path. The control plane keeps the newest two frames in memory. Public clients receive signed frame metadata and fetch signed image bytes with their normal access token.

Frame streams bind to the worker identity accepted by `SessionStore.authenticateWorker()`. A replacement worker gets a new token and stream. Old publishers fail authentication. No display generation is inferred from the runtime lease row because that row currently resets after recovery.

Capture runs at 2 fps only while Cloud mode has an authenticated visible viewer. Local mode releases display interest and keeps the last decoded frame. No viewer means no capture after a short grace period. Display interest does not create or renew conversation presence.

### Checkpoint ownership

Ordinary cloud checkpoints keep their existing digest verification, archive, and origin-sync work. They stop calling `wasm.loadDocument()` on the primary editor. The cloud frame is the live cloud view.

Only these authority transitions replace primary editor bytes:

- verified takeover;
- explicit result application;
- opening another document through the existing document flow.

This keeps local scroll, selection, undo, file-handle identity, and local agent state intact while cloud owns the document. The local root remains read-only under the cloud lease.

### Conversation ownership

One `ChatThread`, transcript, and composer remain shared. Cloud and local agents do not write it concurrently. During a cloud lease, Local mode shows retained local state and a blocked composer. Cloud mode queues messages into the durable room. `AgentBridge` stays connected but cannot start another turn until takeover or end imports the stable cloud timeline.

This preserves the current whole-thread timeline contract. Source-aware concurrent local and cloud turns require event envelopes with immutable source, thread, session, and turn identity, plus message-level reconciliation. That work stays outside this change.

## Module map

| Area | Change |
| --- | --- |
| `cloud/document-runtime/session-frame-publisher.mjs` | Own demand-driven ffmpeg capture, duplicate suppression, one in-flight upload, and fail-soft shutdown. |
| `cloud/worker/client.mjs` and `cloud/worker/main.mjs` | Open, publish, wait for demand, and close a worker-authenticated frame stream. |
| `cloud/src/display-frame-store.mjs` | Keep bounded transient frames, viewer interest, waiters, and worker ownership. |
| `cloud/src/http-server.mjs` | Add worker publish routes and signed public capability, metadata, and image routes. |
| `cloud/install/Containerfile.worker` and `.sandbox` | Install ffmpeg in both runtime products and verify x11grab support. |
| `desktop/cloud-client.mjs` and `cloud-coordinator.mjs` | Verify and forward display state and frames outside the conversation event batch. |
| `desktop/main.mjs` and `preload.cjs` | Scope display subscriptions to the sending window and close them with that window. |
| `rhwp/rhwp-studio/src/cloud/*` | Parse the display contract, own the workspace reducer, and normalize desktop and browser transports. |
| `rhwp/rhwp-studio/src/ui/cloud-workspace.ts` | Present frames, retain pan and zoom, manage object URLs, and announce connection state. |
| `agent-sidebar/index.ts` and `cloud-ui.ts` | Add the Local and Cloud switch and route one composer from the derived target. |
| `main.ts` | Mount both roots and split checkpoint persistence from takeover application. |

## Boundaries and recovery

- Frame state is transient. Conversation and document state remain durable through the existing room, timeline, and checkpoint stores.
- The frame store retains two frames per stream and never writes frames to SQLite or BlobStore.
- Every frame is JPEG, at most 512 KiB, and bound to an authenticated worker stream. The server computes its digest.
- Worker upload, server storage, and client decode are all latest-wins with one pending item.
- Suspend, completion, requeue, worker loss, lease replacement, and runtime shutdown close publishers, subscribers, frame buffers, and demand.
- A display failure never stops document tools or cloud chat.
- The preview is view-only. Pointer and keyboard input need a separate audited capability and are outside `rauhwpx-frame-v1`.
- The transcript and stable checkpoint mirror remain the accessible representation. Preview status uses an ARIA live region and never captures keyboard focus.
- Desktop self-hosted, app-hosted, and browser clients return the same typed unavailable reasons. Missing methods on older builds map to `client-unsupported`.

## Synthesis decision

The signed frame candidate is the base. It scored 21 out of 25 against 11 out of 25 for reverse RFB. It uses the repository's existing worker token, signed HTTP bodies, signed event verification, desktop IPC, PWA transport, and SSH tunnel behavior.

The design takes these details from the reverse RFB candidate:

- one workspace mode derives both content and composer target;
- mounted sibling roots preserve local state;
- checkpoint persistence and takeover application are separate;
- unavailable results are typed;
- stale connections clean up idempotently.

RFB, noVNC, public WebSocket upgrades, remote input, reusable viewer secrets, and a desktop loopback WebSocket proxy are rejected. They add capabilities outside the request and create another transport and authentication system.

## Tradeoffs accepted

- We accept a 2 fps read-only preview in exchange for one bounded transport that works on every current client path.
- We accept a blocked Local composer during a cloud lease in exchange for one transcript writer and one document writer.
- We accept no frame history in exchange for fixed memory and zero long-session disk growth.
- We accept one image request per changed frame in exchange for small signed metadata events and independent binary verification.

## Locked decisions, 2026-08-30

- Cloud preview uses `rauhwpx-frame-v1` at up to 2 fps.
- The first release is view-only.
- Local and cloud roots stay mounted in one renderer.
- The selected mode changes the main view and composer route together.
- Local composer is blocked while cloud owns the document.
- Hidden preview demand does not keep the worker awake.
- Cloud checkpoints no longer replace the local editor before takeover or explicit result application.
- Both worker images receive the same pinned capture dependency and image-level checks.

## Next implementation step

Build the backend vertical slice first. Prove one authenticated worker frame reaches a paired client, stale workers cannot publish, buffers stay bounded, and display failure leaves document work running.
