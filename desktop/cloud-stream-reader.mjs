/** Bound silence, including streams whose TCP connection never reports a close. */
export async function readStreamChunk(reader, timeoutMs = 45_000) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = Object.assign(new Error('Cloud stream stopped responding'), { code: 'ETIMEDOUT', retryable: true });
          reject(error);
          void reader.cancel(error).catch(() => {});
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
