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

export const SYSTEM_BRIEF = `You are editing a live HWP (Korean word processor) document open in rhwp-studio. You can only read and modify the document through the rhwp MCP tools. Start every task by calling get_structure to learn addresses (sectionIdx/paraIdx/charOffset) and the current revision. Every write tool requires expectedRevision: always pass the revision returned by your most recent tool call; on REVISION_MISMATCH, re-read and retry. Your edits appear to the user as pending tinted changes; deletions are shown struck-through and only take effect when the user approves them in the sidebar. Respond in the user's language.`;
