import { ascii, concat, deferred, DeviceError, equal, hex, sleep } from '../bytes';
import { encodeMsp } from '../msp/codec';
import type { EscInfo, Setting } from '../types';

/**
 * BLHeli four-way interface, through the flight controller's ESC passthrough.
 * Ported from the bench-tested src/aircraft/esc-protocol.ts and esc-startup.ts so it runs in a browser.
 * Wire formats: ArduPilot AP_BLHeli, Betaflight serial_4way, and ESC Configurator's layouts. See docs/ESC_READER.md.
 *
 * Writes are bounded to the application and settings area of EFM8 BB1/BB2 ESCs. The bootloader is never written.
 */
export function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
const CMD = { exit: 0x34, reset: 0x35, init: 0x37, erasePage: 0x39, read: 0x3a, write: 0x3b } as const;
export class EscAckError extends DeviceError {
  constructor(command: number, ack: number) { super('rejected', `The ESC rejected command 0x${command.toString(16)} (code 0x${ack.toString(16)}).`, 'Check that the flight battery is connected and the ESC signal wires are sound.'); }
}
export interface EscIo { write(bytes: Uint8Array): Promise<void>; onData(listener: (bytes: Uint8Array) => void): () => void }
export interface EscTiming { responseMs: number; settleMs: number; retryMs: number }
export const ESC_TIMING: EscTiming = { responseMs: 4000, settleMs: 1200, retryMs: 250 };

/** EFM8 BB1/BB2 memory map shared by BLHeli_S and Bluejay. */
export const BB2 = { size: 0x2000, page: 512, settings: 0x1a00, settingsPage: 13, bootloader: 0x1c00 } as const;

export class FourWay {
  private buffer = new Uint8Array(0);
  private pending?: { protocol: 'msp' | 'four'; command: number; address: number; finish: (error?: Error, payload?: Uint8Array) => void };
  private off: () => void;
  /** Set true only inside an approved write session. */
  allowWrites = false;
  constructor(private io: EscIo, readonly timing: EscTiming = ESC_TIMING) { this.off = io.onData(chunk => this.push(chunk)); }
  dispose() { this.off(); this.pending?.finish(new DeviceError('disconnected', 'ESC session ended.')); }

  private push(chunk: Uint8Array) {
    if (!this.pending) return;
    this.buffer = concat(this.buffer, chunk);
    if (this.buffer.length > 8192) this.buffer = this.buffer.subarray(-8192);
    const p = this.pending;
    while (this.buffer.length && this.pending === p) {
      const b = this.buffer;
      if (p.protocol === 'msp') {
        if (b[0] !== 0x24) { this.buffer = b.subarray(1); continue; }
        if (b.length < 3) return;
        if (b[1] !== 0x4d || (b[2] !== 0x3e && b[2] !== 0x21)) { this.buffer = b.subarray(1); continue; }
        if (b.length < 6) return;
        const size = b[3], total = size + 6;
        if (b.length < total) return;
        let checksum = 0;
        for (let i = 3; i < total - 1; i++) checksum ^= b[i];
        if (checksum !== b[total - 1]) { this.buffer = b.subarray(1); continue; }
        this.buffer = b.subarray(total);
        if (b[4] !== p.command) continue;
        p.finish(b[2] === 0x21 ? new DeviceError('rejected', 'The flight controller refused ESC passthrough.') : undefined, b.subarray(5, total - 1));
      } else {
        if (b[0] !== 0x2e) { this.buffer = b.subarray(1); continue; }
        if (b.length < 5) return;
        const size = b[4] || 256, total = size + 8;
        if (b.length < total) return;
        if (crc16(b.subarray(0, total - 2)) !== ((b[total - 2] << 8) | b[total - 1])) { this.buffer = b.subarray(1); continue; }
        this.buffer = b.subarray(total);
        if (b[1] !== p.command || ((b[2] << 8) | b[3]) !== p.address) continue;
        const ack = b[5 + size];
        p.finish(ack ? new EscAckError(p.command, ack) : undefined, b.subarray(5, 5 + size));
      }
    }
  }
  private exchange(protocol: 'msp' | 'four', command: number, address: number, frame: Uint8Array): Promise<Uint8Array> {
    if (this.pending) return Promise.reject(new DeviceError('busy', 'The ESC link is busy.'));
    this.buffer = new Uint8Array(0);
    const d = deferred<Uint8Array>(this.timing.responseMs, 'The ESC did not answer. Check direct USB, the flight battery, and the passthrough settings.');
    const finish = (error?: Error, payload?: Uint8Array) => {
      if (this.pending?.finish !== finish) return;
      this.pending = undefined;
      if (error) d.reject(error); else d.resolve(Uint8Array.from(payload!));
    };
    this.pending = { protocol, command, address, finish };
    d.promise.catch(() => { if (this.pending?.finish === finish) this.pending = undefined; });
    this.io.write(frame).catch(error => finish(error instanceof Error ? error : new DeviceError('disconnected', 'ESC serial write failed.')));
    return d.promise;
  }
  private frame(command: number, address: number, payload: Uint8Array) {
    const body = concat(Uint8Array.of(0x2f, command, address >> 8, address & 255, payload.length & 255), payload);
    const crc = crc16(body);
    return concat(body, Uint8Array.of(crc >> 8, crc & 255));
  }
  msp(command: 1 | 2 | 245) { return this.exchange('msp', command, 0, encodeMsp(command)); }
  private four(command: number, address: number, payload: Uint8Array) { return this.exchange('four', command, address, this.frame(command, address, payload)); }

  /** Select an ESC. Returns its MCU signature and interface mode. Retries a negative answer, as ESC Configurator does. */
  async init(index: number): Promise<{ signature: number; mode: number }> {
    if (!Number.isInteger(index) || index < 0 || index > 7) throw new DeviceError('invalid', 'Invalid ESC number.');
    for (let attempt = 0; ; attempt++) {
      try {
        const info = await this.four(CMD.init, 0, Uint8Array.of(index));
        if (info.length !== 4) throw new DeviceError('mismatch', 'Incomplete ESC identity.');
        return { signature: info[0] | (info[1] << 8), mode: info[3] };
      } catch (error) {
        if (!(error instanceof EscAckError) || attempt === 2) throw error;
        await sleep(this.timing.retryMs);
      }
    }
  }
  async read(address: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(address) || !Number.isInteger(length) || length < 1 || length > 256 || address < 0 || address + length > 0x10000)
      throw new DeviceError('invalid', 'ESC read is out of range.');
    const data = await this.four(CMD.read, address, Uint8Array.of(length & 255));
    if (data.length !== length) throw new DeviceError('mismatch', 'Incomplete ESC memory read.');
    return data;
  }
  async erasePage(page: number) {
    if (!this.allowWrites || !Number.isInteger(page) || page < 0 || page > BB2.settingsPage)
      throw new DeviceError('not_approved', 'ESC page erase is not approved or is outside the application area.');
    await this.four(CMD.erasePage, 0, Uint8Array.of(page));
  }
  async write(address: number, data: Uint8Array) {
    if (!this.allowWrites || !Number.isInteger(address) || address < 0 || data.length < 1 || data.length > 256 ||
        address + data.length > BB2.bootloader || Math.floor(address / BB2.page) !== Math.floor((address + data.length - 1) / BB2.page))
      throw new DeviceError('not_approved', 'ESC write is not approved or is outside the application area.');
    await this.four(CMD.write, address, data);
  }
  async reset(index: number) { await this.four(CMD.reset, 0, Uint8Array.of(index)); }
  async exit() { await this.four(CMD.exit, 0, Uint8Array.of(0)); }
}

// ---- Settings layouts -------------------------------------------------------------------------------------------

interface EscField { key: string; offset: number; title: string; options?: [number, string][]; min?: number; max?: number; firmwares: ('BLHeli_S' | 'Bluejay')[]; description: string }
/** Only fields whose encoding is confirmed for the named firmware are listed. Unknown layouts are read-only. */
export const ESC_FIELDS: EscField[] = [
  { key: 'direction', offset: 0x0b, title: 'Direction', firmwares: ['BLHeli_S', 'Bluejay'], description: 'Which way the motor turns.',
    options: [[1, 'Normal'], [2, 'Reversed'], [3, 'Bidirectional'], [4, 'Bidirectional reversed']] },
  { key: 'timing', offset: 0x15, title: 'Motor timing', firmwares: ['BLHeli_S', 'Bluejay'], description: 'Commutation timing advance.',
    options: [[1, 'Low'], [2, 'Medium low'], [3, 'Medium'], [4, 'Medium high'], [5, 'High']] },
  { key: 'demag', offset: 0x1f, title: 'Demag compensation', firmwares: ['BLHeli_S', 'Bluejay'], description: 'Protection against stalls after fast throttle changes.',
    options: [[1, 'Off'], [2, 'Low'], [3, 'High']] },
  { key: 'beep_strength', offset: 0x1b, title: 'Beep volume', firmwares: ['BLHeli_S', 'Bluejay'], min: 1, max: 255, description: 'Volume of startup and signal beeps.' },
  { key: 'beacon_strength', offset: 0x1c, title: 'Beacon volume', firmwares: ['BLHeli_S', 'Bluejay'], min: 1, max: 255, description: 'Volume of the lost-model beacon.' },
  { key: 'beacon_delay', offset: 0x1d, title: 'Beacon delay', firmwares: ['BLHeli_S', 'Bluejay'], description: 'Idle time before the beacon starts.',
    options: [[1, '1 minute'], [2, '2 minutes'], [3, '5 minutes'], [4, '10 minutes'], [5, 'Never']] },
  { key: 'temperature_protection', offset: 0x23, title: 'Temperature limit', firmwares: ['BLHeli_S'], description: 'Power is reduced above this ESC temperature.',
    options: [[0, 'Off'], [1, '80 °C'], [2, '90 °C'], [3, '100 °C'], [4, '110 °C'], [5, '120 °C'], [6, '130 °C'], [7, '140 °C']] },
  { key: 'brake_on_stop', offset: 0x27, title: 'Brake on stop', firmwares: ['BLHeli_S'], description: 'Brake the motor at zero throttle.', options: [[0, 'Off'], [1, 'On']] },
];

export interface EscRead { info: EscInfo; address?: number; block?: Uint8Array }

export function settingsAddress(signature: number, mode: number): number | null {
  if (mode !== 1) return null;
  if (signature === 0xe8b1 || signature === 0xe8b2) return BB2.settings;
  if (signature === 0xe8b5) return 0x3000;
  return null;
}
/** Identify firmware and layout from a settings block. Never guesses: anything unexpected is "Unknown". */
export function describeEsc(index: number, signature: number, mode: number, data: Uint8Array, at: number): EscInfo {
  const firmwareName = ascii(data.subarray(0x60, 0x70)).trim();
  const layout = ascii(data.subarray(0x40, 0x50)).trim();
  const mcu = ascii(data.subarray(0x50, 0x60)).trim();
  const valid = data[0x0d] === 0x55 && data[0x0e] === 0xaa && /^#[A-Z0-9_]+#$/.test(layout) && mcu.includes('BLHELI');
  const bluejay = valid && /^Bluejay(?:\s|$)/.test(firmwareName);
  const blheli = valid && firmwareName === '' && data[0] === 16 && data[1] <= 7 && (data[2] === 32 || data[2] === 33);
  const known = bluejay ? data[2] >= 200 && data[2] <= 208 : blheli;
  const bb2 = signature === 0xe8b1 || signature === 0xe8b2;
  return {
    index, at, firmware: bluejay ? 'Bluejay' : blheli ? 'BLHeli_S' : 'Unknown',
    version: `${data[0]}.${data[1]}`, layout: layout.replaceAll('#', '').replaceAll('_', '-'), mcu,
    signature: `0x${signature.toString(16).toUpperCase()}`, interfaceMode: mode,
    writable: known && bb2,
  };
}
export function escSettings(info: EscInfo, block: Uint8Array): Setting[] {
  if (info.firmware !== 'BLHeli_S' && info.firmware !== 'Bluejay') return [];
  return ESC_FIELDS.filter(f => f.firmwares.includes(info.firmware as 'BLHeli_S' | 'Bluejay')).map(f => ({
    id: `esc.${info.index}.${f.key}`, name: f.key, part: 'motors' as const, group: `ESC ${info.index}`,
    title: `ESC ${info.index} ${f.title.toLowerCase()}`, description: f.description,
    value: f.options ? (f.options.find(o => o[0] === block[f.offset])?.[1].toLowerCase() ?? block[f.offset]) : block[f.offset],
    type: f.options ? 'enum' as const : 'number' as const,
    options: f.options?.map(([, label]) => ({ value: label.toLowerCase(), label })),
    min: f.min, max: f.max, readOnly: !info.writable, at: info.at,
  }));
}
/** Turn a requested value into the byte to store, or throw with the allowed values. */
export function encodeEscField(key: string, value: string | number, firmware: EscInfo['firmware']): { offset: number; byte: number } {
  const field = ESC_FIELDS.find(f => f.key === key && f.firmwares.includes(firmware as 'BLHeli_S'));
  if (!field) throw new DeviceError('unsupported', `ESC setting "${key}" is not supported on ${firmware}.`);
  if (field.options) {
    const hit = field.options.find(([n, label]) => label.toLowerCase() === String(value).toLowerCase() || n === value);
    if (!hit) throw new DeviceError('invalid', `"${value}" is not allowed.`, `Use one of: ${field.options.map(o => o[1].toLowerCase()).join(', ')}.`);
    return { offset: field.offset, byte: hit[0] };
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < field.min! || n > field.max!) throw new DeviceError('invalid', `${field.title} must be a whole number from ${field.min} to ${field.max}.`);
  return { offset: field.offset, byte: n };
}

/** Read identity and settings for one ESC. The ESC is left selected. */
export async function readEsc(link: FourWay, index0: number, now: () => number): Promise<EscRead> {
  const { signature, mode } = await link.init(index0);
  const address = settingsAddress(signature, mode);
  if (address === null)
    return { info: { index: index0 + 1, at: now(), firmware: 'Unknown', writable: false, signature: `0x${signature.toString(16).toUpperCase()}`, interfaceMode: mode,
      error: 'This ESC type is not supported yet. Only BLHeli_S and Bluejay on EFM8 are read.' } };
  let block = await link.read(address, 0x70);
  const info = describeEsc(index0 + 1, signature, mode, block, now());
  if (info.firmware === 'Bluejay') block = await link.read(address, 0xff);
  return { info, address, block };
}

async function verify(link: FourWay, address: number, expected: Uint8Array) {
  for (let offset = 0; offset < expected.length; offset += 128) {
    const part = expected.subarray(offset, offset + 128);
    if (!equal(await link.read(address + offset, part.length), part))
      throw new DeviceError('mismatch', `ESC readback did not match at 0x${(address + offset).toString(16)}. Do not fly. Re-read the ESC and repair it before use.`);
  }
}
async function writePage(link: FourWay, page: number, image: Uint8Array) {
  const address = page * BB2.page;
  await link.erasePage(page);
  for (let offset = 0; offset < BB2.page; offset += 256) await link.write(address + offset, image.subarray(address + offset, address + offset + 256));
  await verify(link, address, image.subarray(address, address + BB2.page));
}

/**
 * Change settings bytes on the selected ESC: read the whole settings page, patch it, erase, write, read back.
 * Returns the new page. Everything but the patched bytes is written back exactly as it was read.
 */
export async function patchEscSettings(link: FourWay, patches: { offset: number; byte: number }[]): Promise<Uint8Array> {
  const page = new Uint8Array(BB2.page);
  for (let offset = 0; offset < BB2.page; offset += 128) page.set(await link.read(BB2.settings + offset, 128), offset);
  if (page[0x0d] !== 0x55 || page[0x0e] !== 0xaa) throw new DeviceError('mismatch', 'The ESC settings block is not valid. Nothing was written.');
  const next = Uint8Array.from(page);
  for (const { offset, byte } of patches) {
    if (offset < 0 || offset >= 0x40) throw new DeviceError('invalid', 'ESC setting is outside the settings area.');
    next[offset] = byte;
  }
  if (equal(page, next)) return page;
  const image = new Uint8Array(BB2.size);
  image.set(next, BB2.settings);
  await writePage(link, BB2.settingsPage, image);
  return next;
}

/** Strict Intel HEX reader for an 8 KB EFM8 image. No overlaps, no extended addresses. */
export function parseEscHex(text: string): Uint8Array {
  const image = new Uint8Array(BB2.size).fill(255), seen = new Set<number>();
  let ended = false;
  for (const line of text.trim().split(/\r?\n/)) {
    if (ended || !/^:(?:[\da-fA-F]{2})+$/.test(line)) throw new DeviceError('invalid', 'Invalid firmware HEX record.');
    const record = Uint8Array.from(line.slice(1).match(/../g)!, p => parseInt(p, 16));
    if (record.length !== record[0] + 5 || record.reduce((sum, x) => sum + x, 0) % 256) throw new DeviceError('invalid', 'Firmware HEX checksum failed.');
    const address = (record[1] << 8) | record[2], type = record[3];
    if (type === 1 && record[0] === 0) { ended = true; continue; }
    if (type !== 0 || address + record[0] > image.length) throw new DeviceError('invalid', 'Firmware HEX is outside the supported memory range.');
    for (let i = 0; i < record[0]; i++) {
      if (seen.has(address + i)) throw new DeviceError('invalid', 'Overlapping firmware HEX records.');
      seen.add(address + i); image[address + i] = record[4 + i];
    }
  }
  if (!ended) throw new DeviceError('invalid', 'Firmware HEX has no end record.');
  return image;
}

/**
 * Flash BLHeli_S or Bluejay firmware to the selected EFM8 BB1/BB2 ESC, keeping its direction and beeper settings.
 * Follows ESC Configurator's order: a recovery marker first, the reset vector last, the bootloader never.
 */
export async function flashEsc(link: FourWay, current: EscRead, firmware: Uint8Array, progress: (label: string, done?: number, total?: number) => void): Promise<Uint8Array> {
  const info = current.info;
  if (!info.writable || !current.block) throw new DeviceError('unsupported', 'This ESC cannot be flashed by Lucidity yet.');
  if (firmware.length !== BB2.size) throw new DeviceError('invalid', 'Firmware image has the wrong size.');
  const target = describeEsc(info.index, parseInt(info.signature!, 16), 1, firmware.subarray(BB2.settings, BB2.settings + 0x70), 0);
  if (target.firmware === 'Unknown') throw new DeviceError('invalid', 'This file is not a recognised BLHeli_S or Bluejay image.');
  if (target.layout !== info.layout || target.mcu !== info.mcu)
    throw new DeviceError('mismatch', `This firmware is for ${target.layout} (${target.mcu}); the ESC is ${info.layout} (${info.mcu}). Nothing was written.`);
  if (firmware[0] !== 0x02 || ((firmware[1] << 8) | firmware[2]) >= BB2.settings) throw new DeviceError('invalid', 'Firmware reset vector is not valid.');
  const before = new Uint8Array(BB2.size);
  for (let address = 0; address < BB2.size; address += 128) { before.set(await link.read(address, 128), address); progress('Reading current firmware', address, BB2.size); }
  const after = Uint8Array.from(before);
  after.set(firmware.subarray(0, BB2.bootloader), 0);
  for (const offset of [0x0b, 0x1b, 0x1c, 0x1d]) after[BB2.settings + offset] = before[BB2.settings + offset];
  if (!equal(before.subarray(BB2.bootloader), after.subarray(BB2.bootloader))) throw new DeviceError('mismatch', 'The bootloader must stay unchanged.');
  progress('Writing recovery marker');
  const marker = Uint8Array.from(before.subarray(BB2.settings, BB2.settings + 0x70));
  marker.set(new TextEncoder().encode('**FLASH*FAILED**'), 0x60);
  await link.erasePage(BB2.settingsPage);
  await link.write(BB2.settings, marker);
  await verify(link, BB2.settings, marker);
  await link.erasePage(1);
  const jump = Uint8Array.of(0x02, 0x1c, 0x00);
  await link.write(BB2.page, jump);
  await verify(link, BB2.page, jump);
  await link.erasePage(0);
  await verify(link, 0, new Uint8Array(BB2.page).fill(255));
  for (let page = 2; page < BB2.settingsPage; page++) { progress('Writing firmware', page, BB2.settingsPage); await writePage(link, page, after); }
  for (const page of [0, 1]) await writePage(link, page, after);
  progress('Writing settings');
  await writePage(link, BB2.settingsPage, after);
  await verify(link, 0, after);
  return after;
}
export const escDigest = (block: Uint8Array) => hex(block.subarray(0, 0x40));
