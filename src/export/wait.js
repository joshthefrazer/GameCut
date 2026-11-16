/**
 * Waiting on WebCodecs without polling.
 *
 * The export used to wait for the decoder and encoder with short timers
 * (1–5 ms). On Windows a timer that short really lasts up to ~15 ms, and a
 * frame could wait on several of them: a 5-minute export crawled along at a
 * few frames a second while the computer sat mostly idle. These resolve the
 * moment the codec says it has room (its `dequeue` event) or has handed a
 * frame back, with a long timer only as a safety net.
 */
export function dequeued(codec, ms = 100) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { codec.removeEventListener('dequeue', finish); } catch { /* no events */ }
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    try { codec.addEventListener('dequeue', finish); } catch { /* older engine: the timer decides */ }
  });
}

/** A yield to the event loop that is not clamped like setTimeout. */
export function yieldNow() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}
