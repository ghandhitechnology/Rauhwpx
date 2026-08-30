import { randomUUID } from 'node:crypto';

function abortError() {
  return new DOMException('Cloud display connection was replaced', 'AbortError');
}

export class CloudDisplayRegistry {
  #openDisplay;
  #entries = new Map();

  constructor({ openDisplay } = {}) {
    if (typeof openDisplay !== 'function') throw new Error('CloudDisplayRegistry requires openDisplay');
    this.#openDisplay = openDisplay;
  }

  async open(ownerId, sessionId, listener) {
    const previous = this.#entries.get(ownerId);
    const priorClose = this.#closeEntry(previous).catch(() => {});
    const entry = {
      connectionId: randomUUID(),
      controller: new AbortController(),
      connection: null,
      opening: null,
      priorClose,
      closePromise: null,
    };
    this.#entries.set(ownerId, entry);
    await priorClose;
    if (this.#entries.get(ownerId) !== entry) throw abortError();
    try {
      entry.opening = this.#openDisplay(sessionId, (event) => {
        if (this.#entries.get(ownerId) === entry && !entry.controller.signal.aborted) {
          listener(event, entry.connectionId);
        }
      }, { signal: entry.controller.signal });
      const connection = await entry.opening;
      entry.connection = connection;
      if (this.#entries.get(ownerId) !== entry || entry.controller.signal.aborted) {
        await this.#closeEntry(entry);
        throw abortError();
      }
      return { connectionId: entry.connectionId, capability: connection.capability };
    } catch (error) {
      if (this.#entries.get(ownerId) === entry) this.#entries.delete(ownerId);
      await this.#closeEntry(entry);
      throw error;
    }
  }

  async close(ownerId, connectionId = null) {
    const entry = this.#entries.get(ownerId);
    if (!entry || connectionId && entry.connectionId !== connectionId) return false;
    this.#entries.delete(ownerId);
    await this.#closeEntry(entry);
    return true;
  }

  async closeAll() {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(entries.map((entry) => this.#closeEntry(entry)));
  }

  async #closeEntry(entry) {
    if (!entry) return;
    if (entry.closePromise) return entry.closePromise;
    entry.closePromise = (async () => {
      entry.controller.abort();
      await entry.priorClose?.catch(() => {});
      const connection = entry.connection ?? await entry.opening?.catch(() => null);
      await connection?.close();
    })();
    return entry.closePromise;
  }
}
