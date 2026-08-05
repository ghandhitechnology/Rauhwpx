# rhwp-agent — AI agent bridge

Local bridge that lets a Claude or Codex CLI agent read and edit the HWP/HWPX
document open in rhwp-studio via MCP tools. The Node side is a thin router —
all document logic runs in the browser (studio).

```
claude CLI ──spawn──┐                          ┌── ws://127.0.0.1:5175/studio ── rhwp-studio page
codex CLI ──spawn───┤   rhwp-agent server.mjs  │      src/agent/bridge.ts (WS client)
                    │   (WS hub, 127.0.0.1)    │        ├─ tool-executor.ts (29 MCP tools)
mcp-stdio.mjs ──────┴── ws://127.0.0.1:5175/mcp┘        ├─ pending-edits.ts (approval queue)
 (each CLI spawns it as its MCP server;                 └─ src/ui/agent-sidebar/ (chat UI)
  tool calls are forwarded to the hub)
```

## Requirements

- Node ≥ 20
- `claude` and/or `codex` CLI on `PATH`
- rhwp-studio dev server (step 2 below)

## Run

Paths are relative to the repository root.

1. **Start the hub**

   ```sh
   cd rhwp-agent
   npm install     # first time only
   npm start       # = node server.mjs
   # check: curl http://127.0.0.1:5175/healthz
   ```

   Or from the studio directory: `cd rhwp-studio && npm run agent`.

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
     1s→2s→5s→10s backoff while the hub is down).
   - Collapse/expand the sidebar with the slim tab on the right edge.
   - Pick **Claude** or **Codex**, type an instruction, press Enter
     (Shift+Enter for a newline; "Stop" interrupts a running turn).

4. **Agent activity in the chat log** — document tools, reads, commands, file
   changes, and web operations appear as expandable rows: spinner while
   running, then ✓/✕, with the tool name, arguments, and result preview.

5. **Approve / reject (pending edits)** — agent edits are not committed
   immediately: insertions show tinted, deletions struck through, formatting
   with a dotted outline. When the turn ends, a review card appears at the
   bottom of the sidebar. **Approve** applies everything as a single undo step
   (Ctrl+Z reverts the whole turn); **Reject** rolls it back.

6. **Core tools and permissions** — Claude and Codex can both use project files,
   shell commands, and web search/fetch in addition to the rhwp document tools.
   New chats start in **Safe** mode. The permission button can switch an idle
   chat to **Full access** after a warning; the provider session resumes with
   the new boundary. Full access can reach files anywhere on the laptop.

7. **Product skills** — type `/` to browse enabled rhwp skills, `/skills` to
   open the library, or `/skill-create` for the guided creator. These skills
   are shared by both providers but isolated from their global skill folders.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RHWP_AGENT_PORT` | `5175` | Hub port (binds to 127.0.0.1 only) |
| `RHWP_AGENT_TOKEN` | `dev` | Shared token for WS connections (`?token=`) |
| `RHWP_CLAUDE_MODEL` | `sonnet` | Model for Claude sessions |
| `RHWP_CODEX_MODEL` | `gpt-5.6-sol` | Model for Codex sessions |
| `RHWP_SKILLS_DIR` | OS application-data directory | Product-only user skill directory override |

Studio side (build-time, Vite): `VITE_RHWP_AGENT_URL` (default
`ws://127.0.0.1:5175`), `VITE_RHWP_AGENT_TOKEN` (default `dev`).

Each CLI spawns `mcp-stdio.mjs` as its MCP server; the hub passes
`RHWP_WS_URL`, `RHWP_AGENT_TOKEN`, and `RHWP_AGENT_NAME` via env.

## MCP tools (server name `rhwp`, 30 tools)

Visible to Claude as `mcp__rhwp__<name>`.

- Product skill support: `read_product_skill` (enabled skills and their text
  resources only; no arbitrary local paths)
- Read: `get_structure` (entry point; includes tables), `get_text_range`,
  `get_selection`, `get_fields`, `get_document_info` (includes `fontsUsed`),
  `find_text` (searches cells too), `render_page` (SVG markup or PNG image),
  `list_styles`, `list_numberings` (numbering/bullet definition ids),
  `get_para_format` (sees real lists — HWP list numbers are not text),
  `get_char_format` (char format at a point; documents the inheritance rule),
  `preview_equation` (metrics + warnings), `verify_changes`
- Write (all pending approval): `insert_text`, `delete_range`,
  `replace_range`, `apply_char_format` (incl. `fontFamily`),
  `set_field_value`, `create_table` (bulk cell fill + header row),
  `edit_table` (rows/cols/merge/props), `apply_para_format`, `apply_style`,
  `apply_list` (real auto-renumbered HWP lists — never literal `1.` text),
  `insert_image` (local `imagePath`; this process reads/measures the file),
  `insert_equation` (HWP 수식 스크립트; render-validated before insert),
  `insert_chart` (bar/line/pie/scatter → PNG), `set_page_layout`,
  `edit_header_footer` (page-number fields), `insert_page_break`

Verify workflow: the system brief and tool descriptions instruct the model to
call `verify_changes` after a batch of edits and before ending its turn — it
returns per-op status (applied-now vs awaiting-approval), post-edit text
digests, affected pages and warnings, and with `includeImage:true` a PNG
render of the first affected page showing the post-approval state.
`render_page` can likewise return a PNG (`format:"png"`). Any tool result
carrying an `image` field (`{ data: base64, mimeType }`) is forwarded to the
model as an image content block it can visually inspect.

Write-tool approval model: non-destructive object ops (create table, insert
image/equation/chart, para format, page layout, new header/footer) apply
immediately as tinted pending changes and are reverted by inverse ops on
reject; destructive ops (delete row/col, merge cells, cell/table props,
apply style, editing an existing header/footer) are mark-only and execute
when the user approves. A table with a pending destructive mark rejects
further edits with `PENDING_DESTRUCTIVE_OP` until reviewed.

Revision contract: every read response carries a `revision`; every write
requires `expectedRevision`. A mismatch returns `REVISION_MISMATCH`, telling
the model to re-read. Coordinates are body-text based:
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
- `STUDIO_TIMEOUT` — studio did not answer within 30s (hub) / 60s (mcp-stdio).
- "MCP server connection failed" in the sidebar — the CLI failed to spawn
  `mcp-stdio.mjs`; check the hub's stderr log.
- Only one studio connection is kept: a new tab replaces the previous one
  (close code 4000), which takes the connection back when refocused.
- Safe-mode startup failing with a sandbox error — install or enable the
  provider's local sandbox prerequisites. rhwp fails closed instead of silently
  running shell commands outside the selected boundary.

## Files

- `server.mjs` — WS hub + chat session manager (`/studio`, `/mcp`, `GET /healthz`)
- `agents/claude.mjs` — `claude -p` stream-json persistent-process backend
- `agents/codex.mjs` — `codex exec --json` per-turn spawn backend (`exec resume` continuity)
- `agents/backend.mjs` — shared helpers + `SYSTEM_BRIEF`
- `tools.mjs` — MCP tool definitions (name/description/input schema/validation), single source of truth
- `skills.mjs` / `skill-generator.mjs` — isolated skill storage, validation, prompt context, and AI drafts
- `mcp-stdio.mjs` — MCP stdio server → WS forwarder (stdout reserved for MCP frames)
- `tests/` — tool-definition contract tests (`npm test`)
