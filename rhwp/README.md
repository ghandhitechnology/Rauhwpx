<p align="center">
  <img src="assets/logo/logo-256.png" alt="rhwp logo" width="128" />
</p>

<h1 align="center">rhwp</h1>

<p align="center">
  An HWP/HWPX editor with an AI agent sidebar — Claude or Codex reads and edits the open document.
</p>

## AI agent sidebar

`rhwp-studio`, the web editor in this repo, includes a chat sidebar that puts a local Claude or Codex CLI agent to work on the document you have open:

- **Reads the document** through MCP tools — structure, outline, text ranges, selection, fields, search, footnotes, bookmarks, list/format inspection, page rendering, and the live engine edit catalog.
- **Edits the full engine surface** — semantic tools cover common work, while atomic engine batches expose every classified mutation, including shapes, objects, styles, layout, notes, fields/forms, and advanced tables.
- **Commits autonomously with undo** — verified semantic edits commit when the turn succeeds; raw engine batches commit atomically. Failed batches restore the exact prior snapshot.

Everything runs locally: a small Node WebSocket hub (`rhwp-agent/`) bridges the agent CLIs and the browser tab.

```
claude / codex CLI ──spawn──► mcp-stdio.mjs ──ws──► rhwp-agent hub ◄──ws── rhwp-studio sidebar
                              (MCP servers)      (127.0.0.1:5175)        (chat UI + tool executor)
```

## Quick start

Requirements: Node ≥ 20, and the `claude` and/or `codex` CLI on your `PATH`.

1. **Start the agent hub**

   ```sh
   npm start       # from the Rauhwpx repo root; background, no attached terminal
   ```

   Or inside this tree: `cd rhwp-agent && npm start` (foreground).

2. **Start the editor**

   ```sh
   cd rhwp-studio
   npm install     # first time only
   npm run dev     # http://127.0.0.1:7700
   ```

3. **Open a document and chat** — open http://127.0.0.1:7700, load an HWP or HWPX file, pick **Claude** or **Codex** in the right-hand sidebar, and type an instruction (Enter sends, Shift+Enter adds a line). Tool calls appear inline; successful edits commit automatically and remain undoable.

Configuration, the full tool list, and troubleshooting: [rhwp-agent/README.md](rhwp-agent/README.md).

## The engine underneath

The sidebar is built on **rhwp**, an open-source viewer/editor for the Korean HWP/HWPX document formats, written in Rust and compiled to WebAssembly. All document logic — parsing (HWP 5.0, HWPX, HML), layout, rendering (Canvas2D/CanvasKit), and editing — runs in the browser on the WASM engine; `rhwp-agent` is only a thin local router. The Rust core also provides a CLI for document inspection and SVG/PNG/PDF export.

## License

[MIT](LICENSE)
