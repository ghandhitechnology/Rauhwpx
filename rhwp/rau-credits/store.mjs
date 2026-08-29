import { promises as fs } from 'node:fs';
import path from 'node:path';

function emptyState() {
  return { users: {}, sessions: {}, accessTokens: {} };
}

export function createMemoryStore(initial = emptyState()) {
  let state = structuredClone(initial);
  return {
    async load() {
      return structuredClone(state);
    },
    async save(next) {
      state = structuredClone(next);
    },
  };
}

export function createFileStore(filePath) {
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return emptyState();
        throw error;
      }
    },
    async save(next) {
      chain = chain.then(async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.tmp-${process.pid}`;
        await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, filePath);
      }, async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.tmp-${process.pid}`;
        await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, filePath);
      });
      return chain;
    },
  };
}
