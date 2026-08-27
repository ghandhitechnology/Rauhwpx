# rhwp-agent — AI agent bridge

Local bridge that lets a Claude or Codex CLI agent read and edit the HWP/HWPX
document open in rhwp-studio via MCP tools. The hub owns chat workflow state,
local downloads, and a Browserbase sidecar; live-document logic still runs in
the browser (studio).

```
claude CLI ──spawn──┐                          ┌── ws://127.0.0.1:5175/studio ── rhwp-studio page
codex CLI ──spawn───┤   rhwp-agent server.mjs  │      src/agent/bridge.ts (WS client)
                    │   (WS hub, 127.0.0.1)    │        ├─ tool-executor.ts (document tools)
mcp-stdio.mjs ──────┴── ws://127.0.0.1:5175/mcp┘        ├─ pending-edits.ts (verified auto-commit staging)
 (each CLI spawns it as its MCP server;                 └─ src/ui/agent-sidebar/ (chat UI)
  tool calls are forwarded to the hub)
```

## Requirements

- Node ≥ 20
- rhwp-studio dev server (step 2 below)

Codex, Claude, and Pi can be installed from Studio **Settings → Connection**.
Each provider setup opens as a modal and supports browser login or an API key.

## Run

Paths are relative to the repository root.

1. **Start the hub**

   ```sh
   npm start       # from the repository root; returns when healthz is ready
   # check: curl http://127.0.0.1:5175/healthz
   # stop:  npm stop
   ```

   The hub detaches, so the terminal is free. Logs: `.run/rhwp-agent.log`.
   Foreground (old behavior): `npm run start:fg`, or `cd rhwp-agent && npm start`.
   From the studio directory: `cd rhwp-studio && npm run agent` (foreground).

2. **Start the studio dev server**

   ```sh
   cd rhwp-studio
   npm install     # first time only
   npm run dev     # http://127.0.0.1:7700
   ```

3. **Use it in the browser**

   - Open http://127.0.0.1:7700 and load a document.
   - The header of the right-hand "AI agent" sidebar shows the connection state
     (connected once the hub is reachable; the bridge keeps reconnecting with
     250ms→500ms→1s→2s→5s backoff while the hub is down). A brief socket drop no
     longer fails in-flight tool calls: the hub holds them for about 5 seconds
     keyed by the page instance id, and the bridge replays finished results when
     the same page reattaches. A reload or a different tab fails them immediately.
   - Collapse/expand the sidebar with the slim tab on the right edge.
   - Pick **Claude** or **Codex**, type an instruction, press Enter
     (Shift+Enter for a newline; "Stop" interrupts a running turn).

4. **Agent activity in the chat log** — document tools, reads, commands, file
   changes, and web operations appear as expandable rows: spinner while
   running, then ✓/✕, with the tool name, arguments, and result preview.

5. **Autonomous document edits** — semantic edits remain visible as tinted live
   changes while the agent verifies its work, then commit only after an explicitly
   successful turn as one undo step. Failed, interrupted, and unknown outcomes roll
   staged edits back. Raw engine batches commit atomically as one undo step and restore
   the exact snapshot on failure.

6. **Core tools and permissions** — Claude and Codex can both use project files,
   shell commands, and web search/fetch in addition to the rhwp document tools.
   New chats start in **Safe** mode. Live-document MCP writes still work
   autonomously with editor undo history; file and shell tools stay inside the project.
   The permission button can switch an idle chat to **Full access** after a
   warning; the provider session resumes with the new boundary. Full access
   can reach files anywhere on the laptop.

7. **Product skills** — type `/` to browse enabled rhwp skills, `/skills` to
   open the library, or `/skill-create` for the guided creator. These skills
   are shared by both providers but isolated from their global skill folders.

8. **Workflow is separate from permission** — `direct` preserves the existing
   behavior. `plan` progresses through `planning` → `awaiting-approval` →
   `switching` → `implementing`. While planning, provider file tools are
   read-only but live web research, provider subagents, Browserbase, and the
   chat-scoped downloader are enabled. Safe/Full access remains an independent
   filesystem permission choice. The hub blocks document writes before an
   approved plan regardless of that permission choice.

9. **Subagents and Claude workflows** — Claude sessions expose the native
   `Agent` and `Workflow` tools in every mode (tool restrictions inherit into
   subagents, so planning stays read-only), plus two rhwp agent types:
   `doc-editor` (owns one paragraph range) and `doc-researcher` (read-only).
   The harness normalizes the CLI's `task_*` lifecycle into `task-start` /
   `task-progress` / `task-end` events with `parentTaskId` attribution on
   child tool calls, holds the turn open while background tasks run (multiple
   `result` lines per logical turn), and reports cumulative `modelUsage` as
   per-result deltas. Codex `collab_tool_call` items map onto the same task
   events. Studio renders these as fleet cards and auto-rebases disjoint
   parallel document writes (`rebasedParaShift`).

10. **Per-provider capability tuning** — each backend carries briefs and
   permissions shaped to its own CLI traits. Grok runs subagent fleets only in
   Full access (its `dontAsk` mode auto-cancels headless spawns), so Safe-mode
   grok works sequentially with a blanket shell deny; autonomous background
   workers (copy-layout) get a scoped exception pinned to that job's
   `copy_layout.py` path (`python3`/`python` plus the absolute helper, not a
   blanket `python3*` allow). Cursor subagents replay their transcripts when each finishes,
   so its brief asks for tightly bounded child objectives. Pi has no delegation
   tools at all: its brief mandates sequential solo work with batched
   `apply_edits` calls instead of fleets. Activated product skills are appended
   with a one-line `<provider_tool_notes>` correction describing that provider's
   real collaboration/polling surface, so skill text stays provider-neutral.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RHWP_AGENT_PORT` | `5175` | Hub port (binds to 127.0.0.1 only) |
| `RHWP_STUDIO_ORIGINS` | empty | Comma-separated exact HTTPS Studio origins allowed for operator-run remote previews |
| `RHWP_AGENT_TOKEN` | `dev` | Shared token for WS connections (`?token=`) |
| `RHWP_CLAUDE_MODEL` | `sonnet` | Model for Claude sessions |
| `RHWP_CODEX_MODEL` | `gpt-5.6-sol` | Model for Codex sessions |
| `RHWP_SKILLS_DIR` | OS application-data directory | Product-only user skill directory override |
| `RHWP_USAGE_DIR` | OS application-data directory | Token-usage log and plan directory override |
| `RHWP_CLIPROXY_URL` | `http://127.0.0.1:8317` | CLIProxyAPI base URL for official plan usage |
| `RHWP_CLIPROXY_KEY` | — | CLIProxyAPI management key (`remote-management.secret-key`) |
| `RHWP_REFERENCES_DIR` | OS application-data directory | Persistent reference metadata, deduplicated blobs, and search index override |
| `BROWSERBASE_API_KEY` | — | Browserbase API key (required for Browserbase tools) |
| `BROWSERBASE_PROJECT_ID` | — | Browserbase project id (required for Browserbase tools) |
| `GEMINI_API_KEY` | — | Gemini key used by the pinned Browserbase MCP sidecar |

Studio side (build-time, Vite): `VITE_RHWP_AGENT_URL` (default
`ws://127.0.0.1:5175`), `VITE_RHWP_AGENT_TOKEN` (default `dev`).

Each CLI spawns `mcp-stdio.mjs` as its MCP server. In addition to
`RHWP_WS_URL`, `RHWP_AGENT_TOKEN`, and `RHWP_AGENT_NAME`, provider backends pass
`RHWP_AGENT_WORKFLOW`, `RHWP_AGENT_PHASE`, and `RHWP_CAPABILITY_EPOCH`.
`RHWP_TOOL_PROFILE` may explicitly filter visible tools using a named profile
(`direct`, `planning`, `awaiting-approval`, `implementing`, `all`) or a
comma-separated allowlist of tool names/categories. If omitted, the MCP server
derives the profile from workflow and phase. Visibility is advisory; the hub
always rechecks the authoritative state and epoch.

## Provider health and usage (v2)

`agent-setup-status-request`, `agent-setup-install`, and `agent-setup-auth`
drive the Settings modal. Codex and Claude are installed under
`<app data>/rhwp/cli/`; Pi keeps its provider-specific runtime under
`<app data>/rhwp/pi/`. OpenRouter browser login uses a localhost PKCE callback,
while entered keys are stored only in the provider's mode-0600 configuration.

Studio can send `provider-status-request` (`{ requestId, refresh? }`) and the hub
answers `provider-status` with `{ claude, codex }` entries of
`{ available, version, error, checkedAt }`, probed from `claude --version` /
`codex --version` and cached for 60s. `GET /healthz` carries the same cached
object under `providers` (`null` until the first probe).

Token usage rides the same socket: `usage-request` (`{ requestId }`) and
`usage-plan-set` (`{ requestId, agent, plan }`) both answer `usage-report`
(`{ usage }`); an unknown agent/plan answers `usage-error` with code
`INVALID_PLAN`. Claude plans are `pro | max5x | max20x | api`, Codex plans are
`plus | pro | api`. The hub also pushes `provider-status` and `usage-report`
right after a studio connects, and a fresh `usage-report` whenever a provider
turn reports token usage.

Usage totals come from rolling windows (session 5h, day 24h, week 7d) over
weighted tokens (`input + output + cacheCreation + cacheRead/10`); plan budgets
are estimates, so `percent` is a guide, not billing. Connect CLIProxyAPI in
Settings → 사용량 (URL + management key) to replace the 5-hour and weekly
percents with the official plan meters. `cliproxy-connect` / `cliproxy-disconnect`
answer the same `usage-report`; the key is stored next to the usage log as
`cliproxy.json` (mode 0600) and is never sent back to the studio. Records live in
`<app data>/rhwp/usage/` as append-only `events.jsonl` (pruned to 8 days) plus
`plans.json`, overridable with `RHWP_USAGE_DIR`.

## Writing-style calibration (v3)

The calibrated profile is a person to inhabit, not a sentence-recipe.
`style.md` leads with a voice portrait; measured numbers are a fingerprint
checked after drafting, never a target to write toward.

`writing-style-catalog-request` returns `writing-style-catalog` with the
available Codex and Claude models plus only the OpenRouter models configured
for Pi. Start a run with
`writing-style-calibrate { requestId, language, files, agent, model, append }`.
When `append` is true, the hub layers new uploads over the private source
documents saved by the last successful calibration and de-duplicates identical
files.

Long runs emit resumable `writing-style-progress` snapshots with `jobId`,
`state`, `phase`, safe `activity`/`detail`, `completed`/`total`, and the selected
`agent`/`model`. These are high-level activity labels, not model reasoning.
`writing-style-status` includes source descriptors under `sources`; original
contents remain local in the writing-style app-data directory.

## Planning protocol (v2)

Studio starts a chat with `workflow: "direct" | "plan"`. It can send
`chat-workflow-set`, `chat-plan-approve`, and `chat-plan-request-changes` while
the chat is idle. The hub emits `workflow-changed`, `plan-ready`,
`plan-approved`, `plan-invalidated`, and `implementation-started`.

`present_implementation_plan` accepts `goal`, `title`, `summary`,
`assumptions`, `decisions`, `steps`, `files`, `validation`, `risks`, and
`exclusions`. The model does not choose authority fields: the hub adds the
`planId`, `createdAt`, and plan `epoch`, stores the canonical plan, and only
accepts approval for the latest id while the provider is idle. Approval bumps
the capability epoch, awaits the backend mode switch, and automatically sends
the stored plan—not Studio or model-provided replacement text—for execution.

Provider backend contract:

- Initial constructor options include `workflow`, `phase`, and
  `capabilityEpoch`.
- A session exposes
  `setExecutionMode({ workflow, phase, capabilityEpoch }): Promise<void>`.
  It must resolve only when the old provider process is idle/stopped and the
  next turn will spawn/resume with the supplied MCP environment and phase
  prompt.
- `sendUserMessage(text)` remains the execution entry point. After
  `setExecutionMode(...implementing)` resolves, the hub calls it with the
  canonical approved plan.

Every MCP call carries its capability epoch. Plan-workflow calls without an
epoch fail closed; calls with an old epoch are rejected. Direct workflow keeps
legacy compatibility when an older MCP client omits the epoch.

## Reference files

The hub keeps reference files in three isolated scopes: one chat (`threadId`),
one open document (`documentId`), or global. Global files are available to every
chat. The Studio uploads raw bytes to the loopback-only HTTP API with the same
bearer token as the WebSocket connection:

- `POST /reference-files?scope=chat|document|global&scopeId=...` with
  `Authorization: Bearer …`, `X-File-Name`, and `Content-Type`
- `POST /reference-staging?scopeId=...` stages a chat attachment without adding
  it to reference counts; `DELETE /reference-staging/:id?scopeId=...` discards it
- `GET /reference-files?scope=...&scopeId=...`
- `GET /reference-search?scope=...&scopeId=...&q=...&limit=...`
- `DELETE /reference-files/:id?scope=...&scopeId=...`

Uploads are streamed through bounded staging files, SHA-256 deduplicated, and
persisted with atomic metadata updates. Supported formats are plain text,
Markdown, CSV/TSV, JSON, HTML/XML, PDF, DOCX, HWP, HWPX, HML, PNG, JPEG, WebP,
and GIF. Images are available as native vision references without OCR or text
indexing. HWP-family
extraction uses this project's `rhwp export-text` binary when available and
fails explicitly when it is not. Search uses a Korean-aware lexical/BM25 index.
The hub adds a bounded set of relevant global, document, and chat excerpts to
each user turn as untrusted reference data.

Message attachments use a two-phase path. Studio uploads bytes to
`/reference-staging` as soon as they are selected, then sends the returned IDs
on `chat-user-message`. The hub promotes and indexes those files before agent
dispatch and reports `chat-reference-status` updates. Unsent staged files never
enter scope counts and expire after 12 hours.

`chat-start` accepts stable `threadId`, `documentId`, and `documentName` fields.
Studio should repeat the IDs on `chat-user-message`; the hub rejects stale IDs
before retrieval while continuing to accept legacy messages that omit them.

## MCP tools (server name `rhwp`)

Visible to Claude as `mcp__rhwp__<name>`. `tools.mjs` is the authoritative
list — `tests/tools.test.mjs` pins the tool count and classifications, so
check that file rather than this summary when the exact surface matters.

- Product skill support: `read_product_skill` (enabled skills and their text
  resources only; no arbitrary local paths)
- Instruction read/write: `read_agent_instructions`, `update_agent_instructions`
  (app-scoped AGENTS.md; writes are proposals until confirmed in Settings > 지시)
- Reference read: `list_reference_files`, `search_reference_files`,
  `read_reference_chunk`, `read_reference_image` (restricted to global + active
  document + active chat)
- Read: `get_structure` (entry point; includes tables), `get_text_range`,
  `get_selection`, `get_fields`, `get_document_info` (includes `fontsUsed`),
  `materialize_document_snapshot` (writes the exact live HWP/HWPX into the
  isolated chat workspace when no native source path exists or the document is dirty),
  `find_text` (searches cells too), `render_page` (SVG markup or PNG image),
  `get_outline` (heading tree), `list_styles`,
  `list_numberings` (numbering/bullet definition ids),
  `get_para_format` (sees real lists — HWP list numbers are not text),
  `get_char_format` (char format at a point; documents the inheritance rule),
  `get_table_properties` (table/object placement plus optional cell state),
  `get_table_layout` (measured table geometry and page overflow),
  `list_footnotes`, `list_bookmarks`,
  `get_engine_edit_capabilities` (all classified engine edits, structured-copy prerequisites, and signatures),
  `preview_equation` (metrics + warnings), `verify_changes`
- Template read (the reference document, never mutated): `get_active_template`,
  `template_get_structure`, `template_get_text_range`, `template_get_para_format`,
  `template_get_char_format`, `template_list_styles`, `template_get_page_layout`,
  `template_render_page`
- Write (autonomous and undoable): `apply_edits` (1–32 staged semantic writes in
  one call under a single `expectedRevision`; items apply sequentially and the
  whole batch rolls back if any item fails — prefer it whenever two or more edits
  are already known), `apply_engine_edits` (atomic access to every
  classified document mutation), `prepare_engine_edit_session` (structured-copy
  and non-document setup), `insert_text`, `delete_range`,
  `replace_range`, `replace_all` (document-wide find and replace),
  `apply_char_format` (incl. `fontFamily`),
  `set_field_value`, `create_table` (bulk cell fill + header row),
  `edit_table` (rows/cols/merge/split plus table placement, wrapping, pagination,
  captions, margins, and rich cell props), `delete_table` (mark-only whole-table delete),
  `apply_para_format`, `apply_style`,
  `apply_list` (real auto-renumbered HWP lists — never literal `1.` text),
  `insert_image` (local `imagePath`; this process reads/measures the file),
  `insert_equation` (HWP 수식 스크립트; render-validated before insert),
  `insert_chart` (bar/line/pie/scatter → PNG), `set_page_layout`,
  `edit_header_footer` (page-number fields), `insert_page_break`,
  `insert_footnote`, `edit_footnote`, `set_bookmark`,
  `template_apply_section_layout`, `template_apply_paragraph_format`,
  `template_insert_block` (copy layout, formatting, and blocks out of the
  template into the live document)
- Planning control: `present_implementation_plan`
- Hub download: `download_file`
- Generated-file delivery: `publish_artifact` (workspace-confined HWP/HWPX →
  authenticated local download URL)
- Hub Browserbase proxy: `browserbase_start`, `browserbase_end`,
  `browserbase_navigate`, `browserbase_act`, `browserbase_observe`,
  `browserbase_extract`
- Background copy-layout: `delegate_copy_layout`, `update_copy_layout_job`,
  `complete_copy_layout_job`, `register_copy_layout_template`

Every definition has one explicit category: `instruction-read`, `instruction-write`,
`document-read`, `document-write`, `reference-read`, `template-read`, `download-write`,
`artifact-write`, `planning-control`, `background-control`, `background-worker`, or
`browser`. Browser, download, and
planning-control calls are accepted only for plan-origin chats (including the
implementing phase). Document writes are rejected by the hub during planning
and awaiting approval.

`download_file` accepts a URL and an optional filename hint. Files are stored
under `.rhwp-agent/downloads/<chat-id>/`; the hub sanitizes the leaf name,
allocates it without overwriting an existing file, and never accepts a target
directory from the model. Responses include absolute path, MIME type, size,
source/final URL, and SHA-256 checksum. Downloads use a total timeout, bounded
redirects, byte and free-space safety checks, and DNS-pinned public-address
requests that reject local/private/reserved targets on every hop, with no
product-level file-count cap.

`publish_artifact` accepts only regular HWP/HWPX files whose canonical path is
inside the current chat workspace. It rejects links, format mismatches,
malformed/non-conforming HWPX packages, and files over 64 MiB. Publication
captures immutable bytes so later workspace edits cannot corrupt a download,
then returns a session-authenticated localhost URL. Studio renders that URL as
separate Open-in-new-window and Download actions.
The copy-layout skill uses this with `materialize_document_snapshot`, so browser
documents no longer need an OS path and snapshot-backed results remain directly
downloadable from chat.

Browserbase tools proxy the official pinned `@browserbasehq/mcp` stdio
sidecar. It starts lazily, verifies that all six upstream tools are ready,
serializes actions against the shared session, keeps that session across
provider process restarts, and closes it on chat stop or hub shutdown. Text
results are truncated at 50KB to protect the model context. A timed-out action poisons
and closes the sidecar because the remote effect may already have happened; the model
must start fresh and observe before retrying. Missing credentials return
`BROWSERBASE_NOT_CONFIGURED` with the exact variables to set. Browser actions
do not require per-action confirmation.

Verify workflow: the system brief and tool descriptions instruct the model to
call `verify_changes` after a batch of edits and before ending its turn — it
returns per-op status (applied-now vs staged-for-turn-commit), post-edit text
digests, affected pages and warnings, and with `includeImage:true` a PNG
render of the first affected page.
`render_page` can likewise return a PNG (`format:"png"`). Any tool result
carrying an `image` field (`{ data: base64, mimeType }`) is forwarded to the
model as an image content block it can visually inspect.

Write-tool commit model: semantic object ops use the live staged preview and
commit only after an explicitly successful turn; failed, interrupted, and unknown
outcomes roll them back. Destructive table operations remain mark-only during verification and
execute at commit. `apply_engine_edits` runs 1–32 registry-backed document mutations
as one immediate atomic snapshot transaction and one editor undo entry. Clipboard
and view-session setup is explicit through `prepare_engine_edit_session`.

Revision contract: every read response carries a `revision`; every write
requires `expectedRevision`. A mismatch returns `REVISION_MISMATCH` carrying the
current revision, and tells the model it may retry directly with that revision
only when it knows what changed the document and the change cannot have shifted
this call's coordinates — otherwise re-read the affected range first. Saving
does not bump the revision (serialization leaves the content identical), and
`verify_changes` previews do not bump it either because that window ends in a
snapshot restore. Coordinates are body-text based:
`sectionIdx` / `paraIdx` / `charOffset` (0-based).

Table cells: `get_structure` lists every top-level table per section
(`tables[]` with `paraIdx`/`controlIdx`, dimensions, and per-cell text), and
`find_text` also matches text inside cells (such matches carry a `cell`
object). `get_text_range`, `insert_text`, `delete_range`, `replace_range`
and `apply_char_format` accept an optional
`cell: { paraIdx, controlIdx, cellIdx }` — when present, paragraph indexes
and offsets are relative to the inside of that cell. Nested tables are not
addressable yet (Phase-1 limit).

## Product skill format

Each skill is a folder containing `SKILL.md` with `name` and `description`
frontmatter plus concise instructions. Optional `references/`, `scripts/`, and
`assets/` folders are supported. Bundled skills under `rhwp-agent/skills/` are
read-only. User skills live in rhwp's application-data directory and are never
installed into `~/.claude`, `~/.agents`, or `~/.codex`.

- `/skills` — open the library
- `/skill-create` — create an AI-assisted draft
- `/skill-edit <name>` / `/skill-delete <name>` — manage a user skill
- `/<skill-name> [request]` — explicitly activate an enabled skill
- `/fast [on|off|status]` — Codex Fast service tier (Codex only; next turn uses `service_tier="fast"`)

Skills containing scripts are marked in the UI. Review scripts before saving
or invoking them; in Full access mode they inherit the agent's broad access.
The library groups bundled and user skills and supports search, enable/disable,
inspection, bundled-skill duplication, user-skill editing, and recoverable
deletion. Disabled skills are omitted from invocation autocomplete. Unknown
slash text is sent normally, while `//` sends a message beginning with a
literal `/`.

## Troubleshooting

- `HUB_UNAVAILABLE` — the hub (`node server.mjs`) is not running.
- `NO_STUDIO` — no studio page is connected to the hub.
- `STUDIO_TIMEOUT` — Studio did not answer a relayed document call within 30s.
- `TOOL_TIMEOUT` — the MCP-to-hub call did not complete within 180s.
- `CAPABILITY_EPOCH_REQUIRED` / `STALE_CAPABILITY_EPOCH` — restart the provider
  in the hub's current workflow phase.
- `PLAN_WRITE_BLOCKED` — an MCP document write was attempted before the plan
  reached `implementing`.
- `BROWSERBASE_NOT_CONFIGURED` — set all three Browserbase environment
  variables listed above and restart the hub.
- "MCP server connection failed" in the sidebar — the CLI failed to spawn
  `mcp-stdio.mjs`; check the hub's stderr log.
- Only one studio connection is kept: a new tab replaces the previous one
  (close code 4000), which takes the connection back when refocused.
- Safe-mode startup failing with a sandbox error — install or enable the
  provider's local sandbox prerequisites. rhwp fails closed instead of silently
  running shell commands outside the selected boundary.

## Files

- `server.mjs` — WS hub + authoritative chat/workflow manager (`/studio`, `/mcp`, `GET /healthz`)
- `ctl.mjs` — background start/stop/status (`npm start` at the repo root)
- `planning-state.mjs` — plan transitions, canonical plan ids, epochs, and hub gates
- `download-manager.mjs` — confined per-chat downloader
- `provider-health.mjs` — cached CLI version probes for configured backends (single-flight)
- `usage-store.mjs` — token-usage JSONL log, plan budgets, rolling-window summary
- `cliproxy.mjs` — CLIProxyAPI management client for official 5h/weekly plan usage
- `browserbase-session.mjs` — lazy official Browserbase MCP sidecar proxy
- `agents/claude.mjs` — `claude -p` stream-json persistent-process backend
- `agents/codex.mjs` — `codex exec --json` per-turn spawn backend (`exec resume` continuity)
- `agents/grok.mjs` — `grok -p` stream-json backend
- `agents/pi.mjs` — `pi` CLI backend
- `agents/cursor.mjs` — `cursor-agent` backend
- `agents/backend.mjs` — shared helpers + system brief composition
- `tools.mjs` — MCP tool definitions (name/description/input schema/validation), single source of truth
- `skills.mjs` / `skill-generator.mjs` — isolated skill storage, validation, prompt context, and AI drafts
- `mcp-stdio.mjs` — MCP stdio server → WS forwarder (stdout reserved for MCP frames)
- `tests/` — tool-definition contract tests (`npm test`)
