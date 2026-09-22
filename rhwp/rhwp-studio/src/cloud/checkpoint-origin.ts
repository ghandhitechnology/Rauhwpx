import type { CloudCheckpointPayload } from './types.ts';

export function checkpointMatchesActiveDocument(
  checkpoint: Pick<CloudCheckpointPayload, 'documentId' | 'originOnThisDevice'>,
  activeDocumentId: string | null,
): boolean {
  return checkpoint.originOnThisDevice === true
    && checkpoint.documentId !== null
    && checkpoint.documentId === activeDocumentId;
}

export type CheckpointOriginOutcome = 'archive-only' | 'unchanged' | 'written' | 'conflict' | 'permission-denied';

type WritableOriginHandle = {
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
    abort?(reason?: unknown): Promise<void>;
  }>;
};

export async function persistCheckpointToBrowserOrigin({
  handle,
  bytes,
  sha256,
  expectedSha256,
  digest,
}: {
  handle: WritableOriginHandle | null;
  bytes: Uint8Array;
  sha256: string;
  expectedSha256: string | null;
  digest(bytes: Uint8Array): Promise<string>;
}): Promise<CheckpointOriginOutcome> {
  if (!handle) return 'archive-only';
  const permission = await handle.queryPermission?.({ mode: 'readwrite' });
  if (permission !== undefined && permission !== 'granted') return 'permission-denied';
  const currentDigest = await digest(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
  if (currentDigest === sha256) return 'unchanged';
  if (!expectedSha256 || currentDigest !== expectedSha256) return 'conflict';
  const writable = await handle.createWritable();
  try {
    const exactBytes = new Uint8Array(bytes.byteLength);
    exactBytes.set(bytes);
    await writable.write(new Blob([exactBytes.buffer]));
    await writable.close();
  } catch (error) {
    await writable.abort?.(error).catch(() => undefined);
    throw error;
  }
  const savedDigest = await digest(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
  if (savedDigest !== sha256) throw new Error('브라우저 원본 저장 검증에 실패했습니다.');
  return 'written';
}


/** Only a saved origin matching the loaded document may authorize later replacement. */
export async function captureCloudOriginSha256({
  handle,
  loadedDigest,
  sourceDigest,
  digest,
}: {
  handle: Pick<WritableOriginHandle, 'getFile'> | null;
  loadedDigest: string | null;
  sourceDigest(bytes: Uint8Array): string;
  digest(bytes: Uint8Array): Promise<string>;
}): Promise<string | null | undefined> {
  if (!handle) return undefined;
  try {
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    if (!loadedDigest || sourceDigest(bytes) !== loadedDigest) return null;
    return await digest(bytes);
  } catch {
    return null;
  }
}
