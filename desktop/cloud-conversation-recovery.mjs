const MAX_CONVERSATIONS = 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const RESTORABLE_STATES = new Set(['staged', 'queued', 'running', 'suspended']);
const identifier = (value, limit = 160) => (
  typeof value === 'string'
  && value.length >= 1
  && value.length <= limit
  && /^[A-Za-z0-9._:-]+$/.test(value)
);

export function validateConversationSnapshot(value) {
  const createdAt = typeof value?.createdAt === 'string'
    ? value.createdAt
    : Number.isFinite(Number(value?.createdAt)) && Number(value.createdAt) > 0
      ? new Date(Number(value.createdAt)).toISOString()
      : '';
  const expiresAt = typeof value?.expiresAt === 'string'
    ? value.expiresAt
    : Number.isFinite(Number(value?.expiresAt)) && Number(value.expiresAt) > 0
      ? new Date(Number(value.expiresAt)).toISOString()
      : '';
  if (!value || typeof value !== 'object'
    || !identifier(value.id)
    || !identifier(value.sessionId, 128)
    || !identifier(value.documentId, 256)
    || !identifier(value.threadId, 256)
    || !identifier(value.cloudStartId)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.turn) || value.turn < 0
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_SNAPSHOT_BYTES
    || typeof value.pendingWork !== 'boolean'
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isFinite(Date.parse(createdAt))
    || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('Cloud conversation snapshot is invalid');
  }
  return { ...Object.fromEntries([
    'id', 'sessionId', 'documentId', 'threadId', 'cloudStartId', 'revision', 'turn',
    'sha256', 'size', 'state', 'pendingWork',
  ].filter((key) => value[key] !== undefined).map((key) => [key, value[key]])), createdAt, expiresAt };
}

export function conversationSnapshotRestorable(snapshot) {
  return RESTORABLE_STATES.has(String(snapshot?.state ?? '').toLowerCase());
}

/** Account-fenced broker discovery for conversations that can be restored to a replacement worker. */
export class CloudConversationRecovery {
  constructor({ store, provider }) {
    this.store = store;
    this.provider = provider;
    this.conversations = [];
    this.accountId = null;
    this.generation = 0;
    this.inflight = null;
  }

  reset() {
    this.generation += 1;
    this.conversations = [];
    this.accountId = null;
    this.inflight = null;
  }

  async refresh({ sessionId = null, assertCurrent = () => {} } = {}) {
    if (this.inflight) return this.inflight;
    const provider = this.provider();
    if (!provider?.listConversations) {
      this.conversations = [];
      return [];
    }
    const generation = this.generation;
    const cacheIdentity = await provider.getLocalCacheIdentity?.();
    const check = async () => {
      assertCurrent();
      if (generation !== this.generation) throw new DOMException('Cloud account changed', 'AbortError');
      if (provider.getLocalCacheIdentity
        && (!cacheIdentity || cacheIdentity !== await provider.getLocalCacheIdentity())) {
        throw new DOMException('Cloud account changed', 'AbortError');
      }
    };
    const task = (async () => {
      const result = await provider.listConversations({ ...(sessionId ? { sessionId } : {}) });
      await check();
      if (!identifier(result?.accountId) || !Array.isArray(result.conversations)
        || result.conversations.length > MAX_CONVERSATIONS) {
        throw new Error('Cloud conversation inbox is invalid');
      }
      const records = await this.store.list();
      await check();
      const incoming = result.conversations.map(validateConversationSnapshot);
      this.conversations = incoming.filter((conversation) => records.some((record) => (
        record.cloudSessionId === conversation.sessionId
        && record.originDocumentId === conversation.documentId
        && record.threadId === conversation.threadId
        && (!record.timeline?.thread?.cloudStartId
          || record.timeline.thread.cloudStartId === conversation.cloudStartId)
      )));
      this.accountId = result.accountId;
      return this.conversations;
    })().catch((error) => {
      if (generation === this.generation && (error.status === 401 || error.status === 403
        || /AUTH_REQUIRED|ACCOUNT_SESSION/.test(error.code ?? ''))) this.reset();
      throw error;
    }).finally(() => {
      if (this.inflight === task) this.inflight = null;
    });
    this.inflight = task;
    return task;
  }
}
