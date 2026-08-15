import { randomUUID } from 'node:crypto';

export class SessionManager {
  #createId;
  #getHubContext;
  #getSessionToken;
  #launchId;
  #sessions = new Map();
  #senderSessions = new Map();
  #windowSessions = new WeakMap();

  constructor({ launchId, getHubContext, getSessionToken, createId = randomUUID } = {}) {
    if (!launchId) throw new Error('SessionManager requires a launchId');
    if (typeof getHubContext !== 'function') throw new Error('SessionManager requires getHubContext');
    if (typeof getSessionToken !== 'function') throw new Error('SessionManager requires getSessionToken');
    this.#launchId = launchId;
    this.#getHubContext = getHubContext;
    this.#getSessionToken = getSessionToken;
    this.#createId = createId;
  }

  addWindow(window, launch = {}) {
    const sessionId = this.#createId();
    const senderId = window?.webContents?.id;
    if (!Number.isInteger(senderId)) throw new Error('Session window requires an owned webContents');
    if (this.#senderSessions.has(senderId)) throw new Error(`webContents ${senderId} already owns a session`);

    const session = {
      sessionId,
      window,
      sender: window.webContents,
      senderId,
      launch: {
        openFiles: [...(launch.openFiles ?? [])],
        source: launch.source ?? 'launch',
      },
    };
    this.#sessions.set(sessionId, session);
    this.#senderSessions.set(senderId, sessionId);
    this.#windowSessions.set(window, sessionId);
    return session;
  }

  removeWindow(window) {
    const sessionId = window && this.#windowSessions.get(window);
    const session = sessionId ? this.#sessions.get(sessionId) : null;
    if (!session || session.window !== window) return false;
    this.#windowSessions.delete(window);
    this.#senderSessions.delete(session.senderId);
    this.#sessions.delete(sessionId);
    return true;
  }

  sessionForSender(sender) {
    const sessionId = this.#senderSessions.get(sender?.id);
    const session = sessionId ? this.#sessions.get(sessionId) : null;
    if (!session || session.sender !== sender || session.window.isDestroyed?.() || sender.isDestroyed?.()) {
      throw new Error('IPC sender does not own a desktop session');
    }
    return session;
  }

  async contextForSender(sender) {
    const session = this.sessionForSender(sender);
    const hub = await this.#getHubContext();
    return Object.freeze({
      launchId: this.#launchId,
      sessionId: session.sessionId,
      hubUrl: hub.hubUrl,
      hubToken: this.#getSessionToken(session.sessionId, hub.hubToken),
    });
  }

  windowForSender(sender) {
    return this.sessionForSender(sender).window;
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
