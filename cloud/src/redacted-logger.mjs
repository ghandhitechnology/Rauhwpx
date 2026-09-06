const SECRET_KEY = /(authorization|cookie|token|secret|password|credential|api[-_]?key|content|prompt|goal|document)/i;
const TOKEN_PATTERN = /\b(?:Bearer\s+)?(?:ra_(?:at|rt)_[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)\b/gi;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(TOKEN_PATTERN, '[REDACTED]');
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redact(nestedValue, nestedKey)]));
  }
  return value;
}

export class RedactedLogger {
  constructor(database, { now = Date.now, maxBytes = DEFAULT_MAX_BYTES, output = console } = {}) {
    this.database = database;
    this.now = now;
    this.maxBytes = maxBytes;
    this.output = output;
  }

  write(level, event, data = {}, sessionId = null) {
    const clean = redact(data);
    const serialized = JSON.stringify(clean);
    this.database.prepare(`
      INSERT INTO service_logs(session_id, level, event, data_json, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, level, event, serialized, this.now());
    this.output[level]?.(`[${event}]`, clean);
    return clean;
  }

  info(event, data, sessionId) { return this.write('info', event, data, sessionId); }
  warn(event, data, sessionId) { return this.write('warn', event, data, sessionId); }
  error(event, data, sessionId) { return this.write('error', event, data, sessionId); }

  prune() {
    this.database.prepare('DELETE FROM service_logs WHERE created_at < ?').run(this.now() - RETENTION_MS);
    let size = this.database.prepare('SELECT COALESCE(SUM(length(data_json) + length(event) + 32), 0) AS size FROM service_logs').get().size;
    while (size > this.maxBytes) {
      const removed = this.database.prepare(`
        DELETE FROM service_logs WHERE id IN (SELECT id FROM service_logs ORDER BY id LIMIT 1000)
      `).run();
      if (!removed.changes) break;
      size = this.database.prepare('SELECT COALESCE(SUM(length(data_json) + length(event) + 32), 0) AS size FROM service_logs').get().size;
    }
    return size;
  }
}

export { redact as redactLogData };
