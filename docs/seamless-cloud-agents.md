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

Implementation and validation are in progress. This document is an acceptance plan, not completion evidence.
