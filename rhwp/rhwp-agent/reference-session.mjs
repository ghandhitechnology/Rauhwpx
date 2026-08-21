import crypto from 'node:crypto';

import { scopesForReferenceSession } from './reference-store.mjs';

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeStableScopeId(value, label, { optional = false } = {}) {
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value !== 'string') throw sessionError('INVALID_REQUEST', `${label} must be a string`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw sessionError('INVALID_REQUEST', `${label} is invalid`);
  }
  return normalized;
}

export function normalizeDocumentName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw sessionError('INVALID_REQUEST', 'documentName must be a string');
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!normalized || normalized.length > 500) throw sessionError('INVALID_REQUEST', 'documentName is invalid');
  return normalized;
}

/** Resolve stable scope fields while retaining compatibility with old Studio clients. */
export function resolveSessionIdentity({
  threadId,
  documentId,
  documentName,
  existing = null,
  force = false,
  createThreadId = () => crypto.randomUUID(),
} = {}) {
  return {
    threadId: threadId === undefined || threadId === null
      ? (!force && existing?.threadId ? existing.threadId : createThreadId())
      : normalizeStableScopeId(threadId, 'threadId'),
    documentId: documentId === undefined
      ? (!force ? (existing?.documentId ?? null) : null)
      : normalizeStableScopeId(documentId, 'documentId', { optional: true }),
    documentName: documentName === undefined
      ? (!force ? (existing?.documentName ?? null) : null)
      : normalizeDocumentName(documentName),
  };
}

/** Fail stale queued messages before they can retrieve or leak another scope. */
export function assertMessageScope(activeSession, message) {
  if (Object.prototype.hasOwnProperty.call(message, 'threadId')) {
    const received = normalizeStableScopeId(message.threadId, 'threadId');
    if (received !== activeSession.threadId) {
      throw sessionError('STALE_CHAT_SCOPE', 'Message threadId does not match the active chat');
    }
  }
  if (Object.prototype.hasOwnProperty.call(message, 'documentId')) {
    const received = normalizeStableScopeId(message.documentId, 'documentId', { optional: true });
    if (received !== activeSession.documentId) {
      throw sessionError('STALE_DOCUMENT_SCOPE', 'Message documentId does not match the active document');
    }
  }
  return true;
}

export function referenceScopesForSession(activeSession) {
  return scopesForReferenceSession({
    threadId: activeSession?.threadId,
    documentId: activeSession?.documentId,
  });
}

/** Exact Studio document identity bound to this chat; names are display-only. */
export function activeDocumentIdentity(activeSession) {
  return {
    documentId: typeof activeSession?.documentId === 'string' ? activeSession.documentId : null,
    documentName: typeof activeSession?.documentName === 'string' ? activeSession.documentName : null,
  };
}

/** Add stable identity to the live document-info result returned by Studio. */
export function attachActiveDocumentIdentity(result, identity) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return { ...result, ...activeDocumentIdentity(identity) };
}

/** Give every agent turn exact open-document identity without filename search. */
export function addActiveDocumentContext(activeSession, prompt) {
  const identity = activeDocumentIdentity(activeSession);
  const block = [
    '<active_document_identity trust="application-state">',
    JSON.stringify(identity),
    'This is the exact Studio document bound to this chat. All rhwp document tools target this documentId.',
    'Use documentId—not documentName, title matching, recent-file lists, or filesystem search—to decide which open document the user means. Call get_document_info for its digest, source format, dirty state, and exact sourcePath when the desktop app has one.',
    '</active_document_identity>',
  ].join('\n');
  return `${block}\n\n${prompt}`;
}
