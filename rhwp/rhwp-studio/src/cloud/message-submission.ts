export interface CloudMessageRetryAttachment {
  name: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

export interface CloudMessageRetryInput {
  sessionId: string;
  threadId: string;
  documentId: string | null;
  composerText: string;
  workflow: string | null;
  attachments: readonly CloudMessageRetryAttachment[];
}

export interface CloudMessageRetryToken {
  key: string;
  messageId: string;
}

export function resolveCloudMessageRetry(
  previous: CloudMessageRetryToken | null,
  key: string,
  createMessageId: () => string,
): CloudMessageRetryToken {
  return previous?.key === key ? previous : { key, messageId: createMessageId() };
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function cloudMessageRetryKey(input: CloudMessageRetryInput): Promise<string> {
  const attachments = await Promise.all(input.attachments.map(async (attachment) => {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', exactBuffer(attachment.bytes));
    return {
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  }));
  return JSON.stringify({
    sessionId: input.sessionId,
    threadId: input.threadId,
    documentId: input.documentId,
    composerText: input.composerText,
    workflow: input.workflow,
    attachments,
  });
}

export async function runCloudMessageSubmission<TTarget, TPrepared, TCommitted>({
  acquire,
  target: initialTarget,
  changeTarget,
  prepare,
  isCurrent,
  queue,
  commit,
  restore,
}: {
  acquire(): { release(): void };
  target: TTarget;
  changeTarget?(target: TTarget): Promise<TTarget>;
  prepare(): Promise<TPrepared>;
  isCurrent(target: TTarget): boolean;
  queue(target: TTarget, prepared: TPrepared): Promise<void>;
  commit(target: TTarget, prepared: TPrepared): TCommitted;
  restore(prepared: TPrepared): void | Promise<void>;
}): Promise<
  | { kind: 'accepted'; committed: TCommitted }
  | { kind: 'stale' }
> {
  const lock = acquire();
  let prepared: TPrepared | undefined;
  let preparationCompleted = false;
  let accepted = false;
  try {
    const target = changeTarget ? await changeTarget(initialTarget) : initialTarget;
    prepared = await prepare();
    preparationCompleted = true;
    if (!isCurrent(target)) {
      preparationCompleted = false;
      await restore(prepared);
      return { kind: 'stale' };
    }
    await queue(target, prepared);
    accepted = true;
    return { kind: 'accepted', committed: commit(target, prepared) };
  } catch (error) {
    if (preparationCompleted && !accepted) await restore(prepared as TPrepared);
    throw error;
  } finally {
    lock.release();
  }
}
