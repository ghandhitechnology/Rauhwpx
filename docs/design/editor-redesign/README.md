# Editor redesign

The editor uses pure white and black chrome, monochrome vector tools, compact labeled controls, and glass only on floating menus and command search. System fonts, fixed control dimensions, and immediate state changes keep the chrome stable. Reduced transparency and increased contrast preferences use opaque menus.

The added title strip was removed. Search lives in the original menu row. Production sidebar files and their inherited root palette are unchanged. Editor colors are scoped to the header, document workspace, status bar, and editing dialogs.

## Behavior

- Ctrl/Cmd+/ and the visible search button open the same command palette. Disabled commands are identified and skipped by keyboard navigation. Escape restores focus.
- Menus support arrows, Enter, Space, and Escape. Existing document shortcuts are preserved.
- Formatting controls support keyboard activation. Undo/redo and clipboard tools use the command dispatcher and reflect current availability.
- Narrow windows wrap formatting fields and scroll the tool area. Mobile submenus expand inside the menu so they remain on screen.

## Evidence

[Market research](../editor-market-research-2026-09-24.md) records the first-party references used before visual edits. `design-reference.png` is an AI-generated direction study, not a screenshot or shipped UI asset.

| Theme | Before | After |
| --- | --- | --- |
| Light | [Before](before-light.png) | [After](after-light.png) |
| Dark | [Before](before-dark.png) | [After](after-dark.png) |
| Narrow | [Before](before-narrow.png) | [After](after-narrow.png) |

The comparison images use the production shell around a labeled fixture page. `real-editor-document.png`, `real-editor-menu.png`, and `real-editor-search.png` show the running editor with a real engine document. The document engine itself is unchanged.

## Checks

From `rhwp/rhwp-studio`:

- `npm run build`
- `node sidebar-preview/editor-shell.check.mjs`
- `node tests/toolbar-keyboard.browser.test.mjs`
- `node --test tests/accessibility-shell.test.ts tests/shortcut-map.test.ts tests/menu-shortcut-labels.test.ts tests/toolbar-font-size-clamp.test.ts tests/toolbar-line-spacing-clamp.test.ts`
- `CHROME_PATH=... VITE_URL=... node e2e/command-palette.test.mjs --mode=headless`
- `CHROME_PATH=... VITE_URL=... node e2e/toolbar-command-state.test.mjs --mode=headless`

The shell browser check covers 390, 768, and 1440px, repeated menu/search openings without layout shifts, mobile submenu bounds, and unchanged sidebar colors. For the standalone fixture preview, use `npm run dev:sidebar` and `?editor=1`.

Validation results: the production build, 23 focused unit checks, shell browser checks, formatting keyboard checks, command-palette E2E, and toolbar command-state E2E pass. WASM was rebuilt from this checkout for the final build.

The existing contextual-toolbar E2E fails during fixture creation in unchanged Rust code, `src/document_core/commands/object_ops/shape.rs:1500`: shape insertion requests index 3 for a vector of length 1. It fails before its object-toolbar assertions, including with a fresh WASM build. No Rust source was changed in this UI work.
