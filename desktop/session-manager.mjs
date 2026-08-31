import { randomUUID } from 'node:crypto';

export class SessionManager {
  #createId;
  #getHubContext;
  #getSessionCapabilities;
  #launchId;
  #sessions = new Map();
  #senderSessions = new Map();
  #windowSessions = new WeakMap();

  constructor({ launchId, getHubContext, getSessionCapabilities, createId = randomUUID } = {}) {
    if (!launchId) throw new Error('SessionManager requires a launchId');
    if (typeof getHubContext !== 'function') throw new Error('SessionManager requires getHubContext');
    if (typeof getSessionCapabilities !== 'function') {
      throw new Error('SessionManager requires getSessionCapabilities');
    }
    this.#launchId = launchId;
    this.#getHubContext = getHubContext;
    this.#getSessionCapabilities = getSessionCapabilities;
    this.#createId = createId;
  }

  addWindow(window) {
    const sessionId = this.#createId();
    const sender = window?.webContents;
    const senderId = sender?.id;
    if (!Number.isInteger(senderId)) throw new Error('Session window requires an owned webContents');
    if (this.#senderSessions.has(senderId)) throw new Error(`webContents ${senderId} already owns a session`);

    const session = {
      sessionId,
      window,
      sender,
      senderId,
    };
    this.#sessions.set(sessionId, session);
    this.#senderSessions.set(senderId, session);
    this.#windowSessions.set(window, session);
    return session;
  }

  removeWindow(window) {
    const session = window && this.#windowSessions.get(window);
    if (!session || session.window !== window) return false;
    this.#windowSessions.delete(window);
    this.#senderSessions.delete(session.senderId);
    this.#sessions.delete(session.sessionId);
    return true;
  }

  sessionForSender(sender) {
    const session = this.#senderSessions.get(sender?.id);
    if (!session || session.sender !== sender || session.window.isDestroyed?.() || sender.isDestroyed?.()) {
      throw new Error('IPC sender does not own a desktop session');
    }
    return session;
  }

  async contextForSender(sender) {
    const session = this.sessionForSender(sender);
    const hub = await this.#getHubContext();
    const capabilities = await this.#getSessionCapabilities(session.sessionId, hub);
    return Object.freeze({
      launchId: this.#launchId,
      sessionId: session.sessionId,
      hubUrl: hub.hubUrl,
      hubToken: capabilities.studio,
      referenceToken: capabilities.reference,
      templateToken: capabilities.template,
    });
  }

  sessionById(sessionId) {
    return this.#sessions.get(sessionId) ?? null;
  }

  focusSession(sessionId) {
    const window = this.sessionById(sessionId)?.window;
    if (!window || window.isDestroyed?.()) return false;
    if (window.isMinimized?.()) window.restore();
    window.show?.();
    window.focus?.();
    return true;
  }

  windows() {
    return [...this.#sessions.values()]
      .map((session) => session.window)
      .filter((window) => !window.isDestroyed?.());
  }

  get size() {
    return this.#sessions.size;
  }
}
