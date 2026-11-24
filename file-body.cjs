/**
 * A file (or a byte range of one) as the body of a Response.
 *
 * `new Response(fs.createReadStream(…))` looks like it does this, but when the
 * page cancels the request at the moment the file ends (scrubbing, closing a
 * clip) Node closes the same stream twice and throws "ReadableStream is already
 * closed" where nothing can catch it: the "unexpected error" box. Here closing
 * happens once, and a cancelled read simply stops.
 */
const fsp = require('node:fs/promises');

const CHUNK = 256 * 1024;

function fileBody(file, { start = 0, end = Infinity } = {}) {
  let fh = null, pos = start, over = false;
  const release = () => {
    over = true;
    const h = fh;
    fh = null;
    // A read still running finishes first; the handle closes after it.
    h?.close().catch(() => {});
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        if (!fh) {
          const h = await fsp.open(file, 'r');
          if (over) { h.close().catch(() => {}); return; }   // cancelled while it was opening
          fh = h;
        }
        const want = Math.min(CHUNK, end - pos + 1);
        const buf = want > 0 ? Buffer.allocUnsafeSlow(want) : null;
        const { bytesRead } = buf ? await fh.read(buf, 0, want, pos) : { bytesRead: 0 };
        if (over) return;                                    // cancelled while it was reading
        if (bytesRead > 0) {
          pos += bytesRead;
          controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
        }
        if (bytesRead === 0 || pos > end) { release(); controller.close(); }
      } catch (err) {
        if (over) return;
        release();
        controller.error(err);
      }
    },
    cancel() { release(); },
  }, { highWaterMark: 1 });
}

module.exports = { fileBody };
