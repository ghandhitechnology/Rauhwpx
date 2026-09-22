import { CloudError } from './protocol.mjs';

const MAX_TIMELINE_BYTES = 100 * 1024 * 1024;

export async function archiveTurnBoundary({ lease, sessionStore, blobStore, sessionId, boundary }) {
  if (!lease?.enabled || boundary.kind !== 'turn') return;
  const session = sessionStore.getSessionRow(sessionId);
  const existing = sessionStore.database.prepare(`
    SELECT 1 FROM session_checkpoints WHERE session_id = ? AND operation_id = ?
  `).get(sessionId, boundary.operationId);
  if (!existing) {
    const turn = session.current_turn_id ? sessionStore.database.prepare(`
      SELECT turn_number AS turnNumber FROM session_turns WHERE id = ? AND session_id = ?
    `).get(session.current_turn_id, sessionId) : null;
    if (boundary.turnNumber !== (turn?.turnNumber ?? session.turns_used + 1)
      || (session.protocol_version === 2 && !turn)) {
      throw new CloudError('TURN_IDENTITY_CONFLICT', 'Cloud boundary does not belong to the current turn', 409);
    }
    const latest = sessionStore.database.prepare(`
      SELECT MAX(revision) AS revision FROM session_checkpoints WHERE session_id = ?
    `).get(sessionId);
    if (latest.revision !== null && boundary.revision <= latest.revision) {
      throw new CloudError('BOUNDARY_REVISION_CONFLICT', 'Cloud boundary revision must advance the document', 409);
    }
  }
  const { blob, stream } = blobStore.openReadStream(boundary.timeline.blobId);
  if (blob.size > MAX_TIMELINE_BYTES) {
    stream.destroy();
    throw new CloudError('TIMELINE_TOO_LARGE', 'Cloud timeline exceeds 100 MiB', 413);
  }
  const parts = [];
  let size = 0;
  for await (const part of stream) {
    size += part.length;
    if (size > MAX_TIMELINE_BYTES) throw new CloudError('TIMELINE_TOO_LARGE', 'Cloud timeline exceeds 100 MiB', 413);
    parts.push(part);
  }
  let timeline;
  try { timeline = JSON.parse(Buffer.concat(parts, size).toString('utf8')); } catch {
    throw new CloudError('TIMELINE_INVALID', 'Cloud timeline is invalid', 400);
  }
  const cloudStartId = timeline?.thread?.cloudStartId;
  if (!session.client_document_id || !session.client_thread_id
    || timeline?.thread?.id !== session.client_thread_id
    || typeof cloudStartId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(cloudStartId)) {
    throw new CloudError('CLOUD_START_IDENTITY_REQUIRED', 'Cloud document and start identity are required to retain this turn', 409);
  }
  const document = blobStore.openReadStream(boundary.checkpoint.blobId);
  return lease.archiveMergeRequest({
    sessionId,
    documentId: session.client_document_id,
    threadId: session.client_thread_id,
    cloudStartId,
    operationId: boundary.operationId,
    revision: boundary.revision,
    turn: boundary.turnNumber,
    kind: 'turn',
    fileName: session.origin_name,
    sha256: boundary.checkpoint.blobId,
    size: boundary.checkpoint.size,
  }, document.stream);
}
