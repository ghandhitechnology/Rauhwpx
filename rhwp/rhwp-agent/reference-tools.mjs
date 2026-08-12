import { referenceScopesForSession } from './reference-session.mjs';

const REFERENCE_TOOLS = new Set([
  'list_reference_files',
  'search_reference_files',
  'read_reference_chunk',
]);

/** Execute a hub-local reference MCP call without relaying it to Studio. */
export async function executeReferenceTool({ tool, args, store, session }) {
  if (!REFERENCE_TOOLS.has(tool)) return { handled: false, result: null };
  const scopes = referenceScopesForSession(session);
  if (tool === 'list_reference_files') {
    return { handled: true, result: { files: store.listAccessible(scopes) } };
  }
  if (tool === 'search_reference_files') {
    return {
      handled: true,
      result: {
        query: args.query,
        results: store.search({ query: args.query, scopes, maxResults: args.maxResults ?? 8 }),
      },
    };
  }
  return {
    handled: true,
    result: await store.readChunk({
      fileId: args.fileId,
      chunkId: args.chunkId,
      maxChars: args.maxChars ?? 12_000,
      scopes,
    }),
  };
}
