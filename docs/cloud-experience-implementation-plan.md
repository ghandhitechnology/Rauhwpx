# Cloud experience implementation plan

September 20, 2026. Design decisions agreed through the six-question discussion. Implemented on `feat/cloud-experience` and verified against the desktop, Cloud runtime, merge engine, and production sidebar preview.

This plan follows the [cloud research and UI audit](cloud-system-research-2026-09-20.md). The decisions below supersede its earlier design suggestions, particularly grouped inbox headings and any separate task-creation flow.

## Agreed product direction

Cloud belongs to the existing chat and document workflow. Users delegate work, leave, and return to a saved result they can review. Remote monitoring remains available when they want to watch. Reliability should come from durable work and recovery, with concise status when something needs attention.

| Decision | Agreed direction |
| --- | --- |
| Starting work | Start from the existing chat, using its document, conversation, and selected compatible AI. |
| Returning to work | A simple app-wide task inbox with document previews, minimal necessary status, and no subsection headings. |
| Local editing | Users can keep editing their original document while Cloud works on its separate version. Preserve the existing Hancom Git foundation. |
| Reviewing results | Review each change with accept, reject, or custom edit. Also offer applying all compatible changes, with conflicts requiring a choice. Replacing the whole document is a separate destructive action with a warning and a recoverable prior version. |
| Editing remote work | Pause Cloud, edit its saved draft in the local native editor, then resume the same task with the updated document and prior context. |
| Visual philosophy | Reuse the app's navigation, editor, typography, spacing, controls, and interaction patterns. Every additional element must help users act or understand the current state. |

The inbox and review layouts were validated together in the working production preview at normal and narrow widths. The implementation uses the app's existing iconography, controls, and motion.

## Interaction contract

### Delegate and return

The existing composer starts Cloud work. Submission becomes accepted only after the service has durably recorded the request. A brief preparation state covers the transfer. Unsupported provider selection needs a direct correction before submission.

The inbox opens the original task and saved conversation. Each row needs a recognizable document preview or fallback icon, its name, and one short status. Clicking the row must have a clear destination. Avoid nested cards, duplicate badges, usage charts, infrastructure counts, and separate groups for each state. Usage and environment management belong in settings.

Use a small product vocabulary such as Working, Needs you, Ready, and Paused. Derive these from saved task state. A lost viewing connection must not imply that remote work stopped. Display a concise connection message only when it affects what the user can do. Never invent percentage progress for reconnecting or provisioning.

Completion notifications open the exact task and result revision. Persist unsent follow-up messages across restarts. A ready result remains readable even if its worker has gone away.

### Review inside the familiar editor

Open the result through the normal document surface. Keep the document visually dominant and navigate its changes using existing sidebar and editor patterns. The initial preview should explore one change at a time with an optional compact overview. Reuse the native document renderer for layout, images, tables, and formatting.

Each reviewable change supports accept, reject, and edit, with undo. Check and X controls need accessible names and short contextual labels where their meaning is ambiguous. A rejection preserves the corresponding current-document content; a custom edit becomes the selected result for that change.

Every proposed change must be inspectable, including automatically mergeable edits. Structurally dependent operations, such as inserting a table and filling its cells, may need one coherent review unit. Do not offer combinations that would create an invalid document. Show the affected content when a decision also affects dependent edits.

| Action | Result |
| --- | --- |
| Review changes | Decide each change; preview the combined document before applying it. |
| Apply all | Accept compatible Cloud changes while preserving unrelated local edits. If conflicts exist, collect decisions before committing the merged result. |
| Replace with Cloud version | Replace the entire current document with the selected Cloud revision. Put this in the overflow menu, state that local changes will be replaced, and save a recoverable prior version first. |

The action's scope must be visible. A squash commit does not define conflict handling or imply permission to discard local edits. Use ordinary document language in the interface, while retaining Git semantics underneath.

### Watch, pause, edit, continue

Remote monitoring opens from the existing task. Keep the remote viewer for observing work. Pause and edit opens the Cloud draft locally after the worker reaches a verified saved boundary.

The sequence is:

1. Request pause and stop issuing new document mutations. Complete or reconcile any mutation already in flight.
2. Save and acknowledge an exact Cloud revision, then open it as a separate local editable draft. The user's original document remains independent.
3. Save local edits durably while the worker remains paused. Typing, selection, scrolling, and Korean IME use the local editor.
4. On Continue, upload and validate the edited revision, record the edit and resume context, and only then allow the worker to proceed.

Keep the same task, conversation, and visible history throughout. If upload or reconnection fails, retain the local draft and the paused task so the action can be retried. Closing and reopening the app must restore the interrupted editing session.

Local editing removes network round trips from keystrokes. Opening the paused draft and continuing still involve synchronization; measure and reduce those waits. Do not promise instant resume before measuring the real path.

## Engineering design

### Preserve the existing architecture

Extend the current Studio, desktop coordinator, broker, worker, and Hancom Git implementation. Keep existing durable handoff receipts, checkpoint verification, event replay, merge transactions, and recovery mechanisms. This work does not require a new workflow platform or collaborative editing protocol.

Give each task a stable identity independent of a worker attempt. Fence mutations by the current attempt and document revision. Store immutable document resources outside long database transactions, then commit their verified references in a short transaction. Scope broker updates by account or task instead of serializing unrelated accounts through the current global state row.

### Repair durability and transfer costs first

- Fix artifact capacity accounting so replacing an existing snapshot charges for the resulting storage, and cleanup can proceed when an account is full. Retention must protect active task baselines, paused drafts, and replacement recovery versions.
- Change shutdown to stop new work, drain document mutations, obtain a durable checkpoint receipt, then release the lease and tear down the worker. A forced timeout must remain distinguishable from a successful save.
- Reduce repeated full history and document transfers using content-addressed resources and compact event batches. Preserve required durable acknowledgements while moving optional backup work off the interactive path.
- Correlate commands, document revisions, worker attempts, save receipts, and displayed frames so latency and lost transitions can be diagnosed.

Relevant code: [artifact storage](../rhwp/rau-credits/merge-artifacts.mjs), [broker persistence](../rhwp/rau-credits/store.mjs), [broker](../rhwp/rau-credits/cloud-broker.mjs), and [runtime shutdown](../cloud/src/runtime.mjs).

### Extend the merge model beyond conflicts

The current [merge domain](../rhwp/rhwp-studio/src/merge/domain.ts) and [resolver state](../rhwp/rhwp-studio/src/merge/resolver-state.ts) primarily expose decisions for conflicts. Per-change review requires a model for all incoming changes, their dependencies, and their selected outcomes.

Build review units from the existing structural analysis and [manifest identities](../rhwp/rhwp-studio/src/merge/manifest.ts). Bind decisions to the exact base, current, and incoming revisions plus the analysis version. Persist decisions and undo history. If the original changes during review, reanalyze and carry forward only decisions whose content and dependencies still match.

Extend materialization to apply accepted and manually edited units while retaining current content for rejected units. Preserve resource validation and the atomic document/version transaction in the [versioning controller](../rhwp/rhwp-studio/src/versioning/controller.ts) and [composite merge](../rhwp/rhwp-studio/src/versioning/composite-merge.ts).

Adapt the existing [merge resolver](../rhwp/rhwp-studio/src/merge/merge-resolver-window.ts) into the agreed editor experience. Retire the competing standalone presentation once the replacement covers its capabilities.

### Make pause/edit/resume one recoverable operation

The existing [session pause and resume](../cloud/src/session-store.mjs) does not itself import a locally edited document. Add an explicit human-edit session bound to the task, paused revision, and writer generation. Permit one active writer for the Cloud draft; stale devices and retired workers cannot overwrite it.

Use an idempotent resume command containing the edit-session identity, expected revision, verified edited-document digest, and operation ID. Validate document structure and required resources before committing. Atomically record the new revision and a pending resume event. A worker consumes that event only after the document is durable. Retrying after a lost acknowledgement must neither duplicate work nor import the draft twice.

Resume context must include the original request, current user instructions, completed work, unfinished work, queued messages, and a description of the changes made during the pause. Store the underlying revisions so the agent can inspect exact changes. Treat the newly imported document as authoritative and invalidate stale selections, coordinates, and tool references.

The current [timeline recorder](../cloud/document-runtime/timeline.mjs) reconstructs a bounded text history. That alone cannot guarantee the requested continuity. Preserve provider session state when supported, and maintain a durable task summary plus retrievable conversation and tool history for replacement workers. Reconcile interrupted tools before retrying anything with side effects. The [Studio harness](../cloud/document-runtime/studio-harness.mjs) should resume the existing task against the imported draft.

### Reduce startup and resume waits

Ship a tested runtime build containing the engine, fonts, Chromium, and provider tools. Readiness should exercise document loading and saving, not just an HTTP response. Retain the last working build when a new build fails validation.

Reuse healthy paused workers when economical. On replacement, restore the task independently of machine identity. Prefetch verified checkpoints for viewing and review. Measure submission-to-acceptance, pause-to-editable, continue-to-agent-activity, and result-to-review at median and tail latency before deciding whether a warm pool is justified.

## Delivery sequence

| Stage | Deliverable | Completion evidence |
| --- | --- | --- |
| 1. Reliability foundation | Capacity repair, shutdown checkpointing, revision and command correlation, scoped persistence changes. | Full-storage recovery and worker-loss tests preserve saved work; unrelated tasks do not wait on a slow artifact upload. |
| 2. Chat and inbox | Existing-chat entry, flat actionable inbox, truthful status, persistent drafts, precise notification destinations. | Review production sidebar fixtures together at normal and narrow widths; restart and disconnect scenarios retain task identity. |
| 3. Change review | All-change analysis and decisions, integrated review, safe Apply all, recoverable replacement. | Document fixtures cover concurrent edits, conflicts, formatting, tables, images, rejection, manual edits, and stale review decisions. |
| 4. Pause and edit | Local Cloud-draft editing and atomic context-preserving continuation. | Disconnect, app restart, duplicate resume, worker replacement, and competing-device cases preserve edits and resume once. |
| 5. Performance and rollout | Runtime readiness, measured transfer improvements, incremental enablement. | Hosted measurements establish the actual waits; completed tasks remain readable throughout deployment and recovery. |

The retained preview scenarios cover the inbox, exact notification destination, merge-ready result, paused draft, disconnect, restart, and narrow dark-mode states.
Final visual evidence is stored in [`docs/evidence/cloud-implementation-2026-09-20`](evidence/cloud-implementation-2026-09-20/).

## Verification and rollout

Use existing suites and add focused coverage at the new durability and merge boundaries. For sidebar behavior, run `npm run test:sidebar` and `npm run build:sidebar`; inspect the production component through `npm run dev:sidebar`. Update typed preview mocks when service contracts change.

Pause/edit testing must include Korean IME, offline local saves, a failed upload, a lost acknowledgement after successful import, and context restoration with a conversation longer than the current history window. Verify that the agent sees the human's edits and retains unfinished work after worker replacement.

Merge testing must establish that accepting all preserves unrelated local edits, rejecting all preserves the original, conflicts never resolve destructively without a choice, and replacement can restore the prior document. Test structurally dependent changes rather than only text substitutions.

Version persisted review and resume records. Gate new writes on compatible client and worker capabilities, preserve old checkpoints, and migrate broker storage incrementally. Rollback can disable new entry points while leaving completed results, active paused drafts, and recoverable document versions accessible.

The research established specific source-level defects and preview behavior. Local implementation and recovery verification are complete. Production latency percentiles and hosted rollout recovery remain deployment evidence; the interface avoids promising unmeasured timings.
