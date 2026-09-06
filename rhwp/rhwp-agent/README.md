# rhwp-agent

Local WebSocket hub. A Claude, Codex, Pi, Grok, Cursor, or OpenCode CLI reads and edits the document open in rhwp-studio through MCP. The hub owns chat workflow, downloads, and the Browserbase sidecar. Document logic stays in the browser.

```text
agent CLI ──spawn──► mcp-stdio.mjs ──ws──► server.mjs ◄──ws── rhwp-studio
                     (MCP server)         (127.0.0.1)
```

## Requirements

- Node 22.18 or newer
- The dependency setup and WASM build in [CONTRIBUTING.md](../../CONTRIBUTING.md)

Install a provider from Studio **Settings → Connection**. OpenCode accepts an API key in Studio and can reuse credentials created by `opencode auth login`.

## Run

Run these commands from the repository root after setup.

1. Start Studio. It starts its own authenticated hub on an ephemeral port.

   ```sh
   npm run setup
   npm run build:wasm
   npm run dev:studio
   ```

2. Open http://127.0.0.1:7700, load a document, pick a provider, and type an instruction. Enter sends. Shift+Enter adds a line.

For a standalone hub on port 5175, run `npm start` from the repository root. The process returns when `/healthz` is ready. Logs go to `.run/rhwp-agent.log`. Stop with `npm stop`. Foreground: `npm run start:fg`, or `cd rhwp/rhwp-agent && npm start`.

New chats start in **Safe** mode. Staged document edits wait for review. File and shell tools stay inside the project. **Full access** can reach files anywhere on the laptop.

`direct` runs immediately. `plan` stays read-only on the document until you approve. The hub blocks document writes before that approval.

AI requests send prompts and any document content read by the agent to your selected provider. Browserbase and web tools use external services.

## MCP tools

`rhwp/rhwp-agent/tools.mjs` is the list. `rhwp/rhwp-agent/tests/tools.test.mjs` pins the count and categories. Visible to Claude as `mcp__rhwp__<name>`.

Every read returns a `revision`. Every write requires `expectedRevision`. A mismatch returns `REVISION_MISMATCH`. Saving does not bump the revision. Coordinates are `sectionIdx` / `paraIdx` / `charOffset`, 0-based.

## Studio slash commands

These stay in Studio chat. They are not MCP tools.

- `/fast [on|off|status]`. Codex Fast service tier (Codex only). The next turn uses `service_tier="fast"`.
- `/skills`. Open the skill library.
- `/skill-create`. Draft a user skill.
- `/skill-edit <name>` / `/skill-delete <name>`. Change or remove a user skill.
- `/<skill-name> [request]`. Run an enabled skill.

Unknown slash text is sent as a normal message. `//` sends a message that starts with `/`.

## Provider usage

**Settings → AI 연결 → 사용량** reads Claude and Codex subscription quotas from the local CLI login. Claude uses its OAuth credentials in Keychain or `CLAUDE_CONFIG_DIR/.credentials.json`. Codex reads `account/rateLimits/read` through a short-lived app-server and supplements missing windows and banked reset balances through the account usage API. `CODEX_HOME` is respected. API-key billing keeps local token records without showing subscription quota estimates.

Remaining-quota bars refresh while Connections is visible, and each card’s refresh icon forces a new read. Codex banked resets require confirmation and bind the request to the displayed account. The hub saves reset request IDs in `codex-reset-ledger.json` under the usage data directory so an interrupted reset can be retried safely. Credentials stay in the hub. CLIProxyAPI configuration is no longer used.

OpenRouter credit balances, Grok billing, and OpenCode Go usage windows also come from their remote APIs. Unknown values remain unavailable. See [remote provider balances](docs/provider-balances.md) for authentication, supported account types, and endpoint details.

## Environment variables

`browserbase_*` tools run one Stagehand sidecar per browser. Every tool takes an optional `browserId`. Omit it for the shared `main` browser. Subagents pass their own id and get an isolated browser. `BrowserbaseFleet` in `rhwp/rhwp-agent/browserbase-session.mjs` keeps at most 4 browsers per chat and returns `BROWSERBASE_BROWSER_LIMIT` beyond that. Call `browserbase_end` to free a slot. Subagent browsers close when the turn ends. The main browser survives provider restarts and closes on chat stop, hub shutdown, or 15 minutes idle. If a sidecar process dies, the call that hit it returns `BROWSERBASE_SIDECAR_EXITED` and the next call relaunches it.

Browserbase credentials come from the variables below or from Studio **Settings → 원격 브라우저**. `browserbase-credentials-set {apiKey, projectId?, geminiApiKey?}` validates the key against the Browserbase API and picks the project id from the account when omitted. Validation failures are `BROWSERBASE_KEY_INVALID`, `BROWSERBASE_UNREACHABLE`, `BROWSERBASE_PROJECT_NOT_FOUND`, and `BROWSERBASE_NO_PROJECT`. The override lives in hub memory per field and never on disk. `browserbase-credentials-clear` returns to the variables. `browserbase-status-request` reports the source of each field, the key tail, the project id, and open browsers. Studio keeps the override in `sessionStorage` and re-sends it on every reconnect. The hub holds the fleet on `record.browserbaseSession`. A credential change restarts the sidecars when no turn is running. During a turn, open browsers stay and the next call uses the new key.

| Variable | Default | Description |
| --- | --- | --- |
| `RHWP_AGENT_PORT` | `5175` | Hub port, bound to 127.0.0.1 |
| `RHWP_AGENT_TOKEN` | `dev` | Shared token for WS connections (`?token=`) |
| `RHWP_CLAUDE_MODEL` | `sonnet` | Claude model |
| `RHWP_CODEX_MODEL` | `gpt-5.6-sol` | Codex model |
| `RHWP_OPENCODE_MODEL` | `opencode/big-pickle` | OpenCode `provider/model` fallback before discovery |
| `RHWP_SKILLS_DIR` | OS application-data directory | Product skill directory |
| `RHWP_USAGE_DIR` | OS application-data directory | Token-usage log directory |
| `RHWP_REFERENCES_DIR` | OS application-data directory | Reference file store |
| `BROWSERBASE_API_KEY` | — | Browserbase API key |
| `BROWSERBASE_PROJECT_ID` | — | Browserbase project id |
| `GEMINI_API_KEY` | — | Gemini key for the Browserbase sidecar |

Studio build-time: `VITE_RHWP_AGENT_URL` (default `ws://127.0.0.1:5175`), `VITE_RHWP_AGENT_TOKEN` (default `dev`).

## Troubleshooting

- `HUB_UNAVAILABLE`. `node rhwp/rhwp-agent/server.mjs` is not running.
- `NO_STUDIO`. No Studio page is connected.
- `STUDIO_TIMEOUT`. Studio did not answer a document call within 30s.
- `TOOL_TIMEOUT`. The MCP-to-hub call did not finish within 180s.
- `CAPABILITY_EPOCH_REQUIRED` / `STALE_CAPABILITY_EPOCH`. Restart the provider in the current workflow phase.
- `PLAN_WRITE_BLOCKED`. A document write ran before the plan reached `implementing`.
- `BROWSERBASE_NOT_CONFIGURED`. Set the Browserbase variables above and restart the hub.
- Only one Studio connection is kept. A new tab replaces the previous one.

## Tests

```sh
cd rhwp/rhwp-agent
npm test
npm run typecheck:acp
```

`typecheck:acp` checks the shared backend contract and Grok, Cursor, and OpenCode ACP modules. Install Studio dependencies first.

## Files

| File | Role |
| --- | --- |
| `rhwp/rhwp-agent/server.mjs` | WS hub (`/studio`, `/mcp`, `/healthz`) |
| `rhwp/rhwp-agent/ctl.mjs` | `npm start` / `stop` / `status` |
| `rhwp/rhwp-agent/tools.mjs` | MCP tool definitions |
| `rhwp/rhwp-agent/mcp-stdio.mjs` | MCP stdio forwarder |
| `rhwp/rhwp-agent/agents/` | Provider backends |
| `rhwp/rhwp-agent/tests/` | Tool and hub contracts |
