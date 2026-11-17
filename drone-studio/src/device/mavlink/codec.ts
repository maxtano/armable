import { concat, view } from '../bytes';
import { MESSAGES, type MessageDef, type MessageName } from './messages';

/** MAVLink 1 and 2 framing, CRC, and field packing over DataView. No Node dependencies. */
export type Fields = Record<string, number | bigint | string | number[]>;
export interface Packet { name: MessageName; sysid: number; compid: number; seq: number; fields: Fields; signed: boolean }

const BY_ID = new Map<number, [MessageName, MessageDef]>(
  (Object.entries(MESSAGES) as [MessageName, MessageDef][]).map(([name, def]) => [def.id, [name, def]]),
);
const SIZE: Record<string, number> = { uint8: 1, int8: 1, char: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float: 4, uint64: 8, int64: 8, double: 8 };

export function x25(bytes: Uint8Array, crc = 0xffff): number {
  for (const b of bytes) {
    let tmp = b ^ (crc & 0xff);
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  }
  return crc;
}

function get(dv: DataView, type: string, at: number): number | bigint {
  switch (type) {
    case 'uint8': case 'char': return dv.getUint8(at);
    case 'int8': return dv.getInt8(at);
    case 'uint16': return dv.getUint16(at, true);
    case 'int16': return dv.getInt16(at, true);
    case 'uint32': return dv.getUint32(at, true);
    case 'int32': return dv.getInt32(at, true);
    case 'float': return dv.getFloat32(at, true);
    case 'double': return dv.getFloat64(at, true);
    case 'uint64': return dv.getBigUint64(at, true);
    case 'int64': return dv.getBigInt64(at, true);
    default: throw new Error(`Unknown MAVLink type ${type}`);
  }
}
function put(dv: DataView, type: string, at: number, value: number | bigint) {
  switch (type) {
    case 'uint8': case 'char': dv.setUint8(at, Number(value)); break;
    case 'int8': dv.setInt8(at, Number(value)); break;
    case 'uint16': dv.setUint16(at, Number(value), true); break;
    case 'int16': dv.setInt16(at, Number(value), true); break;
    case 'uint32': dv.setUint32(at, Number(value), true); break;
    case 'int32': dv.setInt32(at, Number(value), true); break;
    case 'float': dv.setFloat32(at, Number(value), true); break;
    case 'double': dv.setFloat64(at, Number(value), true); break;
    case 'uint64': dv.setBigUint64(at, BigInt(value), true); break;
    case 'int64': dv.setBigInt64(at, BigInt(value), true); break;
    default: throw new Error(`Unknown MAVLink type ${type}`);
  }
}

export function decodePayload(def: MessageDef, payload: Uint8Array): Fields {
  // MAVLink 2 trims trailing zero bytes; restore them before reading.
  const full = new Uint8Array(def.len);
  full.set(payload.subarray(0, def.len));
  const dv = view(full), out: Fields = {};
  for (const [name, type, offset, array] of def.fields) {
    if (!array) out[name] = get(dv, type, offset);
    else if (type === 'char') {
      let s = '';
      for (let i = 0; i < array; i++) { const c = full[offset + i]; if (!c) break; s += String.fromCharCode(c); }
      out[name] = s;
    } else out[name] = Array.from({ length: array }, (_, i) => Number(get(dv, type, offset + i * SIZE[type])));
  }
  return out;
}
export function encodePayload(def: MessageDef, fields: Fields): Uint8Array {
  const full = new Uint8Array(def.len), dv = view(full);
  for (const [name, type, offset, array] of def.fields) {
    const value = fields[name];
    if (value === undefined) continue;
    if (!array) put(dv, type, offset, value as number | bigint);
    else if (type === 'char') { const s = String(value); for (let i = 0; i < Math.min(array, s.length); i++) full[offset + i] = s.charCodeAt(i) & 0xff; }
    else (value as number[]).slice(0, array).forEach((v, i) => put(dv, type, offset + i * SIZE[type], v));
  }
  return full;
}

/** Build a MAVLink 2 frame. */
export function encode(name: MessageName, fields: Fields, seq: number, sysid = 255, compid = 190): Uint8Array {
  const def: MessageDef = MESSAGES[name];
  let payload = encodePayload(def, fields);
  let end = payload.length;
  while (end > 1 && payload[end - 1] === 0) end--;
  payload = payload.subarray(0, end);
  const head = Uint8Array.of(0xfd, payload.length, 0, 0, seq & 0xff, sysid, compid, def.id & 0xff, (def.id >> 8) & 0xff, (def.id >> 16) & 0xff);
  const crc = x25(Uint8Array.of(def.crc), x25(concat(head.subarray(1), payload)));
  return concat(head, payload, Uint8Array.of(crc & 0xff, crc >> 8));
}

type Attempt = { kind: 'packet'; total: number; packet: Packet } | { kind: 'skip'; total: number } | { kind: 'incomplete' } | { kind: 'invalid' };

/** Try to read one frame at the start of `b`. */
function attempt(b: Uint8Array): Attempt {
  if (b.length < 8) return { kind: 'incomplete' };
  const v2 = b[0] === 0xfd, len = b[1];
  if (v2 && (b[2] & ~1) !== 0) return { kind: 'invalid' };
  const headLen = v2 ? 10 : 6;
  const signed = v2 && (b[2] & 1) === 1;
  const total = headLen + len + 2 + (signed ? 13 : 0);
  if (b.length < total) return { kind: 'incomplete' };
  const id = v2 ? b[7] | (b[8] << 8) | (b[9] << 16) : b[5];
  const known = BY_ID.get(id);
  if (!known) {
    // The CRC cannot be checked without the definition. Accept the frame only if another frame, or nothing, follows it.
    const next = b[total];
    return next === undefined || next === 0xfd || next === 0xfe ? { kind: 'skip', total } : { kind: 'invalid' };
  }
  const [name, def] = known;
  const crc = x25(Uint8Array.of(def.crc), x25(b.subarray(1, headLen + len)));
  if (crc !== (b[headLen + len] | (b[headLen + len + 1] << 8))) return { kind: 'invalid' };
  return {
    kind: 'packet', total,
    packet: { name, signed, seq: v2 ? b[4] : b[2], sysid: v2 ? b[5] : b[3], compid: v2 ? b[6] : b[4], fields: decodePayload(def, b.subarray(headLen, headLen + len)) },
  };
}

/** Incremental parser. Feed it bytes as they arrive; it returns complete, CRC-checked packets. */
export class MavlinkParser {
  private buffer: Uint8Array = new Uint8Array(0);
  /** Bytes that were not part of any valid frame, for protocol auto-detection. */
  junk = 0;
  /** Frames with an unknown message id (plausible framing, no definition). */
  unknown = 0;
  push(chunk: Uint8Array): Packet[] {
    let b = this.buffer.length ? concat(this.buffer, chunk) : chunk;
    if (b.length > 1 << 16) b = b.subarray(-4096);
    const out: Packet[] = [];
    for (;;) {
      let start = 0;
      while (start < b.length && b[start] !== 0xfd && b[start] !== 0xfe) start++;
      this.junk += start;
      b = b.subarray(start);
      if (!b.length) break;
      const result = attempt(b);
      if (result.kind === 'packet') { out.push(result.packet); b = b.subarray(result.total); continue; }
      if (result.kind === 'skip') { this.unknown++; b = b.subarray(result.total); continue; }
      if (result.kind === 'invalid') { this.junk++; b = b.subarray(1); continue; }
      // Incomplete. A false start with a long length byte must not hold back real frames behind it:
      // if a complete, valid frame begins later in the buffer, drop everything before it.
      let rescued = false;
      for (let i = 1; i < b.length; i++) {
        if (b[i] !== 0xfd && b[i] !== 0xfe) continue;
        const later = attempt(b.subarray(i));
        if (later.kind === 'packet') { this.junk += i; b = b.subarray(i); rescued = true; break; }
      }
      if (!rescued) break;
    }
    this.buffer = Uint8Array.from(b);
    return out;
  }
}
