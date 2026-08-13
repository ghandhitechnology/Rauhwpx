# Conversation

- Keep responses short and easy to scan. Share key details first and elaborate when the user asks.
- Push back on unreasonable decisions and ask about the concern at least once.
- When the user asks to "talk with me," brainstorm with them first, then execute once the plan is concrete.

# Environment

- You are working on the user's local laptop. Avoid computer-use automation unless the user asks for it, and prefer sandbox-supported browsers.

# Pull Requests

Pull requests should give reviewers enough context to understand the problem, evaluate the approach, and verify the result without reconstructing the work from the diff.

Use this structure:

1. **Title**
   - Clearly summarize the user-visible or technical outcome.
   - Be specific; avoid vague titles such as "fix issue" or "update code."

2. **Summary**
   - Explain what changed and why in 2–4 sentences.
   - Include relevant product or technical context.

3. **Problem**
   - Describe what was missing, broken, confusing, or risky.
   - Include the observable impact and root cause when known.

4. **Solution**
   - List the important implementation changes.
   - Explain notable design decisions and why this approach was chosen.
   - Call out intentionally excluded work or follow-ups.

5. **Diff overview**
   - Summarize the meaningful changes by component or file area.
   - Focus on behavior and architecture, not a file-by-file transcript.

6. **Testing**
   - List commands and checks that were run, with their outcomes.
   - Include important manual verification scenarios.
   - If testing was not performed, state that clearly and explain why.

7. **Risk and rollout**
   - Identify compatibility concerns, migrations, configuration changes, or deployment requirements.
   - Note rollback steps when the change carries meaningful risk.
   - Write "None" when there are no notable risks or rollout steps.

8. **Visual evidence**
   - For UI changes, include before/after screenshots or a short recording when practical.
   - For non-UI changes, omit this section.

Keep PR descriptions detailed but relevant. Do not pad them with boilerplate, repeat the commit history, or claim tests that were not run.

# Smoke Testing

- Do not run heavy smoke tests for simply booting an app or for trivial code changes.
- Run appropriate smoke tests for new features and changes that could break existing behavior.

## Cursor Cloud specific instructions

Standard commands live in `rhwp/CLAUDE.md` and `README.md`; only the non-obvious cloud caveats are here. The update script runs `npm ci` for `rhwp/rhwp-studio` and `rhwp/rhwp-agent`; everything below is already set up in the VM snapshot.

- **Node version gotcha (important):** the default `node` on `PATH` is `/exec-daemon/node` = v22.14, which **cannot run the studio `.ts` tests** (`npm test` → `ERR_UNKNOWN_FILE_EXTENSION`, because native TS type-stripping is off before Node 22.18). Setup installed Node 22.23 via `nvm` and appended a `PATH` prepend to `~/.bashrc` so **login shells** get it. Always run npm commands from a login shell (the default shell here is login-mode; if `node --version` shows 22.14, run under `bash -lc '...'`).
- **wasm is a prerequisite, not a service:** `rhwp/rhwp-studio` (`npm run dev` → http://127.0.0.1:7700) loads the engine from `rhwp/pkg/` via the Vite `@wasm` alias. `pkg/` is gitignored and built with `wasm-pack build --target web` (run from `rhwp/`, wasm-pack 0.15.0, ~5 min). It is already built in the snapshot; **rebuild it after changing any Rust engine code** or the studio will load a stale/absent engine. `wasm-pack` is installed at `/usr/local/cargo/bin/wasm-pack`.
- **Rust toolchain** auto-installs 1.93.1 (incl. `wasm32-unknown-unknown`) via `rhwp/rust-toolchain.toml` on first `cargo` invocation inside `rhwp/`.
- **AI sidebar is optional:** the `rhwp-agent` hub (`rhwp/rhwp-agent`, `npm start` → 127.0.0.1:5175) plus a `claude`/`codex` CLI are only needed to test the AI sidebar. Without them the sidebar shows `연결 끊김` (disconnected) — this is expected and does not affect the editor.
- **Known pre-existing test failure (not an environment problem):** `cargo test --test issue_1082_endnote_multicolumn_drift` fails 3 layout-drift threshold assertions on this commit; the rest of `cargo test` (57/58 binaries, 3300+ tests) and `npm test` (970/979; the 9 "cancelled" come from an `.unref()`'d timeout in `tests/agent-usage-protocol.test.ts`, not the environment) pass.
