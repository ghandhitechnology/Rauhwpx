# Conversation

- Keep responses short and easy to scan. Share key details first and elaborate when the user asks.
- Push back on unreasonable decisions and ask about the concern at least once.
- When the user asks to "talk with me," brainstorm with them first, then execute once the plan is concrete.

# Environment

- You are working on the user's local laptop. Avoid computer-use automation unless the user asks for it, and prefer sandbox-supported browsers.

# Sidebar Design Preview

- Use `npm run dev:sidebar` and open `http://127.0.0.1:7715` for sidebar design work and frontend interaction checks. On a fresh checkout, first run `npm --prefix rhwp/rhwp-studio ci`. The preview needs no full application, WASM build, agent hub, or cloud credentials.
- The preview mounts the production sidebar from `rhwp/rhwp-studio/src/ui/agent-sidebar/`. Make shipping UI changes there so the application and preview stay in sync; keep temporary experiments in `src/sidebar-preview/preview.css` or an isolated worktree.
- Use the preview controls for sample chat, plans, questions, change review, subagents, connection failures, and provider setup. Backend and document-engine actions use local fixtures and placeholders.
- Maintain the typed mocks in `rhwp/rhwp-studio/src/sidebar-preview/` when service interfaces change. Preserve the independent Vite configuration and frontend-only behavior.
- For sidebar behavior changes, run `npm run test:sidebar`; it uses a fresh headless browser and saves screenshots in `rhwp/rhwp-studio/sidebar-preview/artifacts/`. `npm run build:sidebar` checks the standalone build. Simply starting the preview does not require rerunning these checks.
- See [the preview guide](rhwp/rhwp-studio/sidebar-preview/README.md) for URL scenarios, storage reset, browser prerequisites, and extension instructions.

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
