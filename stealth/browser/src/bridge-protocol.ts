/**
 * [INPUT]: None (pure Buffer framing).
 * [OUTPUT]: Exports encodeMessage, FrameDecoder.
 * [POS]: Phase-3B bridge foundation — Chrome native-messaging stdio wire format.
 *
 * Chrome frames every native-messaging message as a 4-byte little-endian length
 * prefix followed by that many bytes of UTF-8 JSON. The host (bridge-host.ts)
 * reads/writes this on stdin/stdout. A streaming decoder is required because
 * stdin delivers arbitrary chunk boundaries — a frame may split across reads or
 * several frames may coalesce into one read.
 */

/** Encode an object as a Chrome native-messaging frame. */
export function encodeMessage(obj: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(obj), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Stateful decoder: feed it raw chunks via push(); it returns every complete
 * message decoded so far and buffers any partial remainder for the next push.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): any[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: any[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break; // wait for the rest of the frame
      const json = this.buf.subarray(4, 4 + len).toString('utf-8');
      this.buf = this.buf.subarray(4 + len);
      try {
        out.push(JSON.parse(json));
      } catch {
        // Corrupt frame — skip it rather than wedge the stream.
      }
    }
    return out;
  }
}
