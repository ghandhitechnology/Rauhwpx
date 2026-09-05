# Sidebar design preview

The preview mounts `initAgentSidebar` from the application, including its CSS,
icons, fonts, menus, overlays, settings, and interaction handlers. There is no
second sidebar implementation to keep synchronized.

## Start

From the repository root, using Node 22.18 or newer:

```sh
npm --prefix rhwp/rhwp-studio ci  # first run only
npm run dev:sidebar
```

Open **http://127.0.0.1:7715**. Vite reloads when the imported sidebar or its styles
change. The server binds to localhost and reserves this port so the preview's
browser storage stays separate from Studio. It requires no Rust build, WASM,
Electron, agent hub, credentials, or cloud connection.

The left controls belong to the preview. The right panel is the production
sidebar, starting at its normal 480px width. Drag its left edge to resize it;
the application's width limits and compact composer behavior still apply.
The focus-mode button shows a placeholder because this preview covers the sidebar.

## Useful URLs

| URL suffix | Opens |
| --- | --- |
| `?scenario=plan` | Next submitted message produces an approval plan |
| `?scenario=question` | A question with selectable and free-text answers |
| `?scenario=review` | Streaming reply followed by accept/reject changes |
| `?scenario=fleet` | Tool activity and a subagent task |
| `?scenario=error` | A failed turn |
| `?cloud=1` | Cloud workspace with local disconnect, reconnect, restart, and shutdown fixtures |
| `?page=settings` | Production settings panel |
| `?page=versions` | Production version graph |
| `?services=setup&page=settings` | Uninstalled/unconfigured service fixtures |
| `?initial-setup=1` | Production first-run setup wizard |
| `?theme=dark&width=360` | Dark theme and narrow sidebar |
| `?controls=0` | Hide preview controls for clean captures |
| `?reset=1` | Clear preview storage before mounting |

Parameters can be combined. Select **Next reply**, then type a message or press
**Play sample conversation**. Connection and service controls expose disconnected,
reconnecting, replaced-session, and setup screens without waiting for real failures.

For Cloud recovery, open `?cloud=1`, choose **Codex**, select **클라우드**, and send
a message. Select **클라우드** again to show the document preview. **Disconnect
Cloud** pauses the connection while retaining the last frame; the production
Cloud controls reconnect, rebuild from the same conversation, or stop the worker.
The fixture records transfers and session scope in `window.sidebarPreview.cloud`.

## Behavior and placeholders

| Surface | Preview behavior |
| --- | --- |
| Chat | Real composer, provider/model/effort pickers, permissions, streaming Markdown, stop, tool details, question responses, and thread library |
| Plans and changes | Real approval/revision controls, pending change cards, accept/reject, and full-access behavior; document content is simulated |
| Skills | Search, edit files, create/validate/save/delete, enable/disable, and generated sample drafts |
| Templates | Upload metadata, rename, replace, delete, and select via `/templates`; document parsing is simulated |
| References | File picker/drop/paste UI, staged message attachments, scoped lists, filename search, and deletion; extraction returns sample metadata/snippets |
| Settings | Real editing preferences, draft/apply/cancel, themes, model defaults, app instructions, and sample writing-style calibration |
| Connections | Sample account login/logout, provider install/login, usage plans, model catalogs, and usage-link state; no keys are used or stored by mocks |
| Versions | Graph, commit titles, checkpoints, restore/adopt metadata, branches, tags, shelves, and sample merges |
| External/document actions | Local notice for browser/cloud pages, linked documents, full-workspace focus mode, and document comparisons |

Service fixtures are in memory and reset on reload. The production preference and
thread stores persist on the preview's origin. **Reset preview data** clears those
stores too; close other preview tabs first. Real application data is on its own
origin and is unaffected.

## Edit and extend

- Edit `src/ui/agent-sidebar/` for designs intended to ship. Its production code is
  imported directly; changes appear here and in the app.
- For exploratory work, use an isolated Git branch/worktree. Make temporary style
  experiments in `src/sidebar-preview/preview.css` when they should remain preview-only.
- Add sample content in `src/sidebar-preview/fixtures.ts` and service behavior in
  `mock-bridge.ts` or `mock-versions.ts`. Keep application selectors/markup out of mocks.
- The mocks implement `SidebarBridge` and `VersionManagerController`. Changes to
  those interfaces must be reflected in the fixtures; avoid `any`, cast-throughs,
  or a catch-all proxy that would conceal an unimplemented service method.
- `window.sidebarPreview` exposes the typed bridge, version controller, event bus,
  scenario selector, and state snapshot for focused browser experiments.

`vite.sidebar.config.ts` is independent of the application's Vite config. Keep it
free of the agent-hub and PWA plugins and imports of the application entry point.
The shared desktop module's optional PWA import resolves to a preview-only no-op.

## Verification

```sh
npm run test:sidebar
npm run build:sidebar
```

The browser check starts its own Vite server on an ephemeral port and launches a
fresh headless Chrome profile. It exercises the primary panels and mutations,
checks request isolation, and writes **sidebar-only PNGs** to
`sidebar-preview/artifacts/` (Git-ignored). Set `CHROME_PATH` if Chrome/Chromium is
not installed in a standard macOS/Linux location; this also supports Windows paths.
It does not connect to or control your normal browser.

Cloud checks also save full-page `cloud-live.png`, `cloud-disconnected.png`, and
`cloud-restarted.png`, plus narrow dark-mode recovery and status-panel captures.
They check button clipping and panel bounds at the sidebar's minimum width,
a blocked status refresh, stable keyboard focus
across repeated snapshots, duplicate recovery clicks, stopping during reconnect,
fresh transfer IDs after rebuilding, and returning to the original chat after
switching threads. Timings measure the local fixture, not hosted provisioning.

The static build goes to `rhwp/rhwp-studio/dist-sidebar/`, separately from the
application build. For the repository-wide TypeScript check, run Studio's normal
`tsc` command after generating the application's WASM declarations. A checkout
without `rhwp/pkg/rhwp.d.ts` reports existing missing-WASM type errors even though
the sidebar preview runs and builds independently.

For a design review, also inspect keyboard focus, scroll behavior with long
content, and popovers at the sidebar width you plan to ship. Backend correctness
and document-renderer behavior remain covered by their application tests.
