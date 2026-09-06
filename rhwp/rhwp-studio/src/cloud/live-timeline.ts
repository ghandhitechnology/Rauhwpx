import type { AgentStreamEvent } from '../agent/types.ts';
import type { ThreadMessage } from '../agent/threads.ts';

interface LiveTurn {
  text: string[];
  textLength: number;
  tools: Set<string>;
  tasks: Set<string>;
  error: string;
}

function emptyTurn(): LiveTurn {
  return { text: [], textLength: 0, tools: new Set(), tasks: new Set(), error: '' };
}

function containsFragments(text: string, fragments: readonly string[]): boolean {
  let cursor = 0;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, cursor);
    if (at < 0) return false;
    cursor = at + fragment.length;
  }
  return true;
}

/** Operation checkpoints contain completed history but omit the active turn. */
export class CloudLiveTimelineGuard {
  private acceptedLength = 0;
  private active: LiveTurn | null = null;
  private completed: LiveTurn[] = [];

  observe(event: AgentStreamEvent): void {
    if (event.type === 'turn-start') {
      this.active = emptyTurn();
    } else if (event.type === 'text-delta' && !event.parentTaskId) {
      const turn = this.active ??= emptyTurn();
      // Match the recorder's per-delta and completed-response bounds.
      const fragment = event.text.slice(0, Math.min(256 * 1024, 512 * 1024 - turn.textLength));
      turn.textLength += fragment.length;
      if (fragment.trim()) turn.text.push(fragment.trim());
    } else if (event.type === 'tool-call' && !event.parentTaskId) {
      (this.active ??= emptyTurn()).tools.add(event.callId);
    } else if (event.type === 'task-start') {
      (this.active ??= emptyTurn()).tasks.add(event.taskId);
    } else if (event.type === 'error') {
      (this.active ??= emptyTurn()).error = event.message.slice(0, 16 * 1024).trim();
    } else if (event.type === 'turn-end') {
      const turn = this.active;
      this.active = null;
      if (!turn) return;
      turn.error = (event.errorMessage || turn.error).slice(0, 16 * 1024).trim();
      if (turn.text.length || turn.tools.size || turn.tasks.size || turn.error) this.completed.push(turn);
    }
  }

  canApply(messages: readonly ThreadMessage[]): boolean {
    if (this.active || messages.length < this.acceptedLength) return false;
    let cursor = this.acceptedLength;
    for (const turn of this.completed) {
      const remainingTools = new Set(turn.tools);
      const remainingTasks = new Set(turn.tasks);
      let foundText = turn.text.length === 0;
      let foundError = Boolean(turn.text.length) || !turn.error;
      let found = false;
      for (; cursor < messages.length; cursor++) {
        const message = messages[cursor];
        if (message.role === 'assistant' && !message.kind && containsFragments(message.text, turn.text)) foundText = true;
        if (message.role === 'system' && message.text.includes(turn.error)) foundError = true;
        if (message.kind === 'activity') for (const tool of message.tools) remainingTools.delete(tool.callId);
        if (message.kind === 'tasks') for (const task of message.tasks) remainingTasks.delete(task.taskId);
        if (foundText && foundError && !remainingTools.size && !remainingTasks.size) {
          cursor++;
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  accept(messages: readonly ThreadMessage[]): void {
    this.acceptedLength = messages.length;
    this.completed = [];
  }
}
