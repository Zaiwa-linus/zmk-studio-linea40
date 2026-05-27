import type { CustomRpcChannel } from "./customRpcChannel";

/**
 * Manual protobuf encode/decode for the cormoran.rip custom subsystem.
 * Does not depend on generated code — uses raw varint encoding.
 *
 * Field numbers (from proto files):
 *   zmk.studio.Request: request_id=1, custom=100
 *   zmk.custom.Request: list_custom_subsystems=1, call=2
 *   zmk.custom.CallRequest: subsystem_index=1, payload=2
 *   zmk.custom.ListCustomSubsystemResponse.subsystems=1
 *   zmk.custom.CustomSubsystemInfo: index=1, identifier=2
 *   zmk.custom.CallResponse: subsystem_index=1, payload=2
 *   cormoran.rip.Request: list_input_processors=1, get_input_processor=2
 *   cormoran.rip.GetInputProcessorRequest: id=1
 *   cormoran.rip.Response: error=1, list_input_processors=2, get_input_processor=3
 *   cormoran.rip.GetInputProcessorResponse: processor=1
 *   cormoran.rip.InputProcessorInfo: id=1, name=2, scale_multiplier=3, scale_divisor=4
 *   cormoran.rip.Request.get_current_cpi=20
 *   cormoran.rip.Response.get_current_cpi=21
 *   cormoran.rip.GetCurrentCpiResponse.cpi=1
 */

import { readVarint } from "./customRpcChannel";

export interface InputProcessorInfo {
  id: number;
  name: string;
  scaleMultiplier: number;
  scaleDivisor: number;
}

export interface CustomSubsystemInfo {
  index: number;
  identifier: string;
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

function varint(value: number): number[] {
  const bytes: number[] = [];
  value = value >>> 0;
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return bytes;
}

function fieldVarint(fieldNum: number, value: number): number[] {
  if (value === 0) return [];
  return [...varint((fieldNum << 3) | 0), ...varint(value)];
}

function fieldBytes(fieldNum: number, data: number[] | Uint8Array): number[] {
  const tag = [...varint((fieldNum << 3) | 2)];
  const len = [...varint(data.length)];
  return [...tag, ...len, ...data];
}

function concat(...parts: number[][]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ── Request encoders ──────────────────────────────────────────────────────────

/** zmk.studio.Request wrapping a zmk.custom.Request payload */
function wrapStudioRequest(requestId: number, customPayload: number[]): Uint8Array {
  // field 1 (request_id) varint + field 100 (custom) bytes
  return concat(
    fieldVarint(1, requestId),
    fieldBytes(100, customPayload),
  );
}

export function encodeListSubsystemsRequest(requestId: number): Uint8Array {
  // zmk.custom.Request { list_custom_subsystems: {} } = field 1 wire2, length 0
  const customReq = fieldBytes(1, []);
  return wrapStudioRequest(requestId, customReq);
}

export function encodeGetInputProcessorRequest(
  requestId: number,
  subsystemIndex: number,
  processorId: number,
): Uint8Array {
  // cormoran.rip.Request { get_input_processor: { id: processorId } }
  const ripInner = fieldVarint(1, processorId); // GetInputProcessorRequest.id
  const ripReq = fieldBytes(2, ripInner);        // cormoran.rip.Request.get_input_processor

  // zmk.custom.CallRequest { subsystem_index, payload: ripReq }
  const callReq = [
    ...fieldVarint(1, subsystemIndex),
    ...fieldBytes(2, ripReq),
  ];

  // zmk.custom.Request { call: callReq }
  const customReq = fieldBytes(2, callReq);

  return wrapStudioRequest(requestId, customReq);
}

export function encodeGetCurrentCpiRequest(
  requestId: number,
  subsystemIndex: number,
): Uint8Array {
  // cormoran.rip.Request { get_current_cpi: {} }
  const ripReq = fieldBytes(20, []);

  // zmk.custom.CallRequest { subsystem_index, payload: ripReq }
  const callReq = [
    ...fieldVarint(1, subsystemIndex),
    ...fieldBytes(2, ripReq),
  ];

  // zmk.custom.Request { call: callReq }
  const customReq = fieldBytes(2, callReq);

  return wrapStudioRequest(requestId, customReq);
}

// ── Decoding helpers ──────────────────────────────────────────────────────────

function decodeString(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

/** Walk a protobuf message and collect field values keyed by field number. */
function walkFields(
  data: Uint8Array,
  cb: (field: number, wire: number, value: number | Uint8Array) => void,
) {
  let pos = 0;
  while (pos < data.length) {
    const [tag, p1] = readVarint(data, pos);
    pos = p1;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [val, p2] = readVarint(data, pos);
      pos = p2;
      cb(field, 0, val);
    } else if (wire === 2) {
      const [len, p2] = readVarint(data, pos);
      pos = p2;
      const bytes = data.subarray(pos, pos + len);
      pos += len;
      cb(field, 2, bytes);
    } else {
      break; // unsupported wire type
    }
  }
}

// ── Response decoders ─────────────────────────────────────────────────────────

/**
 * Decode a raw frame (zmk.studio.Response bytes) as a ListCustomSubsystems response.
 * Returns null if the frame is not a matching custom response.
 */
export function decodeListSubsystemsResponse(
  frame: Uint8Array,
): { requestId: number; subsystems: CustomSubsystemInfo[] } | null {
  let requestResponseBytes: Uint8Array | null = null;

  walkFields(frame, (f, w, v) => {
    if (f === 1 && w === 2) requestResponseBytes = v as Uint8Array;
  });
  if (!requestResponseBytes) return null;

  let requestId = 0;
  let customBytes: Uint8Array | null = null;

  walkFields(requestResponseBytes, (f, w, v) => {
    if (f === 1 && w === 0) requestId = v as number;
    if (f === 100 && w === 2) customBytes = v as Uint8Array;
  });
  if (!customBytes) return null;

  // zmk.custom.Response.list_custom_subsystems = field 1
  let listBytes: Uint8Array | null = null;
  walkFields(customBytes, (f, w, v) => {
    if (f === 1 && w === 2) listBytes = v as Uint8Array;
  });
  if (!listBytes) return null;

  // repeated CustomSubsystemInfo subsystems = field 1
  const subsystems: CustomSubsystemInfo[] = [];
  walkFields(listBytes, (f, w, v) => {
    if (f === 1 && w === 2) {
      let index = 0;
      let identifier = "";
      walkFields(v as Uint8Array, (sf, sw, sv) => {
        if (sf === 1 && sw === 0) index = sv as number;
        if (sf === 2 && sw === 2) identifier = decodeString(sv as Uint8Array);
      });
      subsystems.push({ index, identifier });
    }
  });

  return { requestId, subsystems };
}

/**
 * Decode a raw frame as a GetInputProcessor response.
 * Returns null if not a matching custom response.
 */
export function decodeGetInputProcessorResponse(
  frame: Uint8Array,
): { requestId: number; processor: InputProcessorInfo } | null {
  let requestResponseBytes: Uint8Array | null = null;

  walkFields(frame, (f, w, v) => {
    if (f === 1 && w === 2) requestResponseBytes = v as Uint8Array;
  });
  if (!requestResponseBytes) return null;

  let requestId = 0;
  let customBytes: Uint8Array | null = null;

  walkFields(requestResponseBytes, (f, w, v) => {
    if (f === 1 && w === 0) requestId = v as number;
    if (f === 100 && w === 2) customBytes = v as Uint8Array;
  });
  if (!customBytes) return null;

  // zmk.custom.Response.call = field 2
  let callResponseBytes: Uint8Array | null = null;
  walkFields(customBytes, (f, w, v) => {
    if (f === 2 && w === 2) callResponseBytes = v as Uint8Array;
  });
  if (!callResponseBytes) return null;

  // zmk.custom.CallResponse.payload = field 2
  let ripPayload: Uint8Array | null = null;
  walkFields(callResponseBytes, (f, w, v) => {
    if (f === 2 && w === 2) ripPayload = v as Uint8Array;
  });
  if (!ripPayload) return null;

  // cormoran.rip.Response.get_input_processor = field 3
  let getRespBytes: Uint8Array | null = null;
  walkFields(ripPayload, (f, w, v) => {
    if (f === 3 && w === 2) getRespBytes = v as Uint8Array;
  });
  if (!getRespBytes) return null;

  // cormoran.rip.GetInputProcessorResponse.processor = field 1
  // nanopb proto3 omits the submessage when all fields are default (zero/""/false),
  // so processorBytes may be null even on a successful response.
  let processorBytes: Uint8Array | null = null;
  walkFields(getRespBytes, (f, w, v) => {
    if (f === 1 && w === 2) processorBytes = v as Uint8Array;
  });

  let id = 0, name = "", scaleMultiplier = 1, scaleDivisor = 1;
  if (processorBytes) {
    walkFields(processorBytes, (f, w, v) => {
      if (f === 1 && w === 0) id = v as number;
      if (f === 2 && w === 2) name = decodeString(v as Uint8Array);
      if (f === 3 && w === 0) scaleMultiplier = v as number;
      if (f === 4 && w === 0) scaleDivisor = v as number;
    });
  }

  if (scaleMultiplier === 0) scaleMultiplier = 1;
  if (scaleDivisor === 0) scaleDivisor = 1;

  return { requestId, processor: { id, name, scaleMultiplier, scaleDivisor } };
}

/**
 * Decode a raw frame as a GetCurrentCpi response.
 * Returns null if not a matching custom response.
 */
export function decodeGetCurrentCpiResponse(
  frame: Uint8Array,
): { requestId: number; cpi: number } | null {
  let requestResponseBytes: Uint8Array | null = null;

  walkFields(frame, (f, w, v) => {
    if (f === 1 && w === 2) requestResponseBytes = v as Uint8Array;
  });
  if (!requestResponseBytes) return null;

  let requestId = 0;
  let customBytes: Uint8Array | null = null;

  walkFields(requestResponseBytes, (f, w, v) => {
    if (f === 1 && w === 0) requestId = v as number;
    if (f === 100 && w === 2) customBytes = v as Uint8Array;
  });
  if (!customBytes) return null;

  // zmk.custom.Response.call = field 2
  let callResponseBytes: Uint8Array | null = null;
  walkFields(customBytes, (f, w, v) => {
    if (f === 2 && w === 2) callResponseBytes = v as Uint8Array;
  });
  if (!callResponseBytes) return null;

  // zmk.custom.CallResponse.payload = field 2
  let ripPayload: Uint8Array | null = null;
  walkFields(callResponseBytes, (f, w, v) => {
    if (f === 2 && w === 2) ripPayload = v as Uint8Array;
  });
  if (!ripPayload) return null;

  // cormoran.rip.Response.get_current_cpi = field 21
  let getRespBytes: Uint8Array | null = null;
  walkFields(ripPayload, (f, w, v) => {
    if (f === 21 && w === 2) getRespBytes = v as Uint8Array;
  });
  if (!getRespBytes) return null;

  let cpi = 0;
  walkFields(getRespBytes, (f, w, v) => {
    if (f === 1 && w === 0) cpi = v as number;
  });

  return { requestId, cpi };
}

// ── High-level call helpers ───────────────────────────────────────────────────

const CORMORAN_RIP_IDENTIFIER = "cormoran_rip";
const CUSTOM_RPC_TIMEOUT_MS = 10000;

let nextCustomRequestId = 0x1000;
function nextReqId() { return nextCustomRequestId++; }

function readWithTimeout(channel: CustomRpcChannel): Promise<Uint8Array> {
  return Promise.race([
    channel.readCustomFrame(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Custom RPC timeout")), CUSTOM_RPC_TIMEOUT_MS),
    ),
  ]);
}

/**
 * Discover the cormoran_rip subsystem index via ListCustomSubsystems.
 * Returns null if the subsystem is not present on the device.
 * Uses the custom queue so it does not block standard RPC calls.
 */
export function findCormoranRipIndex(
  channel: CustomRpcChannel,
): Promise<number | null> {
  return channel.queueCustom(async () => {
    const reqId = nextReqId();
    console.log(`[ripRpc] sending ListSubsystems reqId=${reqId}`);
    await channel.writeCustomFrame(encodeListSubsystemsRequest(reqId));
    console.log(`[ripRpc] ListSubsystems frame sent, waiting for response...`);

    for (let attempt = 0; attempt < 4; attempt++) {
      const frame = await readWithTimeout(channel);
      console.log(`[ripRpc] ListSubsystems attempt=${attempt} frame len=${frame.length}`);
      const resp = decodeListSubsystemsResponse(frame);
      console.log(`[ripRpc] ListSubsystems decoded:`, resp);
      if (resp && resp.requestId === reqId) {
        const found = resp.subsystems.find(
          (s) => s.identifier === CORMORAN_RIP_IDENTIFIER,
        );
        return found?.index ?? null;
      }
    }
    return null;
  });
}

/**
 * Fetch InputProcessorInfo for the given processor id.
 * Uses the custom queue so it does not block standard RPC calls.
 */
export function getInputProcessor(
  channel: CustomRpcChannel,
  subsystemIndex: number,
  processorId: number,
): Promise<InputProcessorInfo | null> {
  return channel.queueCustom(async () => {
    const reqId = nextReqId();
    const encoded = encodeGetInputProcessorRequest(reqId, subsystemIndex, processorId);
    console.log(`[ripRpc] sending GetInputProcessor reqId=${reqId} subsystemIndex=${subsystemIndex} processorId=${processorId} encoded=`, encoded);
    await channel.writeCustomFrame(encoded);
    console.log(`[ripRpc] GetInputProcessor frame sent, waiting...`);

    for (let attempt = 0; attempt < 4; attempt++) {
      const frame = await readWithTimeout(channel);
      console.log(`[ripRpc] GetInputProcessor attempt=${attempt} frame len=${frame.length}`, frame.slice(0, 16));
      const resp = decodeGetInputProcessorResponse(frame);
      console.log(`[ripRpc] GetInputProcessor decoded:`, resp);
      if (resp && resp.requestId === reqId) {
        return resp.processor;
      }
    }
    return null;
  });
}

/**
 * Fetch the current PMW3610 CPI value from the cormoran_rip custom subsystem.
 */
export function getCurrentCpi(
  channel: CustomRpcChannel,
  subsystemIndex: number,
): Promise<number | null> {
  return channel.queueCustom(async () => {
    const reqId = nextReqId();
    const encoded = encodeGetCurrentCpiRequest(reqId, subsystemIndex);
    console.log(`[ripRpc] sending GetCurrentCpi reqId=${reqId} subsystemIndex=${subsystemIndex} encoded=`, encoded);
    await channel.writeCustomFrame(encoded);
    console.log(`[ripRpc] GetCurrentCpi frame sent, waiting...`);

    for (let attempt = 0; attempt < 4; attempt++) {
      const frame = await readWithTimeout(channel);
      console.log(`[ripRpc] GetCurrentCpi attempt=${attempt} frame len=${frame.length}`, frame.slice(0, 16));
      const resp = decodeGetCurrentCpiResponse(frame);
      console.log(`[ripRpc] GetCurrentCpi decoded:`, resp);
      if (resp && resp.requestId === reqId) {
        return resp.cpi;
      }
    }
    return null;
  });
}
