/**
 * Betaflight / INAV / Cleanflight blackbox log decoder (.bbl / onboard flash).
 * Follows the reference parser in betaflight/blackbox-tools (src/parser.c, src/decoders.c): text headers, then
 * I (intra), P (inter), S (slow), G/H (GPS) and E (event) frames with variable-byte and tagged-group encodings.
 */
export interface FrameDef { names: string[]; signed: number[]; predictor: number[]; encoding: number[] }
export interface BlackboxLog {
  index: number;
  headers: Record<string, string>;
  fields: string[];
  /** Main frames, in order. One array per frame, values in field order. */
  frames: number[][];
  slow: { fields: string[]; frames: number[][] };
  events: { type: number; name: string; time?: number; data?: Record<string, number> }[];
  stats: { iFrames: number; pFrames: number; corrupt: number; bytes: number };
  /** Firmware and craft from the headers. */
  firmware?: string; craftName?: string;
}

const ENC = { SIGNED_VB: 0, UNSIGNED_VB: 1, NEG_14BIT: 3, TAG8_8SVB: 6, TAG2_3S32: 7, TAG8_4S16: 8, NULL: 9 } as const;
const PRED = { ZERO: 0, PREVIOUS: 1, STRAIGHT_LINE: 2, AVERAGE_2: 3, MINTHROTTLE: 4, MOTOR_0: 5, INC: 6, HOME_COORD: 7, P1500: 8, VBATREF: 9, LAST_MAIN_FRAME_TIME: 10, MINMOTOR: 11 } as const;
const EVENT_NAMES: Record<number, string> = { 0: 'sync beep', 13: 'in-flight adjustment', 14: 'logging resumed', 15: 'disarm', 30: 'flight mode', 255: 'log end' };
const MARKER = 'H Product:Blackbox flight data recorder by Nicholas Sherlock';

const signExtend = (value: number, bits: number) => { const shift = 32 - bits; return (value << shift) >> shift; };

class Stream {
  pos: number;
  constructor(readonly bytes: Uint8Array, start: number, public end: number) { this.pos = start; }
  get eof() { return this.pos >= this.end; }
  byte(): number { if (this.pos >= this.end) throw new RangeError('eof'); return this.bytes[this.pos++]; }
  unsignedVB(): number {
    let result = 0;
    for (let shift = 0, i = 0; i < 5; i++, shift += 7) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result >>> 0;
    }
    throw new RangeError('vb overflow');
  }
  signedVB(): number { const u = this.unsignedVB(); return (u >>> 1) ^ -(u & 1); }
  s8() { return signExtend(this.byte(), 8); }
  u16le() { return this.byte() | (this.byte() << 8); }
}

function tag2_3s32(s: Stream): number[] {
  let lead = s.byte();
  switch (lead >> 6) {
    case 0: return [signExtend((lead >> 4) & 3, 2), signExtend((lead >> 2) & 3, 2), signExtend(lead & 3, 2)];
    case 1: { const v0 = signExtend(lead & 0x0f, 4); const b = s.byte(); return [v0, signExtend(b >> 4, 4), signExtend(b & 0x0f, 4)]; }
    case 2: { const v0 = signExtend(lead & 0x3f, 6); const v1 = signExtend(s.byte() & 0x3f, 6); return [v0, v1, signExtend(s.byte() & 0x3f, 6)]; }
    default: {
      const out: number[] = [];
      for (let i = 0; i < 3; i++, lead >>= 2) {
        switch (lead & 3) {
          case 0: out.push(s.s8()); break;
          case 1: out.push(signExtend(s.u16le(), 16)); break;
          case 2: { const v = s.byte() | (s.byte() << 8) | (s.byte() << 16); out.push(signExtend(v, 24)); break; }
          default: out.push(s.byte() | (s.byte() << 8) | (s.byte() << 16) | (s.byte() << 24)); break;
        }
      }
      return out;
    }
  }
}
function tag8_4s16v2(s: Stream): number[] {
  let selector = s.byte(), buffer = 0, nibble = 0;
  const out: number[] = [];
  for (let i = 0; i < 4; i++, selector >>= 2) {
    switch (selector & 3) {
      case 0: out.push(0); break;
      case 1:
        if (nibble === 0) { buffer = s.byte(); out.push(signExtend(buffer >> 4, 4)); nibble = 1; }
        else { out.push(signExtend(buffer & 0x0f, 4)); nibble = 0; }
        break;
      case 2:
        if (nibble === 0) out.push(s.s8());
        else { const hi = (buffer << 4) & 0xff; buffer = s.byte(); out.push(signExtend(hi | (buffer >> 4), 8)); }
        break;
      default:
        if (nibble === 0) { const a = s.byte(), b = s.byte(); out.push(signExtend((a << 8) | b, 16)); }
        else { const a = s.byte(), b = s.byte(); out.push(signExtend(((buffer << 12) | (a << 4) | (b >> 4)) & 0xffff, 16)); buffer = b; }
        break;
    }
  }
  return out;
}
function tag8_4s16v1(s: Stream): number[] {
  let selector = s.byte();
  const out: number[] = [];
  for (let i = 0; i < 4; i++, selector >>= 2) {
    switch (selector & 3) {
      case 0: out.push(0); break;
      case 1: { const c = s.byte(); out.push(signExtend(c & 0x0f, 4)); i++; selector >>= 2; out.push(signExtend(c >> 4, 4)); break; }
      case 2: out.push(s.s8()); break;
      default: out.push(signExtend(s.u16le(), 16)); break;
    }
  }
  return out;
}
function tag8_8svb(s: Stream, count: number): number[] {
  if (count === 1) return [s.signedVB()];
  let header = s.byte();
  const out: number[] = [];
  for (let i = 0; i < 8; i++, header >>= 1) out.push(header & 1 ? s.signedVB() : 0);
  return out;
}

interface Ctx { minthrottle: number; vbatref: number; motorLow: number; motor0: number; dataVersion: number; lastMainTime: number }
function predict(p: number, value: number, i: number, cur: number[], prev: number[] | undefined, prev2: number[] | undefined, ctx: Ctx): number {
  switch (p) {
    case PRED.ZERO: return value;
    case PRED.PREVIOUS: return prev ? value + prev[i] : value;
    case PRED.STRAIGHT_LINE: return prev ? value + 2 * prev[i] - (prev2 ?? prev)[i] : value;
    case PRED.AVERAGE_2: return prev ? value + Math.trunc((prev[i] + (prev2 ?? prev)[i]) / 2) : value;
    case PRED.MINTHROTTLE: return value + ctx.minthrottle;
    case PRED.MOTOR_0: return value + (ctx.motor0 >= 0 ? cur[ctx.motor0] : 0);
    case PRED.P1500: return value + 1500;
    case PRED.VBATREF: return value + ctx.vbatref;
    case PRED.LAST_MAIN_FRAME_TIME: return value + ctx.lastMainTime;
    case PRED.MINMOTOR: return value + ctx.motorLow;
    case PRED.HOME_COORD: return value;
    default: throw new Error(`unsupported predictor ${p}`);
  }
}
function parseFrame(s: Stream, def: FrameDef, prev: number[] | undefined, prev2: number[] | undefined, skipped: number, ctx: Ctx): number[] {
  const n = def.names.length, frame = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    if (def.predictor[i] === PRED.INC) { frame[i] = skipped + 1 + (prev ? prev[i] : 0); i++; continue; }
    const enc = def.encoding[i];
    let values: number[] | undefined;
    if (enc === ENC.TAG8_4S16) values = ctx.dataVersion < 2 ? tag8_4s16v1(s) : tag8_4s16v2(s);
    else if (enc === ENC.TAG2_3S32) values = tag2_3s32(s);
    else if (enc === ENC.TAG8_8SVB) {
      let j = i + 1;
      while (j < i + 8 && j < n && def.encoding[j] === ENC.TAG8_8SVB) j++;
      values = tag8_8svb(s, j - i).slice(0, j - i);
    }
    if (values) { for (const v of values) { if (i >= n) break; frame[i] = predict(def.predictor[i], v, i, frame, prev, prev2, ctx); i++; } continue; }
    let value: number;
    switch (enc) {
      case ENC.SIGNED_VB: value = s.signedVB(); break;
      case ENC.UNSIGNED_VB: value = s.unsignedVB(); break;
      case ENC.NEG_14BIT: value = -signExtend(s.unsignedVB(), 14); break;
      case ENC.NULL: value = 0; break;
      default: throw new Error(`unsupported encoding ${enc}`);
    }
    value = predict(def.predictor[i], value, i, frame, prev, prev2, ctx);
    frame[i] = def.signed[i] ? value | 0 : value >>> 0;
    i++;
  }
  return frame;
}

const list = (v: string | undefined) => (v ?? '').split(',').map(x => x.trim()).filter(x => x !== '');
const nums = (v: string | undefined) => list(v).map(Number);

/** Byte offsets where a log starts. A flash dump or file may hold several. */
export function findLogs(bytes: Uint8Array): number[] {
  const needle = new TextEncoder().encode(MARKER), starts: number[] = [];
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    if (bytes[i] !== 0x48) continue;
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    starts.push(i);
  }
  return starts;
}
export const isBlackbox = (bytes: Uint8Array) => findLogs(bytes.subarray(0, Math.min(bytes.length, 4096))).length > 0;

export function decodeLog(bytes: Uint8Array, start: number, end: number, index = 0): BlackboxLog {
  const s = new Stream(bytes, start, end);
  const headers: Record<string, string> = {};
  // Headers are lines beginning "H ". Binary data starts at the first byte that is not 'H' at a line start.
  while (!s.eof && bytes[s.pos] === 0x48 && bytes[s.pos + 1] === 0x20) {
    let lineEnd = s.pos;
    while (lineEnd < end && bytes[lineEnd] !== 0x0a) lineEnd++;
    const line = new TextDecoder('latin1').decode(bytes.subarray(s.pos + 2, lineEnd));
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon)] = line.slice(colon + 1);
    s.pos = lineEnd + 1;
  }
  const def = (t: string): FrameDef | undefined => {
    const names = list(headers[`Field ${t} name`]);
    if (!names.length) return undefined;
    const source = t === 'P' ? 'I' : t;
    return { names: t === 'P' ? list(headers['Field I name']) : names, signed: nums(headers[`Field ${source} signed`]), predictor: nums(headers[`Field ${t} predictor`]), encoding: nums(headers[`Field ${t} encoding`]) };
  };
  const I = def('I'), P = headers['Field P predictor'] ? { ...def('I')!, predictor: nums(headers['Field P predictor']), encoding: nums(headers['Field P encoding']) } : undefined;
  const S = def('S');
  if (!I) throw new Error('This blackbox log has no frame definitions.');
  const motorOutput = nums(headers.motorOutput);
  const ctx: Ctx = {
    minthrottle: Number(headers.minthrottle ?? 1150), vbatref: Number(headers.vbatref ?? 0), motorLow: motorOutput[0] ?? Number(headers.minthrottle ?? 1150),
    motor0: I.names.indexOf('motor[0]'), dataVersion: Number(headers['Data version'] ?? 2), lastMainTime: 0,
  };
  const intervalI = Math.max(1, Number(headers['I interval'] ?? 32));
  const [pNum, pDenom] = (headers['P interval'] ?? '1/1').split('/').map(Number);
  const shouldHave = (index: number) => ((index % intervalI) + (pNum || 1) - 1) % (pDenom || 1) < (pNum || 1);
  const log: BlackboxLog = { index, headers, fields: I.names, frames: [], slow: { fields: S?.names ?? [], frames: [] }, events: [], stats: { iFrames: 0, pFrames: 0, corrupt: 0, bytes: end - start },
    firmware: headers['Firmware revision'], craftName: headers['Craft name'] };
  let prev: number[] | undefined, prev2: number[] | undefined, lastSlow: number[] | undefined;
  const iteration = I.names.indexOf('loopIteration'), time = I.names.indexOf('time');
  const valid = (b: number | undefined) => b === undefined || b === 0x49 || b === 0x50 || b === 0x45 || b === 0x53 || b === 0x47 || b === 0x48;
  // The last frame known to be good. A frame whose counter or clock jumps implausibly from it is garbage that
  // happened to look like a frame, so it is rejected and the search for the next real frame continues.
  let good: { iteration: number; time: number } | undefined;
  const plausible = (frame: number[]) => {
    if (!good || iteration < 0 || time < 0) return true;
    const di = frame[iteration] - good.iteration, dt = frame[time] - good.time;
    return di > 0 && di < intervalI * 4096 && dt > 0 && dt < 30_000_000;
  };
  const accept = (frame: number[]) => { if (iteration >= 0 && time >= 0) good = { iteration: frame[iteration], time: frame[time] }; };
  while (!s.eof) {
    const frameStart = s.pos, marker = s.byte();
    try {
      if (marker === 0x49) {
        const frame = parseFrame(s, I, prev, prev2, 0, ctx);
        if (!valid(bytes[s.pos]) && s.pos < end) throw new Error('bad frame end');
        if (!plausible(frame)) throw new Error('implausible frame');
        accept(frame);
        prev2 = frame; prev = frame; log.frames.push(frame); log.stats.iFrames++;
        if (time >= 0) ctx.lastMainTime = frame[time];
      } else if (marker === 0x50 && P) {
        if (!prev) throw new Error('P frame without I frame');
        let skipped = 0;
        if (iteration >= 0) for (let k = prev[iteration] + 1; !shouldHave(k) && skipped < intervalI; k++) skipped++;
        const frame = parseFrame(s, P, prev, prev2, skipped, ctx);
        if (!valid(bytes[s.pos]) && s.pos < end) throw new Error('bad frame end');
        if (!plausible(frame)) throw new Error('implausible frame');
        accept(frame);
        prev2 = prev; prev = frame; log.frames.push(frame); log.stats.pFrames++;
        if (time >= 0) ctx.lastMainTime = frame[time];
      } else if (marker === 0x53 && S) {
        lastSlow = parseFrame(s, S, undefined, undefined, 0, ctx);
        log.slow.frames.push(lastSlow);
      } else if (marker === 0x45) {
        const type = s.byte();
        const event: BlackboxLog['events'][number] = { type, name: EVENT_NAMES[type] ?? `event ${type}`, time: prev && time >= 0 ? prev[time] : undefined };
        if (type === 0) event.data = { time: s.unsignedVB() };
        else if (type === 13) { const fn = s.byte(); event.data = { function: fn, value: fn > 127 ? (s.byte(), s.byte(), s.byte(), s.byte(), 0) : s.signedVB() }; }
        else if (type === 14) event.data = { iteration: s.unsignedVB(), time: s.unsignedVB() };
        else if (type === 15) event.data = { reason: s.unsignedVB() };
        else if (type === 30) event.data = { flags: s.unsignedVB(), lastFlags: s.unsignedVB() };
        else if (type === 255) {
          // Real only if the end message follows; otherwise these were ordinary bytes that looked like an event.
          const text = new TextDecoder('latin1').decode(bytes.subarray(s.pos, s.pos + 11));
          if (text !== 'End of log\0') throw new Error('false end marker');
          s.pos += 11; log.events.push(event); break;
        }
        else throw new Error('unknown event');
        log.events.push(event);
      } else if (marker === 0x47 || marker === 0x48) {
        // GPS frames: skip by decoding against their definitions when present.
        const g = def(marker === 0x47 ? 'G' : 'H');
        if (!g) throw new Error('GPS frame without definition');
        parseFrame(s, g, undefined, undefined, 0, ctx);
      } else throw new Error('unknown marker');
    } catch {
      // Corrupt or truncated frame: resynchronise on the next byte, as the reference parser does.
      log.stats.corrupt++;
      s.pos = frameStart + 1;
      prev = undefined; prev2 = undefined;
    }
  }
  return log;
}
/** Every log in a file or flash dump. */
export function decodeAll(bytes: Uint8Array): BlackboxLog[] {
  const starts = findLogs(bytes);
  return starts.map((start, i) => decodeLog(bytes, start, starts[i + 1] ?? bytes.length, i + 1)).filter(l => l.frames.length > 0);
}
