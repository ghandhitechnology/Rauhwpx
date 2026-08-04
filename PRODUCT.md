# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are Korean office workers who already work in HWP/HWPX and are tired of AI tools that cannot operate inside Hancom Hangul. Their job is to produce and revise full documents with AI help without leaving the document editor.

## Product Purpose

rhwp is an independent open-source HWP/HWPX viewer/editor with agentic features built into the editing experience. Success means users can create full documents with AI and collaborate smoothly—both in the system (local agent ↔ open document) and in the UI (the AI feels like part of the program, not a bolted-on chat pane).

## Positioning

An HWP editor with agentic features as a first-class part of the product—not an external AI tool that cannot touch Hangul documents, and not a generic chat overlay on a viewer. Documents are edited through a real HWP engine (Rust → WASM); the AI proposes changes against the live open document and the user stays in control.

## Operating Context

- Users open HWP/HWPX (and related formats) in `rhwp-studio` in the browser (PWA).
- A local Node hub (`rhwp-agent`) bridges Claude or Codex CLI to the studio tab via MCP tools.
- AI writes appear as pending, reviewable edits (tint / strikethrough) until the user Approves or Rejects; Approve commits as one undo step.
- Everything document-related runs locally in the browser WASM engine; the agent hub is a thin localhost router with no document logic.
- Adjacent surfaces exist (browser extensions, VS Code viewer, embeddable npm editor, CLI) but the primary product experience for this record is the studio editor + AI sidebar.

## Capabilities and Constraints

- Parse/edit/render Korean HWP ecosystem formats (HWP 5.0, HWPX, HML; HWP3 read); serialize with roundtrip fidelity as a core concern.
- MCP tools use body-text addresses (`sectionIdx` / `paraIdx` / `charOffset`, 0-based) and a revision contract (`expectedRevision` / `REVISION_MISMATCH`).
- AI must not apply document mutations silently; human approval is part of the product.
- Independent of Hancom; “한글,” “한컴,” “HWP,” and “HWPX” are Hancom trademarks—do not imply affiliation, sponsorship, or approval.
- UI and product language are Korean-first where the studio already is (`lang="ko"`).
- Open: exact collaboration model beyond single-user AI review (multi-user co-editing, sharing) is desired as success direction but not fully specified yet.

## Brand Commitments

- Product name: **rhwp**; studio: **rhwp-studio**; agent hub: **rhwp-agent**.
- Korean product framing in public materials includes “알(R), 모두의 한글” for the editor/PWA.
- Voice: practical document-work tool; AI should feel native to the editor, not like a separate SaaS chat product.

## Evidence on Hand

- Engine, studio, and agent implementations under `rhwp/`.
- Large real-document fixture set under `rhwp/samples/` (~430 HWP/HWPX files for fidelity/regression).
- Public demo referenced at https://edwardkim.github.io/rhwp/.
- Logo assets under `rhwp/assets/logo/`.
- Do not fabricate testimonials, customer logos, Hancom endorsement, or fidelity benchmarks not in the repo.

## Product Principles

1. **Editor-native AI** — Agentic features must feel like part of the program, not a sidecar chat product.
2. **User remains the author** — AI proposes; the user approves. Trust and undoability beat silent automation.
3. **Real HWP work** — Success is finishing full documents in the formats Korean office work actually uses.
4. **Local by default** — Document processing stays with the user (browser WASM + localhost agent); do not invent cloud document pipelines.
5. **Smooth collaboration** — System handoffs (agent ↔ document ↔ approval) and UI continuity are both first-class; friction in either breaks the product.

## Accessibility & Inclusion

Korean is the primary UI and document language. Preserve existing studio a11y patterns (labeled controls, live regions, reduced-motion support in the agent sidebar). No separate WCAG target was committed beyond keeping those behaviors intact.
