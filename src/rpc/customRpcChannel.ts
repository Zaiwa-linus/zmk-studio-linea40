import type { RpcTransport } from "@zmkfirmware/zmk-studio-ts-client/transport/index";

const SOF = 0xab;
const ESC = 0xac;
const EOF_BYTE = 0xad;

export function framingEncode(data: Uint8Array): Uint8Array {
  let extra = 0;
  for (const b of data) {
    if (b === SOF || b === ESC || b === EOF_BYTE) extra++;
  }
  const out = new Uint8Array(2 + data.length + extra);
  out[0] = SOF;
  let j = 1;
  for (const b of data) {
    if (b === SOF || b === ESC || b === EOF_BYTE) out[j++] = ESC;
    out[j++] = b;
  }
  out[j] = EOF_BYTE;
  return out;
}

export interface CustomRpcChannel {
  writeCustomFrame: (data: Uint8Array) => Promise<void>;
  readCustomFrame: () => Promise<Uint8Array>;
  /** Serialize custom RPC calls independently of the standard RPC queue. */
  queueCustom: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function interceptTransport(transport: RpcTransport): {
  proxyTransport: RpcTransport;
  customChannel: CustomRpcChannel;
} {
  const underlyingWriter = transport.writable.getWriter();
  let writeQueue: Promise<void> = Promise.resolve();

  function writeRaw(bytes: Uint8Array): Promise<void> {
    const p = writeQueue.then(() => underlyingWriter.write(bytes));
    writeQueue = p.catch(() => {});
    return p;
  }

  const proxyWritable = new WritableStream<Uint8Array>({
    write: (chunk) => writeRaw(chunk),
    close: () => underlyingWriter.close(),
    abort: (r) => underlyingWriter.abort(r),
  });

  let standardCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let customCtrl!: ReadableStreamDefaultController<Uint8Array>;
  const standardReadable = new ReadableStream<Uint8Array>({
    start(c) { standardCtrl = c; },
  });
  const customFrameReadable = new ReadableStream<Uint8Array>({
    start(c) { customCtrl = c; },
  });

  // Framing decode state
  const enum S { IDLE, DATA, ESC }
  let state = S.IDLE;
  let buf: number[] = [];

  function routeFrame(frame: Uint8Array) {
    const isCustom = isCustomResponse(frame);
    console.log(`[customRpc] frame arrived len=${frame.length} isCustom=${isCustom}`, frame.slice(0, 8));
    if (isCustom) {
      customCtrl.enqueue(frame);
    } else {
      standardCtrl.enqueue(framingEncode(frame));
    }
  }

  (async () => {
    const reader = transport.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const b of value) {
          if (state === S.IDLE) {
            if (b === SOF) state = S.DATA;
          } else if (state === S.DATA) {
            if (b === ESC) { state = S.ESC; }
            else if (b === EOF_BYTE) { routeFrame(new Uint8Array(buf)); buf = []; state = S.IDLE; }
            else buf.push(b);
          } else {
            buf.push(b);
            state = S.DATA;
          }
        }
      }
    } catch {
      // transport closed
    } finally {
      reader.releaseLock();
      try { standardCtrl.close(); } catch { /**/ }
      try { customCtrl.close(); } catch { /**/ }
    }
  })();

  // Single long-lived reader; safe because queueCustom serializes all callers.
  const customReader = customFrameReadable.getReader();

  async function readCustomFrame(): Promise<Uint8Array> {
    const { done, value } = await customReader.read();
    if (done) throw new Error("Custom RPC stream closed");
    return value;
  }

  // Separate queue for custom RPCs — does NOT block the standard RPC queue.
  let customQueue: Promise<unknown> = Promise.resolve();
  function queueCustom<T>(fn: () => Promise<T>): Promise<T> {
    const p = customQueue.then(fn);
    customQueue = p.then(() => {}, () => {});
    return p;
  }

  const proxyTransport: RpcTransport = {
    ...transport,
    readable: standardReadable,
    writable: proxyWritable,
  };

  return {
    proxyTransport,
    customChannel: {
      writeCustomFrame: (data) => writeRaw(framingEncode(data)),
      readCustomFrame,
      queueCustom,
    },
  };
}

// Returns true if the decoded frame bytes contain a custom (field 100) response.
function isCustomResponse(frame: Uint8Array): boolean {
  let pos = 0;
  while (pos < frame.length) {
    const [tag, p1] = readVarint(frame, pos);
    pos = p1;
    const wire = tag & 7;
    if (wire === 2) {
      const [len, p2] = readVarint(frame, pos);
      pos = p2;
      if ((tag >>> 3) === 1) {
        // RequestResponse — scan inside for field 100
        const inner = frame.subarray(pos, pos + len);
        if (hasField(inner, 100)) return true;
      }
      pos += len;
    } else if (wire === 0) {
      const [, p2] = readVarint(frame, pos);
      pos = p2;
    } else break;
  }
  return false;
}

function hasField(data: Uint8Array, fieldNum: number): boolean {
  let pos = 0;
  while (pos < data.length) {
    const [tag, p1] = readVarint(data, pos);
    pos = p1;
    const wire = tag & 7;
    if ((tag >>> 3) === fieldNum) return true;
    if (wire === 2) {
      const [len, p2] = readVarint(data, pos);
      pos = p2 + len;
    } else if (wire === 0) {
      const [, p2] = readVarint(data, pos);
      pos = p2;
    } else break;
  }
  return false;
}

export function readVarint(data: Uint8Array, pos: number): [number, number] {
  let result = 0, shift = 0;
  while (pos < data.length) {
    const b = data[pos++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result >>> 0, pos];
}
