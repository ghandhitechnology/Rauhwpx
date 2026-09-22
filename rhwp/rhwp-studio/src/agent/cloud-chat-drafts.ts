import type { AgentWorkflow } from './types.ts';
import type { WorkspaceMode } from '../cloud/workspace.ts';
import {
  IDB_OPERATION_TIMEOUT_MS,
  openIndexedDatabase,
  withTimeout,
} from '../core/idb-open.ts';

const DB_NAME = 'rhwpCloudChatDrafts';
const DB_VERSION = 1;
const STORE = 'drafts';

export interface CloudComposerDraftAttachment {
  name: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

export interface CloudComposerDraft {
  documentId: string;
  docKey: string | null;
  text: string;
  mode: WorkspaceMode;
  workflow: AgentWorkflow;
  attachments: CloudComposerDraftAttachment[];
  updatedAt: number;
}

type StoredDraft = Omit<CloudComposerDraft, 'attachments'> & {
  attachments: Array<Omit<CloudComposerDraftAttachment, 'bytes'> & { bytes: ArrayBuffer }>;
};

function draftKey(documentId: string): string {
  return documentId.trim();
}

function openDb() {
  return openIndexedDatabase(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: 'documentId' });
    }
  });
}

async function runWithDb<T>(operation: (db: IDBDatabase) => Promise<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await withTimeout(operation(db), IDB_OPERATION_TIMEOUT_MS, DB_NAME);
  } finally {
    db.close();
  }
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function toStored(draft: CloudComposerDraft): StoredDraft {
  return {
    ...draft,
    attachments: draft.attachments.map((attachment) => ({
      ...attachment,
      bytes: attachment.bytes.slice().buffer,
    })),
  };
}

function fromStored(value: StoredDraft): CloudComposerDraft {
  return {
    documentId: value.documentId,
    docKey: value.docKey,
    text: value.text,
    mode: value.mode === 'cloud' ? 'cloud' : 'local',
    workflow: value.workflow === 'plan' || value.workflow === 'question' ? value.workflow : 'direct',
    attachments: (value.attachments ?? []).map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      bytes: new Uint8Array(attachment.bytes),
    })),
    updatedAt: value.updatedAt,
  };
}

export async function saveCloudComposerDraft(draft: CloudComposerDraft): Promise<void> {
  const key = draftKey(draft.documentId);
  if (!key) return;
  await runWithDb(async (db) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(toStored({ ...draft, documentId: key, updatedAt: Date.now() }));
    await transactionDone(tx);
  });
}

export async function loadCloudComposerDraft(documentId: string): Promise<CloudComposerDraft | null> {
  const key = draftKey(documentId);
  if (!key) return null;
  const row = await runWithDb((db) => {
    const tx = db.transaction(STORE, 'readonly');
    return requestResult(tx.objectStore(STORE).get(key) as IDBRequest<StoredDraft | undefined>);
  });
  return row ? fromStored(row) : null;
}

export async function deleteCloudComposerDraft(documentId: string): Promise<void> {
  const key = draftKey(documentId);
  if (!key) return;
  await runWithDb(async (db) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    await transactionDone(tx);
  });
}
