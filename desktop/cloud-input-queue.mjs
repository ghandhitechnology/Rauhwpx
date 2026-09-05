function inputError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** One ordered request carries all input collected during the previous round trip. */
export class CloudInputQueue {
  pending = [];
  timer = null;
  sending = null;
  closed = false;
  generation = 0;

  constructor(send, batchSize, now = Date.now) {
    this.send = send;
    this.batchSize = batchSize;
    this.now = now;
  }

  enqueue(streamId, event) {
    if (this.closed) return Promise.reject(inputError('Cloud input is closed', 'DISPLAY_INPUT_UNAVAILABLE'));
    const last = this.pending.at(-1);
    let merged = null;
    if (last?.streamId === streamId) {
      const previous = last.event;
      if (event.kind === 'pointer' && event.action === 'move'
        && previous.kind === 'pointer' && previous.action === 'move') merged = event;
      if (event.kind === 'wheel' && previous.kind === 'wheel'
        && Math.abs(event.deltaX + previous.deltaX) <= 32_768
        && Math.abs(event.deltaY + previous.deltaY) <= 32_768) {
        merged = { ...event, deltaX: previous.deltaX + event.deltaX, deltaY: previous.deltaY + event.deltaY };
      }
      if (event.kind === 'text' && previous.kind === 'text'
        && new TextEncoder().encode(previous.text + event.text).byteLength <= 4096) {
        merged = { kind: 'text', text: previous.text + event.text };
      }
    }
    if (this.pending.length >= 256 || (last?.settle.length ?? 0) >= 256) {
      return Promise.reject(inputError('Cloud input is backed up. Wait for the connection to recover.', 'DISPLAY_INPUT_BACKLOG'));
    }
    const promise = new Promise((resolve, reject) => {
      if (merged && last) {
        last.event = merged;
        last.settle.push({ resolve, reject });
      } else this.pending.push({ streamId, event, createdAt: this.now(), settle: [{ resolve, reject }] });
    });
    this.schedule(event.kind === 'pointer' && event.action === 'click');
    return promise;
  }

  reset(error = inputError('Cloud input connection changed', 'DISPLAY_INPUT_UNAVAILABLE')) {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const item of this.pending.splice(0)) for (const waiter of item.settle) waiter.reject(error);
  }

  async close() {
    this.closed = true;
    this.reset();
    await this.sending;
  }

  schedule(urgent = false) {
    if (this.closed || this.sending || !this.pending.length) return;
    if (urgent && this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, urgent ? 0 : 8);
  }

  flush() {
    if (this.closed || this.sending || !this.pending.length) return;
    if (this.now() - this.pending[0].createdAt > 2500) {
      this.reset(inputError('Cloud input expired while reconnecting. Please repeat the action.', 'DISPLAY_INPUT_EXPIRED'));
      return;
    }
    const streamId = this.pending[0].streamId;
    let count = 0;
    const maximum = Math.max(1, Math.min(32, this.batchSize()));
    let size = 0;
    while (this.pending[count]?.streamId === streamId) {
      const event = this.pending[count].event;
      const cost = event.kind === 'pointer' && event.action === 'click' ? 2 : 1;
      if (size + cost > maximum) break;
      size += cost;
      count++;
    }
    if (!count) {
      this.reset(inputError('Cloud server does not support click batches', 'DISPLAY_INPUT_UNAVAILABLE'));
      return;
    }
    const batch = this.pending.splice(0, count);
    const generation = this.generation;
    this.sending = Promise.resolve().then(() => this.send(streamId, batch.flatMap(({ event }) => event.kind === 'pointer' && event.action === 'click'
      // A click is local shorthand. Existing servers receive their normal wire
      // protocol, with both transitions in one ordered, acknowledged request.
      ? [{ ...event, action: 'down' }, { ...event, action: 'up' }] : [event])))
      .then(() => {
        for (const entry of batch) for (const waiter of entry.settle) waiter.resolve();
      }, (error) => {
        for (const entry of batch) for (const waiter of entry.settle) waiter.reject(error);
        // Never replay later clicks or key transitions after an ambiguous failure.
        if (generation === this.generation) this.reset(error);
      }).finally(() => { this.sending = null; this.schedule(); });
  }
}
