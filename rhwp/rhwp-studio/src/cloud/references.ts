import type { ChatThread, ThreadToolRecord } from '../agent/threads.ts';

function collectReferenceIdsFromValue(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReferenceIdsFromValue(item, output);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'fileId' || key === 'referenceId') && typeof item === 'string' && item.trim()) {
      output.add(item.trim());
    } else if ((key === 'fileIds' || key === 'referenceIds') && Array.isArray(item)) {
      for (const id of item) if (typeof id === 'string' && id.trim()) output.add(id.trim());
    } else {
      collectReferenceIdsFromValue(item, output);
    }
  }
}

function collectReferenceIdsFromText(text: string, output: Set<string>): void {
  try {
    collectReferenceIdsFromValue(JSON.parse(text), output);
    return;
  } catch {
    const pattern = /["'](?:fileId|referenceId)["']\s*:\s*["']([^"']+)["']/g;
    for (const match of text.matchAll(pattern)) if (match[1]?.trim()) output.add(match[1].trim());
  }
}

/** Only references explicitly attached or observed in this visible session may leave the device. */
export function collectUsedCloudReferenceIds(thread: Pick<ChatThread, 'messages'>): string[] {
  const ids = new Set<string>();
  const collectTool = (tool: ThreadToolRecord) => {
    collectReferenceIdsFromText(tool.argsJson, ids);
    collectReferenceIdsFromText(tool.resultPreview, ids);
  };
  for (const message of thread.messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.fileId && attachment.status === 'ready') ids.add(attachment.fileId);
    }
    if (message.kind === 'activity') {
      for (const tool of message.tools) collectTool(tool);
    } else if (message.kind === 'tasks') {
      for (const task of message.tasks) for (const tool of task.tools) collectTool(tool);
    }
  }
  return [...ids];
}
