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
| `?page=settings` | Production settings panel |
| `?page=versions` | Production version graph |
| `?page=versions&history=branches` | Branching and merging history with colored graph lanes |
| `?services=setup&page=settings` | Uninstalled/unconfigured service fixtures |
| `?page=settings&quota=error` | Provider quota errors and unknown health bars in AI 연결 |
| `?page=settings&quota=empty` | Exhausted Codex quota and zero banked resets |
| `?page=settings&quota=refresh-error` | Manual refresh fails once, then succeeds on retry |
| `?initial-setup=1` | Production first-run setup wizard |
| `?theme=dark&width=360` | Dark theme and narrow sidebar |
| `?controls=0` | Hide preview controls for clean captures |
| `?reset=1` | Clear preview storage before mounting |

Parameters can be combined. Select **Next reply**, then type a message or press
**Play sample conversation**. Connection and service controls expose disconnected,
reconnecting, replaced-session, and setup screens without waiting for real failures.

## Behavior and placeholders

### Live account usage audit

Start a development agent hub from this checkout on an unused port, then enable the optional local transport:

```sh
RHWP_AGENT_PORT=5178 npm start
RHWP_SIDEBAR_LIVE_HUB=http://127.0.0.1:5178 npm run dev:sidebar
```

Open `http://127.0.0.1:7715/?page=settings&usage=live` and select **AI 연결**. Usage, token history, and banked reset actions use the real hub; chat, document, and provider setup controls remain fixtures. Confirming a banked reset spends a real reset. The default URL continues to use samples. If the hub uses a custom development token, set `RHWP_SIDEBAR_HUB_TOKEN` on the preview server; hub credentials stay server-side.

The optional transport accepts only same-origin usage reads and Codex reset requests on loopback. It registers its own hub session and deletes that session when the preview server closes.

| Surface | Preview behavior |
| --- | --- |
| Chat | Real composer, provider/model/effort pickers, permissions, streaming Markdown, stop, tool details, question responses, and thread library |
| Plans and changes | Real approval/revision controls, pending change cards, accept/reject, and full-access behavior; document content is simulated |
| Skills | Search, edit files, create/validate/save/delete, enable/disable, and generated sample drafts |
| Templates | Upload metadata, rename, replace, delete, and select via `/templates`; document parsing is simulated |
| References | File picker/drop/paste UI, staged message attachments, scoped lists, filename search, and deletion; extraction returns sample metadata/snippets |
| Settings | Real editing preferences, draft/apply/cancel, themes, model defaults, app instructions, and sample writing-style calibration |
| Connections | Sample account login/logout, provider install/login, direct quota health bars, manual refresh, Codex banked reset confirmation, and model catalogs; provider credentials are never used by mocks |
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

The version graph uses compact rows. Dates appear on hover or keyboard focus;
selecting a commit keeps its details and restore actions below the scrolling list.
The branch buttons switch the active branch, and new preview commits update the
same graph layout used by the application.

For LAN or Tailscale access, bind the preview explicitly:

```sh
npm --prefix rhwp/rhwp-studio run dev:sidebar -- --host 0.0.0.0
```

Open the host's IP address on port 7715. The preview bootstrap supports HTTP
origins where the browser does not expose `crypto.randomUUID()`.

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

The static build goes to `rhwp/rhwp-studio/dist-sidebar/`, separately from the
application build. For the repository-wide TypeScript check, run Studio's normal
`tsc` command after generating the application's WASM declarations. A checkout
without `rhwp/pkg/rhwp.d.ts` reports existing missing-WASM type errors even though
the sidebar preview runs and builds independently.

For a design review, also inspect keyboard focus, scroll behavior with long
content, and popovers at the sidebar width you plan to ship. Backend correctness
and document-renderer behavior remain covered by their application tests.
