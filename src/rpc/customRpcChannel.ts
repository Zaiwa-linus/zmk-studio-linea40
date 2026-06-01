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
  /**
   * Wait for the custom response whose request_id matches `requestId`.
   * Frames for other request ids are buffered (not discarded) so concurrent
   * callers each receive their own response. Rejects on timeout.
   */
  readCustomFrame: (requestId: number, timeoutMs?: number) => Promise<Uint8Array>;
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
  const standardReadable = new ReadableStream<Uint8Array>({
    start(c) { standardCtrl = c; },
  });

  // Buffer of received custom frames that no waiter has claimed yet, keyed by
  // their request_id. Capped so orphaned responses (e.g. to a timed-out call)
  // cannot grow without bound.
  const MAX_BUFFERED_CUSTOM_FRAMES = 32;
  const customFrames: Array<{ requestId: number; frame: Uint8Array }> = [];
  const customWaiters: Array<{
    requestId: number;
    resolve: (frame: Uint8Array) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];

  function enqueueCustomFrame(frame: Uint8Array) {
    const requestId = readCustomRequestId(frame);
    const idx = customWaiters.findIndex((w) => w.requestId === requestId);
    if (idx >= 0) {
      const [waiter] = customWaiters.splice(idx, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    customFrames.push({ requestId, frame });
    if (customFrames.length > MAX_BUFFERED_CUSTOM_FRAMES) customFrames.shift();
  }

  function closeCustomFrames() {
    while (customWaiters.length > 0) {
      const waiter = customWaiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error("Custom RPC stream closed"));
    }
    customFrames.length = 0;
  }

  // Framing decode state
  const enum S { IDLE, DATA, ESC }
  let state = S.IDLE;
  let buf: number[] = [];

  function routeFrame(frame: Uint8Array) {
    const isCustom = isCustomResponse(frame);
    console.log(`[customRpc] frame arrived len=${frame.length} isCustom=${isCustom}`, frame.slice(0, 8));
    if (isCustom) {
      enqueueCustomFrame(frame);
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
      closeCustomFrames();
    }
  })();

  async function readCustomFrame(
    requestId: number,
    timeoutMs?: number,
  ): Promise<Uint8Array> {
    const bufferedIdx = customFrames.findIndex((f) => f.requestId === requestId);
    if (bufferedIdx >= 0) return customFrames.splice(bufferedIdx, 1)[0].frame;

    return new Promise((resolve, reject) => {
      const waiter = { requestId, resolve, reject } as {
        requestId: number;
        resolve: (frame: Uint8Array) => void;
        reject: (error: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
      };

      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const idx = customWaiters.indexOf(waiter);
          if (idx >= 0) customWaiters.splice(idx, 1);
          reject(new Error("Custom RPC timeout"));
        }, timeoutMs);
      }

      customWaiters.push(waiter);
    });
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

// Extract the request_id from a custom response frame (zmk.studio.Response).
// request_id is field 1 of the RequestResponse submessage (field 1, wire 2).
// Returns -1 when no request_id is present.
function readCustomRequestId(frame: Uint8Array): number {
  let pos = 0;
  while (pos < frame.length) {
    const [tag, p1] = readVarint(frame, pos);
    pos = p1;
    const wire = tag & 7;
    if (wire === 2) {
      const [len, p2] = readVarint(frame, pos);
      pos = p2;
      if ((tag >>> 3) === 1) {
        const inner = frame.subarray(pos, pos + len);
        let ipos = 0;
        while (ipos < inner.length) {
          const [itag, ip1] = readVarint(inner, ipos);
          ipos = ip1;
          const iwire = itag & 7;
          if ((itag >>> 3) === 1 && iwire === 0) {
            const [rid] = readVarint(inner, ipos);
            return rid;
          }
          if (iwire === 2) {
            const [ilen, ip2] = readVarint(inner, ipos);
            ipos = ip2 + ilen;
          } else if (iwire === 0) {
            const [, ip2] = readVarint(inner, ipos);
            ipos = ip2;
          } else break;
        }
      }
      pos += len;
    } else if (wire === 0) {
      const [, p2] = readVarint(frame, pos);
      pos = p2;
    } else break;
  }
  return -1;
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
