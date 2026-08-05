/**
 * Shared helpers for agent CLI backends.
 *
 * @typedef {'claude' | 'codex'} AgentName
 *
 * @typedef {(
 *   | { type: 'turn-start';   agent: AgentName }
 *   | { type: 'session-info'; agent: AgentName; sessionId: string; model?: string; mcpStatus?: string }
 *   | { type: 'text-delta';   agent: AgentName; text: string }
 *   | { type: 'tool-call';    agent: AgentName; callId: string; tool: string; argsJson: string }
 *   | { type: 'tool-result';  agent: AgentName; callId: string; ok: boolean; resultPreview: string }
 *   | { type: 'turn-end';     agent: AgentName; stopReason?: string; errorMessage?: string }
 *   | { type: 'error';        agent: AgentName; message: string }
 * )} UnifiedAgentEvent
 *
 * @typedef {Object} BackendOptions
 * @property {string} rootDir
 * @property {string} mcpScriptPath
 * @property {number} hubPort
 * @property {string} token
 * @property {string} [model]
 * @property {string} [effort]
 * @property {(evt: UnifiedAgentEvent) => void} onEvent
 *
 * @typedef {Object} AgentSession
 * @property {AgentName} agent
 * @property {() => string | null} getSessionId
 * @property {(text: string) => void} sendUserMessage
 * @property {() => void} interrupt
 * @property {() => void} dispose
 */

/**
 * Returns a chunk consumer that accumulates buffered data, splits it on
 * newlines and invokes onLine with each JSON-parsed line. Parse failures are
 * logged to stderr and skipped.
 * @param {(obj: any) => void} onLine
 * @returns {(chunk: Buffer | string) => void}
 */
export function createLineReader(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        process.stderr.write(`[backend] skipping unparseable line: ${line.slice(0, 200)}\n`);
        continue;
      }
      try {
        onLine(obj);
      } catch (e) {
        process.stderr.write(`[backend] onLine handler error: ${e?.stack ?? e}\n`);
      }
    }
  };
}

/**
 * @param {string} s
 * @param {number} [max]
 */
export function truncate(s, max = 2000) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export const SYSTEM_BRIEF = `You are editing a live HWP (Korean word processor) document open in rhwp-studio. You can only read and modify the document through the rhwp MCP tools. Start every task by calling get_structure to learn addresses (sectionIdx/paraIdx/charOffset) and the current revision. Every write tool requires expectedRevision: always pass the revision returned by your most recent tool call; on REVISION_MISMATCH, re-read and retry. Your edits appear to the user as pending tinted changes; deletions are shown struck-through and only take effect when the user approves them in the sidebar. Respond in the user's language. Keep routine progress narration brief because the UI compacts it with tool activity. After every tool-using turn, always send a separate final user-facing message that states the outcome and asks the user to check the document or pending changes. Never end a successful tool-using turn on a tool call or progress update alone.

EDITING WORKFLOW:
- You CANNOT approve your own edits; approval only happens between turns, by the user. Never poll, wait, or retry while waiting for approval — finish your turn and the user will review.
- Issue write tools ONE AT A TIME, chaining each response's revision into the next write's expectedRevision — never send write calls in parallel.
- After completing a batch of edits, call verify_changes (includeImage:true when layout matters) to self-check your work, fix any problems you find, THEN end your turn.
- Use apply_list for lists — never type literal number/bullet text like '1.' or '가.'.
- Use replace_range (not delete_range + insert_text) to replace existing text — it is atomic and preserves formatting.
- Always preview_equation before insert_equation, and treat its warnings as errors to fix before inserting.
- After insert_row/insert_col/merge_cells, that table is locked against further edits until the user approves — plan table structure changes last.`;
