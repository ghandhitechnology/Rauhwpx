// The durable log is the queue. Slow clients retain only a cursor and the
// response's writable buffer, rather than copies of every arriving event.
export function streamSessionEvents({ response, sessionStore, sessionId, after, writeEvent, touchPresence, closePresence, onError = () => {} }) {
  const pageSize = 32;
  let cursor = after;
  let closed = false;
  let blocked = false;
  let scheduled = null;
  let unsubscribe = () => {};
  let keepalive;

  const close = () => {
    if (closed) return;
    closed = true;
    clearImmediate(scheduled);
    clearInterval(keepalive);
    unsubscribe();
    response.off('drain', drain);
    response.off('close', close);
    response.off('error', close);
    closePresence();
  };
  const fail = (error) => {
    close();
    response.destroy();
    onError(error);
  };
  const schedule = () => {
    if (closed || blocked || scheduled !== null) return;
    scheduled = setImmediate(pump);
  };
  const pump = () => {
    scheduled = null;
    if (closed || blocked) return;
    try {
      const events = sessionStore.listEvents(sessionId, cursor, pageSize);
      for (const event of events) {
        // A false write still accepted this frame. Resume after it on drain.
        const writable = writeEvent(event);
        cursor = event.seq;
        if (!writable) {
          blocked = true;
          return;
        }
      }
      // Yield between pages so a large replay cannot monopolize the server.
      if (events.length === pageSize) schedule();
    } catch (error) {
      fail(error);
    }
  };
  const drain = () => {
    blocked = false;
    schedule();
  };
  response.on('drain', drain);
  response.once('close', close);
  response.once('error', close);
  unsubscribe = sessionStore.subscribe(sessionId, schedule);
  keepalive = setInterval(() => {
    if (closed) return;
    try {
      touchPresence();
      if (!blocked) blocked = !response.write(': keepalive\n\n');
    } catch (error) {
      fail(error);
    }
  }, 15_000);
  schedule();
  return close;
}
