import {
  parseChatThread,
  type ChatThread,
  type ThreadMessage,
} from '../agent/threads.ts';

export const CLOUD_TIMELINE_SCHEMA = 'rauhwpx.cloud.timeline';
export const CLOUD_TIMELINE_VERSION = 1;

export interface PortableCloudTimelineV1 {
  schema: typeof CLOUD_TIMELINE_SCHEMA;
  version: typeof CLOUD_TIMELINE_VERSION;
  exportedAt: string;
  thread: ChatThread;
}

function cloneMessages(messages: readonly ThreadMessage[]): ThreadMessage[] {
  return structuredClone([...messages]);
}

export function exportCloudTimeline(thread: ChatThread, exportedAt = new Date().toISOString()): PortableCloudTimelineV1 {
  return {
    schema: CLOUD_TIMELINE_SCHEMA,
    version: CLOUD_TIMELINE_VERSION,
    exportedAt,
    thread: {
      ...structuredClone(thread),
      messages: cloneMessages(thread.messages),
    },
  };
}

export function parseCloudTimeline(value: unknown): PortableCloudTimelineV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.schema !== CLOUD_TIMELINE_SCHEMA || envelope.version !== CLOUD_TIMELINE_VERSION) return null;
  if (typeof envelope.exportedAt !== 'string' || !Number.isFinite(Date.parse(envelope.exportedAt))) return null;
  const thread = parseChatThread(envelope.thread);
  if (!thread) return null;
  return {
    schema: CLOUD_TIMELINE_SCHEMA,
    version: CLOUD_TIMELINE_VERSION,
    exportedAt: envelope.exportedAt,
    thread,
  };
}

export function importCloudTimeline(
  value: unknown,
  local: Pick<ChatThread, 'id' | 'docKey' | 'documentId'>,
): ChatThread | null {
  const timeline = parseCloudTimeline(value);
  if (!timeline) return null;
  return {
    ...timeline.thread,
    id: local.id,
    docKey: local.docKey,
    documentId: local.documentId,
    updatedAt: Math.max(timeline.thread.updatedAt, Date.parse(timeline.exportedAt)),
  };
}
