/** Byte helpers shared by every protocol. Pure Uint8Array; runs in browsers and Node. */
export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
export const ascii = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) { if (b === 0) break; s += String.fromCharCode(b); }
  return s;
};
export const latin1 = (bytes: Uint8Array): string => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };
export const fromAscii = (text: string, length = text.length): Uint8Array => {
  const out = new Uint8Array(length);
  for (let i = 0; i < Math.min(length, text.length); i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};
export const hex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (text: string): Uint8Array => {
  if (text.length % 2 || /[^\da-f]/i.test(text)) throw new Error('Invalid hex.');
  return Uint8Array.from(text.match(/../g) ?? [], pair => parseInt(pair, 16));
};
export const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
export const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** Round to float32, the precision MAVLink parameters and many device values really have. */
export const f32 = (value: number) => Math.fround(value);
export const round = (value: number, digits = 3) => { const k = 10 ** digits; return Math.round(value * k) / k; };

/** Sequential little-endian reader that never reads past the end. */
export class Reader {
  private at = 0;
  private readonly dv: DataView;
  constructor(private readonly bytes: Uint8Array) { this.dv = view(bytes); }
  get left() { return this.bytes.length - this.at; }
  private take(n: number) { if (this.left < n) throw new Error('Short payload.'); const at = this.at; this.at += n; return at; }
  u8() { return this.dv.getUint8(this.take(1)); }
  i8() { return this.dv.getInt8(this.take(1)); }
  u16() { return this.dv.getUint16(this.take(2), true); }
  i16() { return this.dv.getInt16(this.take(2), true); }
  u32() { return this.dv.getUint32(this.take(4), true); }
  i32() { return this.dv.getInt32(this.take(4), true); }
  f32() { return this.dv.getFloat32(this.take(4), true); }
  bytesOf(n: number) { const at = this.take(n); return this.bytes.subarray(at, at + n); }
  rest() { return this.bytesOf(this.left); }
  skip(n: number) { this.take(n); return this; }
}
/** Little-endian writer. */
export class Writer {
  private parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16(v: number) { this.parts.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number) { this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  i16(v: number) { return this.u16(v & 0xffff); }
  bytes(v: Uint8Array | number[]) { for (const b of v) this.parts.push(b & 0xff); return this; }
  done() { return Uint8Array.from(this.parts); }
}

/** A promise with its resolvers, plus a timeout that rejects with a plain-language message. */
export function deferred<T>(timeoutMs: number, onTimeout: string) {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  const timer = setTimeout(() => reject(new DeviceError('timeout', onTimeout)), timeoutMs);
  const clear = () => clearTimeout(timer);
  promise.then(clear, clear);
  return { promise, resolve, reject };
}

export type DeviceErrorCode =
  | 'timeout' | 'rejected' | 'unsupported' | 'blocked' | 'stale' | 'mismatch' | 'disconnected' | 'busy' | 'invalid' | 'not_approved';
/** Every device failure carries a code an assistant can act on and words a person can read. */
export class DeviceError extends Error {
  constructor(readonly code: DeviceErrorCode, message: string, readonly hint?: string) { super(message); this.name = 'DeviceError'; }
}
