import { concat, deferred, DeviceError, equal } from '../bytes';
import type { ByteTransport } from '../transport';

/**
 * The PX4/ArduPilot serial bootloader, used to install .apj and .px4 firmware.
 * Written from the reference uploader (px_uploader.py). The board id in the file is checked against the board
 * before anything is erased. Exercised against a simulated bootloader only; it has not been run on hardware.
 */
const INSYNC = 0x12, EOC = 0x20, OK = 0x10, FAILED = 0x11, INVALID = 0x13;
const GET_SYNC = 0x21, GET_DEVICE = 0x22, CHIP_ERASE = 0x23, PROG_MULTI = 0x27, GET_CRC = 0x29, REBOOT = 0x30;
const INFO_BOARD_ID = 2, INFO_FLASH_SIZE = 4;

const TABLE = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
/** The bootloader's CRC: standard table, starting from zero, with no final inversion. */
export function bootloaderCrc(image: Uint8Array, flashSize: number): number {
  let crc = 0;
  for (const b of image) crc = (TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  for (let i = image.length; i < flashSize; i++) crc = (TABLE[(crc ^ 0xff) & 0xff] ^ (crc >>> 8)) >>> 0;
  return crc >>> 0;
}
export interface Firmware { boardId: number; image: Uint8Array; summary?: string }
/** Read an .apj / .px4 file: JSON carrying a zlib-compressed image and the board it was built for. */
export async function parseApj(file: Uint8Array): Promise<Firmware> {
  let json: { board_id?: number; image?: string; image_size?: number; summary?: string };
  try { json = JSON.parse(new TextDecoder().decode(file)); } catch { throw new DeviceError('invalid', 'This is not an ArduPilot or PX4 firmware file.'); }
  if (!Number.isInteger(json.board_id) || typeof json.image !== 'string') throw new DeviceError('invalid', 'The firmware file is missing its board id or image.');
  const packed = Uint8Array.from(atob(json.image), c => c.charCodeAt(0));
  const stream = new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  let image: Uint8Array = new Uint8Array(await new Response(stream).arrayBuffer().catch(() => { throw new DeviceError('invalid', 'The firmware image could not be unpacked.'); }));
  if (json.image_size && json.image_size !== image.length) throw new DeviceError('invalid', 'The firmware image is the wrong size.');
  if (image.length % 4) image = concat(image, new Uint8Array(4 - (image.length % 4)).fill(255));
  return { boardId: json.board_id!, image, summary: json.summary };
}

class Link {
  private buffer: Uint8Array = new Uint8Array(0);
  private wake?: () => void;
  private off: () => void;
  constructor(private transport: ByteTransport) { this.off = transport.onData(chunk => { this.buffer = concat(this.buffer, chunk); this.wake?.(); }); }
  dispose() { this.off(); }
  flush() { this.buffer = new Uint8Array(0); }
  async read(n: number, timeoutMs: number, what: string): Promise<Uint8Array> {
    const d = deferred<void>(timeoutMs, `The bootloader did not answer while ${what}.`);
    const check = () => { if (this.buffer.length >= n) d.resolve(); };
    this.wake = check; check();
    try { await d.promise; } finally { this.wake = undefined; }
    const out = this.buffer.subarray(0, n);
    this.buffer = Uint8Array.from(this.buffer.subarray(n));
    return out;
  }
  async sync(timeoutMs: number, what: string) {
    const [a, b] = await this.read(2, timeoutMs, what);
    if (a !== INSYNC) throw new DeviceError('mismatch', `The bootloader lost sync while ${what}.`);
    if (b === INVALID) throw new DeviceError('unsupported', `The bootloader does not support ${what}.`);
    if (b === FAILED) throw new DeviceError('rejected', `The bootloader failed while ${what}.`);
    if (b !== OK) throw new DeviceError('mismatch', `Unexpected bootloader answer while ${what}.`);
  }
  send(...bytes: number[]) { return this.transport.write(Uint8Array.from(bytes)); }
  async info(what: number): Promise<number> {
    await this.send(GET_DEVICE, what, EOC);
    const v = await this.read(4, 2000, 'identifying the board');
    await this.sync(2000, 'identifying the board');
    return (v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 0;
  }
}

export async function px4Flash(transport: ByteTransport, firmware: Firmware, progress: (label: string, done?: number, total?: number) => void = () => {}, timing = { syncMs: 1500, eraseMs: 40000 }): Promise<{ boardId: number; bytes: number }> {
  const link = new Link(transport);
  try {
    let synced = false;
    for (let attempt = 0; attempt < 4 && !synced; attempt++) {
      link.flush();
      await link.send(GET_SYNC, EOC);
      synced = await link.sync(timing.syncMs, 'connecting').then(() => true, () => false);
    }
    if (!synced) throw new DeviceError('timeout', 'No bootloader answered.', 'Unplug the flight controller, plug it back in, and choose its port within a few seconds.');
    const boardId = await link.info(INFO_BOARD_ID), flashSize = await link.info(INFO_FLASH_SIZE);
    if (boardId !== firmware.boardId)
      throw new DeviceError('mismatch', `This firmware is for board ${firmware.boardId}; the flight controller is board ${boardId}. Nothing was erased.`, 'Download the firmware built for this board.');
    if (firmware.image.length > flashSize) throw new DeviceError('mismatch', 'This firmware is too large for the flight controller. Nothing was erased.');
    progress('Erasing');
    await link.send(CHIP_ERASE, EOC);
    await link.sync(timing.eraseMs, 'erasing');
    for (let at = 0; at < firmware.image.length; at += 252) {
      const chunk = firmware.image.subarray(at, at + 252);
      await transport.write(concat(Uint8Array.of(PROG_MULTI, chunk.length), chunk, Uint8Array.of(EOC)));
      await link.sync(3000, 'writing');
      progress('Writing', at + chunk.length, firmware.image.length);
    }
    progress('Verifying');
    await link.send(GET_CRC, EOC);
    const c = await link.read(4, 10000, 'verifying');
    await link.sync(2000, 'verifying');
    const expected = bootloaderCrc(firmware.image, flashSize);
    const w = Uint8Array.of(expected & 255, (expected >>> 8) & 255, (expected >>> 16) & 255, (expected >>> 24) & 255);
    if (!equal(c, w)) throw new DeviceError('mismatch', 'The flight controller\'s checksum does not match the firmware. Do not fly. Flash again.');
    progress('Starting the new firmware');
    await link.send(REBOOT, EOC);
    await link.sync(2000, 'restarting').catch(() => {});
    return { boardId, bytes: firmware.image.length };
  } finally { link.dispose(); }
}

/** A simulated bootloader, for tests. */
export class SimBootloader {
  flash: Uint8Array;
  erased = false;
  rebooted = false;
  written = 0;
  constructor(port: ByteTransport, readonly boardId = 1013, readonly flashSize = 4096) {
    this.flash = new Uint8Array(flashSize).fill(0);
    let buffer: Uint8Array = new Uint8Array(0);
    port.onData(chunk => {
      buffer = concat(buffer, chunk);
      for (;;) {
        if (!buffer.length) return;
        const op = buffer[0];
        const need = op === GET_DEVICE ? 3 : op === PROG_MULTI ? (buffer.length > 1 ? buffer[1] + 3 : 99999) : 2;
        if (buffer.length < need) return;
        const frame = buffer.subarray(0, need);
        buffer = Uint8Array.from(buffer.subarray(need));
        const u32 = (v: number) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
        const ok = Uint8Array.of(INSYNC, OK);
        if (op === GET_SYNC) void port.write(ok);
        else if (op === GET_DEVICE) void port.write(concat(u32(frame[1] === INFO_BOARD_ID ? this.boardId : frame[1] === INFO_FLASH_SIZE ? this.flashSize : 5), ok));
        else if (op === CHIP_ERASE) { this.flash.fill(255); this.erased = true; this.written = 0; void port.write(ok); }
        else if (op === PROG_MULTI) { this.flash.set(frame.subarray(2, 2 + frame[1]), this.written); this.written += frame[1]; void port.write(ok); }
        else if (op === GET_CRC) void port.write(concat(u32(bootloaderCrc(this.flash.subarray(0, this.written), this.flashSize)), ok));
        else if (op === REBOOT) { this.rebooted = true; void port.write(ok); }
        else void port.write(Uint8Array.of(INSYNC, INVALID));
      }
    });
  }
}
