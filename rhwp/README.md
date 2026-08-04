<p align="center">
  <img src="assets/logo/logo-256.png" alt="rhwp logo" width="128" />
</p>

<h1 align="center">rhwp</h1>

<p align="center">
  An HWP/HWPX editor with an AI agent sidebar — Claude or Codex reads and edits the open document.
</p>

## AI agent sidebar

`rhwp-studio`, the web editor in this repo, includes a chat sidebar that puts a local Claude or Codex CLI agent to work on the document you have open:

- **Reads the document** through 12 MCP tools — structure, text ranges, selection, fields, search, page rendering.
- **Proposes edits** — insert, delete, replace, character formatting, field values. Nothing is applied silently: insertions are tinted, deletions struck through, formatting outlined.
- **Waits for your call** — each turn ends with a review card in the sidebar. **Approve** commits the whole turn as a single undo step (one Ctrl+Z reverts it); **Reject** rolls it back.

Everything runs locally: a small Node WebSocket hub (`rhwp-agent/`) bridges the agent CLIs and the browser tab.

```
claude / codex CLI ──spawn──► mcp-stdio.mjs ──ws──► rhwp-agent hub ◄──ws── rhwp-studio sidebar
                              (MCP servers)      (127.0.0.1:5175)        (chat UI + tool executor)
```

## Quick start

Requirements: Node ≥ 20, and the `claude` and/or `codex` CLI on your `PATH`.

1. **Start the agent hub**

   ```sh
   cd rhwp-agent
   npm install     # first time only
   npm start       # WS hub on 127.0.0.1:5175
   ```

2. **Start the editor** (second terminal)

   ```sh
   cd rhwp-studio
   npm install     # first time only
   npm run dev     # http://127.0.0.1:7700
   ```

3. **Open a document and chat** — open http://127.0.0.1:7700, load an HWP or HWPX file, pick **Claude** or **Codex** in the right-hand sidebar, and type an instruction (Enter sends, Shift+Enter adds a line). Tool calls appear inline in the chat log; edits wait for your approval.

Configuration, the full tool list, and troubleshooting: [rhwp-agent/README.md](rhwp-agent/README.md).

## The engine underneath

The sidebar is built on **rhwp**, an open-source viewer/editor for the Korean HWP/HWPX document formats, written in Rust and compiled to WebAssembly. All document logic — parsing (HWP 5.0, HWPX, HML), layout, rendering (Canvas2D/CanvasKit), and editing — runs in the browser on the WASM engine; `rhwp-agent` is only a thin local router. The Rust core also provides a CLI for document inspection and SVG/PNG/PDF export.

## License

[MIT](LICENSE)
