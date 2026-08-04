# rhwp-agent — AI agent bridge

Local bridge that lets a Claude or Codex CLI agent read and edit the HWP/HWPX
document open in rhwp-studio via MCP tools. The Node side is a thin router —
all document logic runs in the browser (studio).

```
claude CLI ──spawn──┐                          ┌── ws://127.0.0.1:5175/studio ── rhwp-studio page
codex CLI ──spawn───┤   rhwp-agent server.mjs  │      src/agent/bridge.ts (WS client)
                    │   (WS hub, 127.0.0.1)    │        ├─ tool-executor.ts (12 MCP tools)
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

4. **Tool calls in the chat log** — each MCP tool call appears as a row:
   spinner while running, then ✓/✕, with the tool name and an argument summary.
   Click a row to expand the full arguments and a result preview.

5. **Approve / reject (pending edits)** — agent edits are not committed
   immediately: insertions show tinted, deletions struck through, formatting
   with a dotted outline. When the turn ends, a review card appears at the
   bottom of the sidebar. **Approve** applies everything as a single undo step
   (Ctrl+Z reverts the whole turn); **Reject** rolls it back.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RHWP_AGENT_PORT` | `5175` | Hub port (binds to 127.0.0.1 only) |
| `RHWP_AGENT_TOKEN` | `dev` | Shared token for WS connections (`?token=`) |
| `RHWP_CLAUDE_MODEL` | (CLI default) | Model for Claude sessions |
| `RHWP_CODEX_MODEL` | `gpt-5.6-sol` | Model for Codex sessions |

Studio side (build-time, Vite): `VITE_RHWP_AGENT_URL` (default
`ws://127.0.0.1:5175`), `VITE_RHWP_AGENT_TOKEN` (default `dev`).

Each CLI spawns `mcp-stdio.mjs` as its MCP server; the hub passes
`RHWP_WS_URL`, `RHWP_AGENT_TOKEN`, and `RHWP_AGENT_NAME` via env.

## MCP tools (server name `rhwp`, 12 tools)

Visible to Claude as `mcp__rhwp__<name>`.

- Read: `get_structure` (entry point), `get_text_range`, `get_selection`,
  `get_fields`, `get_document_info`, `find_text`, `render_page`
- Write (all pending approval): `insert_text`, `delete_range`,
  `replace_range`, `apply_char_format`, `set_field_value`

Revision contract: every read response carries a `revision`; every write
requires `expectedRevision`. A mismatch returns `REVISION_MISMATCH`, telling
the model to re-read. Coordinates are body-text based:
`sectionIdx` / `paraIdx` / `charOffset` (0-based).

## Troubleshooting

- `HUB_UNAVAILABLE` — the hub (`node server.mjs`) is not running.
- `NO_STUDIO` — no studio page is connected to the hub.
- `STUDIO_TIMEOUT` — studio did not answer within 30s (hub) / 60s (mcp-stdio).
- "MCP server connection failed" in the sidebar — the CLI failed to spawn
  `mcp-stdio.mjs`; check the hub's stderr log.
- Only one studio connection is kept: a new tab replaces the previous one
  (close code 4000), which takes the connection back when refocused.
- Codex tool calls failing with "user cancelled MCP tool call" — as of codex
  0.146, headless (`exec`) runs MCP tools only with `approval_policy=never` +
  `--sandbox danger-full-access` (applied by default in the backend). In this
  mode codex shell commands also run unsandboxed — use only for trusted local
  work.

## Files

- `server.mjs` — WS hub + chat session manager (`/studio`, `/mcp`, `GET /healthz`)
- `agents/claude.mjs` — `claude -p` stream-json persistent-process backend
- `agents/codex.mjs` — `codex exec --json` per-turn spawn backend (`exec resume` continuity)
- `agents/backend.mjs` — shared helpers + `SYSTEM_BRIEF`
- `mcp-stdio.mjs` — MCP stdio server → WS forwarder (stdout reserved for MCP frames)
