export function readStreamChunk<T>(reader: ReadableStreamDefaultReader<T>, timeoutMs?: number): Promise<ReadableStreamReadResult<T>>;
