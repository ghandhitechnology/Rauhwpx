# Seamless cloud agents

## Delivery target

Send a document task to Cloud, close the laptop after Cloud accepts it, and return to locally available results. Setup, connection recovery, and continued conversations should require as little intervention as possible.

The integration branch starts at current `origin/main` plus PR #253. Component PRs target `feat/seamless-cloud-agents`. The orchestrator reviews and merges component PRs; the completed feature PR remains ready to merge into main.

## Architecture

- `rhwp/rhwp-studio/src/ui/agent-sidebar/` owns Cloud setup, the composer, connection status, and result review. Its independent sidebar preview mounts production UI.
- `rhwp/rhwp-studio/src/cloud/` adapts desktop and browser transports and mirrors verified checkpoints into local version history.
- `desktop/cloud-coordinator.mjs` owns desktop provisioning, pairing, durable handoff, reconnect, and session reconciliation. `cloud-merge-recovery.mjs` discovers and caches broker artifacts.
- `cloud/src/` owns the worker control plane, SQLite session state, ordered events, safe document boundaries, and broker leases. `cloud/document-runtime/` drives the document editor and provider runtime.
- `rhwp/rau-credits/` owns account authentication, quotas, worker allocation, and encrypted durable artifacts in PostgreSQL. PR #253 retains completed documents independently of worker lifetime.

## Required behavior and evidence

| Area | Required behavior | Verification |
| --- | --- | --- |
| Onboarding | A user with a supported configured provider can prepare Cloud and send the existing draft through one guided flow. Retry preserves the draft and reconciles an uncertain allocation. | Production sidebar checks plus desktop provisioning and handoff tests. |
| Persistence | Laptop absence does not cancel accepted work. Temporary broker outages recover. Idle cleanup preserves a resumable conversation, and resource limits end work at a recoverable boundary. | Fake-clock lease and quota tests, worker restart tests, and an integrated disconnect/recovery scenario. |
| Stability | Lost responses, expired tokens, stream gaps, and reconnect races cannot duplicate accepted work or lose its state. | Transport, queue, account-fencing, and restart regressions against production modules. |
| Local results | Reopening automatically discovers and downloads completed results. Results remain usable offline after verified download; review integrates them while preserving concurrent local edits. | Broker-to-desktop recovery test, local cache/offline test, and version-merge browser coverage. |
| Configuration | Cloud setup and settings expose useful readiness and clear next actions with polished narrow/wide layouts. | Production preview screenshots, sidebar interaction checks, and standalone build. |
| Delivery | All component PRs are reviewed, have passing relevant CI, and are merged into the integration branch. The final feature PR is current with main, mergeable, and includes complete runtime and rollout changes. | GitHub PR/check state, integration tests, and reviewed deployment configuration. |

## Work tracks

1. Broker and worker continuity, including graceful resource policy and durable conversation recovery.
2. Desktop handoff, automatic reconnect, and automatic local result retrieval.
3. Studio onboarding, configuration, and result presentation.
4. Integration verification, review feedback, CI, and deployment readiness.

Each track must document the behavior actually implemented and the checks actually run. Cross-layer contracts must be agreed before changing shared interfaces. Accepted tasks must never be silently replayed after an ambiguous result, and automatic retrieval must preserve local document edits.

## Integration record

The component work is split across [runtime continuity, #256](https://github.com/ghandhitechnology/Rauhwpx/pull/256), [desktop delivery, #257](https://github.com/ghandhitechnology/Rauhwpx/pull/257), and [Studio setup and review, #258](https://github.com/ghandhitechnology/Rauhwpx/pull/258). Their reviewed changes land in [the feature PR, #255](https://github.com/ghandhitechnology/Rauhwpx/pull/255).

The combined checkout passes 326 desktop tests, 246 worker tests, five HTTP experience scenarios, and 110 broker tests with PostgreSQL. Studio passes 2,183 unit tests with one environment skip, all 46 browser tests, production-sidebar checks, the full build and the standalone sidebar build. The browser suite includes nine Cloud version-merge cases using real HWP/HWPX documents and the built WASM engine. Cloud onboarding, workspace and display smoke checks pass, including concurrent local typing, merged edits, Korean input and reconnect without duplicate chat or setup.

Four worker checks require Linux filesystem or display support; the image workflow runs the document-shell and headed display/input proofs in the built container. Final component CI and image publication remain part of the feature PR's readiness gate. The HTTP experience scenarios run in the regular `npm run test:cloud` command.

The HTTP experience tests use the production signed worker routes, encrypted broker artifact storage, desktop coordinator and local recovery files. They exercise:

- Losing activation and attached-message responses, replacing the worker, restoring the original queue and retrying without duplicate messages or another attachment upload.
- Failing broker persistence before activation acknowledgment, then recovering the same transfer and command identity.
- Rejecting a managed runtime that lacks durable conversation restoration before it can receive a handoff.
- Receiving a queued progress event before broker persistence fails, then restoring and delivering that still-pending message exactly once.
- Completing a worker turn while the desktop is closed, downloading its verified result on return without allocating another worker, and reopening the local result offline.

Provider output in these protocol tests is deterministic. Actual HWP/HWPX parsing, merge behavior, layout and keyboard input have separate browser and container checks.

## Candidate rollout

The feature uses `2.0.3-cloud.1` for desktop metadata, worker metadata and default image selection. A branch-dispatched image build publishes a separate candidate after runtime, broker and container checks. Its artifact records the registry digest and source commit and contains matching tested broker source. The shared stable and edge channels remain unchanged.

Deploy the compatible broker before selecting the new worker image and distributing the desktop. Keep `SESSION_SECRET` and `DATABASE_URL` unchanged, and preserve unrelated staged Railway settings. Once conversation artifacts exist, a broker rollback must retain artifact-kind filtering; rolling back only the worker image keeps the completed-document inbox compatible. The [release guide](releasing.md#cloud-feature-candidates) contains the candidate command, and the feature PR records the final verification run, digest and rollout status.
